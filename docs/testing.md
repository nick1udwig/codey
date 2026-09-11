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
