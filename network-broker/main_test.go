package main

import (
	"net"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

func TestStopManagedMCPTreatsExpectedSignalAsSuccessfulCleanup(t *testing.T) {
	testManagedMCPStop(t, "sleep", "30")
}

func TestStopManagedMCPTreatsExitedProcessAsSuccessfulCleanup(t *testing.T) {
	testManagedMCPStop(t, "sh", "-c", "exit 1")
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
