package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/nick1udwig/pebble-agent/internal/agent"
	"github.com/nick1udwig/pebble-agent/internal/appserver"
	"github.com/nick1udwig/pebble-agent/internal/httpapi"
	"github.com/nick1udwig/pebble-agent/internal/logfile"
	"github.com/nick1udwig/pebble-agent/internal/state"
)

var version = "dev"

type options struct {
	listen                     string
	model                      string
	effort                     string
	codexCommand               string
	appServerUnix              string
	appServerURL               string
	appServerTokenEnvironment  string
	authTokenEnvironment       string
	allowUnauthenticatedPublic bool
	connectTimeout             time.Duration
	turnTimeout                time.Duration
	statePath                  string
	workspace                  string
	logLevel                   string
	logFile                    string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "pebble-agent-server:", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	defaults, err := defaultPaths()
	if err != nil {
		return err
	}
	flags := flag.NewFlagSet("pebble-agent-server", flag.ContinueOnError)
	var config options
	flags.StringVar(&config.listen, "listen", environment("PEBBLE_AGENT_LISTEN", "127.0.0.1:8787"), "HTTP listen address")
	flags.StringVar(&config.model, "model", environment("PEBBLE_AGENT_MODEL", "gpt-5.6-luna"), "Codex model")
	flags.StringVar(&config.effort, "effort", environment("PEBBLE_AGENT_EFFORT", "xhigh"), "reasoning effort")
	flags.StringVar(&config.codexCommand, "codex", environment("PEBBLE_AGENT_CODEX", "codex"), "Codex CLI command")
	flags.StringVar(&config.appServerUnix, "app-server-unix", os.Getenv("PEBBLE_AGENT_APP_SERVER_UNIX"), "explicit Codex daemon Unix socket")
	flags.StringVar(&config.appServerURL, "app-server-url", environment("PEBBLE_AGENT_APP_SERVER_URL", "ws://127.0.0.1:4222"), "fallback Codex app-server WebSocket URL")
	flags.StringVar(&config.appServerTokenEnvironment, "app-server-token-env", "CODEX_APP_SERVER_TOKEN", "environment variable containing app-server WebSocket bearer token")
	flags.StringVar(&config.authTokenEnvironment, "auth-token-env", "PEBBLE_AGENT_TOKEN", "environment variable containing the phone bearer token")
	flags.BoolVar(&config.allowUnauthenticatedPublic, "allow-unauthenticated-public", false, "allow a non-loopback listener without a phone bearer token")
	flags.DurationVar(&config.connectTimeout, "connect-timeout", 5*time.Second, "timeout per app-server transport")
	flags.DurationVar(&config.turnTimeout, "turn-timeout", 110*time.Second, "maximum Codex turn duration")
	flags.StringVar(&config.statePath, "state", defaults.state, "session state JSON path")
	flags.StringVar(&config.workspace, "workspace", defaults.workspace, "absolute Codex cwd and writable root when phone settings allow workspace writes")
	flags.StringVar(&config.logLevel, "log-level", environment("PEBBLE_AGENT_LOG_LEVEL", "info"), "debug, info, warn, or error")
	flags.StringVar(&config.logFile, "log-file", environment("PEBBLE_AGENT_LOG_FILE", defaults.log), "rotating log path, or - for stderr only")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	if strings.TrimSpace(config.model) == "" || strings.TrimSpace(config.effort) == "" {
		return errors.New("model and effort must not be empty")
	}
	if config.connectTimeout <= 0 || config.turnTimeout <= 0 {
		return errors.New("connect-timeout and turn-timeout must be positive")
	}
	if !filepath.IsAbs(config.statePath) || !filepath.IsAbs(config.workspace) ||
		(config.logFile != "-" && !filepath.IsAbs(config.logFile)) {
		return errors.New("state, workspace, and log-file paths must be absolute")
	}
	level, err := parseLogLevel(config.logLevel)
	if err != nil {
		return err
	}
	logOutput := io.Writer(os.Stderr)
	var rotatingLog *logfile.Writer
	if config.logFile != "-" {
		rotatingLog, err = logfile.Open(config.logFile, logfile.DefaultMaxBytes, logfile.DefaultBackups)
		if err != nil {
			return fmt.Errorf("configure logging: %w", err)
		}
		defer rotatingLog.Close()
		logOutput = io.MultiWriter(os.Stderr, rotatingLog)
	}
	logger := slog.New(slog.NewTextHandler(logOutput, &slog.HandlerOptions{Level: level}))
	logger.Info("Pebble Agent logging configured",
		"file", config.logFile,
		"max_bytes", logfile.DefaultMaxBytes,
		"backups", logfile.DefaultBackups)
	phoneToken := os.Getenv(config.authTokenEnvironment)
	if phoneToken == "" && !config.allowUnauthenticatedPublic && !loopbackListener(config.listen) {
		return fmt.Errorf("refusing unauthenticated non-loopback listener %q; set %s or pass --allow-unauthenticated-public", config.listen, config.authTokenEnvironment)
	}
	if err := os.MkdirAll(config.workspace, 0o700); err != nil {
		return fmt.Errorf("create workspace: %w", err)
	}
	store, err := state.Open(config.statePath)
	if err != nil {
		return err
	}
	connectors := appserver.DefaultConnectors(appserver.ResolverConfig{
		CodexCommand:   config.codexCommand,
		UnixSocket:     config.appServerUnix,
		WebSocketURL:   config.appServerURL,
		WebSocketToken: os.Getenv(config.appServerTokenEnvironment),
		Logger:         logger,
	})
	client := appserver.NewClient(appserver.ClientConfig{
		Connectors:     connectors,
		ConnectTimeout: config.connectTimeout,
		Logger:         logger,
		Version:        version,
	})
	defer client.Close()
	startupContext, startupCancel := context.WithTimeout(context.Background(), config.connectTimeout*time.Duration(len(connectors)))
	_, _, transport, err := client.Connection(startupContext)
	startupCancel()
	if err != nil {
		return err
	}
	responder := agent.New(client, store, agent.Config{
		Model:     config.model,
		Effort:    config.effort,
		Workspace: config.workspace,
		Timeout:   config.turnTimeout,
		Logger:    logger,
	})
	handler := httpapi.New(httpapi.Config{Responder: responder, Token: phoneToken, Logger: logger})
	listener, err := net.Listen("tcp", config.listen)
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	logger.Info("Pebble Agent server listening",
		"address", listener.Addr().String(),
		"endpoint", "/v1/agent",
		"model", config.model,
		"effort", config.effort,
		"app_server_transport", transport,
		"authenticated", phoneToken != "")

	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	select {
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-shutdownContext.Done():
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			return err
		}
	}
	return nil
}

type paths struct {
	state     string
	workspace string
	log       string
}

func defaultPaths() (paths, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return paths{}, fmt.Errorf("find user cache directory: %w", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return paths{}, fmt.Errorf("find user home directory: %w", err)
	}
	root := filepath.Join(cache, "pebble-agent")
	return paths{
		state:     filepath.Join(root, "sessions.json"),
		workspace: filepath.Join(root, "workspace"),
		log:       filepath.Join(home, ".pebble-agent", "server.log"),
	}, nil
}

func environment(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func parseLogLevel(value string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid log level %q", value)
	}
}

func loopbackListener(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
