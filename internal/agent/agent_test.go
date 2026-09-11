package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nick1udwig/pebble-agent/internal/appserver"
	"github.com/nick1udwig/pebble-agent/internal/pam"
	"github.com/nick1udwig/pebble-agent/internal/state"
)

type scriptedConnector struct {
	server *scriptedServer
}

func (connector *scriptedConnector) Name() string { return "fake" }
func (connector *scriptedConnector) Open(context.Context) (appserver.Session, error) {
	return connector.server.session(), nil
}

type scriptedServer struct {
	mu sync.Mutex

	threadStarts  int
	threadResumes int
	turnStarts    int
	invalidOutput bool
	turnParams    []map[string]any
	threadParams  []map[string]any
}

type scriptedSession struct {
	server *scriptedServer
	reads  chan []byte
	done   chan struct{}
	once   sync.Once
}

func (server *scriptedServer) session() *scriptedSession {
	return &scriptedSession{server: server, reads: make(chan []byte, 64), done: make(chan struct{})}
}

func (session *scriptedSession) Read(ctx context.Context) ([]byte, error) {
	select {
	case payload := <-session.reads:
		return payload, nil
	case <-session.done:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (session *scriptedSession) Write(_ context.Context, payload []byte) error {
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		return err
	}
	respond := func(result any) {
		encoded, _ := json.Marshal(map[string]any{"id": json.RawMessage(message.ID), "result": result})
		session.reads <- encoded
	}
	notify := func(method string, params any) {
		encoded, _ := json.Marshal(map[string]any{"method": method, "params": params})
		session.reads <- encoded
	}
	switch message.Method {
	case "initialize":
		respond(map[string]any{"serverInfo": map[string]string{"name": "fake"}})
	case "initialized":
	case "config/read":
		respond(map[string]any{"config": map[string]any{"mcp_servers": map[string]any{"local-files": map[string]any{"enabled": true}}, "plugins": map[string]any{"example@local": map[string]any{"enabled": true}}}})
	case "model/list":
		respond(map[string]any{"data": []map[string]any{{"model": "test-model", "defaultReasoningEffort": "low", "supportedReasoningEfforts": []map[string]string{{"reasoningEffort": "low"}, {"reasoningEffort": "high"}}}}, "nextCursor": nil})
	case "thread/start":
		session.server.mu.Lock()
		session.server.threadStarts++
		session.server.threadParams = append(session.server.threadParams, message.Params)
		number := session.server.threadStarts
		session.server.mu.Unlock()
		respond(map[string]any{"thread": map[string]any{"id": fmt.Sprintf("thread-%d", number)}})
	case "thread/resume":
		session.server.mu.Lock()
		session.server.threadResumes++
		session.server.mu.Unlock()
		respond(map[string]any{"thread": map[string]any{"id": message.Params["threadId"]}})
	case "turn/start":
		session.server.mu.Lock()
		session.server.turnStarts++
		number := session.server.turnStarts
		session.server.turnParams = append(session.server.turnParams, message.Params)
		invalid := session.server.invalidOutput
		session.server.mu.Unlock()
		threadID := message.Params["threadId"].(string)
		turnID := fmt.Sprintf("turn-%d", number)
		respond(map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress"}})
		notify("item/started", map[string]any{
			"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"id": "commentary", "type": "agentMessage", "phase": "commentary", "text": ""},
		})
		notify("item/agentMessage/delta", map[string]any{
			"threadId": threadID, "turnId": turnID, "itemId": "commentary", "delta": "I am thinking\n",
		})
		notify("item/started", map[string]any{
			"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": ""},
		})
		chunks := []string{"pam ver", "sion=1\nscreen id=answer lay", "out=card title=Agent\n  text id=body value=\"Hello", " watch\"\ndone\n"}
		if invalid {
			chunks = []string{"ordinary prose, not PAM"}
		}
		for _, chunk := range chunks {
			notify("item/agentMessage/delta", map[string]any{
				"threadId": threadID, "turnId": turnID, "itemId": "answer", "delta": chunk,
			})
		}
		notify("item/completed", map[string]any{
			"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": ""},
		})
		notify("turn/completed", map[string]any{
			"threadId": threadID, "turn": map[string]any{"id": turnID, "status": "completed", "items": []any{}},
		})
	case "turn/interrupt":
		respond(map[string]any{})
	}
	return nil
}

func (session *scriptedSession) Close() error {
	session.once.Do(func() { close(session.done) })
	return nil
}

func TestAgentStreamsFinalPAMAndKeepsConversationThread(t *testing.T) {
	server := &scriptedServer{}
	client := appserver.NewClient(appserver.ClientConfig{
		Connectors:     []appserver.Connector{&scriptedConnector{server: server}},
		ConnectTimeout: time.Second,
	})
	defer client.Close()
	store, err := state.Open(filepath.Join(t.TempDir(), "sessions.json"))
	if err != nil {
		t.Fatal(err)
	}
	agent := New(client, store, Config{Model: "gpt-5.6-luna", Effort: "xhigh", Workspace: t.TempDir(), Timeout: 3 * time.Second})
	request := testRequest(t, "watch-session")
	for turn := 0; turn < 2; turn++ {
		var output bytes.Buffer
		err := agent.Respond(context.Background(), request, func(payload []byte) error {
			_, err := output.Write(payload)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(output.Bytes(), []byte("thinking")) {
			t.Fatalf("commentary leaked into PAM: %q", output.String())
		}
		nodes, err := pam.Decode(output.Bytes(), pam.MaxOutputBytes)
		if err != nil {
			t.Fatalf("invalid response: %v\n%s", err, output.String())
		}
		if len(nodes) != 4 || nodes[1].Kind != "screen" || nodes[3].Kind != "done" {
			t.Fatalf("unexpected response nodes: %#v", nodes)
		}
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.threadStarts != 1 || server.threadResumes != 0 || server.turnStarts != 2 {
		t.Fatalf("starts=%d resumes=%d turns=%d", server.threadStarts, server.threadResumes, server.turnStarts)
	}
	if len(server.turnParams) != 2 {
		t.Fatalf("turn params count %d", len(server.turnParams))
	}
	params := server.turnParams[0]
	if params["model"] != "gpt-5.6-luna" || params["effort"] != "xhigh" || params["approvalPolicy"] != "never" {
		t.Fatalf("unexpected model policy: %#v", params)
	}
	if server.threadParams[0]["permissions"] != "pebble" || params["approvalsReviewer"] != "user" {
		t.Fatalf("unexpected permission policy: %#v", params)
	}
}

func TestAgentResumesPersistedThreadAfterReconnect(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "sessions.json")
	store, err := state.Open(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defaults, _ := pam.ParseBackendOptions(nil)
	workspace := t.TempDir()
	key := New(nil, nil, Config{Workspace: workspace}).sessionKey("watch-session", defaults)
	if err := store.Set(key, "persisted-thread"); err != nil {
		t.Fatal(err)
	}
	server := &scriptedServer{}
	client := appserver.NewClient(appserver.ClientConfig{
		Connectors:     []appserver.Connector{&scriptedConnector{server: server}},
		ConnectTimeout: time.Second,
	})
	defer client.Close()
	agent := New(client, store, Config{Workspace: workspace, Timeout: 3 * time.Second})
	var output bytes.Buffer
	if err := agent.Respond(context.Background(), testRequest(t, "watch-session"), func(payload []byte) error {
		_, err := output.Write(payload)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.threadStarts != 0 || server.threadResumes != 1 || server.turnStarts != 1 {
		t.Fatalf("starts=%d resumes=%d turns=%d", server.threadStarts, server.threadResumes, server.turnStarts)
	}
}

func TestAgentConvertsMalformedModelOutputToPAMError(t *testing.T) {
	server := &scriptedServer{invalidOutput: true}
	client := appserver.NewClient(appserver.ClientConfig{
		Connectors:     []appserver.Connector{&scriptedConnector{server: server}},
		ConnectTimeout: time.Second,
	})
	defer client.Close()
	store, _ := state.Open(filepath.Join(t.TempDir(), "sessions.json"))
	agent := New(client, store, Config{Workspace: t.TempDir(), Timeout: 3 * time.Second})
	var output bytes.Buffer
	err := agent.Respond(context.Background(), testRequest(t, "watch-session"), func(payload []byte) error {
		_, writeErr := output.Write(payload)
		return writeErr
	})
	if err == nil {
		t.Fatal("expected invalid model output error")
	}
	nodes, parseErr := pam.Decode(output.Bytes(), pam.MaxOutputBytes)
	if parseErr != nil {
		t.Fatalf("fallback was invalid PAM: %v\n%s", parseErr, output.String())
	}
	if len(nodes) != 2 || nodes[1].Kind != "error" {
		t.Fatalf("unexpected fallback: %#v", nodes)
	}
}

func testRequest(t *testing.T, session string) pam.Request {
	t.Helper()
	source := "pam version=1\nrequest id=1 protocol=pam/1 session=" + session + "\n  input kind=dictation text=hello action= element= value=\n  context screen= layout= selected=\n  device platform=emery model=pebble_time_2 shape=rect touch=true\ndone\n"
	request, err := pam.ParseRequest([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	return request
}
