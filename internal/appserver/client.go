package appserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

const notificationBuffer = 2048

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (rpcError *RPCError) Error() string {
	return fmt.Sprintf("app-server error %d: %s", rpcError.Code, rpcError.Message)
}

type Notification struct {
	Method string
	Params json.RawMessage
}

type response struct {
	Result json.RawMessage
	Error  *RPCError
}

type Subscription struct {
	C <-chan Notification

	connection *Connection
	threadID   string
	channel    chan Notification
	once       sync.Once
}

func (subscription *Subscription) Close() {
	subscription.once.Do(func() {
		subscription.connection.removeSubscription(subscription.threadID, subscription)
	})
}

type Connection struct {
	session   Session
	logger    *slog.Logger
	transport string

	nextID  atomic.Int64
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan response
	subs    map[string]*Subscription
	err     error
	done    chan struct{}
	once    sync.Once
}

func newConnection(session Session, logger *slog.Logger, transport string) *Connection {
	connection := &Connection{
		session:   session,
		logger:    logger,
		transport: transport,
		pending:   make(map[string]chan response),
		subs:      make(map[string]*Subscription),
		done:      make(chan struct{}),
	}
	go connection.readLoop()
	return connection
}

func (connection *Connection) Request(ctx context.Context, method string, params any, result any) error {
	id := connection.nextID.Add(1)
	payload, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return fmt.Errorf("encode %s request: %w", method, err)
	}
	key := fmt.Sprintf("%d", id)
	responseChannel := make(chan response, 1)
	connection.mu.Lock()
	if connection.err != nil {
		err = connection.err
		connection.mu.Unlock()
		return err
	}
	connection.pending[key] = responseChannel
	connection.mu.Unlock()
	defer func() {
		connection.mu.Lock()
		delete(connection.pending, key)
		connection.mu.Unlock()
	}()

	if err := connection.write(ctx, payload); err != nil {
		connection.fail(fmt.Errorf("write %s request: %w", method, err))
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-connection.done:
		return connection.Err()
	case response := <-responseChannel:
		if response.Error != nil {
			return response.Error
		}
		if result != nil && len(response.Result) > 0 {
			if err := json.Unmarshal(response.Result, result); err != nil {
				return fmt.Errorf("decode %s response: %w", method, err)
			}
		}
		return nil
	}
}

func (connection *Connection) Notify(ctx context.Context, method string, params any) error {
	payload, err := json.Marshal(map[string]any{"method": method, "params": params})
	if err != nil {
		return err
	}
	return connection.write(ctx, payload)
}

func (connection *Connection) Subscribe(threadID string) (*Subscription, error) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.err != nil {
		return nil, connection.err
	}
	if _, exists := connection.subs[threadID]; exists {
		return nil, errors.New("a turn is already active for this thread")
	}
	channel := make(chan Notification, notificationBuffer)
	subscription := &Subscription{connection: connection, threadID: threadID, channel: channel, C: channel}
	connection.subs[threadID] = subscription
	return subscription, nil
}

func (connection *Connection) Alive() bool {
	select {
	case <-connection.done:
		return false
	default:
		return true
	}
}

func (connection *Connection) Err() error {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.err == nil {
		return errors.New("app-server connection closed")
	}
	return connection.err
}

func (connection *Connection) Close() error {
	connection.fail(errors.New("app-server connection closed"))
	return connection.session.Close()
}

func (connection *Connection) write(ctx context.Context, payload []byte) error {
	connection.writeMu.Lock()
	defer connection.writeMu.Unlock()
	connection.logMessage("to_app_server", payload)
	return connection.session.Write(ctx, payload)
}

func (connection *Connection) readLoop() {
	for {
		payload, err := connection.session.Read(context.Background())
		if err != nil {
			connection.fail(fmt.Errorf("read app-server message: %w", err))
			return
		}
		connection.logMessage("from_app_server", payload)
		if err := connection.dispatch(payload); err != nil {
			connection.fail(err)
			return
		}
	}
}

func (connection *Connection) logMessage(direction string, payload []byte) {
	if connection.logger == nil {
		return
	}
	connection.logger.Info("Codex app-server RPC",
		"direction", direction,
		"transport", connection.transport,
		"payload", string(payload))
}

func (connection *Connection) dispatch(payload []byte) error {
	var envelope struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
		Result json.RawMessage `json:"result"`
		Error  *RPCError       `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return fmt.Errorf("decode app-server message: %w", err)
	}
	if envelope.Method != "" {
		if len(bytes.TrimSpace(envelope.ID)) > 0 && !bytes.Equal(bytes.TrimSpace(envelope.ID), []byte("null")) {
			connection.rejectServerRequest(envelope.ID, envelope.Method)
			return nil
		}
		var scoped struct {
			ThreadID string `json:"threadId"`
		}
		_ = json.Unmarshal(envelope.Params, &scoped)
		if scoped.ThreadID == "" {
			return nil
		}
		connection.mu.Lock()
		subscription := connection.subs[scoped.ThreadID]
		if subscription != nil {
			select {
			case subscription.channel <- Notification{Method: envelope.Method, Params: envelope.Params}:
			default:
				connection.mu.Unlock()
				return errors.New("app-server notification buffer overflow")
			}
		}
		connection.mu.Unlock()
		return nil
	}
	if len(bytes.TrimSpace(envelope.ID)) == 0 {
		return errors.New("app-server message has neither method nor id")
	}
	key := string(bytes.TrimSpace(envelope.ID))
	connection.mu.Lock()
	responseChannel := connection.pending[key]
	if responseChannel != nil {
		responseChannel <- response{Result: envelope.Result, Error: envelope.Error}
	}
	connection.mu.Unlock()
	return nil
}

func (connection *Connection) rejectServerRequest(id json.RawMessage, method string) {
	payload, err := json.Marshal(struct {
		ID    json.RawMessage `json:"id"`
		Error RPCError        `json:"error"`
	}{ID: id, Error: RPCError{Code: -32000, Message: "Pebble Agent does not permit interactive request " + method}})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := connection.write(ctx, payload); err != nil && connection.logger != nil {
		connection.logger.Warn("failed to reject app-server request", "method", method, "error", err)
	}
}

func (connection *Connection) removeSubscription(threadID string, subscription *Subscription) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.subs[threadID] == subscription {
		delete(connection.subs, threadID)
	}
}

func (connection *Connection) fail(err error) {
	connection.once.Do(func() {
		connection.mu.Lock()
		connection.err = err
		for _, subscription := range connection.subs {
			close(subscription.channel)
		}
		connection.subs = make(map[string]*Subscription)
		connection.mu.Unlock()
		close(connection.done)
		_ = connection.session.Close()
	})
}

type ClientConfig struct {
	Connectors     []Connector
	ConnectTimeout time.Duration
	Logger         *slog.Logger
	Version        string
}

type Client struct {
	config ClientConfig

	connectMu  sync.Mutex
	mu         sync.Mutex
	connection *Connection
	transport  string
	generation uint64
}

func NewClient(config ClientConfig) *Client {
	if config.ConnectTimeout <= 0 {
		config.ConnectTimeout = 5 * time.Second
	}
	if config.Version == "" {
		config.Version = "dev"
	}
	return &Client{config: config}
}

func (client *Client) Connection(ctx context.Context) (*Connection, uint64, string, error) {
	client.mu.Lock()
	if client.connection != nil && client.connection.Alive() {
		connection, generation, transport := client.connection, client.generation, client.transport
		client.mu.Unlock()
		return connection, generation, transport, nil
	}
	client.mu.Unlock()

	client.connectMu.Lock()
	defer client.connectMu.Unlock()
	client.mu.Lock()
	if client.connection != nil && client.connection.Alive() {
		connection, generation, transport := client.connection, client.generation, client.transport
		client.mu.Unlock()
		return connection, generation, transport, nil
	}
	client.mu.Unlock()

	attemptErrors := make([]error, 0, len(client.config.Connectors))
	for _, connector := range client.config.Connectors {
		attemptCtx, cancel := context.WithTimeout(ctx, client.config.ConnectTimeout)
		session, err := connector.Open(attemptCtx)
		if err != nil {
			cancel()
			attemptErrors = append(attemptErrors, fmt.Errorf("%s: %w", connector.Name(), err))
			continue
		}
		connection := newConnection(session, client.config.Logger, connector.Name())
		var initializeResult map[string]any
		err = connection.Request(attemptCtx, "initialize", map[string]any{
			"capabilities": map[string]bool{"experimentalApi": true},
			"clientInfo":   map[string]string{"name": "pebble_agent", "title": "Pebble Agent", "version": client.config.Version},
		}, &initializeResult)
		if err == nil {
			err = connection.Notify(attemptCtx, "initialized", map[string]any{})
		}
		cancel()
		if err != nil {
			_ = connection.Close()
			attemptErrors = append(attemptErrors, fmt.Errorf("%s initialize: %w", connector.Name(), err))
			continue
		}
		client.mu.Lock()
		client.connection = connection
		client.transport = connector.Name()
		client.generation++
		generation := client.generation
		client.mu.Unlock()
		if client.config.Logger != nil {
			client.config.Logger.Info("connected to Codex app-server", "transport", connector.Name())
		}
		return connection, generation, connector.Name(), nil
	}
	if len(attemptErrors) == 0 {
		return nil, 0, "", errors.New("no app-server transports are configured")
	}
	return nil, 0, "", fmt.Errorf("no Codex app-server transport is available: %w", errors.Join(attemptErrors...))
}

func (client *Client) LastTransport() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.transport
}

func (client *Client) Close() error {
	client.mu.Lock()
	connection := client.connection
	client.connection = nil
	client.mu.Unlock()
	if connection != nil {
		return connection.Close()
	}
	return nil
}
