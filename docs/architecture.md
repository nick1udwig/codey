# Architecture and extension points

## Data flow

```text
watch input / dictation
        │ AppMessage
        ▼
PebbleKit JS ── PAM request ──► Go agent endpoint ── RPC ──► Codex app-server
        ▲                         │ validated PAM deltas
        └──── parse/model/deltas ─┘
        │ queued compact AppMessage operations
        ▼
native AgentUi renderer or capability module
```

The backend never controls pointers, coordinates for ordinary widgets, Pebble API names, or raw AppMessage dictionaries. It chooses from a bounded semantic UI vocabulary. The phone validates that vocabulary and the watch validates IDs, capacity, request ownership, and capability names again.

The included Go endpoint has separate packages for PAM validation, HTTP/WebSocket ingress, Codex app-server transport, agent/thread orchestration, and session persistence. App-server connections are long-lived and multiplexed; turns for one watch session are serialized while independent sessions can overlap. Transport resolution is Unix daemon socket, managed stdio process, then configured WebSocket.

## Phone library

`require("pebble-agent")` exposes:

```js
const Agent = require("pebble-agent");

const writer = new Agent.writer.Writer({
  onLine(line) {
    response.write(line); // each call is independently renderable
  }
});

writer.beginScreen("results", "list", { title: "Results", status: true })
  .item({ id: "one", title: "First", action: "result.open" })
  .item({ id: "two", title: "Second", action: "result.open" })
  .endScreen();
```

The writer's convenience methods match all element kinds. `open(kind, attrs)` and `close()` create deeper hierarchy when a consumer needs nested sections or groups.

The parser is push-based:

```js
const parser = new Agent.pam.Parser({
  onNode(node) {
    // Called at the newline, not at end-of-response.
  },
  onError(error) {
    // line and column are available.
  }
});

parser.push(networkChunk);
parser.finish();
```

`ScreenModel` turns parsed nodes into `begin`, `node`, `patch`, `remove`, `end`, and `capability` operations. `MessageQueue` converts them into bounded AppMessage dictionaries, splits UTF-8 text safely, and provides ordered retry/backpressure handling.

## Native UI library

`src/c/agent_ui.h` is independent of AppMessage. A different transport can drive it with:

```c
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

The renderer owns display adaptation, selection, scroll position, status/action rails, touch hit-testing, and numeric field windows. It reports semantic `AgentUiEvent` values through a callback.

To add a layout:

1. Add its name to `LAYOUTS` in `src/common/model.js`.
2. Add the enum/mapping in `agent_ui.h` and `agent_ui.c`.
3. Define geometry in `prv_calculate_layout()` and drawing behavior in `prv_draw_element()`.
4. Add parser/model and watch builds to the test pass.

## Capability registries

Phone modules register a name and handler:

```js
registry.register("calendar", function(attrs, host) {
  // Fetch on the phone, then call host.renderPam(...).
});
```

Native modules use a descriptor instead of a central switch:

```c
agent_capabilities_register(capabilities, "counter", (AgentCapabilityModule) {
  .command = counter_command,
  .event = counter_event,
  .wakeup = counter_wakeup,
  .destroy = counter_destroy,
}, counter_state);
```

Only the module decides which commands and internal action names it accepts. The manager supplies access to `AgentUi`, semantic event emission back to the phone, wakeup dispatch, and active-screen ownership. Timer, stopwatch, and reminder are separate examples in `src/c/capabilities/`; weather is a phone example in `src/common/weather.js`.

## Resource and platform choices

- Target platforms are Emery and Gabbro, matching the touch-capable Core Devices supported by the sibling Bibble project.
- The current linked footprint is about 30 KB of the 128 KB app RAM budget on both targets; screen data is fixed-capacity and does not grow without bound.
- Symbolic images avoid accepting arbitrary agent-provided bitmap allocations.
- Raw touch is used because hotspots and gesture bindings are agent-defined. Button navigation remains a complete fallback whenever touch is disabled.
- Dictation is owned above the binding layer, which prevents a PAM response from replacing long Select.

## Testing strategy

`npm test` exercises chunk-boundary parsing, hierarchy validation, every layout name, patch merging, UTF-8 message splitting, queue ordering/retry, incremental HTTP and WebSocket consumption, settings, registry extension, weather cards, and writer output. It also compiles native protocol helpers with strict warnings plus AddressSanitizer and UndefinedBehaviorSanitizer, starts the demo HTTP server on a loopback port to verify line-by-line delivery, executes the configuration page against a simulated DOM, and runs the Go server's PAM/RPC/transport/API integration suite.

See [testing.md](testing.md) for the emulator matrix and the remaining hardware-only checks.

`npm run build:watch` compiles and links every native module independently for both round and rectangular targets and reports the platform memory footprint.

## Screen refresh and power use

Passive UI changes share a 60-second refresh limit, including the app-owned
clock, weather, countdowns, and server status/results. Changes accumulate in the
model and complete screens are laid out once when painted. An interaction
refreshes elapsed values and flushes pending changes immediately; its short
animations remain responsive. Subsequent passive updates wait until at least
60 seconds after the most recent paint. Checking uses a static indicator.
This controls Agent's layers; system-owned dictation and notification screens
are controlled by Pebble OS.

The capability host runs once per minute and also refreshes on input. Stopwatch
elapsed time uses wall-clock timestamps, so reduced repainting does not lose
elapsed time. Timer/alarm deadlines still use OS wakeups; three-second alert
vibrations and retries after wakeup failures have scoped timers. Job checks
use one-shot timeout timers rather than a per-second polling counter. Completed
job responses can buzz immediately while their visual changes wait for a paint.

No-op element/status patches avoid layout work, and unchanged job records avoid
flash writes. The phone reuses weather for 15 minutes and suppresses identical
weather packets; unit/location-setting changes invalidate the cache. These reduce
scheduled CPU work, storage writes, and radio/network traffic. Battery-life
improvements have not been measured on hardware.

## Collection integration boundary

Notes and To Do share a remembered dashboard tile, while their capability
modules retain independent records and commands. Both allocate stable local
identities; note edits and task completion preserve them. See
[collections](collections.md) for the planned provider adapter, canonical store,
outbox, revision, and conflict boundaries. Remote synchronization is not yet
implemented.
