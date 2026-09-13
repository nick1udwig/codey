# Agent backend contract

## HTTP

The phone sends:

- Method: `POST`
- `Content-Type: text/x-pebble-agent-markup; version=1; charset=utf-8`
- `Accept: text/x-pebble-agent-markup; version=1`
- Optional `Authorization: Bearer …`
- Body: one PAM request document

Return status `2xx` and stream raw PAM bytes. Do not wrap PAM in JSON, an SSE `data:` field, Markdown fences, or an OpenAI/Anthropic provider envelope. Flush after every useful line. Chunk boundaries may occur anywhere; newline boundaries are the commit points.

If the phone runtime exposes progressive `XMLHttpRequest.responseText`, lines reach the watch immediately. A runtime that buffers HTTP still produces the same final result. Use WebSocket when guaranteed incremental delivery is required.

## WebSocket

The phone opens the configured `ws:`/`wss:` endpoint with subprotocol `pam.v1`, then sends one complete PAM request as a text message. The bearer token is included in a nested `auth` request node because browser-style WebSockets cannot set an Authorization header. Send one or more text messages containing PAM chunks, then close normally (`1000`).

Prefer WSS. Avoid putting long-lived high-value credentials directly on a watch/phone client; a short-lived backend session token is safer.

## Request nodes

```pam
pam version=1
request id=42 protocol=pam/1 session=1788123456-12345
  input action=result.open element=row-2 kind=select text= value=
  context layout=list screen=results selected=row-2
  device model=pebble_time_2 now=1788220800 platform=emery shape=rect touch=true utc_offset_minutes=-420
done
```

- `request.id` is a 1–65535 transport generation, not a global conversation ID.
- `request.session` is stable in phone-local storage and may key backend conversation state.
- `input.kind` is `dictation`, a button/gesture name, `field`, or `capability`.
- `input.text` contains dictation.
- `input.action`, `element`, and `value` contain a semantic UI event.
- `context` describes the currently rendered agent screen.
- `device` lets an agent favor, for example, a two-column grid on round hardware without emitting pixel geometry. `now` is Unix time in seconds and `utc_offset_minutes` is the phone's offset east of UTC, allowing absolute reminder times to be resolved without guessing the user's clock.

Treat every field as untrusted client input. Authenticate the session separately and authorize external side effects on the backend.

## Suggested agent instruction

Use this as a starting system/developer instruction for the model that chooses the interface:

```text
Return only Pebble Agent Markup version 1 (PAM), never JSON, Markdown, or prose outside PAM.
Start with exactly: pam version=1

PAM is line-streamed. Emit the screen line as soon as you know the best layout, then emit useful
children one complete newline-terminated line at a time. Indent children with exactly two spaces.
Use quoted attribute values for whitespace. Keep copy concise enough for a watch.

Choose one layout from text, list, menu, grid, card, progress, form, choice, modal. Use stable,
short element IDs. Visible elements are section, item, text, metric, progress, field, choice,
action, image, spacer. Bind inputs with bind and input=up|select|down|back|tap|swipe-left|
swipe-right|swipe-up|swipe-down. Never attempt to bind long Select; it is reserved for dictation.
End a screen with done.

Use patch target=<id> for later updates and remove target=<id> for deletion. Do not reference an
element before emitting it.

For a timer, stopwatch, weather lookup, or reminder, prefer a root capability node over pretending
the operation happened. Allowed commands and attributes follow the supplied PAM capability schema.
Do not invent capabilities. Never claim an external side effect succeeded unless the backend has
actually completed it or the watch capability reports success.
```

Supply the detailed layout/element/capability portion of [protocol.md](protocol.md) to the model as tool/schema context. Enforce the same allowlist server-side; model instructions are not a security boundary.

## Production adapter pattern

1. Parse the request with `Pam.Parser` or another strict implementation.
2. Load conversation/session state and any authorized tools.
3. Ask the model for PAM under the instruction above.
4. Validate each complete output line before flushing it downstream.
5. Stop and emit `error message="…"` on invalid structure rather than forwarding arbitrary text.
6. Persist only the state needed for the next semantic event.

The included `examples/server.mjs` is a deterministic transport fixture, not a production AI or authentication service. The real reference implementation is `cmd/codey-server`; see [server.md](server.md).

## Codex settings

The Go backend accepts an optional request child such as:

```pam
  backend model=gpt-5.6-luna effort=xhigh fast_mode=true web_search=live file_access=none network_access=false shell_access=false auto_review=false
```

These are configuration attributes, not model instructions. The Go parser validates
them and removes the entire node from the model-facing request. Missing attributes
use server model/effort defaults, fast mode on, and restrictive tool defaults. Generic PAM endpoints
may ignore this node if they do not support Codex settings. See [server settings](server.md).
