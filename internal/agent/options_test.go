package agent

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/nick1udwig/pebble-agent/internal/appserver"
	"github.com/nick1udwig/pebble-agent/internal/pam"
	"github.com/nick1udwig/pebble-agent/internal/state"
)

func TestSettingsApplyToThreadsAndTurnsWithoutPermissionCarryover(t *testing.T) {
	server := &scriptedServer{}
	client := appserver.NewClient(appserver.ClientConfig{Connectors: []appserver.Connector{&scriptedConnector{server: server}}, ConnectTimeout: time.Second})
	defer client.Close()
	store, err := state.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	a := New(client, store, Config{Workspace: workspace, Timeout: time.Second})
	request := testRequest(t, "settings")
	run := func() {
		t.Helper()
		if err := a.Respond(context.Background(), request, func([]byte) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
	run()
	request.Backend.Model = "test-model"
	request.Backend.Effort = "high"
	run() // Model-only change reuses the thread.
	request.Backend.FileAccess = "workspace-write"
	request.Backend.WebSearch = "live"
	request.Backend.NetworkAccess = true
	request.Backend.ShellAccess = true
	request.Backend.AutoReview = true
	run() // Permissions change gets a separate thread.
	request.Backend, _ = pam.ParseBackendOptions(nil)
	run() // Restricting again returns to the restricted thread.
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.threadStarts != 2 || server.turnStarts != 4 {
		t.Fatalf("starts=%d turns=%d", server.threadStarts, server.turnStarts)
	}
	if _, ok := server.turnParams[0]["permissions"]; ok {
		t.Fatal("turn re-resolves thread-only permissions")
	}
	if server.turnParams[1]["model"] != "test-model" || server.turnParams[1]["effort"] != "high" {
		t.Fatal(server.turnParams[1])
	}
	if server.turnParams[2]["approvalPolicy"] != "on-request" || server.turnParams[2]["approvalsReviewer"] != "auto_review" {
		t.Fatal(server.turnParams[2])
	}
	if server.turnParams[3]["threadId"] != server.turnParams[0]["threadId"] || server.turnParams[3]["approvalPolicy"] != "never" {
		t.Fatal("permission settings leaked across threads")
	}
	restricted := server.threadParams[0]["config"].(map[string]any)
	if restricted["web_search"] != "disabled" || restricted["features.shell_tool"] != false {
		t.Fatal(restricted)
	}
	mcp := restricted["mcp_servers"].(map[string]any)["local-files"].(map[string]any)
	if mcp["enabled"] != false {
		t.Fatal("inherited MCP still enabled")
	}
	plugins := restricted["plugins"].(map[string]any)["example@local"].(map[string]any)
	if plugins["enabled"] != false {
		t.Fatal("inherited plugin still enabled")
	}
	rprofile := restricted["permissions"].(map[string]any)["pebble"].(map[string]any)
	rfiles := rprofile["filesystem"].(map[string]any)
	if len(rfiles) != 1 || rfiles[":minimal"] != "read" {
		t.Fatal(rfiles)
	}
	permissive := server.threadParams[1]["config"].(map[string]any)
	profile := permissive["permissions"].(map[string]any)["pebble"].(map[string]any)
	files := profile["filesystem"].(map[string]any)
	if files[workspace] != "write" || files["/"] != "read" || profile["network"].(map[string]any)["enabled"] != true {
		t.Fatal(profile)
	}
}

func TestModelEffortsUseCatalogAndRejectUnsupportedSelections(t *testing.T) {
	server := &scriptedServer{}
	client := appserver.NewClient(appserver.ClientConfig{Connectors: []appserver.Connector{&scriptedConnector{server: server}}, ConnectTimeout: time.Second})
	defer client.Close()
	a := New(client, nil, Config{})
	model, effort, err := a.modelOptions(context.Background(), pam.BackendOptions{Model: "test-model"})
	if err != nil || model != "test-model" || effort != "low" {
		t.Fatalf("%s %s %v", model, effort, err)
	}
	for _, o := range []pam.BackendOptions{{Model: "unknown"}, {Model: "test-model", Effort: "ultra"}} {
		if _, _, err := a.modelOptions(context.Background(), o); err == nil {
			t.Fatalf("accepted %#v", o)
		}
	}
}
