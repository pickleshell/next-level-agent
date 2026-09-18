package main

import (
	"context"
	"net"
	"testing"
)

func TestValidateRequiresExplicitHTTPOriginAndPort(t *testing.T) {
	if err := validate(&Policy{}); err == nil {
		t.Fatal("empty policy accepted")
	}
	if err := validate(&Policy{Allowed: []Origin{{Scheme: "ws", Host: "127.0.0.1", Ports: []int{80}}}}); err == nil {
		t.Fatal("unsupported scheme accepted")
	}
	if err := validate(&Policy{Allowed: []Origin{{Scheme: "http", Host: "127.0.0.1", Ports: []int{0}}}}); err == nil {
		t.Fatal("invalid port accepted")
	}
	if err := validate(&Policy{Allowed: []Origin{{Scheme: "http", Host: "::1", Ports: []int{80}}}}); err == nil {
		t.Fatal("IPv6 policy was not fail-closed")
	}
}

func TestAllowedIsExactSchemeHostAndPort(t *testing.T) {
	p := Policy{Allowed: []Origin{{Scheme: "http", Host: "127.0.0.1", Ports: []int{18080}}}}
	for _, tc := range []struct {
		url string
		ok  bool
	}{
		{"http://127.0.0.1:18080/ok", true},
		{"http://127.0.0.1:18081/forbidden", false},
		{"https://127.0.0.1:18080/ok", false},
		{"http://localhost:18080/ok", false},
		{"http://127.0.0.2:18080/alias", false},
	} {
		if got := allowed(p, tc.url, false); got != tc.ok {
			t.Fatalf("allowed(%q)=%v, want %v", tc.url, got, tc.ok)
		}
	}
}

func TestDNSRebindingDoesNotReachNewAddress(t *testing.T) {
	original := lookupIP
	defer func() { lookupIP = original }()
	calls := 0
	lookupIP = func(string) ([]net.IP, error) {
		calls++
		if calls == 1 {
			return []net.IP{net.ParseIP("127.0.0.1")}, nil
		}
		return []net.IP{net.ParseIP("127.0.0.2")}, nil
	}
	p := Policy{
		Allowed:      []Origin{{Scheme: "http", Host: "rebind.test", Ports: []int{18080}}},
		AllowPrivate: true,
	}
	pinned, err := pinPolicy(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dialPolicy(context.Background(), "tcp", "rebind.test:18080", p, pinned); err == nil {
		t.Fatal("DNS rebinding was accepted")
	}
	if calls != 2 {
		t.Fatalf("lookup calls=%d, want 2", calls)
	}
}
