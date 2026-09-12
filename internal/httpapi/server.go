package httpapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/nick1udwig/pebble-agent/internal/jobs"
	"github.com/nick1udwig/pebble-agent/internal/pam"
)

const pamContentType = "text/x-pebble-agent-markup; version=1; charset=utf-8"

type Responder interface {
	Respond(context.Context, pam.Request, func([]byte) error) error
}

type Config struct {
	Jobs      *jobs.Store
	Responder Responder
	Token     string
	Logger    *slog.Logger
}

type Server struct {
	config Config
	mux    *http.ServeMux
}

func New(config Config) *Server {
	server := &Server{config: config, mux: http.NewServeMux()}
	server.mux.HandleFunc("/healthz", server.health)
	server.mux.HandleFunc("/v1/jobs/", server.job)
	server.mux.HandleFunc("/v1/models", server.models)
	server.mux.HandleFunc("/v1/agent", server.agent)
	server.mux.HandleFunc("/", server.root)
	return server
}

func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	server.mux.ServeHTTP(response, request)
}

func (server *Server) root(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/" {
		http.NotFound(response, request)
		return
	}
	if request.Method == http.MethodPost || isWebSocket(request) {
		server.agent(response, request)
		return
	}
	response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	response.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(response, "Pebble Agent server\nPOST PAM to /v1/agent\n")
}

func (server *Server) health(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", "GET, HEAD")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = io.WriteString(response, "ok\n")
	}
}

func (server *Server) agent(response http.ResponseWriter, request *http.Request) {
	if isWebSocket(request) {
		server.webSocket(response, request)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", "POST")
		http.Error(response, "POST PAM requests only", http.StatusMethodNotAllowed)
		return
	}
	if !server.authorized(headerToken(request), "") {
		response.Header().Set("WWW-Authenticate", `Bearer realm="pebble-agent"`)
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	if contentType := request.Header.Get("Content-Type"); contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || !strings.EqualFold(mediaType, "text/x-pebble-agent-markup") {
			http.Error(response, "Content-Type must be text/x-pebble-agent-markup", http.StatusUnsupportedMediaType)
			return
		}
	}
	body, err := readBody(response, request)
	if err != nil {
		server.writeBadRequest(response, err)
		return
	}
	parsed, err := pam.ParseRequest(body)
	if err != nil {
		server.writeBadRequest(response, err)
		return
	}

	setPAMHeaders(response.Header())
	response.WriteHeader(http.StatusOK)
	flusher, _ := response.(http.Flusher)
	emit := func(payload []byte) error {
		if _, err := response.Write(payload); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	if err := server.config.Responder.Respond(request.Context(), parsed, emit); err != nil {
		server.logError("agent request failed", request, err)
	}
}

func (server *Server) webSocket(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		http.Error(response, "WebSocket requires GET", http.StatusMethodNotAllowed)
		return
	}
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{Subprotocols: []string{"pam.v1"}})
	if err != nil {
		server.logError("accept WebSocket", request, err)
		return
	}
	defer connection.CloseNow()
	connection.SetReadLimit(pam.MaxRequestBytes)
	if connection.Subprotocol() != "pam.v1" {
		_ = connection.Close(websocket.StatusProtocolError, "pam.v1 subprotocol required")
		return
	}
	messageType, body, err := connection.Read(request.Context())
	if err != nil {
		return
	}
	if messageType != websocket.MessageText {
		_ = connection.Close(websocket.StatusUnsupportedData, "PAM must be a text message")
		return
	}
	parsed, err := pam.ParseRequest(body)
	if err != nil {
		_ = connection.Write(request.Context(), websocket.MessageText, []byte(pam.ErrorDocument(err.Error())))
		_ = connection.Close(websocket.StatusNormalClosure, "")
		return
	}
	if !server.authorized(headerToken(request), parsed.Bearer) {
		_ = connection.Close(websocket.StatusPolicyViolation, "unauthorized")
		return
	}
	emit := func(payload []byte) error {
		return connection.Write(request.Context(), websocket.MessageText, payload)
	}
	if err := server.config.Responder.Respond(request.Context(), parsed, emit); err != nil {
		server.logError("agent WebSocket request failed", request, err)
	}
	_ = connection.Close(websocket.StatusNormalClosure, "")
}

func (server *Server) authorized(header, nested string) bool {
	if server.config.Token == "" {
		return true
	}
	provided := header
	if provided == "" {
		provided = nested
	}
	return len(provided) == len(server.config.Token) && subtle.ConstantTimeCompare([]byte(provided), []byte(server.config.Token)) == 1
}

func (server *Server) writeBadRequest(response http.ResponseWriter, err error) {
	setPAMHeaders(response.Header())
	response.WriteHeader(http.StatusBadRequest)
	_, _ = io.WriteString(response, pam.ErrorDocument(err.Error()))
}

func (server *Server) logError(message string, request *http.Request, err error) {
	if server.config.Logger == nil || errors.Is(err, context.Canceled) {
		return
	}
	server.config.Logger.Error(message, "remote", request.RemoteAddr, "error", err)
}

func readBody(response http.ResponseWriter, request *http.Request) ([]byte, error) {
	reader := http.MaxBytesReader(response, request.Body, pam.MaxRequestBytes)
	defer reader.Close()
	payload, err := io.ReadAll(reader)
	if err != nil {
		return nil, fmt.Errorf("read PAM request: %w", err)
	}
	return payload, nil
}

func setPAMHeaders(header http.Header) {
	header.Set("Content-Type", pamContentType)
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Accel-Buffering", "no")
}

func headerToken(request *http.Request) string {
	value := request.Header.Get("Authorization")
	if len(value) < 7 || !strings.EqualFold(value[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(value[7:])
}

func isWebSocket(request *http.Request) bool {
	return strings.EqualFold(request.Header.Get("Upgrade"), "websocket") && headerContains(request.Header.Get("Connection"), "upgrade")
}

func headerContains(value, target string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), target) {
			return true
		}
	}
	return false
}
