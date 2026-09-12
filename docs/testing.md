# Testing before hardware

The project has a useful pre-hardware test boundary. Parser, model, transport, phone bridge, backend fixture, configuration, watch compilation, most interaction logic, persistence, and wakeup behavior can be checked locally. Microphone quality, physical touch behavior, Bluetooth/phone integration, and real power timing still need devices.

## Repeatable automated checks

Run:

```sh
npm test
npm run build:watch
```

`npm test` currently includes:

- 47 JavaScript tests covering PAM at every chunk boundary, byte and hierarchy limits, all layouts/elements, patches/removals, UTF-8 AppMessage splitting, queue retry/staleness, HTTP and WebSocket cancellation/timeouts, settings, weather, the capability registry, writer output, onboarding, native dashboard preservation, and dictation input through the full PebbleKit-to-agent-to-render bridge.
- Native C tests built with `-Wall -Wextra -Werror`, AddressSanitizer, and UndefinedBehaviorSanitizer. These cover metadata parsing and escaping, strict signed 32-bit bounds, bounded copies, and duration parsing/formatting.
- Four integration tests covering every demo-agent route, actual loopback HTTP response streaming, HTTP error behavior, and configuration-page hydration/submission through both Pebble close mechanisms.
- Go tests covering strict request/output PAM handling, output at arbitrary model-delta boundaries, invalid-model containment, persisted conversation threads, Codex RPC initialization and fallback order, real loopback HTTP and downstream WebSocket requests, and app-server stdio, WebSocket, and WebSocket-over-Unix-socket transports.

The watch build compiles and links the same sources for both target platforms. At the last run it used about 31 KiB of each platform's 128 KiB RAM budget, leaving about 100 KiB for heap.

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
after relaunch, migration of existing dashboard records, a 10-second timer
expiring while a 60-second timer is open, and alarm expiry over dashboard,
remote response, stopwatch, and timer screens. Notification focus changes
preserve outstanding capability commands while suppressing late render traffic.


### Pixel dashboard regression

The generated resource bundle builds on Emery and Gabbro. The JS bridge suite
covers New Chat resetting/persisting a session before its dictation acknowledgment,
canceling old responses, keeping subsequent normal dictation in that session,
and routing Weather locally without a model request. Native scheduler tests cover
all five dashboard action bindings, the Calendar placeholder, persistent todo addition,
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
AppInstaller(pebble, 'build/pebble-agent.pbw').install()
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
