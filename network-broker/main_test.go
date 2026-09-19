package main

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func containsIdentity(identities []ProcessIdentity, expected ProcessIdentity) bool {
	for _, identity := range identities {
		if identity.PID == expected.PID && identity.Start == expected.Start {
			return true
		}
	}
	return false
}

func TestBrowserEnvironmentUsesPeerAccount(t *testing.T) {
	t.Setenv("HOME", "/not-the-peer-home")
	t.Setenv("SECRET_CANARY", "must-not-inherit")
	account, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	env, err := browserEnvironment(uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, pair := range env {
		parts := strings.SplitN(pair, "=", 2)
		values[parts[0]] = parts[1]
	}
	if len(values) != 6 || values["HOME"] != account.HomeDir || values["USER"] != account.Username || values["LOGNAME"] != account.Username {
		t.Fatalf("unexpected child environment: %v", values)
	}
	if _, err := browserEnvironment(^uint32(0)); err == nil {
		t.Fatal("unknown peer account must fail closed")
	}
}

func TestStopManagedMCPTreatsExpectedSignalAsSuccessfulCleanup(t *testing.T) {
	testManagedMCPStop(t, "sleep", "30")
}

func TestStopManagedMCPTreatsExitedProcessAsSuccessfulCleanup(t *testing.T) {
	testManagedMCPStop(t, "sh", "-c", "exit 1")
}

func TestProcessGroupExistsChecksOwnedMembers(t *testing.T) {
	pgid, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !processGroupExists(pgid) {
		t.Fatalf("current process group %d was not found", pgid)
	}
	if processGroupExists(1 << 30) {
		t.Fatal("nonexistent process group was reported as present")
	}
}

func TestProcessGroupInventoryIsBoundToTheRequestedGroup(t *testing.T) {
	pgid, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	identities, ok := processGroupInventory(pgid)
	if !ok {
		t.Fatalf("expected current process group to be observable")
	}
	found := false
	for _, identity := range identities {
		if identity.PID == os.Getpid() && identity.PGID == pgid && identity.Start != "" {
			found = true
		}
		if identity.PGID != pgid {
			t.Fatalf("inventory escaped requested process group: %+v", identity)
		}
	}
	if !found {
		t.Fatalf("current process was not included in owned group inventory: %+v", identities)
	}
	if _, ok := processGroupInventory(1 << 30); ok {
		t.Fatal("unowned process group was reported as observable")
	}
}

func TestPostStopInventoryIsAuthoritativelyAbsent(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "mcp.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sleep", "30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	leader, ok := readProcessIdentity(cmd.Process.Pid)
	if !ok {
		t.Fatal("started process identity was not observable")
	}
	s := &session{info: SessionInfo{ID: "nla-test"}, mcp: &managedMCP{cmd: cmd, listener: listener, path: socketPath}, mcpPath: socketPath, mcpPGID: cmd.Process.Pid, mcpStart: leader.Start, owned: []ProcessIdentity{leader}}
	if err := stopMCP(s); err != nil {
		t.Fatal(err)
	}
	report := s.inventory()
	if report.Status != "ABSENT" || len(report.Identities) != 0 || report.Reason != "PROCESS_GROUP_TERMINATED" {
		t.Fatalf("expected authoritative post-stop absence, got %+v", report)
	}
}

func TestExitedLeaderWithRemainingMemberIsPresent(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "sleep 30 & exit 0")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pgid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	identities, present, inspectable := processGroupInventoryState(pgid)
	if !inspectable || !present || len(identities) == 0 {
		t.Fatalf("expected surviving process-group member to remain present: inspectable=%v present=%v identities=%+v", inspectable, present, identities)
	}
	for _, identity := range identities {
		if identity.PGID != pgid {
			t.Fatalf("identity escaped process group: %+v", identity)
		}
		if identity.PID == pgid {
			t.Fatalf("leader unexpectedly remained in process group: %+v", identities)
		}
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}

func TestEscapedNewProcessGroupRemainsOwnedByStableTreeIdentity(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "setsid /bin/sleep 30 & wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pgid := cmd.Process.Pid
	var owned []ProcessIdentity
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var ok bool
		owned, ok = processTreeInventory(cmd.Process.Pid)
		if ok && len(owned) > 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(owned) < 2 {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		_, _ = cmd.Process.Wait()
		t.Fatalf("did not observe descendant tree: %+v", owned)
	}
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_, _ = cmd.Process.Wait()
	remaining, inspectable := stableOwnedState(owned)
	if !inspectable || len(remaining) == 0 {
		t.Fatalf("escaped descendant was not retained as owned: inspectable=%v remaining=%+v owned=%+v", inspectable, remaining, owned)
	}
	for _, identity := range remaining {
		_ = syscall.Kill(identity.PID, syscall.SIGKILL)
	}
}

func TestCleanupResourceProbesFailClosed(t *testing.T) {
	if classifySocketError(syscall.EACCES) != resourceBlocked || classifySocketError(syscall.EIO) != resourceBlocked {
		t.Fatal("socket permission and I/O errors must remain blocked")
	}
	if classifySocketError(os.ErrNotExist) != resourceAbsent {
		t.Fatal("socket ENOENT must be confirmed absent")
	}
	if classifyProxyError(syscall.ETIMEDOUT) != resourceBlocked || classifyProxyError(syscall.EIO) != resourceBlocked {
		t.Fatal("proxy timeout and I/O errors must remain blocked")
	}
	if classifyProxyError(syscall.ECONNREFUSED) != resourceAbsent {
		t.Fatal("proxy ECONNREFUSED must be confirmed absent")
	}
	for _, err := range []error{syscall.ENETUNREACH, syscall.EHOSTUNREACH, syscall.EADDRNOTAVAIL} {
		if classifyProxyError(err) != resourceBlocked {
			t.Fatalf("proxy error %v must remain blocked", err)
		}
	}
	if socketState("") != resourceBlocked || proxyState("") != resourceBlocked {
		t.Fatal("malformed resource addresses must remain blocked")
	}
	if classifyLinkProbe(syscall.EACCES, "permission denied") != resourceBlocked || classifyLinkProbe(syscall.ETIMEDOUT, "") != resourceBlocked {
		t.Fatal("veth permission and timeout errors must remain blocked")
	}
	if classifyLinkProbe(syscall.EIO, "") != resourceBlocked {
		t.Fatal("veth I/O errors must remain blocked")
	}
	if classifyLinkProbe(syscall.ENODEV, `Device "nlah-test" does not exist.`) != resourceAbsent {
		t.Fatal("authoritative no-link result must be absent")
	}
}

func TestCgroupBoundaryKillsEscapedDescendant(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("cgroup boundary regression requires the broker-owned root boundary")
	}
	boundary, err := createCgroup("test-boundary")
	if err != nil {
		t.Skipf("cgroup v2 boundary unavailable: %v", err)
	}
	defer func() { _ = cleanupCgroup(boundary) }()
	cmd := exec.Command("/bin/sh", "-c", "setsid /bin/sleep 30 & wait")
	cgroupDir, err := os.Open(boundary)
	if err != nil {
		t.Fatal(err)
	}
	defer cgroupDir.Close()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, UseCgroupFD: true, CgroupFD: int(cgroupDir.Fd())}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if state := cgroupBoundaryState(boundary); state != resourcePresent {
		_, _ = cmd.Process.Wait()
		t.Fatalf("expected populated process boundary, got %s", state)
	}
	procs, err := os.ReadFile(filepath.Join(boundary, "cgroup.procs"))
	if err != nil || len(strings.Fields(string(procs))) < 2 {
		_, _ = cmd.Process.Wait()
		t.Fatalf("expected leader and reparented descendant in cgroup: %q", procs)
	}
	if state := cleanupCgroup(boundary); state != resourceAbsent {
		_, _ = cmd.Process.Wait()
		t.Fatalf("cgroup cleanup did not prove absence: %s", state)
	}
	_, _ = cmd.Process.Wait()
}

func TestOwnedLedgerIsMonotonicAcrossReparentedSnapshot(t *testing.T) {
	root := ProcessIdentity{PID: 101, ParentPID: 1, PGID: 101, Start: "root"}
	reparented := ProcessIdentity{PID: 202, ParentPID: 1, PGID: 202, Start: "descendant"}
	ledger := mergeIdentities([]ProcessIdentity{root, reparented}, []ProcessIdentity{root})
	if len(ledger) != 2 || !containsIdentity(ledger, reparented) {
		t.Fatalf("latest snapshot erased reparented owned identity: %+v", ledger)
	}
	remaining, inspectable := stableOwnedStateWith(ledger, func(identity ProcessIdentity) (ProcessIdentity, error) {
		if identity.PID == reparented.PID {
			return identity, nil
		}
		return ProcessIdentity{}, os.ErrNotExist
	})
	if !inspectable || len(remaining) != 1 || remaining[0].Start != reparented.Start {
		t.Fatalf("reparented identity was not retained for teardown: inspectable=%v remaining=%+v", inspectable, remaining)
	}
}

func TestTransientUnreadableProcEntryDoesNotHidePresentGroup(t *testing.T) {
	read := func(pid int) (ProcessIdentity, bool) {
		if pid == 11 {
			return ProcessIdentity{PID: pid, PGID: 77, Start: "member"}, true
		}
		return ProcessIdentity{}, false
	}
	identities, present, inspectable := processGroupInventoryStateFromPIDs(77, []int{10, 11, 12}, read, func(int) error { return syscall.EPERM })
	if !inspectable || !present || len(identities) != 1 || identities[0].PID != 11 {
		t.Fatalf("transient unreadable entry hid present group: inspectable=%v present=%v identities=%+v", inspectable, present, identities)
	}
	identities, present, inspectable = processGroupInventoryStateFromPIDs(77, []int{10, 12}, read, func(int) error { return syscall.ESRCH })
	if !inspectable || present || len(identities) != 0 {
		t.Fatalf("confirmed absent group was not classified absent: inspectable=%v present=%v identities=%+v", inspectable, present, identities)
	}
	_, present, inspectable = processGroupInventoryStateFromPIDs(77, []int{11}, read, func(int) error { return syscall.EIO })
	if inspectable || present {
		t.Fatalf("unknown group existence was not fail-closed: inspectable=%v present=%v", inspectable, present)
	}
}

func TestInventoryFailureCannotBecomeAbsent(t *testing.T) {
	s := &session{info: SessionInfo{ID: "nla-test"}, mcpPath: "/tmp/nla-test.sock", mcpPGID: 1, mcpStopped: true}
	report := s.inventory()
	if report.Status != "BLOCKED" || report.Reason != "BROKER_PROCESS_INVENTORY_UNAVAILABLE" {
		t.Fatalf("expected fail-closed inventory failure, got %+v", report)
	}
}

func TestLaunchExistingSessionDoesNotReenterMutex(t *testing.T) {
	pgid, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	leader, ok := readProcessIdentity(os.Getpid())
	if !ok {
		t.Fatal("test process identity was not observable")
	}
	s := &session{info: SessionInfo{ID: "nla-launch-test", Token: "token", State: "READY"}, ownerUID: uint32(os.Getuid()), mcp: &managedMCP{cmd: &exec.Cmd{Process: &os.Process{Pid: os.Getpid()}}, path: "/tmp/test-mcp.sock"}, mcpPath: "/tmp/test-mcp.sock", mcpPGID: pgid, mcpStart: leader.Start}
	sessionsMu.Lock()
	sessions[s.info.ID] = s
	sessionsMu.Unlock()
	defer func() { sessionsMu.Lock(); delete(sessions, s.info.ID); sessionsMu.Unlock() }()
	done := make(chan Response, 1)
	go func() { done <- launch(s.info.ID, s.info.Token, uint32(os.Getuid())) }()
	select {
	case response := <-done:
		if !response.OK || response.Endpoint != s.mcp.path {
			t.Fatalf("existing launch failed: %+v", response)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("launch re-entered the session mutex")
	}
}

func TestLaunchCapturesActualProcessIdentity(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("real cgroup launch requires the broker-owned root boundary")
	}
	tmp := t.TempDir()
	ipShim := filepath.Join(tmp, "ip")
	if err := os.WriteFile(ipShim, []byte("#!/bin/sh\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nexec \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	oldPath, oldCommand, oldDir := os.Getenv("PATH"), os.Getenv("NLA_BROWSER_MCP_COMMAND_JSON"), os.Getenv("NLA_BROKER_MCP_DIR")
	defer func() {
		_ = os.Setenv("PATH", oldPath)
		_ = os.Setenv("NLA_BROWSER_MCP_COMMAND_JSON", oldCommand)
		_ = os.Setenv("NLA_BROKER_MCP_DIR", oldDir)
	}()
	_ = os.Setenv("PATH", tmp+":"+oldPath)
	command, _ := json.Marshal([]string{"/bin/sh", "-c", "setsid /bin/sleep 30 & wait # __NLA_SESSION_PROXY__"})
	_ = os.Setenv("NLA_BROWSER_MCP_COMMAND_JSON", string(command))
	_ = os.Setenv("NLA_BROKER_MCP_DIR", tmp)
	s := &session{info: SessionInfo{ID: "nla-real-launch", Token: "token", State: "READY", Proxy: "127.0.0.1:1"}, ownerUID: uint32(os.Getuid()), ownerGID: uint32(os.Getgid())}
	// Keep the test independent of namespace and nft setup: the launch path is
	// exercised through a temporary test-only ip shim, never the service.
	s.info.Namespace = "test-namespace"
	sessionsMu.Lock()
	sessions[s.info.ID] = s
	sessionsMu.Unlock()
	defer func() { sessionsMu.Lock(); delete(sessions, s.info.ID); sessionsMu.Unlock() }()
	response := launch(s.info.ID, s.info.Token, uint32(os.Getuid()))
	if !response.OK || response.Inventory == nil {
		t.Fatalf("real launch path did not return inventory: %+v", response)
	}
	if response.Inventory.Status != "OBSERVED" || response.Inventory.ProcessGroupID <= 1 || response.Inventory.ProcessStart == "" || len(response.Inventory.Identities) == 0 {
		t.Fatalf("launch did not capture actual process identity: %+v", response.Inventory)
	}
	if response.Inventory.Identities[0].PGID != response.Inventory.ProcessGroupID {
		t.Fatalf("launch inventory process-group mismatch: %+v", response.Inventory)
	}
	deadline := time.Now().Add(2 * time.Second)
	var descendant []ProcessIdentity
	for time.Now().Before(deadline) {
		if data, readErr := os.ReadFile(filepath.Join(s.cgroupPath, "cgroup.procs")); readErr == nil {
			for _, field := range strings.Fields(string(data)) {
				pid, parseErr := strconv.Atoi(field)
				if parseErr != nil {
					continue
				}
				identity, identityOK := readProcessIdentity(pid)
				if identityOK && identity.PGID != response.Inventory.ProcessGroupID {
					descendant = append(descendant, identity)
				}
			}
		}
		if len(descendant) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(descendant) == 0 {
		t.Fatalf("launch did not observe a distinct descendant process group")
	}
	if err := stopMCP(s); err != nil {
		t.Fatal(err)
	}
	if s.cgroupPath == "" || cleanupCgroup(s.cgroupPath) != resourceAbsent {
		t.Fatal("production launch cgroup was not cleaned")
	}
	if report := s.inventory(); report.Status != "ABSENT" || len(report.Identities) != 0 {
		t.Fatalf("descendant remained after cgroup cleanup: %+v", report)
	}
	if report := s.inventory(); report.Status != "ABSENT" || len(report.Identities) != 0 {
		t.Fatalf("post-launch cleanup was not authoritative: %+v", report)
	}
}

func TestBridgeAndDestroyShareMCPTeardown(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "mcp.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sleep", "30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	managed := &managedMCP{cmd: cmd, listener: listener, path: socketPath}
	bridgeDone := make(chan struct{})
	go func() {
		bridgeMCP(managed, stdin, stdout)
		close(bridgeDone)
	}()
	client, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := stopManagedMCP(managed, nil, nil); err != nil {
		t.Fatalf("concurrent destroy must share bridge teardown result: %v", err)
	}
	_ = client.Close()
	select {
	case <-bridgeDone:
	case <-time.After(3 * time.Second):
		t.Fatal("bridge teardown did not complete")
	}
	if _, err := os.Stat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("MCP socket remains after shared teardown: %v", err)
	}
}

func testManagedMCPStop(t *testing.T, name string, args ...string) {
	t.Helper()
	socketPath := filepath.Join(t.TempDir(), "mcp.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}

	managed := &managedMCP{cmd: cmd, listener: listener, path: socketPath}
	if err := stopManagedMCP(managed, nil, nil); err != nil {
		t.Fatalf("expected completed process cleanup to be successful: %v", err)
	}
}
