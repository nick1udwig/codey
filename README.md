# Pebble Agent

Pebble Agent puts a voice-driven agent on your Pebble. Hold Select, say what you need, and the agent chooses a watch-friendly screen for its answer: a list, grid, card, form, progress view, or another supported layout.

The app is built for Repebble and currently supports:

- Pebble Time 2 (`emery`)
- Pebble Round 2 (`gabbro`)

Other Pebble models are not included in this build.

## What you need

- A supported watch paired with the Pebble mobile app.
- The Pebble Agent `.pbw` watchapp.
- An internet connection on the paired phone.
- A computer or server that can run the bundled Go agent service and the authenticated Codex CLI.
- A URL the paired phone can use to reach that service, plus its bearer token.

Pebble Agent includes the watch client and a self-hosted agent service. The service uses your local Codex login; it is not a hosted account or public relay.

## Run the agent service

Install and sign in to the Codex CLI, install Go 1.24 or newer, then build the service from this repository:

```sh
go build -o build/pebble-agent-server ./cmd/pebble-agent-server
export PEBBLE_AGENT_TOKEN="replace-with-a-long-random-secret"
./build/pebble-agent-server --listen 0.0.0.0:8787
```

The server uses `gpt-5.6-luna` with `xhigh` reasoning by default. Configure either at startup with `--model` and `--effort`, or the `PEBBLE_AGENT_MODEL` and `PEBBLE_AGENT_EFFORT` environment variables.

It first looks for the running Codex app-server daemon over its Unix socket. If none is available, it starts `codex app-server --stdio`; a configured app-server WebSocket is the final fallback. The service exits at startup if no transport can initialize.

The phone endpoint is:

```text
http://YOUR-SERVER:8787/v1/agent
```

Use the same `PEBBLE_AGENT_TOKEN` value in the app settings. Plain HTTP is suitable only on a trusted private network for development. For internet access, put the service behind an HTTPS/WSS reverse proxy and keep the Go listener on loopback. See [Server setup](docs/server.md) for connection, security, persistence, and deployment options.

## Install and connect

1. Install the Pebble Agent `.pbw` with your paired Pebble mobile app.
2. Find **Agent** in the phone app's watchapp list and open its settings using the gear icon.
3. Enter your server's `/v1/agent` endpoint. `https://` and `wss://` are recommended; a trusted local network may also use `http://` or `ws://`.
4. Enter the server's bearer token, choose weather units and a timeout, then tap **Save & close**.
5. Launch **Agent** on the watch. The home screen should say **Agent connected**.

Settings also select the Codex model and reasoning effort. Use **Load available
models** to fetch the server's supported choices. Permissions control web search,
user-file access, command execution, command networking, and auto-review. All tool
permissions start off. Auto-review can approve exceptions to the selected baseline;
when off, additional-permission requests are denied. Changing permissions uses a
separate conversation. See [backend settings](docs/server.md#codex-configuration).

The gear icon is supplied by the Pebble mobile app. The settings page requires internet access when it opens.

## Use the app

Hold Select until dictation opens, then speak normally. The phone first matches
common commands locally, using normalized speech and regular expressions inspired
by Bibble. Only unmatched dictation is sent to the configured Codex agent.
**Thinking** can appear briefly while the phone processes the transcription.

Local examples: “start a five-minute timer,” “set a timer for one hour and thirty
minutes,” “set an alarm in ten minutes,” “set an alarm for 7:30 pm,” “wake me up
tomorrow at seven am,” “remind me in an hour to check the oven,” “pause the
stopwatch,” “show my timers,” “cancel all alarms,” and “what's the weather?”
These commands need no agent endpoint; weather still uses the phone's location
and weather service. Each new timer gets its own delivery identity.

Clock alarms use the phone's local timezone. AM/PM, noon/midnight, or 24-hour
HH:MM notation is required; without a date they mean the next occurrence.
Ambiguous times (“set an alarm for seven”), recurring alarms, commands targeting
an individual timer, and requests with additional instructions fall back to
Codex unchanged. Matching is for complete phrases, never just a command buried
inside a longer sentence. Relative durations support 1 second through 7 days.

Agent opens to a local dashboard with the time, unacknowledged notifications,
running or paused timers, alarms/reminders, and the stopwatch. It works without
the phone. Select an entry to open its controls. Back returns to the dashboard
without stopping anything; Back from the dashboard exits the app. On a timer,
the X (Down) cancels only that timer, Select pauses/resumes it, and the arrow
(Up) returns home.

You can have four timers and four alarms/reminders at once. Finished alerts
return you to Notifications and buzz every three seconds until acknowledged or
snoozed. Open a finished entry and press Select to acknowledge, or Down to
snooze ten minutes. Acknowledging one leaves other notifications active.
If you close Agent with an unacknowledged alert, it requests a wakeup to remind
you again in a minute. Pebble only lets the app vibrate while running; if the
system refuses a wakeup, Agent displays “keep Agent open” instead of silently
promising a background alert.

Assign Agent to a button in the watch's Quick Launch settings. Launching with
that shortcut opens dictation automatically; opening Agent from the app menu
shows the dashboard, and a scheduled wakeup shows notifications.

The agent can choose the controls and presentation that fit each response:

- Up and Down usually move through or scroll the current screen.
- Short Select activates the selected item.
- Back returns to the dashboard; from the dashboard it exits the app.
- Taps, hotspots, and swipes may be available when the screen defines them.
- Long Select is always reserved for new dictation and cannot be replaced by the agent.

Depending on the configured agent, you can ask for things such as “start a ten-minute timer,” “show my stopwatch,” “what is the weather?”, or “remind me in two hours.” Timers, stopwatches, and reminders run on the watch; current-location weather is fetched by the phone.

## Troubleshooting

**The watch stays on Thinking.** The transcription reached Pebble Agent, but the endpoint has not returned a usable response. Check the phone's connection, endpoint URL, token, timeout, server log, Codex login, and app-server availability. The endpoint must return Pebble Agent Markup (PAM), not ordinary chat text or JSON.

**Where are the server logs?** Start debugging with `~/.pebble-agent/server.log`. The server also writes the same records to stderr. It rotates the file at 10 MiB and retains five backups, from `server.log.1` (newest) through `server.log.5` (oldest). Set `PEBBLE_AGENT_LOG_FILE` or pass `--log-file /absolute/path` to move it; pass `--log-file -` for stderr only.

**The home screen says Configure endpoint.** Open Agent's gear icon in the paired phone app, save a valid endpoint, then reopen the watchapp if needed.

**Dictation reports Voice unavailable, Voice disabled, or Voice connection failed.** Check microphone/voice permissions and the phone/watch connection, then retry. Voice recognition depends on the system dictation service.

**Weather cannot get a location.** Allow location access for the Pebble mobile app and make sure the phone has network access.

**The settings page will not open.** Confirm the phone is online. The hosted page is [nick1udwig.github.io/pebble-agent/config/](https://nick1udwig.github.io/pebble-agent/config/).

## Privacy and security

Dictated text and watch interactions are sent to the endpoint you configure, then to Codex through the self-hosted service. The server logs every JSON message to and from Codex app-server, including prompts and model responses, in `~/.pebble-agent/server.log`, so that file and its rotated backups must be treated as sensitive conversation data. The bearer token is kept in the Pebble phone runtime's local storage and sent only to the endpoint authentication boundary. When current-location weather is requested, the phone sends coordinates to Open-Meteo. Use an endpoint you trust and prefer HTTPS or WSS.

For source builds, backend integration, PAM, library APIs, extension points, and testing, see [DEVS.md](DEVS.md).
