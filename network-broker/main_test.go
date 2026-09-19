package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestStopManagedMCPTreatsExpectedSignalAsSuccessfulCleanup(t *testing.T) {
	testManagedMCPStop(t, "sleep", "30")
}

func TestStopManagedMCPTreatsExitedProcessAsSuccessfulCleanup(t *testing.T) {
	testManagedMCPStop(t, "sh", "-c", "exit 1")
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
