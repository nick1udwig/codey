# codey

A voice-driven assistant for **Pebble Time 2** and **Pebble Round 2**.
Speak to your watch and get answers as lists, cards, forms, and other interactive screens.
Timers, alarms, reminders, todos, notes, and weather are built in.

codey includes a watchapp and a self-hosted service that uses your Codex login.
You run the service on your own computer or server.
Other Pebble models are not currently supported.

## Get started

You need a supported watch paired with the Pebble mobile app, an internet-connected phone, and a computer running an installed, signed-in Codex CLI under the same user account as the service.

### Run the agent service

Install the service on Linux or Apple Silicon macOS:

```sh
curl -fsSL https://github.com/nick1udwig/pebble-agent/releases/latest/download/install.sh | bash
```

On Linux, the installer offers to start a systemd user service and saves its generated bearer token in `~/.config/codey/environment` (or under `$XDG_CONFIG_HOME`).
Otherwise, it prints manual startup instructions.

For private access from your phone over Wi-Fi or cellular, follow the [Tailscale setup](docs/server.md#private-phone-access-with-tailscale).
It gives you an HTTPS endpoint while keeping the backend on `127.0.0.1:8787`.
See [server setup](docs/server.md) for networking, manual startup, and configuration.

### Install and connect the watchapp

1. Install the codey `.pbw` through the paired Pebble mobile app.
   To build the bundle yourself, see [Development](#development).
2. Open **codey** in the phone app's watchapp list and tap its settings gear.
3. Enter your server base URL (for example, `https://YOUR-SERVER/codey`) and bearer token, then tap **Save & close**.
4. Launch **codey** on the watch.
   The dashboard should say **codey connected**.

The phone needs internet access to open the settings page.
Use HTTPS or WSS; unencrypted connections are only suitable for trusted private development networks.

## Everyday use

Press **Select** on the dashboard to talk.
Try “start a five-minute timer,” “remind me in an hour to check the oven,” “to-do buy milk,” or “what's the weather?”
Common commands run locally; other requests go to your agent.

- **Up** opens Notifications, where you can check requests and open completed answers.
- **Down** opens Todos.
  Notes are available by tapping, then holding the same tile.
- **Hold Select** on the dashboard to choose **New Chat**; on other screens, it starts dictation.
- **Back** returns home; pressing it again exits the app.
- **Touch controls** generally need two taps to activate.
  Drag lists or text directly to scroll.

Requests can keep running while you use another screen.
Open Notifications to check again after the completion notification window ends.
Local lists work offline; voice and weather need the phone.

See the [user guide](docs/user-guide.md) for gestures, alarms and snoozing, notes, settings, and troubleshooting.

## Development

The app uses C on the watch, JavaScript for the phone bridge, and Go for the agent service.
Install Node.js, Go 1.24+, and the Repebble SDK with Emery and Gabbro support, then run:

```sh
npm test
npm run build:watch
npm run build:server
```

Outputs are `build/codey.pbw` and `build/codey-server`.
No npm runtime dependencies need installing.

The [developer guide](DEVS.md) covers the source layout, local demo server, UI changes, protocol, and testing.
For backend configuration and deployment, use [server setup](docs/server.md).

## Privacy

Agent requests go through your server to Codex.
Server logs at `~/.pebble-agent/server.log` include prompts and responses; treat them and their backups as sensitive.
Weather sends the phone's coordinates to Open-Meteo.
The bearer token is stored on the phone, so use an endpoint you trust.
