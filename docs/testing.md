# Testing before hardware

The project has a useful pre-hardware test boundary. Parser, model, transport, phone bridge, backend fixture, configuration, watch compilation, most interaction logic, persistence, and wakeup behavior can be checked locally. Microphone quality, physical touch behavior, Bluetooth/phone integration, and real power timing still need devices.

## Repeatable automated checks

Run:

```sh
npm test
npm run build:watch
```

`npm test` currently includes:

- 92 JavaScript tests covering PAM at every chunk boundary, byte and hierarchy limits, all layouts/elements, patches/removals, UTF-8 AppMessage splitting, queue retry/staleness, HTTP and WebSocket cancellation/timeouts, settings, weather, the capability registry, writer output, onboarding, native dashboard preservation, and dictation input through the full PebbleKit-to-agent-to-render bridge.
- Native C tests built with `-Wall -Wextra -Werror`, AddressSanitizer, and UndefinedBehaviorSanitizer. These cover metadata parsing and escaping, strict signed 32-bit bounds, bounded copies, and duration parsing/formatting.
- 12 integration tests covering every demo-agent route, actual loopback HTTP response streaming, HTTP error behavior, and configuration-page hydration/submission through both Pebble close mechanisms.
- Go tests covering strict request/output PAM handling, output at arbitrary model-delta boundaries, invalid-model containment, persisted conversation threads, Codex RPC initialization and fallback order, real loopback HTTP and downstream WebSocket requests, and app-server stdio, WebSocket, and WebSocket-over-Unix-socket transports.

The watch build compiles and links the same sources for both target platforms. The current static footprint is 62,110 bytes on Emery and 62,622 bytes on Gabbro, leaving about 66 KiB of the 128 KiB RAM budget for heap.

### Streaming efficiency regressions

Phone tests verify that UTF-8 truncation stops after the requested prefix while
preserving splitting behavior for Unicode, malformed surrogates, and small byte
budgets. Go tests cover bounded PAM line storage, maximum-length CRLF at every
split, emitted-byte ownership across buffer reuse, emission failures, and strict
validation around display-text repairs.

Run the repeatable server benchmark with:

```sh
go test ./internal/pam -run '^$' -bench BenchmarkOutputStream -benchmem -count=3
```

It streams 48 text elements using one-byte, 32-byte, and whole-response chunks.
On the development host, buffering and normalization improvements reduced the
32-byte case from about 47 to 33 microseconds and from 78,218 to 38,488 allocated
bytes per response. These are host measurements, not device battery results.

### Collection efficiency regressions

```sh
go test ./internal/collectionstore -run '^$' -bench 'Benchmark(CollectionCounts|NoteSnapshot)$' -benchmem -benchtime=10x
```

The fixture contains 100 notes with approximately 67 KiB bodies. A development-host
run before/after the read optimizations measured:

| Operation | Before | After | Allocated bytes before → after |
| --- | ---: | ---: | ---: |
| Collection counts | 35.95 ms | 0.105 ms | 29,570,308 → 4,588 |
| Note snapshot | 37.73 ms | 22.76 ms | 29,829,582 → 268,967 |

These are ten-iteration host measurements, not physical battery or Bluetooth
latency measurements. The index adds a small persistent database cost and is
maintained during record writes. Snapshot creation still scans the collection;
it now avoids allocating full note bodies in Go.

Phone tests cover one-request first pages, unchanged metadata/count suppression,
watch reconnects, count reconciliation, durable journal compaction and storage
failures. Store tests cover summary fields, intact canonical bodies, immutable
pagination after records change, and counts matching active snapshots. Native
sanitizer tests verify zero writes for unchanged previews, three instead of ten
writes for a single changed title in eight rows, and invalidation/recovery after
an interrupted write. Combining watch collection handlers reduced each watch's
code/data footprint by 905 bytes without adding BSS.

## Emulator checks completed

### Emery (rectangular)

- Streamed dynamic screens containing every visible element type, then patched, appended, selected, scrolled, and removed content.
- Exercised list, grid, card, progress, form, choice, modal, action-bar, status-bar, and symbolic-image rendering.
- Opened a native number field, changed it using the declared step, confirmed it, and observed the semantic input sent to PebbleKit JS.
- Started, paused, resumed, reset, replaced, and persisted timers/stopwatches. A timer exited in the background and relaunched the app at expiry. Replacing a timer no longer lets the old wakeup finish the new timer.
- Scheduled a reminder, relaunched through its wakeup, acknowledged it, and verified its completion state.
- Held Select through the app-wide long-click recognizer and entered the system dictation UI. The SDK simulator exercised the failure callback; successful transcription-to-agent delivery is covered by the phone-bridge test but remains a device check.
- Repeated malformed and boundary-value render traffic without an app fault. App shutdown reported no retained heap allocation.

### Gabbro (round/touch target)

- Streamed a two-column grid and custom action rail on the round display.
- Verified round-safe title/content insets and fully visible Up, Select, and Down symbols.
- Replayed the dynamic render stress sequence without a native fault.
- Compiled the touch-service code under `PBL_TOUCH`. The installed SDK's emulator had touch disabled at runtime, so taps, drags, hotspots, and swipes are not claimed as emulator passes.

## Still requires hardware (and a paired phone)

### Timer crash regression

A physical Emery crash after dictation returned `duration=5s` was captured with
`pebble logs --phone` (the default phone connection needs no IP). In the affected
build, PC `0x5778` is inside newlib `strtol`, loading `_impure_ptr` through an
absolute address. That implementation is not safe in the relocated watchapp.
Duration and reminder timestamp parsing now use the bounded native integer
parser. Native sanitizer tests cover suffixes, signed limits, and overflow;
check both watch ELF symbol tables for absence of `strtol` and `_impure_ptr`.
Hardware verification: dictate “Set a timer for 5 seconds”, then verify the
countdown and completion without an app fault while watch logging is attached.

### Remaining device checks

The native scheduler suite now runs the real capability host and scheduler with
mocked clock, persistence, wakeup and UI APIs under ASan/UBSan. It covers
concurrent timer/alarm expiry, repeated alerts, individual acknowledgment,
snooze, pause/resume, close/reopen recovery, capacity, failed storage/wakeups,
corrupt records, and stopwatch dashboard updates. Watch builds reject newlib
state symbols (`_impure_ptr`, `_ctype_`, etc.) that are unsafe in relocated
watchapps. Host sanitizer success alone cannot detect that class of bug.

Emulator checks on Emery and Gabbro show simultaneous timer/alarm notifications,
independent acknowledgment, and an ongoing timer in the dashboard. The fixture
uses the production scheduler and UI with seeded local commands.

Hardware acceptance for the dashboard update: create two timers and an alarm;
Back to the dashboard and verify the running rows; cancel one timer with X;
verify completion navigates to Notifications, repeated buzzing, independent
acknowledgment and snooze. Close/reopen with active work and compare remaining
time. Assign a Quick Launch button and verify automatic dictation, while menu
and wakeup launches show the dashboard. These hardware checks remain pending
until exercised on the updated app.

- A successful real microphone/dictation session, including cancellation, noisy speech, Unicode transcription, and permission/connectivity failures.
- Physical tap targeting, drag scrolling, every swipe direction, action-rail taps, touch-disabled fallback, and edge behavior on both touch displays.
- Bluetooth disconnect/reconnect, Android and iOS background behavior, configuration through the real phone app, HTTP buffering differences, WebSocket reconnects, authorization, and geolocation permission flows.
- Haptic feel, reminder audibility/visibility, real wakeup accuracy across sleep/reboot/time-zone changes, and timer/reminder coexistence with other apps.
- Battery use, long-running stopwatch drift, memory behavior over many conversations, and sunlight/low-light readability.

Do not treat emulator wakeup timing, simulated dictation, or mouse-based touch as a substitute for the corresponding hardware checks.

Concurrent-alert regressions cover reused model IDs, delivery retries before and
after relaunch, a 10-second timer
expiring while a 60-second timer is open, and alarm expiry over dashboard,
remote response, stopwatch, and timer screens. Notification focus changes
preserve outstanding capability commands while suppressing late render traffic.


### Pixel dashboard regression

The generated resource bundle builds on Emery and Gabbro. The JS bridge suite
covers New Chat resetting/persisting a session before its dictation acknowledgment,
canceling old responses, keeping subsequent normal dictation in that session,
and routing Weather locally without a model request. Native scheduler tests cover
all five dashboard action bindings, the Calendar agenda request, phone-routed explicit task actions without collection persistence,
archive/restore, counts, storage failure, capacity and text limits, opening and
refreshing the separate Notifications list, returning home, and concurrent expiry.

Both Emery and Gabbro dashboards were visually checked with the generated assets
and fully visible cards. On Emery, Calendar,
Notifications (with existing due timers/reminders), and Todos open via buttons.
Real microphone transcription, physical touch, phone geolocation, and New Chat's
end-to-end device handshake remain hardware checks.

If the phone simulator reports a successful installation but leaves the app menu
empty, the SDK's packet installer works through `pebble repl --emulator emery`:

```python
from libpebble2.services.install import AppInstaller
AppInstaller(pebble, 'build/codey.pbw').install()
```

Notification progress regression checks 0%, 25%, paused stability, resumed 50%,
100% completion, removal after acknowledgment/cancellation, and seven-day duration
bounds. The native scheduler sends explicit timer/alarm kind and elapsed percentage
metadata. The SDK radial primitive defines zero at 12 o’clock and clockwise growth;
empty models draw no notification icons or labels.

### Failure delivery regression

Regression coverage replays the unquoted multiword screen title at every chunk
split, verifies strict request parsing and rejection of ambiguous repairs, and
checks terminal error lines after a header or partial screen. Bridge tests ensure
that the original failure reason reaches the watch with the response-begin ID,
is not replaced by “no screen,” does not emit success/idle notifications, and
allows a subsequent request to succeed. Native response-state tests cover errors
before any screen, stale IDs, terminal failure, pre-handshake timeout, and retry.

Todo and failure regressions also cover local voice parsing with preserved case/Unicode and HTTP 0/401/503 explanations without HTML parser errors. Hardware checks: drag long todo text both ways, scroll a long checklist, hold Talk to open the menu, tap outside to dismiss, and dictate through both conversation options.

The revised dashboard and conversation overlay were visually checked on Emery and Gabbro. Emery button checks confirmed Back dismisses the overlay, Down opens Todos, and Up opens Notifications. Screenshots are in `docs/screenshots/`.

Time-bar tests verify Todos and Calendar flags and absence of an Add item row. Weather tests cover summary values, day/night/precipitation icons, background refresh isolation, cache writes, timeouts, and retaining a new summary across dashboard navigation. `dashboard-weather-emery.png` uses an injected synthetic 58F moon forecast for layout verification, not live weather.

### Interactive PAM controls

Regression coverage includes local action construction and bounds, range snapping,
clockwise/counterclockwise dial seam handling, generated dictation fallback,
custom answers bypassing regexes with screen context, server validation of skill
examples, and skill installation into a temporary state directory. Slider/dial
screens were rendered using an isolated emulator fixture; the slider confirmation
opened a native five-minute timer without an agent request, then the synthetic
timer was canceled. See `pam-slider-emery.png` and `pam-dial-emery.png`. Physical
slider/dial gestures and microphone answers still need hardware checks.

## Background requests

`internal/jobs` tests connection cancellation without worker cancellation,
explicit cancellation, duplicate submission, durable retrieval acknowledgements,
restart recovery, and retention. HTTP tests check authentication and job routes.
`tests/jobs.js` covers the single bounded wait, no continued polling, manual
refresh/cancel, durable IDs, ambiguous-submission retries, and stale responses.
The bridge tests verify completion buzz messages without unsolicited rendering,
manual PAM retrieval, conversation context, stable capability invocation IDs,
and acknowledgement only after watch presentation. Native tests cover job rows,
status checks, cancel/dismiss actions, and watch persistence.

Opening Notifications is covered by native tests for immediate Checking labels,
failed-check fallback, and no refresh loop during list rebuilds. JS tests cover
all ongoing jobs, exclusion of terminal/retrieved jobs, overlapping pane opens,
transient checking state, and row-only bridge updates without unsolicited
rendering or vibration.

## Touchscreen arming

The native `touch_guard_test` exercises same-target double taps, one-use arming,
expiry, target changes, tap-then-hold and tap-then-drag, unarmed hold/drag rejection,
menu targets, screen/input resets, edge retargeting, and clock wrap. The watch
handler gates touchdown, movement and liftoff before any mutation or hold timer;
physical click handlers do not use the gate. Both Emery and Gabbro SDK builds
compile the touch integration. Physical touchscreen behavior still requires a
hardware smoke test.

## Minute refresh efficiency regression

The native suite checks the passive paint deadline (including clock wrap),
immediate user refresh, one idle host callback per minute, no separate stopwatch
callback, accurate elapsed values on interaction, unchanged-job write suppression,
and one-shot job-check timeout behavior. Existing schedule tests retain exact
short deadlines, repeated alerts, wakeup failure fallback, and persistence.
Phone tests cover fresh weather reuse, duplicate packet suppression, stale-cache
fetching, and invalidation after unit changes. The full npm suite and both watch
builds pass. Emery screenshots confirm dashboard and Todos clock rendering and
physical-button navigation; the emulator was shut down with `pebble kill`.
Physical display timing and battery savings still require hardware.

## Notes, collection preference, and unlock ripple

The native sanitizer suite covers two-tap checkbox completion, note add/edit,
exact-match ambiguity, stable IDs across edits/relaunches, capacity, write failure,
operation replay, persisted tile preference, and archived todo identities.
Ripple tests cover half-width travel and reflected points at rectangular edges
and the circular bezel, including grazing contacts. Phone tests cover note voice
regexes, preserved text, and bypassing both agent and timer interpretation. Go PAM
tests accept the note add/edit/list commands. The full suite passes (80 phone
tests, seven integration tests, native cases, and all Go packages), and both watch
builds pass. The PAM skill validator also passes.

An Emery fixture rendered the full note, Edit note action, and remembered Notes
dashboard tile; screenshots were inspected and the emulator shut down. The SDK
emulator does not provide validated touchscreen/dictation coverage: confirm on
hardware that the first checkbox tap only ripples, the second archives, the next
contact stops the ripple immediately, guarded holds open the collection menu,
and Edit note dictation replaces only the selected note.

## Phone-owned Notes and ripple preference

Notes storage tests now exercise the phone repository: complete Unicode bodies,
summary-only list pages, content pagination with lossless reconstruction, stable
IDs and operation replay, and failed writes preserving prior data. Bridge tests
cover on-demand list/read, quiet completion, echoed request tokens, and the
disabled ripple preference. Native tests verify list/read/page/edit requests write
no note bodies. Settings-page tests cover default-on hydration and saving the
ripple toggle as false.

## Dashboard telemetry and compatibility removal

The pre-alpha app reads only current storage/protocol formats. Watch-to-phone
Notes migration, earlier schedule conversions, missing to-do ID backfilling, the
one-time wakeup upgrade, and old-watch onboarding have been removed.

Status tests cover the current multi-bucket quota API, paginated active-thread
counting without loading conversation turns, unavailable data, bearer auth,
method checks, once-per-minute requests, and stale endpoint response rejection.
The full suite includes 83 phone tests, native sanitizer cases, seven integration
tests, and all Go packages. Emulator screenshots verify dashboard layout; real
touch and dictation remain hardware checks.

## Backend collection synchronization

`npm test` includes the two-slot journal/replay/alias tests, native collection
persistence checks, and Go transactional/provider fixtures. The shared engine
tests include unknown delivery, interrupted enumeration, and late acknowledgments
of older revisions. `pebble build` verifies Emery/Gabbro; server release targets
remain linux/{amd64,386,arm,arm64} and darwin/arm64 with CGO disabled.
Authenticated provider accounts, real PebbleKit termination, OAuth browser return,
and hardware remain separate qualification gates; see the operations runbook.

Collection latency: phone logs report `collection read <kind> <action> ms=…`
(HTTP/setup work before queuing the list) and `collection Bluetooth ack ms=…`
(the compact list send until transport acknowledgment). These logs exclude titles
and credentials. Watch cached previews require no network; verify initial loads,
reopening after restart, empty collections, pagination, and offline refresh errors
on hardware. Local server timings do not measure phone networking or Bluetooth.

### Collection and calendar regressions

CalDAV fixtures cover discovery, Basic auth, calendar-query expansion, distinct
recurrence identities, all-day/timed creates, lost PUT responses and conditional
retries, external-edit conflicts, cross-origin href rejection, and incomplete
recurrence data. Store tests check chronological paging, exact counts, event
validation and reconciliation restricted to the observed window. Phone tests
check immediate task completion from cached pages, event summaries/details, and
agent animation only after remote dispatch. Setup tests exercise four-step
progress, service-specific fields, changing the destination, and independent
double-tap/ripple preferences. Native tests cover single tap/hold and structural
refresh bypass after notifications.

Real provider accounts, physical touch/holds, Bluetooth timing, and OS overlay
return still require device verification. No claim of a sub-second phone or
provider response follows from the host fixtures.

The sync-engine regression also verifies that a remote resource observed after a
lost create response is not imported as a duplicate before the conditional retry
acknowledges its original canonical record. A headless Chromium check with mocked
services verified actual hidden-field CSS and all three inline setup paths.

## Completed efficiency changes (2026-09-15)

The full `npm test` suite passes: 96 phone cases, collection regressions, ten
native ASan/UBSan executables, 12 integration cases, and all Go packages.
`go test -race ./internal/agent ./internal/collectionsync ./internal/httpapi`
also passes. Both SDK targets and the CGO-disabled server release build pass.

New regressions cover durable job acknowledgment compaction and retry, batched
journal writes, coalesced/backed-off polling, stale credentials, shared status
scans with canceled callers, immediate mutation wakeups, snapshot schema upgrades
and pinned pages, bounded page decoding, and bitmap cache allocation failures.

Emery and Gabbro emulators rendered the retained dashboard icons and Codey poses.
GDB counted one artwork bitmap load per request animation, with 76 / 62 calls
to the app resource-range wrapper respectively; the audit predicted about
1,520 / 1,220 row reads without caching. Both caches were null after the animation.
The temporary cache is also released on navigation, window disappearance,
shutdown, or timer failure; failed bitmap allocation retains row rendering.
The native cache fixture verifies one load across 20 frames, pose invalidation,
allocation failure without repeated retries, later retry, and complete cleanup.
All emulator, simulator, and debugger processes used for these checks exited.

Final measurements and implementation tradeoffs are in `efficiency-audit.md`.
API-call counts and synthetic host timings do not measure physical battery use.
