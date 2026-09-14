# Codex-backed agent server

`codey-server` is the real self-hosted PAM endpoint.
It accepts a watch request over streaming HTTP or the `pam.v1` WebSocket subprotocol, runs the corresponding conversation turn through Codex app-server, validates the model's PAM one complete line at a time, and streams those lines to the phone.

## Release installation

See the [one-line installer](../README.md#run-the-agent-service) for prebuilt Linux and Apple Silicon binaries.
Go is only needed for source builds.
Publishing a GitHub release triggers `.github/workflows/release-server.yml`, which tests the service, cross-compiles five targets and attaches binaries, `SHA256SUMS`, and `install.sh`.
Release asset uploads require mutable releases; repositories enforcing immutable releases need to attach assets before publishing.

The installer verifies SHA-256 checksums and installs into `~/.local/bin`.
Release targets are Linux x86-64, x86 (32-bit), ARMv7, ARM64, and macOS Apple Silicon.
Set `CODEY_VERSION=vX.Y.Z` to select a specific release.
On Linux, the generated token is saved in `~/.config/codey/environment` (or under `$XDG_CONFIG_HOME`).
The service starts with the user manager, normally at login.
Noninteractive installs do not enable a service.

The installer offers a systemd **user** unit on Linux and otherwise prints manual instructions.
It never uses sudo or enables lingering.
Configure a reverse proxy or VPN to reach the default loopback listener from the phone.
Use `systemctl --user edit codey.service` to customize the unit.
Stop and disable it with `systemctl --user disable --now codey.service`.

## Prerequisites

- Go 1.24 or newer to build the binary.
- A current Codex CLI on `PATH`.
- A working Codex CLI login on the same operating-system account that runs the service.
- A TLS reverse proxy, VPN, or trusted private network through which the paired phone can reach the service.

Build and start it:

```sh
go build -o build/codey-server ./cmd/codey-server
export CODEY_TOKEN="replace-with-a-long-random-secret"
./build/codey-server --listen 0.0.0.0:8787
```

Set the watchapp server URL to `http://SERVER:8787` and enter the same token.
`POST /` is also accepted, but `/v1/agent` is the stable endpoint.
`GET /healthz` reports process health.

The server refuses a non-loopback listener when `CODEY_TOKEN` is empty.
`--allow-unauthenticated-public` exists for tightly controlled development environments, but it is deliberately explicit.
The bearer token is read from an environment variable rather than a command-line value so it is not exposed in a process listing.

## Private phone access with Tailscale

Install [Tailscale](https://tailscale.com/docs/how-to/quickstart) on the backend computer and phone, sign into the same tailnet, and connect the phone's Tailscale VPN.
The example below runs the backend in tmux and publishes the `/codey/` path over private HTTPS on port **443**.

### Run the server in tmux

Install tmux with your package manager and install the agent server as described above.
If the installer started a systemd service, stop it with `systemctl --user stop codey.service` before running the same backend in tmux.
Create a session:

```sh
tmux new-session -s codey
```

Inside that session, set a long random token and start the server:

```sh
export CODEY_TOKEN="replace-with-a-long-random-secret"
~/.local/bin/codey-server --listen 127.0.0.1:8787
```

For a source build, use `./build/codey-server` from the repository root instead.
Keep the token for the phone settings; when replacing an installed service, you can reuse the token from `~/.config/codey/environment`.
Press **Ctrl-b**, then **d** to detach while the server keeps running.
Use `tmux attach-session -t codey` to return, and **Ctrl-c** to stop the server.
Tmux does not restart the backend after a crash or reboot; use the installed systemd service for automatic startup.
See the [tmux manual](https://man.openbsd.org/tmux) for session controls.

### Serve at /codey on port 443

In another terminal on the backend computer:

```sh
curl --fail http://127.0.0.1:8787/healthz
tailscale serve --bg --https=443 --set-path=/codey/ http://127.0.0.1:8787
tailscale serve status
```

Use `sudo` for Tailscale commands if required, and follow any consent link to enable HTTPS and MagicDNS.
Use the full hostname printed by Serve and save this endpoint in codey's phone settings, together with the token:

```text
https://MACHINE.TAILNET.ts.net/codey
```

This adds `/codey/` alongside an existing site at `/` on port 443.
The client appends API routes beneath this base URL, and Serve strips `/codey` before forwarding to the backend.
[Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) stays private to your tailnet and persists with `--bg`; leave public Funnel sharing disabled.
To remove this endpoint, run `tailscale serve --bg --https=443 --set-path=/codey/ off`.

### Verify from the phone

Open `https://MACHINE.TAILNET.ts.net/codey/healthz` in the phone browser to check connectivity.
Then use **Load available models** in codey settings with the token saved and make a watch request.
Repeat over cellular with Tailscale connected.
Keep the backend computer awake; if access fails, check the VPN, server logs, and [tailnet rules](https://tailscale.com/docs/features/access-control) for TCP port 443.
Keep bearer authentication enabled and limit access to your intended users or devices.
HTTPS certificates publish the hostname in certificate transparency logs; see [certificate setup](https://tailscale.com/docs/how-to/set-up-https-certificates).

## Server URLs

Enter a base URL such as `foo.com/bar/baz/biz`; an omitted scheme defaults to HTTPS.
The client uses `https://foo.com/bar/baz/biz/v1/jobs/`, `/v1/models`, `/v1/status`, and `/v1/agent` beneath the same base path.
Existing URLs ending in `/v1/agent` are also accepted, and trailing slashes are ignored.
HTTP, HTTPS, WS, and WSS are supported; job, model, and status calls use the corresponding HTTP scheme.
Use the separate token field for credentials; URL credentials, queries, and fragments are rejected.

## Codex configuration

Defaults:

```text
model:  gpt-5.6-luna
effort: xhigh
fast:   on
```

Set them when the process starts:

```sh
./build/codey-server \
  --model gpt-5.6-luna \
  --effort xhigh
```

The corresponding environment variables are `CODEY_MODEL` and `CODEY_EFFORT`.
These values are server defaults.
Phone settings can override the model and effort for each request.

The phone settings provide model and effort selection plus web search (disabled, cached, live), filesystem access (runtime files only, read-only, workspace writes), command execution, command network access, and automatic approval review.
Phone settings default to Luna / xhigh, fast mode, and live web search.
Commands, user-file access, command network access, and auto-review remain off.
Older callers without a backend node retain disabled web search.
Missing fast_mode defaults on.
Permission settings do not affect local timers, alarms, dictation, phone weather, or the transport connection to Codex.

`GET /v1/models` uses the same bearer authentication and returns the installed Codex `model/list` catalog, including supported reasoning efforts and server defaults.
It supports cross-origin requests from the static settings page using an explicit Authorization header and no cookies.
A custom model with blank effort uses that model's advertised default; blank model and effort use server defaults.
Unsupported selections produce an error rather than silently changing models.
The phone bridge preloads model choices before opening settings, including for local HTTP/WS endpoints.
The page also has a refresh button; browser refresh may be blocked as mixed content for HTTP endpoints.
In that case, save the endpoint and reopen settings to load through the phone bridge.

Fast mode is sent as the allowlisted `fast_mode=true|false` backend attribute.
Each turn requests `serviceTierForTurn=fast` or `default`, so turning it off does not inherit a previous fast tier.
Fast mode changes preserve the conversation.
Codex maps fast to priority processing; model/account availability still applies.
Existing saved preferences are preserved when defaults change.

Permission options are allowlisted PAM `backend` attributes, excluded from the model-facing document.
They resolve to a thread-local named Codex permission profile.
No user files grants only the platform's minimal runtime paths; read-only allows file reads; workspace-write additionally grants writes under `--workspace`.
Command execution and network access are independent.
Shells inherit only core environment variables.
Project instruction files and memory injection are disabled.
Inherited MCP servers, plugins, and app tools are disabled because their privileges are not controlled by the local command sandbox.

Auto-review off means `approvalPolicy=never` and `approvalsReviewer=user`: operations requiring additional permission are denied.
Auto-review on means `on-request` and `auto_review`: Codex may review and approve exceptions beyond the selected baseline.
It is not blanket approval.
Unexpected interactive client requests are rejected; there is no manual approval UI on the watch.
Managed server restrictions remain in force and can reject requested settings.

Permission profiles are isolated by session, workspace, and permission settings.
Changing permissions uses a separate conversation; returning to a previous profile resumes its conversation.
Model/effort changes keep the same conversation.
Legacy threads without a recorded permission profile are not reused.
Each turn inherits the resolved thread permissions; it must not re-send the thread-local profile name, which app-server otherwise resolves against global disk config.

This implementation was verified with Codex CLI 0.153.2 and its generated app-server schema.
Named permissions use the experimental API handshake; unsupported servers fail explicitly.
See the official [app-server documentation](https://learn.chatgpt.com/docs/app-server) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).


## App-server transport selection

Each connection attempt follows this order:

1. Discover the running daemon with `codex app-server daemon version` and connect to its reported Unix socket using WebSocket-over-Unix-socket.
   `--app-server-unix /absolute/path.sock` skips discovery.
2. Start and retain a managed `codex app-server --stdio` child process.
3. Connect to `--app-server-url`, which defaults to `ws://127.0.0.1:4222`.

Use `CODEY_CODEX` to select another Codex executable, `CODEY_APP_SERVER_UNIX` for an explicit socket, and `CODEY_APP_SERVER_URL` for the fallback URL.
If a remote WebSocket app-server requires a bearer token, put it in `CODEX_APP_SERVER_TOKEN` or change the variable name with `--app-server-token-env`.

Every transport performs the required `initialize` request and `initialized` notification.
A dropped long-lived connection is re-resolved in the same order on the next request.
A connection attempt has a five-second per-transport timeout by default.

Every JSON protocol message sent to or received from Codex app-server is logged at `info` with `direction=to_app_server` or `direction=from_app_server`, the selected transport, and the complete raw payload.
This includes dictated prompts, model output deltas, thread metadata, errors, and any server requests or client responses.
Phone endpoint bearer credentials are consumed at the HTTP/WebSocket boundary and are never forwarded in the model-facing PAM document.

## Logs and rotation

Start runtime debugging with:

```text
~/.pebble-agent/server.log
```

The server mirrors its structured stderr output into that file.
Before a complete log record would take the active file past 10 MiB (10,485,760 bytes), it rotates the file.
It retains five backups: `server.log.1` is newest and `server.log.5` is oldest.
A single record larger than 10 MiB remains intact.
The active log is created with mode `0600`, and a newly created `.pebble-agent` directory is private to the current user.

Set `CODEY_LOG_FILE` or use `--log-file /absolute/path` to choose a different file.
Use `--log-file -` to log only to stderr.
The payloads are intentionally not content-redacted, so protect the active file and every backup as sensitive conversation data.

These logs prove what crossed the Go server/Codex boundary.
If they show a completed, valid PAM response but the watchapp exits, collect Pebble watch logs next: that failure is downstream in the phone bridge, AppMessage delivery, or native watch process.

## Conversations and streaming

The PAM `request.session` value and permission profile map to a persisted Codex thread.
The default state file is the user cache directory's `pebble-agent/sessions.json`, written with mode `0600`; use `--state /absolute/path.json` to move it.
Restarting either service resumes the thread.
If Codex no longer has a persisted thread, the mapping is discarded and a new one is created.

Only final-answer agent-message deltas are forwarded.
Commentary is ignored.
Output is limited to 128 KiB, 2,048 bytes per line, 96 PAM nodes, eight indentation levels, and 48 screen elements.
Layouts, element kinds, bindings, patches, removals, and built-in capability commands are allowlisted before each line is flushed.
Invalid output becomes a valid root PAM `error` instead of arbitrary bytes reaching the watch.
A missing final `done` is supplied for an otherwise valid screen.

Agent execution is unlimited by default (`--turn-timeout 0`).
A positive duration sets an execution deadline independent of the phone notification window.

## Persistent request jobs

The phone generates and saves a 30-character hexadecimal ID before submitting PAM to `POST /v1/jobs/{id}`.
The server persists the accepted job before replying with JSON.
Repeating the ID and identical request returns that job; a different request using the same ID receives HTTP 409.
All job routes use the same bearer authentication as `/v1/agent`.

- `GET /v1/jobs/{id}` returns status and a completed PAM result, if available.
- `GET /v1/jobs/{id}?wait=45` waits once for completion, bounded to 120 seconds.
  Disconnecting this GET never cancels the job.
  The phone uses one wait and makes no further automatic polls after it expires.
  Opening Notifications explicitly refreshes all ongoing jobs once; overlapping checks for the same job are coalesced.
  This batch never opens result screens or buzzes.
- `POST /v1/jobs/{id}/cancel` explicitly cancels the work.
  The transitional `canceling` status becomes `canceled` after execution unwinds.
- `POST /v1/jobs/{id}/ack` releases the server result only after the phone has cached it and the watch confirms presentation.
  The ID/hash remain as a deduplication tombstone.

Jobs are stored as private JSON files beside session state, under `jobs/`.
Unretrieved results have no expiry by default.
`--job-retention 168h` expires terminal jobs seven days after completion, whether retrieved or not; cleanup runs every minute and during lookups/submissions.
The finite retention setting also bounds tombstone lifetime and therefore the duplicate-submission guarantee.
Running jobs are never removed by retention.
On restart, unfinished jobs become failed with an explicit restart message; completed results remain retrievable.
Cancellation does not roll back prior changes.

Work in the same conversation is serialized.
Up to 32 agent jobs may be active on the server, with 24 unviewed requests in the phone/watch notification list.
Retrieved results remain cached on the phone.
Failed/canceled entries can be dismissed.
Restoring the original endpoint is required to check a job after changing servers, so a new server token is never sent to an old endpoint.

The streaming `/v1/agent` endpoint is used by the standalone client and demo protocol.
The watch uses the job routes.
Reverse proxies must route `/v1/jobs/` as well; a shorter proxy timeout only ends the completion wait, not the work.

## Internet-facing deployment

Keep the Go listener on `127.0.0.1` when a reverse proxy runs on the same host.
Terminate TLS at that proxy, disable response buffering for `/v1/agent`, permit WebSocket upgrades if using WSS, and forward `Authorization`.
The service already sends `Cache-Control: no-store` and `X-Accel-Buffering: no`.

Do not expose an unencrypted bearer token over the public internet.
The service is designed for one trusted operator's Codex account; it is not a multi-tenant authorization or billing boundary.

## Useful flags

Run `codey-server -h` for the complete set.
Common options include:

```text
--listen 127.0.0.1:8787
--model gpt-5.6-luna
--effort xhigh
--connect-timeout 5s
--turn-timeout 0
--job-retention 0
--state /absolute/path/sessions.json
--workspace /absolute/path/empty-workspace
--log-level debug|info|warn|error
--log-file /absolute/path/server.log
```

The workspace is an otherwise empty directory by default.
It becomes the writable root only when workspace writes are selected in phone settings.
Read-only and workspace-write modes allow reads outside that root; no-user-files mode restricts reads to minimal runtime paths.

## Dashboard status

The authenticated `GET /v1/status` endpoint reads Codex app-server telemetry on demand.
`remainingPercent` is the lowest remaining percentage across the primary and secondary windows of `rateLimitsByLimitId["codex"]` from `account/rateLimits/read`.
It is quota remaining, not context-window capacity.
Missing quota data is `null`, including accounts without reported limits.

`activeThreads` counts loaded threads whose current status is `active`, using `thread/loaded/list` and metadata-only `thread/read` calls.
It covers the connected app-server instance, including its threads outside codey.
The state is `working` when any thread is active, `idle` otherwise, and `error` for a thread system error.
Unavailable status/counts remain unknown.
The endpoint has a 15-second deadline.

The phone fetches at startup and at most once per minute using the existing watch tick; unchanged telemetry sends no additional watch packet.
Dashboard rendering keeps its existing passive minute limit.
The time button shows battery charge at the top left and the sleeping/thinking pictograph with active thread count at the top right.
The brain and quota remaining sit below the text in the Talk to codey button.
There is no separate dashboard status bar.
Unknown values display dashes and a question face.
The pictographs are drawn directly because the watch system font does not supply emoji glyphs.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).

## Durable notes and to-dos

The collection API starts independently of Codex. Configure `--data-dir` and
`CODEY_TOKEN`; optional `--integrations-config` enables provider management.
See [collection server operations](collections-server-operations.md) for OAuth,
Nextcloud setup, encryption keys, backup, restore, and recovery.
