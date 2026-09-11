package appserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type connectorStub struct {
	name  string
	open  func(context.Context) (Session, error)
	calls int
}

func (connector *connectorStub) Name() string { return connector.name }
func (connector *connectorStub) Open(ctx context.Context) (Session, error) {
	connector.calls++
	return connector.open(ctx)
}

type rpcSession struct {
	reads chan []byte
	done  chan struct{}
	once  sync.Once
}

func newRPCSession() *rpcSession {
	return &rpcSession{reads: make(chan []byte, 16), done: make(chan struct{})}
}

func (session *rpcSession) Read(ctx context.Context) ([]byte, error) {
	select {
	case payload := <-session.reads:
		return payload, nil
	case <-session.done:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (session *rpcSession) Write(_ context.Context, payload []byte) error {
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		return err
	}
	if message.Method == "initialize" {
		session.reads <- []byte(fmt.Sprintf(`{"id":%s,"result":{"serverInfo":{"name":"fake"}}}`, message.ID))
	} else if message.Method == "log/test" {
		session.reads <- []byte(fmt.Sprintf(`{"id":%s,"result":{"text":"model output"}}`, message.ID))
	}
	return nil
}

func TestClientLogsCompleteMessagesInBothDirections(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	session := newRPCSession()
	connector := &connectorStub{name: "fake transport", open: func(context.Context) (Session, error) {
		return session, nil
	}}
	client := NewClient(ClientConfig{
		Connectors:     []Connector{connector},
		ConnectTimeout: time.Second,
		Logger:         logger,
	})
	defer client.Close()
	connection, _, _, err := client.Connection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Text string `json:"text"`
	}
	if err := connection.Request(context.Background(), "log/test", map[string]string{"prompt": "dictated input"}, &response); err != nil {
		t.Fatal(err)
	}
	if response.Text != "model output" {
		t.Fatalf("unexpected response: %#v", response)
	}

	directions := map[string]int{}
	var sawInput, sawOutput bool
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log record: %v\n%s", err, line)
		}
		if record["msg"] != "Codex app-server RPC" {
			continue
		}
		direction, _ := record["direction"].(string)
		directions[direction]++
		if record["transport"] != "fake transport" {
			t.Fatalf("missing transport field: %#v", record)
		}
		payload, _ := record["payload"].(string)
		sawInput = sawInput || strings.Contains(payload, "dictated input")
		sawOutput = sawOutput || strings.Contains(payload, "model output")
	}
	if directions["to_app_server"] != 3 || directions["from_app_server"] != 2 {
		t.Fatalf("unexpected direction counts: %#v\n%s", directions, logs.String())
	}
	if !sawInput || !sawOutput {
		t.Fatalf("complete payloads were not logged: input=%v output=%v\n%s", sawInput, sawOutput, logs.String())
	}
}

func (session *rpcSession) Close() error {
	session.once.Do(func() { close(session.done) })
	return nil
}

func TestClientFallsBackInOrderAndReusesConnection(t *testing.T) {
	first := &connectorStub{name: "unix socket", open: func(context.Context) (Session, error) {
		return nil, errors.New("not running")
	}}
	session := newRPCSession()
	second := &connectorStub{name: "stdio", open: func(context.Context) (Session, error) { return session, nil }}
	third := &connectorStub{name: "websocket", open: func(context.Context) (Session, error) {
		return nil, errors.New("must not be reached")
	}}
	client := NewClient(ClientConfig{Connectors: []Connector{first, second, third}, ConnectTimeout: time.Second})
	defer client.Close()
	connection, generation, transport, err := client.Connection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if connection == nil || generation != 1 || transport != "stdio" {
		t.Fatalf("unexpected connection result: %p %d %q", connection, generation, transport)
	}
	again, nextGeneration, _, err := client.Connection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if again != connection || nextGeneration != generation {
		t.Fatal("client did not reuse the live connection")
	}
	if first.calls != 1 || second.calls != 1 || third.calls != 0 {
		t.Fatalf("connector calls: first=%d second=%d third=%d", first.calls, second.calls, third.calls)
	}
}

func TestUnixConnectorUsesWebSocketOverUnixSocket(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "app-server.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		messageType, payload, err := connection.Read(request.Context())
		if err != nil {
			t.Error(err)
			return
		}
		if messageType != websocket.MessageText || string(payload) != "ping" {
			t.Errorf("unexpected payload %q", payload)
			return
		}
		_ = connection.Write(request.Context(), websocket.MessageText, []byte("pong"))
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	session, err := (&UnixConnector{SocketPath: socket}).Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if err := session.Write(ctx, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	payload, err := session.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "pong" {
		t.Fatalf("got %q", payload)
	}
}

func TestStdioConnectorFramesJSONLines(t *testing.T) {
	if os.Getenv("PEBBLE_AGENT_STDIO_HELPER") == "1" {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			fmt.Println(scanner.Text())
		}
		os.Exit(0)
	}
	connector := &StdioConnector{
		Command: os.Args[0],
		Args:    []string{"-test.run=TestStdioConnectorFramesJSONLines"},
		Env:     []string{"PEBBLE_AGENT_STDIO_HELPER=1"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	session, err := connector.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	message := []byte(`{"id":7,"method":"hello"}`)
	if err := session.Write(ctx, message); err != nil {
		t.Fatal(err)
	}
	response, err := session.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(response) != string(message) {
		t.Fatalf("got %q", response)
	}
}

func TestWebSocketConnectorSendsBearerToken(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer secret" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		_, payload, _ := connection.Read(request.Context())
		_ = connection.Write(request.Context(), websocket.MessageText, []byte(strings.ToUpper(string(payload))))
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connector := &WebSocketConnector{RawURL: "ws://" + listener.Addr().String(), BearerToken: "secret"}
	session, err := connector.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if err := session.Write(ctx, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	payload, err := session.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "HELLO" {
		t.Fatalf("got %q", payload)
	}
}
