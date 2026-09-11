# Codex-backed agent server

`pebble-agent-server` is the real self-hosted PAM endpoint. It accepts a watch request over streaming HTTP or the `pam.v1` WebSocket subprotocol, runs the corresponding conversation turn through Codex app-server, validates the model's PAM one complete line at a time, and streams those lines to the phone.

## Prerequisites

- Go 1.24 or newer to build the binary.
- A current Codex CLI on `PATH`.
- A working Codex CLI login on the same operating-system account that runs the service.
- A TLS reverse proxy, VPN, or trusted private network through which the paired phone can reach the service.

Build and start it:

```sh
go build -o build/pebble-agent-server ./cmd/pebble-agent-server
export PEBBLE_AGENT_TOKEN="replace-with-a-long-random-secret"
./build/pebble-agent-server --listen 0.0.0.0:8787
```

Set the watchapp endpoint to `http://SERVER:8787/v1/agent` and enter the same token. `POST /` is also accepted, but `/v1/agent` is the stable endpoint. `GET /healthz` reports process health.

The server refuses a non-loopback listener when `PEBBLE_AGENT_TOKEN` is empty. `--allow-unauthenticated-public` exists for tightly controlled development environments, but it is deliberately explicit. The bearer token is read from an environment variable rather than a command-line value so it is not exposed in a process listing.

## Codex configuration

Defaults:

```text
model:  gpt-5.6-luna
effort: xhigh
```

Set them when the process starts:

```sh
./build/pebble-agent-server \
  --model gpt-5.6-luna \
  --effort xhigh
```

The corresponding environment variables are `PEBBLE_AGENT_MODEL` and `PEBBLE_AGENT_EFFORT`. The selected values are logged at startup and applied to every new turn.

The service creates Codex threads with approval policy `never` and the legacy `read-only` sandbox, then applies the stable `readOnly` sandbox policy with network access disabled to each turn. The agent instruction forbids shell, files, tools, approval prompts, and app-server user-input requests. If an unexpected server request still arrives, the service rejects it instead of leaving the watch waiting.

## App-server transport selection

Each connection attempt follows this order:

1. Discover the running daemon with `codex app-server daemon version` and connect to its reported Unix socket using WebSocket-over-Unix-socket. `--app-server-unix /absolute/path.sock` skips discovery.
2. Start and retain a managed `codex app-server --stdio` child process.
3. Connect to `--app-server-url`, which defaults to `ws://127.0.0.1:4222`.

Use `PEBBLE_AGENT_CODEX` to select another Codex executable, `PEBBLE_AGENT_APP_SERVER_UNIX` for an explicit socket, and `PEBBLE_AGENT_APP_SERVER_URL` for the fallback URL. If a remote WebSocket app-server requires a bearer token, put it in `CODEX_APP_SERVER_TOKEN` or change the variable name with `--app-server-token-env`.

Every transport performs the required `initialize` request and `initialized` notification. A dropped long-lived connection is re-resolved in the same order on the next request. A connection attempt has a five-second per-transport timeout by default.

Every JSON protocol message sent to or received from Codex app-server is logged at `info` with `direction=to_app_server` or `direction=from_app_server`, the selected transport, and the complete raw payload. This includes dictated prompts, model output deltas, thread metadata, errors, and any server requests or client responses. Phone endpoint bearer credentials are consumed at the HTTP/WebSocket boundary and are never forwarded in the model-facing PAM document.

## Logs and rotation

Start runtime debugging with:

```text
~/.pebble-agent/server.log
```

The server mirrors its structured stderr output into that file. Before a complete log record would take the active file past 10 MiB (10,485,760 bytes), it rotates the file. It retains five backups: `server.log.1` is newest and `server.log.5` is oldest. A single record larger than 10 MiB remains intact. The active log is created with mode `0600`, and a newly created `.pebble-agent` directory is private to the current user.

Set `PEBBLE_AGENT_LOG_FILE` or use `--log-file /absolute/path` to choose a different file. Use `--log-file -` to log only to stderr. The payloads are intentionally not content-redacted, so protect the active file and every backup as sensitive conversation data.

These logs prove what crossed the Go server/Codex boundary. If they show a completed, valid PAM response but the watchapp exits, collect Pebble watch logs next: that failure is downstream in the phone bridge, AppMessage delivery, or native watch process.

## Conversations and streaming

The PAM `request.session` value maps to a persisted Codex thread. The default state file is the user cache directory's `pebble-agent/sessions.json`, written with mode `0600`; use `--state /absolute/path.json` to move it. Restarting either service resumes the thread. If Codex no longer has a persisted thread, the mapping is discarded and a new one is created.

Only final-answer agent-message deltas are forwarded. Commentary is ignored. Output is limited to 128 KiB, 2,048 bytes per line, 96 PAM nodes, eight indentation levels, and 48 screen elements. Layouts, element kinds, bindings, patches, removals, and built-in capability commands are allowlisted before each line is flushed. Invalid output becomes a valid root PAM `error` instead of arbitrary bytes reaching the watch. A missing final `done` is supplied for an otherwise valid screen.

The default turn timeout is 110 seconds, configurable with `--turn-timeout`. The watch setting must be long enough for the selected model and effort; its client-side maximum is 120 seconds.

## Internet-facing deployment

Keep the Go listener on `127.0.0.1` when a reverse proxy runs on the same host. Terminate TLS at that proxy, disable response buffering for `/v1/agent`, permit WebSocket upgrades if using WSS, and forward `Authorization`. The service already sends `Cache-Control: no-store` and `X-Accel-Buffering: no`.

Do not expose an unencrypted bearer token over the public internet. The service is designed for one trusted operator's Codex account; it is not a multi-tenant authorization or billing boundary.

## Useful flags

Run `pebble-agent-server -h` for the complete set. Common options include:

```text
--listen 127.0.0.1:8787
--model gpt-5.6-luna
--effort xhigh
--connect-timeout 5s
--turn-timeout 110s
--state /absolute/path/sessions.json
--workspace /absolute/path/empty-workspace
--log-level debug|info|warn|error
--log-file /absolute/path/server.log
```

The workspace is an otherwise empty directory used as Codex's read-only working directory. It keeps the service from exposing the source repository or the operator's home directory to routine agent turns.
