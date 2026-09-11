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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const maxMessageBytes = 32 << 20

type Session interface {
	Read(context.Context) ([]byte, error)
	Write(context.Context, []byte) error
	Close() error
}

type Connector interface {
	Name() string
	Open(context.Context) (Session, error)
}

type ResolverConfig struct {
	CodexCommand   string
	UnixSocket     string
	WebSocketURL   string
	WebSocketToken string
	Logger         *slog.Logger
}

func DefaultConnectors(config ResolverConfig) []Connector {
	command := strings.TrimSpace(config.CodexCommand)
	if command == "" {
		command = "codex"
	}
	return []Connector{
		&UnixConnector{CodexCommand: command, SocketPath: strings.TrimSpace(config.UnixSocket), Logger: config.Logger},
		&StdioConnector{Command: command, Args: []string{"app-server", "--stdio"}, Logger: config.Logger},
		&WebSocketConnector{RawURL: strings.TrimSpace(config.WebSocketURL), BearerToken: config.WebSocketToken},
	}
}

type webSocketSession struct {
	connection *websocket.Conn
	cleanup    func()
	closeOnce  sync.Once
}

func (session *webSocketSession) Read(ctx context.Context) ([]byte, error) {
	messageType, payload, err := session.connection.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, errors.New("app-server sent a non-text WebSocket message")
	}
	return payload, nil
}

func (session *webSocketSession) Write(ctx context.Context, payload []byte) error {
	return session.connection.Write(ctx, websocket.MessageText, payload)
}

func (session *webSocketSession) Close() error {
	var closeErr error
	session.closeOnce.Do(func() {
		closeErr = session.connection.Close(websocket.StatusNormalClosure, "")
		if session.cleanup != nil {
			session.cleanup()
		}
	})
	return closeErr
}

type WebSocketConnector struct {
	RawURL      string
	BearerToken string
}

func (connector *WebSocketConnector) Name() string { return "websocket" }

func (connector *WebSocketConnector) Open(ctx context.Context) (Session, error) {
	if connector.RawURL == "" {
		return nil, errors.New("URL is not configured")
	}
	parsed, err := url.Parse(connector.RawURL)
	if err != nil {
		return nil, fmt.Errorf("parse URL: %w", err)
	}
	if (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
		return nil, errors.New("URL must use ws or wss and include a host")
	}
	header := make(http.Header)
	if connector.BearerToken != "" {
		header.Set("Authorization", "Bearer "+connector.BearerToken)
	}
	connection, response, err := websocket.Dial(ctx, parsed.String(), &websocket.DialOptions{HTTPHeader: header})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return nil, err
	}
	connection.SetReadLimit(maxMessageBytes)
	return &webSocketSession{connection: connection}, nil
}

type UnixConnector struct {
	CodexCommand string
	SocketPath   string
	Logger       *slog.Logger
}

func (connector *UnixConnector) Name() string { return "unix socket" }

func (connector *UnixConnector) Open(ctx context.Context) (Session, error) {
	socketPath := strings.TrimPrefix(strings.TrimSpace(connector.SocketPath), "unix://")
	if socketPath == "" {
		discovered, err := connector.discover(ctx)
		if err != nil {
			return nil, err
		}
		socketPath = discovered
	}
	if !filepath.IsAbs(socketPath) {
		return nil, fmt.Errorf("Unix socket path must be absolute: %q", socketPath)
	}

	transport := &http.Transport{DialContext: func(dialCtx context.Context, _, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(dialCtx, "unix", socketPath)
	}}
	client := &http.Client{Transport: transport}
	connection, response, err := websocket.Dial(ctx, "ws://localhost/", &websocket.DialOptions{HTTPClient: client})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		transport.CloseIdleConnections()
		return nil, fmt.Errorf("connect %s: %w", socketPath, err)
	}
	connection.SetReadLimit(maxMessageBytes)
	return &webSocketSession{connection: connection, cleanup: transport.CloseIdleConnections}, nil
}

func (connector *UnixConnector) discover(ctx context.Context) (string, error) {
	if strings.TrimSpace(connector.CodexCommand) == "" {
		return "", errors.New("Codex command is not configured")
	}
	command := exec.CommandContext(ctx, connector.CodexCommand, "app-server", "daemon", "version")
	output, err := command.Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && len(bytes.TrimSpace(exitError.Stderr)) > 0 {
			return "", fmt.Errorf("discover daemon socket: %w: %s", err, strings.TrimSpace(string(exitError.Stderr)))
		}
		return "", fmt.Errorf("discover daemon socket: %w", err)
	}
	var status struct {
		SocketPath string `json:"socketPath"`
		Status     string `json:"status"`
	}
	if err := json.Unmarshal(output, &status); err != nil {
		return "", fmt.Errorf("decode daemon status: %w", err)
	}
	if status.Status != "running" {
		return "", fmt.Errorf("Codex app-server daemon is %s", status.Status)
	}
	if !filepath.IsAbs(status.SocketPath) {
		return "", fmt.Errorf("daemon returned an invalid socket path %q", status.SocketPath)
	}
	if connector.Logger != nil {
		connector.Logger.Debug("discovered Codex app-server daemon", "socket", status.SocketPath)
	}
	return status.SocketPath, nil
}

type StdioConnector struct {
	Command string
	Args    []string
	Env     []string
	Logger  *slog.Logger
}

func (connector *StdioConnector) Name() string { return "stdio" }

func (connector *StdioConnector) Open(ctx context.Context) (Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(connector.Command) == "" {
		return nil, errors.New("Codex command is not configured")
	}
	command := exec.Command(connector.Command, connector.Args...)
	if connector.Env != nil {
		command.Env = append(os.Environ(), connector.Env...)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	command.Stderr = logWriter{Logger: connector.Logger, Transport: connector.Name()}
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	session := &stdioSession{
		command:  command,
		done:     make(chan struct{}),
		stdin:    stdin,
		messages: make(chan readResult, 1),
		wait:     make(chan error, 1),
	}
	go session.read(stdout)
	go func() { session.wait <- command.Wait() }()
	return session, nil
}

type readResult struct {
	payload []byte
	err     error
}

type stdioSession struct {
	command  *exec.Cmd
	done     chan struct{}
	stdin    io.WriteCloser
	messages chan readResult
	wait     chan error

	closeOnce sync.Once
	writeMu   sync.Mutex
}

func (session *stdioSession) read(stdout io.ReadCloser) {
	defer stdout.Close()
	defer close(session.messages)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), maxMessageBytes)
	for scanner.Scan() {
		payload := bytes.Clone(scanner.Bytes())
		if len(bytes.TrimSpace(payload)) == 0 {
			continue
		}
		select {
		case session.messages <- readResult{payload: payload}:
		case <-session.done:
			return
		}
	}
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	select {
	case session.messages <- readResult{err: err}:
	case <-session.done:
	}
}

func (session *stdioSession) Read(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result, ok := <-session.messages:
		if !ok {
			return nil, io.EOF
		}
		return result.payload, result.err
	}
}

func (session *stdioSession) Write(ctx context.Context, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	session.writeMu.Lock()
	defer session.writeMu.Unlock()
	if err := writeAll(session.stdin, payload); err != nil {
		return err
	}
	return writeAll(session.stdin, []byte{'\n'})
}

func (session *stdioSession) Close() error {
	var closeErr error
	session.closeOnce.Do(func() {
		close(session.done)
		_ = session.stdin.Close()
		if session.command.Process != nil {
			if err := session.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				closeErr = err
			}
		}
		select {
		case <-session.wait:
		case <-time.After(2 * time.Second):
			if closeErr == nil {
				closeErr = errors.New("timed out waiting for app-server process to exit")
			}
		}
	})
	return closeErr
}

func writeAll(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		payload = payload[written:]
	}
	return nil
}

type logWriter struct {
	Logger    *slog.Logger
	Transport string
}

func (writer logWriter) Write(payload []byte) (int, error) {
	if message := strings.TrimSpace(string(payload)); message != "" && writer.Logger != nil {
		writer.Logger.Debug("Codex app-server", "transport", writer.Transport, "message", message)
	}
	return len(payload), nil
}
