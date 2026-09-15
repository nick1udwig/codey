# codey

A voice-driven assistant for **Pebble Time 2** and **Pebble Round 2**.
Speak to your watch and get answers as lists, cards, forms, and other interactive screens.
Timers, alarms, reminders, todos, notes, calendars, and weather are built in.

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

## Backend sync setup

Notes, to-dos, and calendars default to **Server only**: they are stored in `~/.codey/data`
without an external account. Configure them independently in phone settings:

| Collection | Choices | Authentication |
| --- | --- | --- |
| To-dos | Server only, Todoist, Google Tasks | None, Todoist API token, Google OAuth |
| Notes | Server only, Nextcloud Notes | None, Nextcloud username and app password |
| Calendar | Server only, CalDAV | None, calendar username and app password |

Select a service under **To-do sync setup**, **Notes sync setup**, or **Calendar sync setup**. Selecting
Nextcloud Notes reveals its HTTPS URL, username, and app-password fields in the
same settings page. Todoist reveals an API-token field. **Connect**, choose a
destination, **Preview connection**, then **Activate this destination**. Errors
stay beside the fields; these buttons never save-and-close the Pebble webview.
Each panel shows the current step out of four: connect account, choose destination,
review and activate, then active. The last step explains how to open the collection
on the watch. Use **Change destination** to return from review, or **Change account
or destination** after activation. The active backend is shown separately from the
dropdown selection.

The phone obtains a short-lived, setup-only session before opening settings.
The normal server bearer token is not sent to the settings website. Provider
credentials go directly over HTTPS to your server and are never saved as phone
preferences. On first use or after changing your server URL/token, save those
connection settings and reopen settings once to obtain a session. Sessions expire
after 30 minutes; reopen settings to renew. **Save & close** saves other phone
preferences; activation/disconnection takes effect immediately on the server.

- **Todoist:** enter your Todoist API token in the settings fields, connect,
  select a project, preview, and activate the destination.
- **Nextcloud Notes:** enter the HTTPS Nextcloud base URL (including its installation
  subpath, if any), username, and an app password in the settings fields. Choose
  a category, preview, and activate. The Nextcloud Notes app must be available.
  For a private Nextcloud hostname, add `"private_hosts": ["cloud.example"]` to
  `~/.codey/integrations.json` and restart codey.
- **CalDAV:** enter the HTTPS calendar URL or calendar-home URL supplied by your
  calendar app (for example, `https://cloud.example/remote.php/dav/calendars/USER/`),
  username, and app password. Connect, select an event calendar, preview, and
  activate. The server imports the next 90 days, including recurring events and
  exceptions, and sends newly created events to that calendar. Edits/deletions
  made in your calendar app appear on the next sync (normally within a minute).
  Use the same CalDAV account in an Android or iOS calendar app to see the events
  there. For a private hostname, add it to `private_hosts` in
  `~/.codey/integrations.json` and restart codey. The server must support CalDAV
  calendar-query recurrence expansion; setup reports incompatible servers.
  Event editing, invitations, and creating recurring series use your calendar
  app. Codey shows its own agenda; it does not publish Pebble OS Timeline pins.
- **Google Tasks:** obtain a Google OAuth web client with access to the Tasks API
  and register the exact callback `<your-codey-HTTPS-base>/integrations/oauth/callback`.
  Put the following in `~/.codey/integrations.json` (merge with any existing config),
  restrict its permissions to `0600`, and restart codey:

  ```json
  {
    "oauth": {
      "googletasks": {
        "client_id": "YOUR_CLIENT_ID",
        "client_secret": "YOUR_CLIENT_SECRET",
        "redirect_url": "https://YOUR-SERVER/codey/integrations/oauth/callback"
      }
    }
  }
  ```

  Then select Google Tasks and **Continue to Google authorization**. Navigation
  happens inside the current webview, without closing/reopening it. Save other
  changed phone preferences before navigating. Authorize Google, choose a task list, preview, and
  activate. The server loads this file automatically; no extra startup flag is
  needed. Provider tokens are encrypted on the server. Do not commit this file.
- **Server only:** no setup is required for a new collection. To disconnect an
  existing backend, select Server only for that collection and click **Use Server only**.
  This preserves server and remote records; pending delivery may need an explicit
  stop decision.

Existing server records are exported to a backend only when you select the export
option during setup. See [server-side configuration and recovery](docs/collections-server-operations.md)
for OAuth, private-host configuration, backups, and interrupted deliveries.

## Everyday use

Press **Select** on the dashboard to talk.
Try “start a five-minute timer,” “remind me in an hour to check the oven,” “to-do buy milk,” or “what's the weather?”
Common commands run locally; other requests go to your agent.

- **Up** opens Notifications, where you can check requests and open completed answers.
- **Down** opens the selected collection. **Hold Down** opens **To Do / Notes**.
  Tap then hold the collection tile to open the same menu. The top-left date tile opens Calendar.
- **Hold Select** on the dashboard to choose **New Chat**; on other screens, it starts dictation.
- **Back** returns from a note or event to its list, then home; pressing it on home exits the app.
- **Touch controls** default to two taps, with a water ripple on the first tap.
  Disable **Require double tap** for a single tap or hold. **First-tap ripple
  animation** can be toggled independently. Drag lists or text directly to scroll.

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
