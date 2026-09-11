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

The corresponding environment variables are `PEBBLE_AGENT_MODEL` and `PEBBLE_AGENT_EFFORT`. These values are server defaults. Phone settings can override the model and effort for each request.

The phone settings provide model and effort selection plus web search (disabled,
cached, live), filesystem access (runtime files only, read-only, workspace
writes), command execution, command network access, and automatic approval
review. Defaults disable web search, commands, user-file access, command network
access, and auto-review. Permission settings do not affect local timers, alarms,
dictation, phone weather, or the transport connection to Codex.

`GET /v1/models` uses the same bearer authentication and returns the installed
Codex `model/list` catalog, including supported reasoning efforts and server
defaults. It supports cross-origin requests from the static settings page using
an explicit Authorization header and no cookies. A custom model with blank
effort uses that model's advertised default; blank model and effort use server
defaults. Unsupported selections produce an error rather than silently changing
models. The phone bridge preloads model choices before opening settings, including for
local HTTP/WS endpoints. The page also has a refresh button; browser refresh may
be blocked as mixed content for HTTP endpoints. In that case, save the endpoint
and reopen settings to load through the phone bridge.

Permission options are allowlisted PAM `backend` attributes, excluded from the
model-facing document. They resolve to a thread-local named Codex permission
profile. No user files grants only the platform's minimal runtime paths; read-only
allows file reads; workspace-write additionally grants writes under `--workspace`.
Command execution and network access are independent. Shells inherit only core
environment variables. Project instruction files and memory injection are disabled.
Inherited MCP servers, plugins, and app tools are disabled because their privileges
are not controlled by the local command sandbox.

Auto-review off means `approvalPolicy=never` and `approvalsReviewer=user`: operations
requiring additional permission are denied. Auto-review on means `on-request` and
`auto_review`: Codex may review and approve exceptions beyond the selected baseline.
It is not blanket approval. Unexpected interactive client requests are rejected;
there is no manual approval UI on the watch. Managed server restrictions remain
in force and can reject requested settings.

Permission profiles are isolated by session, workspace, and permission settings.
Changing permissions uses a separate conversation; returning to a previous profile
resumes its conversation. Model/effort changes keep the same conversation.
Legacy threads without a recorded permission profile are not reused. Each turn
inherits the resolved thread permissions; it must not re-send the thread-local
profile name, which app-server otherwise resolves against global disk config.

This implementation was verified with Codex CLI 0.153.2 and its generated app-server
schema. Named permissions use the experimental API handshake; unsupported servers
fail explicitly. See the official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).


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

The PAM `request.session` value and permission profile map to a persisted Codex thread. The default state file is the user cache directory's `pebble-agent/sessions.json`, written with mode `0600`; use `--state /absolute/path.json` to move it. Restarting either service resumes the thread. If Codex no longer has a persisted thread, the mapping is discarded and a new one is created.

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

The workspace is an otherwise empty directory by default. It becomes the writable root only when workspace writes are selected in phone settings. Read-only and workspace-write modes allow reads outside that root; no-user-files mode restricts reads to minimal runtime paths.
