# Pebble Agent

Pebble Agent is a native Repebble watchapp whose interface is chosen by an agent at runtime. The agent streams **Pebble Agent Markup (PAM)**, a small hierarchical line protocol; the phone parses each finished line and immediately forwards a compact render operation to the watch. The title and first item can therefore appear before the rest of the response has arrived.

The project targets Core Devices' `emery` (Pebble Time 2) and `gabbro` (Pebble Round 2) platforms. It uses the current [Repebble developer documentation](https://developer.repebble.com/) and SDK APIs—not the legacy Rebble documentation.

## What works

- Agent-selected `text`, `list`/`menu`, `grid`, `card`, `progress`, `form`, `choice`, and `modal` layouts.
- `section`, `item`, `text`, `metric`, `progress`, `field`, `choice`, `action`, `bind`, `image`, `spacer`, and `hotspot` elements.
- Incremental add, patch, append, and remove operations while a response streams.
- Agent-defined Up, Select, Down, Back, tap, hotspot, and swipe actions.
- Long Select is always reserved for dictation. The transcription is sent to the configured agent endpoint.
- Native-style status and action bars, scrolling, selection, touch hit-testing, and a real `NumberWindow` for numeric form fields.
- Modular timer, stopwatch, weather, and reminder capabilities.
  - Timer and stopwatch state survive app restarts.
  - Timers and reminders use Pebble wakeups and vibration.
  - Weather can render agent-supplied values or obtain current-location forecasts through Open-Meteo on the phone.
- HTTP response streaming and WebSocket transports, with AppMessage queuing, retries, stale-response rejection, and UTF-8-safe chunking.

## Build and test

Prerequisite: a current Repebble Pebble SDK installation with Emery and Gabbro support.

```sh
npm test
npm run build:watch
```

The watch bundle is written to `build/pebble-agent.pbw`.

`npm test` runs the streaming/model/transport suite, sanitizer-enabled native C checks, a real loopback HTTP streaming test, and configuration-page logic tests. The emulator matrix and the checks that still require physical hardware are recorded in [docs/testing.md](docs/testing.md).

To exercise the transport without an AI backend:

```sh
npm run demo:server
```

Then expose `http://127.0.0.1:8787` to the paired phone (or bind the fixture to a reachable interface with `AGENT_DEMO_HOST=0.0.0.0`) and put that URL in the app settings. The fixture deliberately streams one PAM line at a time.

## Agent endpoint

Configure an HTTP(S) or WebSocket endpoint from the app's phone settings. The watch sends input such as:

```pam
pam version=1
request id=7 protocol=pam/1 session=1788123456-12345
  input action= element= kind=dictation text="show weather" value=
  context layout=list screen=home selected=
  device model=pebble_time_2 platform=emery shape=rect touch=true
done
```

The endpoint responds with PAM directly, using `Content-Type: text/x-pebble-agent-markup; version=1`. For example:

```pam
pam version=1
screen id=forecast layout=card title="San Francisco" status=true
  metric id=temperature label=Now value="68°F"
  text id=conditions value="Clear"
  item id=today title=Today subtitle="72 / 55°F"
  bind id=refresh input=select action=weather.refresh title=Refresh
done
```

See [the backend contract](docs/backend.md) for transport behavior and a suggested agent instruction, and [the PAM specification](docs/protocol.md) for the full UI and capability API.

## Library boundaries

The implementation is intentionally reusable:

- `src/common/pam.js` — incremental PAM parser and serializer.
- `src/common/writer.js` — server-friendly streaming writer API.
- `src/common/model.js` — validated screen model and render deltas.
- `src/common/watch-protocol.js` — compact, queued AppMessage bridge.
- `src/common/capabilities.js` — phone capability registry.
- `src/c/agent_ui.h` — native dynamic UI library API.
- `src/c/agent_capabilities.h` — native capability module registry API.
- `src/c/capabilities/` — timer, stopwatch, and reminder modules.

Adding a screen format is isolated to the model plus renderer. Adding a capability is a registry entry; it does not require changing the transport dispatcher. See [architecture and extension points](docs/architecture.md).

## Configuration page

The app expects its settings page at `https://nick1udwig.github.io/pebble-agent/config/`. The source is in `docs/config/` and is ready for GitHub Pages. Until that page is deployed, change `CONFIG_URL` in `src/common/settings.js` or serve the directory at that address.

Bearer tokens are stored by PebbleKit JS in phone-local storage. Use HTTPS in production and keep the endpoint responsible for authentication, authorization, model access, and conversation state.

## Design references

The watch implementation follows Repebble's current guidance for [layers and standard UI components](https://developer.repebble.com/guides/user-interfaces/layers/), [touch and touch navigation](https://developer.repebble.com/guides/events-and-services/touch/), [dictation](https://developer.repebble.com/guides/events-and-services/dictation/), [wakeups](https://developer.repebble.com/guides/events-and-services/wakeups/), and [PebbleKit JS communication](https://developer.repebble.com/guides/communication/using-pebblekit-js/).
