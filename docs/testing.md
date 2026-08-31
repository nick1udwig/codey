# Testing before hardware

The project has a useful pre-hardware test boundary. Parser, model, transport, phone bridge, backend fixture, configuration, watch compilation, most interaction logic, persistence, and wakeup behavior can be checked locally. Microphone quality, physical touch behavior, Bluetooth/phone integration, and real power timing still need devices.

## Repeatable automated checks

Run:

```sh
npm test
npm run build:watch
```

`npm test` currently includes:

- 45 JavaScript tests covering PAM at every chunk boundary, byte and hierarchy limits, all layouts/elements, patches/removals, UTF-8 AppMessage splitting, queue retry/staleness, HTTP and WebSocket cancellation/timeouts, settings, weather, the capability registry, writer output, onboarding, and dictation input through the full PebbleKit-to-agent-to-render bridge.
- Native C tests built with `-Wall -Wextra -Werror`, AddressSanitizer, and UndefinedBehaviorSanitizer. These cover metadata parsing and escaping, strict signed 32-bit bounds, bounded copies, and duration parsing/formatting.
- Four integration tests covering every demo-agent route, actual loopback HTTP response streaming, HTTP error behavior, and configuration-page hydration/submission through both Pebble close mechanisms.

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

- A successful real microphone/dictation session, including cancellation, noisy speech, Unicode transcription, and permission/connectivity failures.
- Physical tap targeting, drag scrolling, every swipe direction, action-rail taps, touch-disabled fallback, and edge behavior on both touch displays.
- Bluetooth disconnect/reconnect, Android and iOS background behavior, configuration through the real phone app, HTTP buffering differences, WebSocket reconnects, authorization, and geolocation permission flows.
- Haptic feel, reminder audibility/visibility, real wakeup accuracy across sleep/reboot/time-zone changes, and timer/reminder coexistence with other apps.
- Battery use, long-running stopwatch drift, memory behavior over many conversations, and sunlight/low-light readability.

Do not treat emulator wakeup timing, simulated dictation, or mouse-based touch as a substitute for the corresponding hardware checks.
