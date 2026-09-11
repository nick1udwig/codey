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
	if want := filepath.Join(home, ".pebble-agent", "server.log"); got.log != want {
		t.Fatalf("log path = %q, want %q", got.log, want)
	}
	if want := filepath.Join(cache, "pebble-agent", "sessions.json"); got.state != want {
		t.Fatalf("state path = %q, want %q", got.state, want)
	}
	if want := filepath.Join(cache, "pebble-agent", "workspace"); got.workspace != want {
		t.Fatalf("workspace path = %q, want %q", got.workspace, want)
	}
}
