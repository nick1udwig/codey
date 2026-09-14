package main

import (
	"path/filepath"
	"testing"
)

func TestDefaultPathsPutLogsInUserHome(t *testing.T) {
	home := t.TempDir()
	cache := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", cache)

	got, err := defaultPaths()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".codey", "server.log"); got.log != want {
		t.Fatalf("log path = %q, want %q", got.log, want)
	}
	if want := filepath.Join(home, ".codey", "sessions.json"); got.state != want {
		t.Fatalf("state path = %q, want %q", got.state, want)
	}
	if want := filepath.Join(home, ".codey", "workspace"); got.workspace != want {
		t.Fatalf("workspace path = %q, want %q", got.workspace, want)
	}
}

func TestEnvironmentAcceptsLegacyNamesAndPrefersCodey(t *testing.T) {
	t.Setenv("PEBBLE_AGENT_TOKEN", "legacy-token")
	t.Setenv("CODEY_TOKEN", "new-token")
	if got := environment("CODEY_TOKEN", ""); got != "new-token" {
		t.Fatalf("token = %q", got)
	}
	t.Setenv("CODEY_TOKEN", "")
	if got := environment("CODEY_TOKEN", "fallback"); got != "" {
		t.Fatalf("explicit empty token = %q", got)
	}
	t.Setenv("PEBBLE_AGENT_TEST_OPTION", "legacy-option")
	if got := environment("CODEY_TEST_OPTION", "fallback"); got != "legacy-option" {
		t.Fatalf("legacy option = %q", got)
	}
	if got := environment("CODEY_MISSING_TEST_OPTION", "fallback"); got != "fallback" {
		t.Fatalf("default = %q", got)
	}
}
