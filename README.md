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
- The URL of a PAM-compatible agent service, plus a bearer token if that service requires one.

Pebble Agent is the watch client. It does not include an AI provider or a hosted agent account; whoever provides your agent service should give you its endpoint and any required token.

## Install and connect

1. Install the Pebble Agent `.pbw` with your paired Pebble mobile app.
2. Find **Agent** in the phone app's watchapp list and open its settings using the gear icon.
3. Enter the agent endpoint you were given. `https://` and `wss://` are recommended; local development endpoints may also use `http://` or `ws://`.
4. Add the optional bearer token, choose weather units and a timeout, then tap **Save & close**.
5. Launch **Agent** on the watch. The home screen should say **Agent connected**.

The gear icon is supplied by the Pebble mobile app. The settings page requires internet access when it opens.

## Use the app

Hold Select until dictation opens, then speak normally. Your transcription is sent to the configured agent. A **Thinking** indicator means the watch accepted the transcription and is waiting for that service to respond.

The agent can choose the controls and presentation that fit each response:

- Up and Down usually move through or scroll the current screen.
- Short Select activates the selected item.
- Back returns or closes the screen unless the agent assigns it another action.
- Taps, hotspots, and swipes may be available when the screen defines them.
- Long Select is always reserved for new dictation and cannot be replaced by the agent.

Depending on the configured agent, you can ask for things such as “start a ten-minute timer,” “show my stopwatch,” “what is the weather?”, or “remind me in two hours.” Timers, stopwatches, and reminders run on the watch; current-location weather is fetched by the phone.

## Troubleshooting

**The watch stays on Thinking.** The transcription reached Pebble Agent, but the endpoint has not returned a usable response. Check the phone's connection, endpoint URL, token, and configured timeout. The endpoint must return Pebble Agent Markup (PAM), not ordinary chat text or JSON.

**The home screen says Configure endpoint.** Open Agent's gear icon in the paired phone app, save a valid endpoint, then reopen the watchapp if needed.

**Dictation reports Voice unavailable, Voice disabled, or Voice connection failed.** Check microphone/voice permissions and the phone/watch connection, then retry. Voice recognition depends on the system dictation service.

**Weather cannot get a location.** Allow location access for the Pebble mobile app and make sure the phone has network access.

**The settings page will not open.** Confirm the phone is online. The hosted page is [nick1udwig.github.io/pebble-agent/config/](https://nick1udwig.github.io/pebble-agent/config/).

## Privacy and security

Dictated text and watch interactions are sent to the endpoint you configure. The bearer token is kept in the Pebble phone runtime's local storage and sent to that endpoint. When current-location weather is requested, the phone sends coordinates to Open-Meteo. Use an endpoint you trust and prefer HTTPS or WSS.

For source builds, backend integration, PAM, library APIs, extension points, and testing, see [DEVS.md](DEVS.md).
