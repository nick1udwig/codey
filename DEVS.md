# Developing Pebble Agent

This document is for contributors, backend authors, and consumers of the reusable UI/protocol libraries. The end-user setup and controls live in [README.md](README.md).

Pebble Agent is a native C watchapp with a PebbleKit JS phone bridge. An agent returns **Pebble Agent Markup (PAM)**, a bounded, newline-framed tree format. Each complete line can be validated and rendered while later lines are still streaming.

## Quick start

Install Node.js and a current Repebble Pebble SDK with the Emery and Gabbro platforms, then run:

```sh
npm test
npm run build:watch
```

The watch bundle is written to `build/pebble-agent.pbw`. There are no npm runtime dependencies to install.

Useful commands:

```sh
npm run demo:server       # deterministic streaming PAM endpoint on port 8787
npm run build:settings    # local GitHub Pages artifact
```

The demo server is a transport fixture, not a production agent. Point the phone settings at a URL the paired phone can reach; `127.0.0.1` on a development computer is not the phone's loopback address.

## Repository map

- `src/c/main.c` owns the watch lifecycle, AppMessage bridge, dictation, and module wiring.
- `src/c/agent_ui.{h,c}` is the transport-independent native dynamic UI library.
- `src/c/agent_protocol.{h,c}` contains bounded native protocol helpers.
- `src/c/agent_capabilities.{h,c}` is the native capability registry.
- `src/c/capabilities/` contains the timer, stopwatch, and reminder modules.
- `src/pkjs/index.js` connects watch events, agent transport, parsed model operations, settings, and phone capabilities.
- `src/common/` contains reusable CommonJS protocol, model, writer, transport, settings, and capability modules.
- `docs/config/` is the hosted phone configuration page.
- `examples/server.mjs` is the streaming test backend.
- `tests/` contains JavaScript, native sanitizer, browser-page, and loopback integration tests.

## Architecture

```text
watch input or dictation
        │ AppMessage
        ▼
PebbleKit JS ───── PAM request ─────► agent endpoint
        ▲                                │ streamed PAM lines
        └──── parser → model → deltas ───┘
        │ compact queued AppMessage operations
        ▼
native AgentUi renderer or capability module
```

The backend chooses semantic layouts, elements, bindings, and capability commands. It never sends Pebble pointers, native API names, or ordinary widget coordinates. Both the phone and watch validate their boundary, and fixed capacities keep agent output from growing watch memory without limit.

See [docs/architecture.md](docs/architecture.md) for ownership and extension details.

## PAM protocol

PAM is deliberately smaller than TOML, YAML, XML, or a streaming JSON dialect. Newlines are commit points and two-space indentation expresses hierarchy:

```pam
pam version=1
screen id=results layout=list title=Results status=true
  item id=first title="First result" action=result.open
  item id=second title="Second result" action=result.open
done
```

The phone can begin the screen after line two and add the first row after line three. Supported layouts, elements, patches, input bindings, capability schemas, limits, and escaping rules are specified in [docs/protocol.md](docs/protocol.md).

The backend request/response contract, including HTTP streaming, WebSockets, authentication, and a suggested model instruction, is in [docs/backend.md](docs/backend.md).

## JavaScript library

The package entry point is `src/common/index.js`. A linked or installed consumer can use `require("pebble-agent")`; code running at the repository root can use `require(".")`. The entry point exports these modules:

- `pam` — incremental parser, attribute formatting, and serialization helpers.
- `model` — schema validation and `ScreenModel`, which emits render deltas.
- `writer` — a server-friendly line-streaming `Writer`.
- `watchProtocol` — compact AppMessage encoding, UTF-8 chunking, queuing, and retry handling.
- `agentClient` — HTTP and WebSocket PAM transports.
- `capabilities` — the extensible phone capability registry.
- `weather` — the built-in phone-side weather handler.

The package is currently marked `private`, so this is a source/library boundary rather than a published npm package. It can be consumed from a workspace or Git checkout without involving the Pebble UI.

Example streaming backend output:

```js
const Agent = require("pebble-agent");

const writer = new Agent.writer.Writer({
  onLine(line) {
    response.write(line);
  }
});

writer.beginScreen("results", "list", { title: "Results", status: true })
  .item({ id: "one", title: "First", action: "result.open" })
  .item({ id: "two", title: "Second", action: "result.open" })
  .endScreen();
```

`onLine` runs for every independently renderable line. For arbitrary nesting, use `open(kind, attrs)`, `element(kind, attrs)`, and `close()`. `patch()`, `remove()`, `capability()`, and `error()` cover root operations.

The push parser has the same streaming boundary:

```js
const parser = new Agent.pam.Parser({
  onNode(node) {
    // Called as soon as this node's newline arrives.
  },
  onError(error) {
    console.error(error.line, error.column, error.message);
  }
});

parser.push(networkChunk);
parser.finish();
```

Keep `src/common/` compatible with the PebbleKit JS runtime: prefer CommonJS and the ES5-era language features already used there. Node-only adapters belong outside the phone bundle.

## Native UI library

`src/c/agent_ui.h` is independent of AppMessage and can be driven by another transport. Its main lifecycle is:

```c
AgentUi *ui = agent_ui_create(event_handler, dictation_handler, context);

agent_ui_begin(ui, "results", "list", "Results", "", "", 16);
agent_ui_add(ui, &(AgentUiElementSpec) {
  .kind = "item",
  .id = "one",
  .title = "First",
  .action = "result.open",
  .present = AgentUiPresentAll,
});
agent_ui_end(ui);
```

The renderer owns layout adaptation, drawing, scrolling, selection, action/status rails, numeric fields, and touch hit-testing. It reports semantic `AgentUiEvent` values through the callback. Call `agent_ui_destroy()` when the owner exits.

`src/c/agent_capabilities.h` similarly exposes a descriptor-based registry. A module supplies command, UI-event, wakeup, and destroy callbacks. The registry supplies access to the renderer, active-screen ownership, wakeup dispatch, and events back to the phone; each module owns its persistence.

## Adding formats and modules

To add a layout:

1. Add and validate its name in `src/common/model.js`.
2. Add the native enum/string mapping in `src/c/agent_ui.{h,c}`.
3. Define geometry and rendering behavior in the native renderer.
4. Add parser/model/native tests and document the layout in `docs/protocol.md`.

To add a screen element, follow the same phone-schema → compact bridge → native-spec path. Do not add arbitrary remote bitmap loading; symbolic images are intentional memory and trust boundaries.

To add a capability:

1. Decide whether it belongs on the phone (network/location work) or watch (persistent, offline, wakeup, or vibration work).
2. Register its handler with `CapabilityRegistry` or `agent_capabilities_register()`.
3. Keep command dispatch inside the module rather than adding a central transport switch.
4. Add its allowlisted PAM commands to `docs/protocol.md` and cover success, invalid commands, persistence, and event round-trips in tests.

Long Select is owned above agent bindings and must remain reserved for dictation.

## Settings site and GitHub Pages

The watchapp opens:

```text
https://nick1udwig.github.io/pebble-agent/config/
```

Source files live in `docs/config/`. Build the exact deployment artifact locally with:

```sh
npm run build:settings
```

This writes `build/settings-site/`, with a top-level redirect page and the app under `config/`. The configured watch URL therefore stays stable while the artifact still has the top-level entry file GitHub Pages requires.

`.github/workflows/deploy-settings.yml` builds and uploads that artifact, then deploys it to the `github-pages` environment. It runs when relevant files reach `master`, and it can also be started manually from the Actions tab.

Before the first deployment, set **Repository settings → Pages → Build and deployment → Source** to **GitHub Actions**. This is a one-time repository setting; `GITHUB_TOKEN` cannot enable a previously disabled Pages site. After a deploy, test both the root redirect and `/config/` on a phone-sized browser.

If the repository owner or name changes, update `CONFIG_URL` in `src/common/settings.js` as well as documentation. The site is static and requires no Actions secrets.

## Testing

`npm test` runs the protocol/model/transport suite, strict native C tests under AddressSanitizer and UndefinedBehaviorSanitizer, a real loopback streaming server, and settings-page behavior in a simulated DOM.

`npm run build:watch` compiles and links both Emery and Gabbro. `npm run build:settings` checks that all settings source assets exist and assembles the deployable path structure.

The completed emulator matrix and the microphone, touch, Bluetooth, wakeup, and power checks that still require hardware are maintained in [docs/testing.md](docs/testing.md). Do not promote emulator-only dictation or touch results to hardware passes.

## Further documentation

- [Architecture and extension points](docs/architecture.md)
- [Backend contract](docs/backend.md)
- [PAM 1 specification](docs/protocol.md)
- [Test matrix](docs/testing.md)
- [Current Repebble developer documentation](https://developer.repebble.com/)

Use the Repebble documentation for Emery/Gabbro APIs and behavior; do not substitute the legacy Rebble documentation for the current platform.
