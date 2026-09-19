package main

// nlabridged is a narrow privileged broker. IPC accepts a typed policy only.
import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Origin struct {
	Scheme string `json:"scheme"`
	Host   string `json:"host"`
	Ports  []int  `json:"ports"`
}
type Policy struct {
	Allowed        []Origin `json:"allowed_origins"`
	AllowPrivate   bool     `json:"allow_private_addresses"`
	AllowWebSocket bool     `json:"allow_websocket"`
	MaxRedirects   int      `json:"max_redirects"`
}
type Request struct {
	Op        string  `json:"op"`
	SessionID string  `json:"session_id,omitempty"`
	Token     string  `json:"token,omitempty"`
	Policy    *Policy `json:"policy,omitempty"`
}
type Response struct {
	OK        bool              `json:"ok"`
	Error     string            `json:"error,omitempty"`
	Session   *SessionInfo      `json:"session,omitempty"`
	Endpoint  string            `json:"endpoint,omitempty"`
	Inventory *ProcessInventory `json:"inventory,omitempty"`
	Cleanup   *CleanupReport    `json:"cleanup,omitempty"`
}
type ProcessIdentity struct {
	PID       int    `json:"pid"`
	ParentPID int    `json:"parent_pid"`
	PGID      int    `json:"process_group_id"`
	Start     string `json:"start_time"`
	State     string `json:"state"`
	RSSKB     uint64 `json:"rss_kb"`
}
type ProcessInventory struct {
	Status         string            `json:"status"`
	Source         string            `json:"source,omitempty"`
	Reason         string            `json:"reason,omitempty"`
	SessionID      string            `json:"session_id"`
	OwnerUID       uint32            `json:"owner_uid"`
	ProcessGroupID int               `json:"process_group_id,omitempty"`
	ProcessStart   string            `json:"process_start,omitempty"`
	BoundaryState  string            `json:"process_boundary_state,omitempty"`
	Identities     []ProcessIdentity `json:"identities"`
}
type CleanupReport struct {
	Status           string            `json:"status"`
	SessionID        string            `json:"session_id"`
	Inventory        ProcessInventory  `json:"inventory"`
	Remaining        []ProcessIdentity `json:"remaining_processes"`
	MCPRemoved       string            `json:"mcp_socket_state"`
	NamespaceRemoved string            `json:"namespace_state"`
	ProxyRemoved     string            `json:"proxy_state"`
	PolicyRemoved    string            `json:"policy_state"`
	VethRemoved      string            `json:"veth_state"`
	CgroupState      string            `json:"process_boundary_state"`
}
type resourceState string

const (
	resourceAbsent  resourceState = "ABSENT"
	resourcePresent resourceState = "PRESENT"
	resourceBlocked resourceState = "BLOCKED"
)

type SessionInfo struct {
	ID           string    `json:"session_id"`
	Token        string    `json:"session_token"`
	Namespace    string    `json:"namespace"`
	Proxy        string    `json:"proxy"`
	PolicyDigest string    `json:"policy_digest"`
	State        string    `json:"state"`
	CreatedAt    time.Time `json:"created_at"`
}
type session struct {
	info       SessionInfo
	policy     Policy
	hostAddr   string
	ownerUID   uint32
	ownerGID   uint32
	pinned     map[string]map[string]struct{}
	redirects  int
	server     *http.Server
	listener   net.Listener
	mcp        *managedMCP
	mcpPath    string
	mcpPGID    int
	mcpStart   string
	mcpStopped bool
	owned      []ProcessIdentity
	cgroupPath string
	mu         sync.Mutex
	destroyMu  sync.Mutex
}
type managedMCP struct {
	cmd          *exec.Cmd
	listener     net.Listener
	path         string
	stopInitOnce sync.Once
	stopOnce     sync.Once
	stopDone     chan struct{}
	stopErr      error
}

type boundedWriter struct {
	w   io.Writer
	n   int
	max int
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if w.n >= w.max {
		return len(p), nil
	}
	keep := len(p)
	if remaining := w.max - w.n; keep > remaining {
		keep = remaining
	}
	n, err := w.w.Write(p[:keep])
	w.n += n
	if n < len(p) && err == nil {
		return len(p), nil
	}
	return n, err
}

var sessionsMu sync.Mutex
var sessions = map[string]*session{}
var validHost = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
var lookupIP = net.LookupIP

const defaultMaxRedirects = 10

func main() {
	if len(os.Args) != 3 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: nlabridged serve SOCKET")
		os.Exit(2)
	}
	if err := serve(os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func serve(path string) error {
	reapStale()
	if rawFDs := os.Getenv("LISTEN_FDS"); rawFDs != "" {
		if rawFDs != "1" {
			return errors.New("invalid systemd socket activation fd count")
		}
		if os.Getenv("LISTEN_PID") != strconv.Itoa(os.Getpid()) {
			return errors.New("invalid systemd socket activation pid")
		}
		f := os.NewFile(3, "nla-browser-broker")
		if f == nil {
			return errors.New("systemd socket activation fd unavailable")
		}
		l, err := net.FileListener(f)
		_ = f.Close()
		if err != nil {
			return fmt.Errorf("systemd socket activation: %w", err)
		}
		if _, ok := l.(*net.UnixListener); !ok {
			_ = l.Close()
			return errors.New("systemd socket activation did not provide a Unix listener")
		}
		defer l.Close()
		for {
			c, err := l.Accept()
			if err == nil {
				go handle(c)
			}
		}
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}
	l, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	defer l.Close()
	if err = os.Chmod(path, 0660); err != nil {
		return err
	}
	if rawGID := os.Getenv("NLA_BROKER_SOCKET_GID"); rawGID != "" {
		gid, err := strconv.Atoi(rawGID)
		if err != nil || gid < 0 {
			return errors.New("invalid NLA_BROKER_SOCKET_GID")
		}
		if err := os.Chown(path, os.Getuid(), gid); err != nil {
			return fmt.Errorf("socket group: %w", err)
		}
	}
	for {
		c, err := l.Accept()
		if err == nil {
			go handle(c)
		}
	}
}
func reapStale() {
	if paths, err := filepath.Glob("/run/nla-browser/nla-mcp-*.sock"); err == nil {
		for _, path := range paths {
			_ = os.Remove(path)
		}
	}
	if out, err := exec.Command("ip", "netns", "list").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 && strings.HasPrefix(fields[0], "nla-") {
				cleanup(fields[0])
			}
		}
	}
	if out, err := exec.Command("ip", "-br", "link").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 && strings.HasPrefix(fields[0], "nlah-") {
				_ = run("ip", "link", "del", fields[0])
			}
		}
	}
	if out, err := exec.Command("nft", "-a", "list", "chain", "ip", "filter", "INPUT").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			if !strings.Contains(line, "nla-") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) > 2 && fields[len(fields)-2] == "handle" {
				_ = run("nft", "delete", "rule", "ip", "filter", "INPUT", "handle", fields[len(fields)-1])
			}
		}
	}
}
func handle(c net.Conn) {
	defer c.Close()
	var q Request
	if json.NewDecoder(bufio.NewReader(io.LimitReader(c, 1<<20))).Decode(&q) != nil {
		return
	}
	uid, gid, ok := peerCred(c)
	if !ok {
		_ = json.NewEncoder(c).Encode(Response{Error: "peer credentials unavailable"})
		return
	}
	var r Response
	switch q.Op {
	case "create":
		r = create(q.Policy, uid, gid)
	case "status":
		r = status(q.SessionID, q.Token, uid)
	case "destroy":
		r = destroy(q.SessionID, q.Token, uid)
	case "launch":
		r = launch(q.SessionID, q.Token, uid)
	default:
		r.Error = "unsupported operation"
	}
	_ = json.NewEncoder(c).Encode(r)
}
func create(p *Policy, uid, gid uint32) Response {
	if p == nil {
		return Response{Error: "policy required"}
	}
	if e := validate(p); e != nil {
		return Response{Error: e.Error()}
	}
	if p.MaxRedirects == 0 {
		p.MaxRedirects = defaultMaxRedirects
	}
	pinned, e := pinPolicy(*p)
	if e != nil {
		return Response{Error: "DNS policy unavailable: " + e.Error()}
	}
	id := random("nla-")
	name := "nla-" + id[4:16]
	hostAddr := sessionAddress(id)
	if e := startNamespace(name, id, hostAddr); e != nil {
		return Response{Error: "network boundary unavailable: " + e.Error()}
	}
	s := &session{policy: *p, hostAddr: hostAddr, ownerUID: uid, ownerGID: gid, pinned: pinned, info: SessionInfo{ID: id, Token: random("tok-"), Namespace: name, PolicyDigest: digest(*p), State: "READY", CreatedAt: time.Now().UTC()}}
	s.server = &http.Server{Handler: proxyHandler(s)}
	l, e := net.Listen("tcp", hostAddr+":0")
	if e != nil {
		cleanup(name)
		return Response{Error: "proxy listen failed"}
	}
	s.listener = l
	s.info.Proxy = l.Addr().String()
	port := l.Addr().(*net.TCPAddr).Port
	if e = allowHostPort(id, port); e != nil {
		_ = l.Close()
		cleanup(name)
		return Response{Error: "host ingress policy failed: " + e.Error()}
	}
	if e = allowNamespaceProxy(name, id, hostAddr, port); e != nil {
		_ = l.Close()
		denyHostPort(id)
		cleanup(name)
		return Response{Error: "namespace egress policy failed: " + e.Error()}
	}
	go s.server.Serve(l)
	sessionsMu.Lock()
	sessions[id] = s
	sessionsMu.Unlock()
	return Response{OK: true, Session: &s.info, Inventory: s.inventory()}
}
func status(id, t string, uid uint32) Response {
	s, ok := owned(id, t, uid)
	if !ok {
		return Response{Error: "session not found or not owned"}
	}
	return Response{OK: true, Session: &s.info, Inventory: s.inventory()}
}
func destroy(id, t string, uid uint32) Response {
	s, ok := owned(id, t, uid)
	if !ok {
		return Response{Error: "session not found or not owned"}
	}
	s.destroyMu.Lock()
	defer s.destroyMu.Unlock()
	s.mu.Lock()
	if s.info.State == "DESTROYING" {
		s.mu.Unlock()
		return Response{Error: "session cleanup already in progress"}
	}
	s.info.State = "DESTROYING"
	s.mu.Unlock()
	mcpPath := s.mcpPathValue()
	log.Printf("cleanup session=%s stage=destroy-start", id)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	shutdownErr := s.server.Shutdown(shutdownCtx)
	cancel()
	if shutdownErr != nil {
		log.Printf("cleanup session=%s stage=proxy-shutdown result=timeout", id)
		_ = s.server.Close()
	} else {
		log.Printf("cleanup session=%s stage=proxy-shutdown result=ok", id)
	}
	_ = s.listener.Close()
	var cleanupErrs []error
	if s.cgroupPath != "" {
		if err := killCgroup(s.cgroupPath); err != nil {
			cleanupErrs = append(cleanupErrs, fmt.Errorf("process boundary kill: %w", err))
		}
	}
	if err := stopMCP(s); err != nil {
		log.Printf("cleanup session=%s stage=browser-process result=error detail=%q", id, err.Error())
		cleanupErrs = append(cleanupErrs, err)
	} else {
		log.Printf("cleanup session=%s stage=browser-process result=stopped", id)
	}
	cgroupState := resourceBlocked
	if s.cgroupPath != "" {
		cgroupState = cleanupCgroup(s.cgroupPath)
		if cgroupState != resourceAbsent {
			cleanupErrs = append(cleanupErrs, errors.New("process boundary cleanup was not confirmed"))
		}
	}
	if shutdownErr != nil {
		cleanupErrs = append(cleanupErrs, fmt.Errorf("proxy shutdown: %w", shutdownErr))
	}
	policyState := resourceBlocked
	if err := denyHostPort(s.info.ID); err != nil {
		log.Printf("cleanup session=%s stage=nft result=error", id)
		cleanupErrs = append(cleanupErrs, err)
	} else {
		log.Printf("cleanup session=%s stage=nft result=ok", id)
		policyState = hostPolicyState(s.info.ID)
		if policyState != resourceAbsent {
			cleanupErrs = append(cleanupErrs, errors.New("host policy absence was not confirmed"))
		}
	}
	if err := cleanup(s.info.Namespace); err != nil {
		log.Printf("cleanup session=%s stage=namespace result=error detail=%q", id, err.Error())
		cleanupErrs = append(cleanupErrs, err)
	} else {
		log.Printf("cleanup session=%s stage=namespace result=ok", id)
	}
	after := s.inventory()
	proxyResourceState := resourceBlocked
	if shutdownErr == nil {
		proxyResourceState = resourceAbsent
	} else {
		proxyResourceState = proxyState(s.info.Proxy)
	}
	cleanupReport := &CleanupReport{SessionID: id, Inventory: *after, Remaining: after.Identities,
		MCPRemoved: string(socketState(mcpPath)), NamespaceRemoved: string(namespaceState(s.info.Namespace)),
		ProxyRemoved: string(proxyResourceState), PolicyRemoved: string(policyState), VethRemoved: string(linkState(vethName(s.info.Namespace))), CgroupState: string(cgroupState)}
	if after.Status == "ABSENT" && len(cleanupReport.Remaining) == 0 && cleanupReport.MCPRemoved == string(resourceAbsent) && cleanupReport.NamespaceRemoved == string(resourceAbsent) && cleanupReport.ProxyRemoved == string(resourceAbsent) && cleanupReport.PolicyRemoved == string(resourceAbsent) && cleanupReport.VethRemoved == string(resourceAbsent) && cleanupReport.CgroupState == string(resourceAbsent) {
		cleanupReport.Status = "OBSERVED_CLEAN"
	} else {
		cleanupReport.Status = "BLOCKED"
		cleanupErrs = append(cleanupErrs, errors.New("broker cleanup inventory is not clean"))
	}
	sessionsMu.Lock()
	delete(sessions, id)
	sessionsMu.Unlock()
	if len(cleanupErrs) > 0 {
		log.Printf("cleanup session=%s stage=destroy-result result=error detail=%q process=%s socket=%s namespace=%s proxy=%s policy=%s veth=%s cgroup=%s", id, errors.Join(cleanupErrs...).Error(), cleanupReport.Inventory.Status, cleanupReport.MCPRemoved, cleanupReport.NamespaceRemoved, cleanupReport.ProxyRemoved, cleanupReport.PolicyRemoved, cleanupReport.VethRemoved, cleanupReport.CgroupState)
		return Response{Error: errors.Join(cleanupErrs...).Error(), Cleanup: cleanupReport}
	}
	log.Printf("cleanup session=%s stage=destroy-result result=ok", id)
	return Response{OK: true, Cleanup: cleanupReport}
}
func launch(id, t string, uid uint32) Response {
	s, ok := owned(id, t, uid)
	if !ok {
		return Response{Error: "session not found or not owned"}
	}
	s.mu.Lock()
	response := func() Response {
		if s.info.State != "READY" {
			return Response{Error: "session is not ready"}
		}
		if s.mcp != nil {
			return Response{OK: true, Endpoint: s.mcp.path}
		}
		command, err := approvedMCPCommand()
		if err != nil {
			return Response{Error: err.Error()}
		}
		foundProxyPlaceholder := false
		for i, arg := range command {
			if strings.Contains(arg, "__NLA_SESSION_PROXY__") {
				foundProxyPlaceholder = true
				command[i] = strings.ReplaceAll(arg, "__NLA_SESSION_PROXY__", "http://"+s.info.Proxy)
			}
		}
		if !foundProxyPlaceholder {
			return Response{Error: "browser MCP command lacks session proxy placeholder"}
		}
		// Keep the broker-to-owner endpoint in the fixed shared temp directory;
		// never inherit a privileged broker's TMPDIR from an operator environment.
		mcpDir := os.Getenv("NLA_BROKER_MCP_DIR")
		if mcpDir == "" {
			mcpDir = "/tmp"
		}
		path := filepath.Join(mcpDir, "nla-mcp-"+s.info.ID+".sock")
		_ = os.Remove(path)
		ln, err := net.Listen("unix", path)
		if err != nil {
			return Response{Error: "MCP endpoint unavailable"}
		}
		if err := os.Chmod(path, 0660); err != nil {
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP endpoint permissions unavailable"}
		}
		if err := os.Chown(path, int(s.ownerUID), -1); err != nil {
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP endpoint ownership unavailable"}
		}
		// Entering a named netns requires privilege.  Drop it before the approved
		// browser command, never in the caller and never after the browser starts.
		setpriv := []string{"netns", "exec", s.info.Namespace, "/usr/bin/setpriv", "--reuid", strconv.FormatUint(uint64(s.ownerUID), 10), "--regid", strconv.FormatUint(uint64(s.ownerGID), 10), "--clear-groups", "--no-new-privs", "--"}
		cmd := exec.Command("ip", append(setpriv, command...)...)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=/home/next", "TMPDIR=/tmp", "LANG=C", "USER=next", "LOGNAME=next"}
		cmd.Stderr = &boundedWriter{w: os.Stderr, max: 16 * 1024}
		stdin, err := cmd.StdinPipe()
		if err != nil {
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP stdin unavailable"}
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP stdout unavailable"}
		}
		cgroupPath, err := createCgroup(s.info.ID)
		if err != nil {
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP process boundary unavailable"}
		}
		cgroupDir, err := os.Open(cgroupPath)
		if err != nil {
			_ = cleanupCgroup(cgroupPath)
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP process boundary handle unavailable"}
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, UseCgroupFD: true, CgroupFD: int(cgroupDir.Fd())}
		if err := cmd.Start(); err != nil {
			_ = cgroupDir.Close()
			_ = cleanupCgroup(cgroupPath)
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP process unavailable"}
		}
		_ = cgroupDir.Close()
		if cgroupBoundaryState(cgroupPath) != resourcePresent {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_, _ = cmd.Process.Wait()
			_ = cleanupCgroup(cgroupPath)
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP process boundary verification unavailable"}
		}
		leader, ok := readProcessIdentity(cmd.Process.Pid)
		if !ok {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_, _ = cmd.Process.Wait()
			_ = cleanupCgroup(cgroupPath)
			_ = ln.Close()
			_ = os.Remove(path)
			return Response{Error: "MCP process inventory unavailable"}
		}
		m := &managedMCP{cmd: cmd, listener: ln, path: path}
		s.mcp = m
		s.mcpPath = path
		s.cgroupPath = cgroupPath
		s.mcpPGID = cmd.Process.Pid
		s.mcpStart = leader.Start
		go bridgeMCP(m, stdin, stdout)
		return Response{OK: true, Endpoint: path}
	}()
	s.mu.Unlock()
	if response.OK {
		response.Inventory = s.inventory()
	}
	return response
}
func approvedMCPCommand() ([]string, error) {
	raw := os.Getenv("NLA_BROWSER_MCP_COMMAND_JSON")
	if raw == "" {
		return nil, errors.New("browser MCP command is not configured")
	}
	var command []string
	if json.Unmarshal([]byte(raw), &command) != nil || len(command) == 0 || command[0] == "" || command[0][0] != '/' {
		return nil, errors.New("browser MCP command is invalid")
	}
	for _, arg := range command {
		if arg == "sh" || arg == "bash" || arg == "sudo" || arg == "nft" || arg == "unshare" {
			return nil, errors.New("browser MCP command is not approved")
		}
	}
	return command, nil
}
func bridgeMCP(m *managedMCP, stdin io.WriteCloser, stdout io.ReadCloser) {
	c, err := m.listener.Accept()
	if err != nil {
		stopManagedMCP(m, stdin, stdout)
		return
	}
	go func() { _, _ = io.Copy(stdin, c); _ = stdin.Close() }()
	_, _ = io.Copy(c, stdout)
	_ = c.Close()
	stopManagedMCP(m, stdin, stdout)
}

func (s *session) mcpPathValue() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mcpPath
}

func (s *session) inventory() *ProcessInventory {
	s.mu.Lock()
	m := s.mcp
	mcpPath := s.mcpPath
	mcpPGID := s.mcpPGID
	mcpStart := s.mcpStart
	mcpStopped := s.mcpStopped
	cgroupPath := s.cgroupPath
	owned := append([]ProcessIdentity(nil), s.owned...)
	s.mu.Unlock()
	report := &ProcessInventory{Status: "OBSERVED", Source: "broker-owned-session", SessionID: s.info.ID, OwnerUID: s.ownerUID, Identities: []ProcessIdentity{}}
	if cgroupPath != "" {
		report.BoundaryState = string(cgroupBoundaryState(cgroupPath))
	}
	if m == nil {
		if mcpPath == "" {
			report.Status = "NOT_RUN"
			report.Reason = "BROKER_PROCESS_NOT_LAUNCHED"
			return report
		}
		groupIdentities, present, inspectable := processGroupInventoryState(mcpPGID)
		remaining, ownedInspectable := stableOwnedState(owned)
		report.Source = "broker-owned-process-group"
		report.ProcessGroupID = mcpPGID
		report.ProcessStart = mcpStart
		report.Identities = mergeIdentities(groupIdentities, remaining)
		if !inspectable || !ownedInspectable {
			report.Status = "BLOCKED"
			report.Reason = "BROKER_PROCESS_INVENTORY_UNAVAILABLE"
			return report
		}
		if cgroupPath != "" && report.BoundaryState != string(resourceAbsent) {
			report.Status = "BLOCKED"
			report.Reason = "BROKER_PROCESS_BOUNDARY_NOT_EMPTY"
			return report
		}
		if present || len(remaining) > 0 || !mcpStopped {
			report.Status = "BLOCKED"
			report.Reason = "BROKER_PROCESS_GROUP_REMAINS"
			if !present && len(remaining) == 0 && !mcpStopped {
				report.Reason = "BROKER_PROCESS_TEARDOWN_UNCONFIRMED"
			}
			return report
		}
		if len(owned) == 0 {
			report.Status = "BLOCKED"
			report.Reason = "BROKER_PROCESS_OWNERSHIP_UNAVAILABLE"
			return report
		}
		report.Status = "ABSENT"
		report.Reason = "PROCESS_GROUP_TERMINATED"
		return report
	}
	if m.cmd == nil || m.cmd.Process == nil {
		report.Status = "BLOCKED"
		report.Reason = "BROKER_PROCESS_INVENTORY_UNAVAILABLE"
		return report
	}
	if cgroupPath == "" || report.BoundaryState != string(resourcePresent) {
		report.Status = "BLOCKED"
		report.Reason = "BROKER_PROCESS_BOUNDARY_UNAVAILABLE"
		return report
	}
	report.ProcessGroupID = m.cmd.Process.Pid
	treeIdentities, treeInspectable := processTreeInventory(m.cmd.Process.Pid)
	groupIdentities, groupPresent, groupInspectable := processGroupInventoryState(m.cmd.Process.Pid)
	if !treeInspectable || !groupInspectable || !groupPresent {
		report.Status = "BLOCKED"
		report.Reason = "BROKER_PROCESS_INVENTORY_UNAVAILABLE"
		return report
	}
	report.Source = "broker-owned-process-group"
	identities := mergeIdentities(treeIdentities, groupIdentities)
	if len(identities) == 0 {
		report.Status = "BLOCKED"
		report.Reason = "BROKER_PROCESS_INVENTORY_UNAVAILABLE"
		return report
	}
	s.mu.Lock()
	s.owned = mergeIdentities(s.owned, identities)
	owned = append([]ProcessIdentity(nil), s.owned...)
	s.mu.Unlock()
	report.Identities = owned
	for _, identity := range identities {
		if identity.PID == report.ProcessGroupID {
			report.ProcessStart = identity.Start
			break
		}
	}
	return report
}

func mergeIdentities(groups ...[]ProcessIdentity) []ProcessIdentity {
	seen := make(map[string]bool)
	result := make([]ProcessIdentity, 0)
	for _, group := range groups {
		for _, identity := range group {
			key := fmt.Sprintf("%d:%s", identity.PID, identity.Start)
			if !seen[key] {
				seen[key] = true
				result = append(result, identity)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].PID < result[j].PID })
	return result
}

func processTreeInventory(rootPID int) ([]ProcessIdentity, bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, false
	}
	all := make(map[int]ProcessIdentity, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 1 {
			continue
		}
		identity, ok := readProcessIdentity(pid)
		if ok {
			all[pid] = identity
		}
	}
	if _, ok := all[rootPID]; !ok {
		return nil, false
	}
	owned := map[int]bool{rootPID: true}
	changed := true
	for changed {
		changed = false
		for pid, identity := range all {
			if !owned[pid] && owned[identity.ParentPID] {
				owned[pid] = true
				changed = true
			}
		}
	}
	result := make([]ProcessIdentity, 0, len(owned))
	for pid := range owned {
		result = append(result, all[pid])
	}
	sort.Slice(result, func(i, j int) bool { return result[i].PID < result[j].PID })
	return result, true
}

func stableOwnedState(owned []ProcessIdentity) ([]ProcessIdentity, bool) {
	return stableOwnedStateWith(owned, func(identity ProcessIdentity) (ProcessIdentity, error) {
		return readProcessIdentityDetailed(identity.PID)
	})
}

func stableOwnedStateWith(owned []ProcessIdentity, read func(ProcessIdentity) (ProcessIdentity, error)) ([]ProcessIdentity, bool) {
	if len(owned) == 0 {
		return nil, true
	}
	remaining := make([]ProcessIdentity, 0)
	for _, expected := range owned {
		current, err := read(expected)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || current.Start != expected.Start {
			if err == nil && current.Start != expected.Start {
				continue
			}
			return nil, false
		}
		remaining = append(remaining, current)
	}
	return remaining, true
}

// The broker owns a delegated child hierarchy under its systemd service cgroup.
// NLA and Browser never receive cgroup management privileges.
const cgroupRoot = "/sys/fs/cgroup/system.slice/nla-browser-network-broker.service/nla-browser"

func createCgroup(sessionID string) (string, error) {
	if os.Geteuid() != 0 {
		return "", errors.New("privileged process boundary required")
	}
	if sessionID == "" || strings.ContainsAny(sessionID, `/\\`) {
		return "", errors.New("invalid process boundary session")
	}
	if err := os.MkdirAll(cgroupRoot, 0750); err != nil {
		return "", err
	}
	path := filepath.Join(cgroupRoot, "session-"+sessionID)
	if err := os.Mkdir(path, 0750); err != nil {
		return "", err
	}
	for _, file := range []string{"cgroup.procs", "cgroup.kill", "cgroup.events"} {
		if _, err := os.Stat(filepath.Join(path, file)); err != nil {
			_ = os.Remove(path)
			return "", err
		}
	}
	if _, err := os.Stat(filepath.Join(cgroupRoot, "cgroup.controllers")); err != nil {
		_ = os.Remove(path)
		return "", errors.New("cgroup v2 controller boundary unavailable")
	}
	return path, nil
}

func attachCgroup(path string, pid int) error {
	if path == "" || pid <= 1 {
		return errors.New("invalid process boundary")
	}
	return os.WriteFile(filepath.Join(path, "cgroup.procs"), []byte(strconv.Itoa(pid)+"\n"), 0600)
}

func cgroupBoundaryState(path string) resourceState {
	if path == "" {
		return resourceBlocked
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return resourceAbsent
		}
		return resourceBlocked
	}
	events, err := os.ReadFile(filepath.Join(path, "cgroup.events"))
	if err != nil {
		return resourceBlocked
	}
	procs, err := os.ReadFile(filepath.Join(path, "cgroup.procs"))
	if err != nil {
		return resourceBlocked
	}
	populated := ""
	for _, line := range strings.Split(string(events), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "populated" {
			populated = fields[1]
		}
	}
	if populated != "0" && populated != "1" {
		return resourceBlocked
	}
	if populated == "1" || len(strings.TrimSpace(string(procs))) > 0 {
		return resourcePresent
	}
	return resourceAbsent
}

func stopForBoundary(pid int) error {
	if pid <= 1 || syscall.Kill(pid, syscall.SIGSTOP) != nil {
		return errors.New("process stop failed")
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		identity, ok := readProcessIdentity(pid)
		if ok && (identity.State == "T" || identity.State == "t") {
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return errors.New("process did not stop")
}

func cleanupCgroup(path string) resourceState {
	if path == "" {
		return resourceBlocked
	}
	if err := killCgroup(path); err != nil {
		return resourceBlocked
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		state := cgroupBoundaryState(path)
		if state == resourceBlocked {
			return resourceBlocked
		}
		if state == resourceAbsent {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return resourceBlocked
			}
			if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
				return resourceAbsent
			}
			return resourceBlocked
		}
		time.Sleep(10 * time.Millisecond)
	}
	return resourceBlocked
}

func killCgroup(path string) error {
	if path == "" {
		return errors.New("invalid process boundary")
	}
	return os.WriteFile(filepath.Join(path, "cgroup.kill"), []byte("1\n"), 0600)
}

func processGroupInventory(pgid int) ([]ProcessIdentity, bool) {
	identities, exists, inspectable := processGroupInventoryState(pgid)
	return identities, exists && inspectable
}

func processGroupInventoryState(pgid int) ([]ProcessIdentity, bool, bool) {
	if pgid <= 1 {
		return nil, false, false
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, false, false
	}
	pids := make([]int, 0, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 1 {
			continue
		}
		pids = append(pids, pid)
	}
	return processGroupInventoryStateFromPIDs(pgid, pids, readProcessIdentity, probeProcessGroup)
}

func processGroupInventoryStateFromPIDs(pgid int, pids []int, read func(int) (ProcessIdentity, bool), probe func(int) error) ([]ProcessIdentity, bool, bool) {
	identities := make([]ProcessIdentity, 0, 4)
	for _, pid := range pids {
		identity, ok := read(pid)
		if ok && identity.PGID == pgid {
			identities = append(identities, identity)
		}
	}
	switch err := probe(pgid); {
	case err == nil || errors.Is(err, syscall.EPERM):
		return identities, true, true
	case errors.Is(err, syscall.ESRCH):
		return identities, false, true
	default:
		return identities, false, false
	}
}

func probeProcessGroup(pgid int) error {
	return syscall.Kill(-pgid, 0)
}

func readProcessIdentity(pid int) (ProcessIdentity, bool) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return ProcessIdentity{}, false
	}
	return parseProcessIdentity(pid, data)
}

func readProcessIdentityDetailed(pid int) (ProcessIdentity, error) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return ProcessIdentity{}, err
	}
	identity, ok := parseProcessIdentity(pid, data)
	if !ok {
		return ProcessIdentity{}, errors.New("malformed process identity")
	}
	return identity, nil
}

func parseProcessIdentity(pid int, data []byte) (ProcessIdentity, bool) {
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return ProcessIdentity{}, false
	}
	fields := strings.Fields(string(data[end+2:]))
	if len(fields) < 22 {
		return ProcessIdentity{}, false
	}
	ppid, err1 := strconv.Atoi(fields[1])
	pgid, err2 := strconv.Atoi(fields[2])
	rss, err3 := strconv.ParseUint(fields[21], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return ProcessIdentity{}, false
	}
	return ProcessIdentity{PID: pid, ParentPID: ppid, PGID: pgid, Start: fields[19], State: fields[0], RSSKB: rss * 4}, true
}

func socketState(path string) resourceState {
	if path == "" {
		return resourceBlocked
	}
	info, err := os.Stat(path)
	if err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return resourcePresent
		}
		return resourcePresent
	}
	return classifySocketError(err)
}

func classifySocketError(err error) resourceState {
	if errors.Is(err, os.ErrNotExist) {
		return resourceAbsent
	}
	return resourceBlocked
}

func proxyState(address string) resourceState {
	if address == "" {
		return resourceBlocked
	}
	connection, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
	if err == nil {
		_ = connection.Close()
		return resourcePresent
	}
	return classifyProxyError(err)
}

func classifyProxyError(err error) resourceState {
	if errors.Is(err, syscall.ECONNREFUSED) {
		return resourceAbsent
	}
	return resourceBlocked
}

func stopMCP(s *session) error {
	s.mu.Lock()
	m := s.mcp
	s.mcp = nil
	s.mu.Unlock()
	if m != nil {
		err := stopManagedMCP(m, nil, nil)
		if err == nil {
			s.mu.Lock()
			s.mcpStopped = true
			s.mu.Unlock()
		}
		return err
	}
	return nil
}
func stopManagedMCP(m *managedMCP, stdin io.WriteCloser, stdout io.ReadCloser) error {
	m.stopInitOnce.Do(func() { m.stopDone = make(chan struct{}) })
	m.stopOnce.Do(func() {
		m.stopErr = stopManagedMCPOnce(m, stdin, stdout)
		close(m.stopDone)
	})
	<-m.stopDone
	return m.stopErr
}
func stopManagedMCPOnce(m *managedMCP, stdin io.WriteCloser, stdout io.ReadCloser) error {
	if stdin != nil {
		_ = stdin.Close()
	}
	if stdout != nil {
		_ = stdout.Close()
	}
	_ = m.listener.Close()
	var killErr error
	if m.cmd.Process != nil {
		killErr = syscall.Kill(-m.cmd.Process.Pid, syscall.SIGKILL)
	}
	wait := make(chan error, 1)
	go func() { wait <- m.cmd.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			// The broker owns teardown of this process. Once Wait has
			// completed, the process is gone; its exit status (including a
			// non-zero status after stdin/socket shutdown) is not itself a
			// resource-cleanup failure. Namespace, nft, and veth cleanup are
			// checked separately by destroy/cleanup.
			if _, ok := err.(*exec.ExitError); !ok {
				return fmt.Errorf("browser process: %w", err)
			}
		}
	case <-time.After(2 * time.Second):
		return errors.New("browser process cleanup timed out")
	}
	if killErr != nil && errors.Is(killErr, syscall.EPERM) && !processGroupExists(m.cmd.Process.Pid) {
		// Chromium may place descendants in a user namespace.  The group kill
		// can then report EPERM even though the backend has already terminated
		// every member.  Treat that case as successful only after independently
		// proving that no member of the owned process group remains.
		killErr = nil
	}
	if killErr != nil && !errors.Is(killErr, syscall.ESRCH) {
		return fmt.Errorf("browser process termination: %w", killErr)
	}
	if err := os.Remove(m.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("browser MCP socket cleanup: %w", err)
	}
	return nil
}

func processGroupExists(pgid int) bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true
	}
	for _, entry := range entries {
		if len(entry.Name()) == 0 || entry.Name()[0] < '0' || entry.Name()[0] > '9' {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		end := bytes.LastIndexByte(data, ')')
		if end < 0 {
			continue
		}
		fields := strings.Fields(string(data[end+2:]))
		if len(fields) > 2 {
			group, err := strconv.Atoi(fields[2])
			if err == nil && group == pgid {
				return true
			}
		}
	}
	return false
}
func owned(id, t string, uid uint32) (*session, bool) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	s, ok := sessions[id]
	return s, ok && t != "" && t == s.info.Token && uid == s.ownerUID
}

func peerCred(c net.Conn) (uint32, uint32, bool) {
	u, ok := c.(*net.UnixConn)
	if !ok {
		return 0, 0, false
	}
	var cred *syscall.Ucred
	var err error
	raw, err := u.SyscallConn()
	if err != nil {
		return 0, 0, false
	}
	_ = raw.Control(func(fd uintptr) {
		cred, err = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil || cred == nil {
		return 0, 0, false
	}
	return cred.Uid, cred.Gid, true
}
func validate(p *Policy) error {
	if len(p.Allowed) == 0 || len(p.Allowed) > 128 {
		return errors.New("allowed_origins must contain 1..128 entries")
	}
	if p.MaxRedirects < 0 || p.MaxRedirects > 20 {
		return errors.New("max_redirects must be 0..20")
	}
	for _, o := range p.Allowed {
		if o.Scheme != "http" && o.Scheme != "https" {
			return errors.New("only http/https origins are accepted")
		}
		if o.Host == "" || !validHost.MatchString(o.Host) {
			return errors.New("invalid policy host")
		}
		if strings.Contains(o.Host, ":") {
			return errors.New("IPv6 and malformed host authorities are unsupported in N1")
		}
		if ip := net.ParseIP(o.Host); ip != nil && ip.To4() == nil {
			return errors.New("IPv6 is fail-closed and unsupported in N1")
		}
		if len(o.Ports) == 0 || len(o.Ports) > 16 {
			return errors.New("explicit ports required")
		}
		for _, port := range o.Ports {
			if port < 1 || port > 65535 {
				return errors.New("invalid policy port")
			}
		}
	}
	return nil
}
func digest(p Policy) string {
	b, _ := json.Marshal(p)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func random(pre string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return pre + hex.EncodeToString(b)
}
func pinPolicy(p Policy) (map[string]map[string]struct{}, error) {
	pinned := make(map[string]map[string]struct{})
	for _, origin := range p.Allowed {
		host := strings.ToLower(strings.TrimSuffix(origin.Host, "."))
		ips, err := lookupIP(host)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", host, err)
		}
		set := make(map[string]struct{})
		for _, ip := range ips {
			if ip.To4() == nil {
				continue
			}
			if !p.AllowPrivate && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
				continue
			}
			set[ip.To4().String()] = struct{}{}
		}
		if len(set) == 0 {
			return nil, fmt.Errorf("no approved IPv4 address for %s", host)
		}
		pinned[host] = set
	}
	return pinned, nil
}
func allowed(p Policy, raw string, connect bool) bool {
	u, e := url.Parse(raw)
	if e != nil || u.Hostname() == "" {
		return false
	}
	h := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	sc := strings.ToLower(u.Scheme)
	if connect && sc == "" {
		sc = "https"
	}
	port := 0
	if u.Port() != "" {
		port, _ = strconv.Atoi(u.Port())
	} else if sc == "https" || sc == "wss" {
		port = 443
	} else {
		port = 80
	}
	for _, o := range p.Allowed {
		if strings.EqualFold(o.Scheme, sc) && strings.EqualFold(o.Host, h) {
			for _, x := range o.Ports {
				if x == port {
					return true
				}
			}
		}
	}
	return false
}
func proxyHandler(s *session) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			connect(w, r, s)
			return
		}
		if !r.URL.IsAbs() || !allowed(s.policy, r.URL.String(), false) {
			http.Error(w, "POLICY_DENIED", 403)
			return
		}
		tr := &http.Transport{
			DisableKeepAlives: true,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				return dialPolicy(ctx, network, address, s.policy, s.pinned)
			},
		}
		q := r.Clone(r.Context())
		q.RequestURI = ""
		resp, e := tr.RoundTrip(q)
		if e != nil {
			http.Error(w, "upstream unavailable", 502)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 && resp.StatusCode < 400 && resp.Header.Get("Location") != "" {
			s.mu.Lock()
			s.redirects++
			tooMany := s.redirects > s.policy.MaxRedirects
			s.mu.Unlock()
			if tooMany {
				http.Error(w, "REDIRECT_LIMIT", http.StatusLoopDetected)
				return
			}
		} else {
			s.mu.Lock()
			s.redirects = 0
			s.mu.Unlock()
		}
		for k, v := range resp.Header {
			for _, x := range v {
				w.Header().Add(k, x)
			}
		}
		w.Header().Set("Connection", "close")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	})
}
func connect(w http.ResponseWriter, r *http.Request, s *session) {
	allowedHTTPS := allowed(s.policy, "https://"+r.Host, true)
	allowedWebSocket := s.policy.AllowWebSocket && allowed(s.policy, "http://"+r.Host, false)
	if !allowedHTTPS && !allowedWebSocket {
		http.Error(w, "POLICY_DENIED", 403)
		return
	}
	up, e := dialPolicy(context.Background(), "tcp", r.Host, s.policy, s.pinned)
	if e != nil {
		http.Error(w, "upstream unavailable", 502)
		return
	}
	h, ok := w.(http.Hijacker)
	if !ok {
		_ = up.Close()
		http.Error(w, "hijack unavailable", 500)
		return
	}
	cl, rw, e := h.Hijack()
	if e != nil {
		_ = up.Close()
		return
	}
	_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	_ = rw.Flush()
	go func() { _, _ = io.Copy(up, cl); _ = up.Close() }()
	go func() { _, _ = io.Copy(cl, up); _ = cl.Close() }()
}
func dialPolicy(ctx context.Context, network, address string, p Policy, pinned map[string]map[string]struct{}) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("invalid upstream authority")
	}
	ips, err := lookupIP(host)
	if err != nil {
		return nil, errors.New("DNS resolution failed")
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	for _, ip := range ips {
		if ip.To4() == nil {
			continue
		}
		if _, ok := pinned[strings.ToLower(strings.TrimSuffix(host, "."))][ip.To4().String()]; !ok {
			continue
		}
		if !p.AllowPrivate && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
			continue
		}
		conn, e := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if e == nil {
			return conn, nil
		}
	}
	return nil, errors.New("no policy-approved address")
}
func sessionAddress(id string) string {
	v, _ := strconv.ParseUint(id[4:6], 16, 8)
	return fmt.Sprintf("10.200.%d.1", 10+v%240)
}

func startNamespace(name, id, hostAddr string) error {
	if e := run("ip", "netns", "add", name); e != nil {
		return e
	}
	hi := "nlah-" + id[4:12]
	ni := "nlan-" + id[4:12]
	bad := func() { cleanup(name); _ = run("ip", "link", "del", hi) }
	nsAddr := strings.TrimSuffix(hostAddr, ".1") + ".2/24"
	cmds := [][]string{{"ip", "link", "add", hi, "type", "veth", "peer", "name", ni}, {"ip", "link", "set", ni, "netns", name}, {"ip", "addr", "add", hostAddr + "/24", "dev", hi}, {"ip", "link", "set", hi, "up"}, {"ip", "netns", "exec", name, "ip", "addr", "add", nsAddr, "dev", ni}, {"ip", "netns", "exec", name, "ip", "link", "set", "lo", "up"}, {"ip", "netns", "exec", name, "ip", "link", "set", ni, "up"}, {"ip", "netns", "exec", name, "ip", "route", "add", "default", "via", hostAddr}}
	for _, a := range cmds {
		if e := run(a[0], a[1:]...); e != nil {
			bad()
			return e
		}
	}
	rules := fmt.Sprintf("table inet nla_%s {\n chain output {\n  type filter hook output priority 0; policy drop;\n  oifname \"lo\" accept\n  ct state established,related accept\n }\n}\n", id[4:12])
	if e := input("ip", []string{"netns", "exec", name, "nft", "-f", "-"}, rules); e != nil {
		bad()
		return e
	}
	return nil
}
func cleanup(n string) error {
	var errs []error
	if err := run("ip", "netns", "delete", n); err != nil && namespaceExists(n) {
		errs = append(errs, fmt.Errorf("namespace %s: %w", n, err))
	}
	suffix := strings.TrimPrefix(n, "nla-")
	if len(suffix) >= 8 {
		iface := vethName(n)
		if err := run("ip", "link", "del", iface); err != nil {
			state := linkState(iface)
			if state != resourceAbsent {
				errs = append(errs, fmt.Errorf("veth %s cleanup not confirmed: %s", iface, state))
			}
		}
		if state := linkState(iface); state != resourceAbsent {
			errs = append(errs, fmt.Errorf("veth %s cleanup not confirmed: %s", iface, state))
		}
	}
	if namespaceExists(n) {
		errs = append(errs, fmt.Errorf("namespace %s still exists after cleanup", n))
	}
	return errors.Join(errs...)
}
func hostTable(id string) string { return "nla_host_" + id[4:12] }
func allowNamespaceProxy(name, id, hostAddr string, port int) error {
	table := "nla_" + id[4:12]
	return run("ip", "netns", "exec", name, "nft", "add", "rule", "inet", table,
		"output", "ip", "daddr", hostAddr, "tcp", "dport", strconv.Itoa(port), "accept")
}
func allowHostPort(id string, port int) error {
	iface := "nlah-" + id[4:12]
	return run("nft", "insert", "rule", "ip", "filter", "INPUT",
		"iifname", iface, "tcp", "dport", strconv.Itoa(port), "accept",
		"comment", "nla-"+id[4:12])
}
func denyHostPort(id string) error {
	marker := "nla-" + id[4:12]
	out, err := exec.Command("nft", "-a", "list", "chain", "ip", "filter", "INPUT").Output()
	if err != nil {
		return fmt.Errorf("list host policy for %s: %w", id, err)
	}
	var errs []error
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, marker) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[len(fields)-2] == "handle" {
			if err := run("nft", "delete", "rule", "ip", "filter", "INPUT", "handle", fields[len(fields)-1]); err != nil {
				errs = append(errs, fmt.Errorf("delete host policy %s: %w", id, err))
			}
		}
	}
	return errors.Join(errs...)
}

func hostPolicyState(id string) resourceState {
	out, err := exec.Command("nft", "-a", "list", "chain", "ip", "filter", "INPUT").Output()
	if err != nil {
		return resourceBlocked
	}
	marker := "nla-" + id[4:12]
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, marker) {
			return resourcePresent
		}
	}
	return resourceAbsent
}

func namespaceExists(name string) bool {
	return namespaceState(name) == resourcePresent
}

func namespaceState(name string) resourceState {
	if name == "" {
		return resourceBlocked
	}
	out, err := exec.Command("ip", "netns", "list").Output()
	if err != nil {
		return resourceBlocked
	}
	for _, line := range strings.Split(string(out), "\n") {
		if fields := strings.Fields(line); len(fields) > 0 && fields[0] == name {
			return resourcePresent
		}
	}
	return resourceAbsent
}

func vethName(name string) string {
	suffix := strings.TrimPrefix(name, "nla-")
	if len(suffix) < 8 {
		return ""
	}
	return "nlah-" + suffix[:8]
}

func linkState(name string) resourceState {
	if name == "" {
		return resourceBlocked
	}
	out, err := exec.Command("ip", "-br", "link", "show", "dev", name).CombinedOutput()
	return classifyLinkProbe(err, string(out))
}

func classifyLinkProbe(err error, output string) resourceState {
	if err == nil {
		if strings.TrimSpace(output) == "" {
			return resourceAbsent
		}
		return resourcePresent
	}
	message := strings.ToLower(output)
	if strings.Contains(message, "does not exist") || strings.Contains(message, "cannot find device") {
		return resourceAbsent
	}
	return resourceBlocked
}
func run(bin string, a ...string) error {
	c := exec.Command(bin, a...)
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", strings.Join(append([]string{bin}, a...), " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
func input(bin string, a []string, s string) error {
	c := exec.Command(bin, a...)
	c.Stdin = strings.NewReader(s)
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", strings.Join(append([]string{bin}, a...), " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
