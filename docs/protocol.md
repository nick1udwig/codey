# Pebble Agent Markup 1

PAM is a UTF-8, newline-framed tree protocol for dynamic watch interfaces and capability calls. It is not JSON, TOML, YAML, or Markdown.

## Why this format

TOML tables are pleasant for static configuration but do not cleanly express ordered, repeated UI children while they are still arriving. YAML is broad and difficult to parse safely in the Pebble phone runtime. XML is streamable but verbose and requires a substantially larger parser.

PAM has four properties that matter here:

1. A newline commits exactly one node. No later token can change how that line parses.
2. Two-space indentation supplies parent/child hierarchy, and a child can only follow an already-emitted parent.
3. Attributes are bounded `name=value` tokens with one quoting/escaping rule.
4. The parser has no aliases, executable tags, implicit typing, or ambiguous scalars.

As soon as this arrives:

```pam
pam version=1
screen id=results layout=list title=Results
  item id=first title="First result"
```

the watch can show the screen and first row. It does not wait for `done`.

## Lexical grammar

```text
document  = header, newline, { node, newline } ;
header    = "pam version=1" ;
node      = indent, kind, { space, attribute } ;
indent    = { "  " } ;
kind      = lowercase-letter, { lowercase-letter | digit | "_" | "-" } ;
attribute = name, "=", (bare-value | quoted-value) ;
```

- Indentation is exactly two spaces per level. Tabs and skipped levels are errors.
- Blank lines and lines whose first non-space character is `#` are ignored.
- Bare values contain no whitespace.
- Single or double quotes may delimit values.
- Quoted escapes are `\\`, `\"`, `\'`, `\n`, `\r`, `\t`, and `\uXXXX`.
- Duplicate attributes on one line are errors.
- The current implementation accepts at most 2,048 bytes per agent line and eight hierarchy levels.

Attributes remain strings at the protocol boundary. Schema consumers explicitly parse booleans and numbers.

## Root nodes

### `screen`

Begins a new screen and replaces the previous agent screen immediately.

Required attributes:

- `id` — stable identifier, at most 31 UTF-8 bytes on the watch.
- `layout` — one of the layouts below.

Common optional attributes:

- `title`, `subtitle`
- `status=true` — show Pebble's time/status bar.
- `actionbar=true` — reserve a right action rail for Up/Select/Down bindings.
- `columns=1..4` — grid column count; defaults to two.

### `patch`

Updates an existing element. The model merges the supplied attributes with the existing element before forwarding the patch, so omitted fields remain intact.

```pam
patch target=download value=63 subtitle="63 percent"
```

### `remove`

```pam
remove target=stale-row
```

### `done`

Marks the active screen complete and removes its streaming indicator. It does not close the screen.

### `error`

```pam
error message="I couldn't complete that request"
```

### `capability`

Invokes a registered phone-side or watch-side module. See [Capabilities](#capabilities).

## Layouts

- `text` — long prose, explanations, and logs; scrolls by default.
- `list` / `menu` — Pebble-style rows and sections with row selection.
- `grid` — compact choices, app launchers, and numeric tiles with grid selection.
- `card` — a focused fact plus supporting metrics or items.
- `progress` — ongoing work, countdowns, and progress bars.
- `form` — fields, toggles, and submit actions.
- `choice` — radio/check-style decisions.
- `modal` — alerts, confirmations, and important decisions.

These cover Pebble's standard menu/list, scrolling text, card, status bar, action bar, choice dialog, progress, form, and number-input idioms. The renderer adapts geometry to rectangular and round displays.

## Screen elements

Every addressable element should have a unique `id`. If it does not, the phone assigns a response-local ID, but explicit IDs are required for patching and are strongly recommended.

### Content

```pam
  section id=nearby title=Nearby
  item id=cafe title="Coffee shop" subtitle="0.2 mi" action=place.open
  text id=summary value="A paragraph that wraps and scrolls."
  metric id=heart-rate label="Heart rate" value="72 bpm"
  image id=notice title="Heads up" value=warning icon=warning
  spacer id=gap height=16
```

Supported symbolic image icons are `info`, `check`, `warning`, `sun`/`weather`, `timer`, `close`, `up`, `down`, `left`, and `right`. The image element is deliberately symbolic: arbitrary remote bitmaps are not accepted into the watch heap.

### Progress

```pam
  progress id=download title=Downloading value=35 min=0 max=100
```

`value`, `min`, and `max` are integers.

### Forms and choices

```pam
screen id=settings layout=form title=Settings
  field id=servings title=Servings value=2 type=number min=1 max=12 step=1 action=settings.servings
  choice id=metric title=Metric checked=true action=settings.units.metric
  choice id=imperial title=Imperial action=settings.units.imperial
  action id=save title=Save action=settings.save primary=true
done
```

A selected numeric field opens Pebble's native `NumberWindow`. Its confirmed value is returned as an input event.

### Flags

All selectable elements accept:

- `disabled=true`
- `checked=true`
- `selected=true`
- `primary=true`
- `destructive=true`

## Input bindings

An element's `action` is emitted when the user selects or taps it. A `bind` maps a physical or gesture input without drawing another content row:

```pam
  bind id=older input=up action=page.previous title=Older icon=up
  bind id=open input=select action=result.open title=Open icon=check
  bind id=newer input=down action=page.next title=Newer icon=down
  bind id=back-swipe input=swipe-right action=navigate.back
```

Inputs are:

- Buttons: `up`, `select`, `down`, `back`
- Touch: `tap`, `swipe-left`, `swipe-right`, `swipe-up`, `swipe-down`

If Up or Down has no binding, it navigates/selects or scrolls. If Back has no binding, it closes the current window. A right swipe without a binding follows Pebble's Back convention.

Long Select is not bindable. It always starts dictation, regardless of a short-Select binding.

### Touch hotspots

Normal visual elements are automatically tappable. Invisible percentage-based regions are available for custom layouts:

```pam
  hotspot id=map-west x=0 y=20 width=50 height=80 action=map.west
```

Coordinates are percentages of the full display. Prefer element taps unless a genuine free-form region is necessary.

## Capabilities

Capabilities are root nodes so they can execute as soon as their line arrives. The registry allows additional modules without a protocol change.

### Timer

```pam
capability type=timer command=start id=tea title="Tea" duration=5m
capability type=timer command=pause id=tea
capability type=timer command=resume id=tea
capability type=timer command=cancel id=tea
capability type=timer command=show id=tea
```

Durations accept an integer number of seconds or `s`, `m`, `h`, and `d` suffixes. Timers persist and schedule a wakeup.

### Stopwatch

```pam
capability type=stopwatch command=start id=run title="Run"
capability type=stopwatch command=pause id=run
capability type=stopwatch command=resume id=run
capability type=stopwatch command=lap id=run
capability type=stopwatch command=reset id=run
capability type=stopwatch command=show id=run
```

### Weather

Fetch at the phone's current location:

```pam
capability type=weather command=current id=weather location="Current location"
```

Or let the agent supply already-known data without a second network request:

```pam
capability type=weather command=show id=weather location="London" temperature=18 unit="°C" condition=Rain high=20 low=14 wind="12 km/h"
```

Latitude and longitude can be supplied as `latitude` and `longitude`. Weather networking runs in a phone registry module and emits a normal card screen.

### Reminder

```pam
capability type=reminder command=schedule id=medicine title="Take medicine" subtitle="With food" in=2h
capability type=reminder command=schedule id=meeting title="Meeting" at=1788201000
capability type=reminder command=list
capability type=reminder command=cancel id=meeting
capability type=reminder command=cancel_all
```

`at` is a Unix timestamp in seconds; `in` is a duration from 1 second to 7 days.
`alarm` is an alias of `reminder`. Four timers and four alarms/reminders are
persisted independently, including unacknowledged notifications. Use a unique
ID shorter than 32 bytes for each new alert. Each new creation command allocates
a separate alert even if the model reuses an ID; collisions receive a unique
suffix. Use `show` to open an existing alert, or `replace=true` to replace it.
The phone supplies a persisted delivery sequence in `Index` for capability
messages. A retry retains that sequence and cannot restart or duplicate its
alert. The watch persists this delivery identity separately from the model ID.
Timer and reminder/alarm support `show`, `list`, `ack`, `cancel`, and
`cancel_all` (the latter only affects its own category). Timer also supports
`start`, `pause`, and `resume`; alarm/reminder use `schedule`.

Finished alerts appear in the native dashboard and buzz repeatedly until
acknowledged or snoozed ten minutes. Local completion does not trigger an agent
turn. Back returns home without canceling. The native scheduler multiplexes all
deadlines onto one system wakeup; when wakeup scheduling fails, it warns that
Agent must stay open. The native watch sends `ready value=local-active`; the
phone sends `MessageType=bridge` with connection/configuration status instead
of streaming an onboarding screen over the local dashboard.

## Answer arrival notification

The phone sends `MessageType=answer Operation=begin` when a query starts.
After a successful response has finished parsing and any phone capability has
finished, it queues `MessageType=answer Operation=complete`, its `RequestId`,
and `Flags=1` when the `answerVibrate`
setting is enabled (`0` when disabled). This setting defaults to on and appears
as "Answer arrived vibration" on the phone settings page. The watch tracks the
request from its begin message and emits one short pulse on completion, even
if the user has returned to the dashboard. It checks `quiet_time_is_active()`
at delivery time and suppresses the pulse during Quiet Time. Duplicate or stale
completion messages do not vibrate. Startup screens, local timer events,
transport failures, and malformed responses do not send this notification.

## Limits and failure behavior

- The watch stores up to 48 elements per screen.
- Text values are capped at 319 bytes on the watch. Larger values are streamed in UTF-8-safe append chunks and truncated at the final watch buffer boundary.
- Titles, subtitles, IDs, actions, and metadata have smaller fixed limits declared in `agent_ui.h`.
- Unknown kinds/layouts and invalid hierarchy produce a visible protocol error rather than partially executing an unrecognized node.
- A new response supersedes queued operations from an older request. The watch also rejects stale request IDs.
- Capability commands are allowlisted by registries; PAM cannot call arbitrary native functions.


### Dashboard controls

`input` with operation `new-chat` and action `local.new-chat` carries a watch
request ID. PebbleKit JS saves a fresh session ID, cancels the previous response,
and replies with `control`, operation `dictate`, and the same request ID. Only
then does the watch start dictation. The watch rejects stale acknowledgments,
including those superseded by a local navigation or notification revision, and
times out after eight seconds. Ordinary `local.dictate` keeps the current session.

`input` with action `local.weather` invokes the existing local weather capability
on the phone. Calendar is a local placeholder. Todos use the phone collection capability (`add` with quoted `value`, `list`, and `archive`), backed by canonical server records. Notifications
uses a separate native list; arrival of an alert opens it without incrementing
the navigation revision that protects pending capability commands.

### Request failures

The server normalizes a narrowly defined model formatting mistake before strict
validation: an unquoted trailing display-text attribute containing spaces (for
example `title=File search results`) is quoted. It does not relax request parsing,
repair command arguments, or guess around malformed quotes or ambiguous attributes.
Other failures are emitted as a terminal PAM `error message="Request failed: ..."`,
including when only the header or a partial screen has already streamed.

The phone sends `answer begin` before response status/render messages; the watch
binds that phone response ID immediately, so a failure before `render begin` is
accepted. Error status clears loading and incomplete-screen indicators, cancels
success vibration, and rejects subsequent render/status traffic for that request.
The next request can start normally. A 135-second watch watchdog clears Thinking
if the phone never completes delivery; it does not overwrite a newer screen or
an alert. Phone transport timeouts normally report the failure sooner.

The dashboard maps Up to Notifications, Down to Todos, and Select to dictation.
Holding Talk to codey or Select opens a reusable animated overlay menu; outside
taps and Back dismiss it without changing the dashboard. New Chat lives in this
menu. Todo rows use `choice` with `meta` containing `todo=true`, text in `value`,
and the checked flag for archived items. Horizontal touch drags or long Up/Down
pan text; short Up/Down scroll the list. Checking archives, unchecking restores.
Lists are transient eight-record pages. The phone resolves short aliases against the exact view token and displayed revision; no native collection store exists.

Terminal errors replace the content with a scrollable Request failed screen,
including the reason and Try again / Dashboard actions. Transport HTTP 0,
401/403, and other HTTP failures have distinct explanations. Non-PAM HTML error
bodies are not fed to the PAM parser.

### Dashboard weather summaries

The phone sends `bridge operation=weather` with current temperature/unit in
`Value`, low/high in `Subtitle`, and `icon=<condition>` in `Meta`. The native
host caches these fields independently of the current screen and patches only
the dashboard weather tile. This channel neither starts nor completes an agent
request. A native `capability_event operation=weather action=refresh` every 15
minutes requests a background update; startup and saved settings also refresh.
The phone caches validated fetched data for up to an hour. Weather failures leave
the current screen alone. Current Open-Meteo `is_day` selects day/night icons.

Todos and Calendar enable the native time status bar. Todos have no add control:
whole-phrase local regex matching accepts add/create/make/set/put down plus
todo/to-do/to do/task, preserving the trailing task text. The public Pebble SDK
supports Timeline pins and launches from pins, but no direct open-Timeline call;
Calendar remains a placeholder.

### Deferred local actions and range controls

A selectable row can declare `action=local.run capability=reminder seconds=86400
task="Send a card"`. Nothing runs while rendering; selection creates a native
reminder without phone/model traffic. Supported capability types are timer,
reminder and alarm; seconds are 1..604800 and task labels at most 71 UTF-8 bytes.

`field type=slider|dial` declares min, max, step and value integers (0 <= min <
max <= 604800), plus an optional unit label. A local field uses `seconds="$value"`.
Dragging only adjusts; `action=local.submit control=<field-id>` confirms. Select
on a field opens the button-operated number picker, whose Select confirms and
Back cancels. A dial winds through the range clockwise/counterclockwise without
jumping at noon. An ordinary field action sends the confirmed value to the agent.
Interactive metadata must fit 220 bytes; the bridge rejects oversized declarations.
For existing interactive definitions, patches may update only title or an in-range
value; replace the screen to change ranges or actions.

Every generated form/question should include `action=local.answer` titled
"Dictate answer". The phone inserts a fallback for choice/form layouts or screens
containing choice/field elements if omitted; reserve one of 48 slots. Its
`input.kind=dictate-answer` bypasses local speech regexes and goes to the same
agent thread with screen context. Local actions do not generate a model turn.

The maintained advanced examples live in the server's
`internal/agent/skills/pam-ui/` package. On startup the server installs it under
`<state-directory>/skills/pam-ui/`, points the base prompt to SKILL.md, and supplies
full fallback guidance when file-reading tools are disabled. The Codex app-server
must share that filesystem. Native notification and timer behavior is unchanged.

## Notes capabilities

Use `capability type=note command=add value="Call Jane"` to request a real save,
and `capability type=note command=list` to browse. Existing-record edits use the
record picker and its revision-scoped Append / Replace entire note actions.
Text matches and invented IDs cannot authorize an edit. Body pages stay pinned
to one revision, and displayed chunks are never submitted as a full replacement.
See [collections](collections.md) for server ownership and durability handoff.

## Collection protocol version 1

AppMessage keys 0–12 retain their values. New keys are:

| Number | Name | Meaning |
|---|---|---|
| 13 | CollectionProtocol | Version 1 |
| 14 | BridgeSession | Phone-issued bridge session |
| 15 | EventSequence | Monotonic event identity; retransmissions reuse it |
| 16 | ViewToken | Exact alias/revision mapping |
| 17 | DeliveryState | accepted_phone, accepted_server, synced, needs_attention, rejected |
| 18 | ErrorCode | Bounded machine-readable error |

`bridge operation=collections` supplies protocol/session readiness. `collection-view`
sets the token for the matching render request. Lists instead use one
`collection-list` message: Operation is `note`, `task`, or `event`, Value contains up to eight
newline-separated titles (71 UTF-8 bytes each; embedded whitespace is normalized),
ViewToken binds `r0` through `r7` to the exact phone records/revisions, and Meta has
one delivery-state character per row (`p` pending server, `s` synced, `b` backend
pending, `d` saved on server). Flags are completed=1, next page=2, stale=4,
partial=8, first active page=16. Index is the full filtered collection count,
not just the number of preview rows. Event titles include date/time. Subtitle carries the overall status. Only first
active pages replace the persistent title preview. Preview rows have no mutation
or read aliases until a live response arrives. All list messages are guarded by
the same request/navigation checks as render messages. Existing `capability_event` messages
with operation `note`, `todo`, or `calendar` carry list/read/edit/append/complete/restore actions.
The phone resolves an alias only within that exact view. It checks an existing
receipt before rejecting an expired view, so retransmission cannot target a reused
row. `collection-ack` carries the original session/event and delivery state.
The native app retains and retries an unacknowledged mutation in RAM only.

JSON collection routes, schemas, and recovery are documented in
[the collection specification](notes-todos-backend-sync-spec.md),
[JSON schema](collections-api.schema.json), and [operations](collections-server-operations.md).
All routes require bearer authentication. Mutation revisions/sequences are decimal
strings. Snapshot pages are fixed; body pages are UTF-8 safe and revision-pinned.
`POST /v1/sync/snapshots` accepts an optional positive `limit` (capped at 200).
With it, the response includes the first page's `records`, full `total`, `complete`,
and optional `next_cursor`, along with `snapshot_id` and the high-water `cursor`.
Without it, creation returns snapshot metadata with an empty `records` array.
The phone uses `limit: 8` to avoid a second request for the first screen.
Management uses a single-use `/v1/integration-sessions` ticket and server cookies.
Its authenticated POST accepts `{public_url, provider, collection_id}` from phone settings. The
HTTPS base (including any proxy prefix) is bound to the ticket/session, not inferred
from forwarded headers or stored as a mutable global URL. The provider choice
opens that service’s setup section for the selected collection; authentication and activation remain explicit.
Management sessions use secure cookies,
never a provider token in a phone settings fragment.

### In-page sync setup

Before opening phone settings, the bridge posts `{public_url}` to bearer-protected
`/v1/integration-setup-sessions`. The result is a 30-minute setup-only token and
an exact `/integrations/setup-api` URL. Only this temporary token travels in the
settings URL fragment; the page removes the fragment from browser history and
never returns it with saved phone settings. The main bearer token stays on the phone.

The setup API accepts GET for public descriptors/collections/active bindings and
URL-encoded POST actions: connect, bind (preview), apply, disconnect, and authorize
(Google's existing browser flow). Requests use the temporary bearer token. CORS
allows only the hosted settings origin `https://nick1udwig.github.io`; no cookie
authentication is used by this API. Provider credentials are omitted from every
response. Candidates are tied to their originating setup session. Errors are JSON
and displayed inline. The `webviewclosed` handler never opens another page.

### Calendar and interaction preferences

The third collection is `col_event`, kind `event`. `event.create` accepts title,
start, end, optional location and description. Times require RFC3339 offsets, or
two YYYY-MM-DD values for an all-day event with exclusive end. Read APIs retain
start/end/location in summaries and return the description through body pages.
Active event snapshots are chronological and exclude ended events. Snapshot
creation accepts `utc_offset_minutes`; collection listing accepts the same query
parameter, so all-day dates and counts follow the phone's local date.

PAM uses `capability type=calendar command=list` and
`capability type=calendar command=add title="Lunch" start="2026-09-16T12:00:00-07:00" end="2026-09-16T13:00:00-07:00"`.
Phone journal/receipt semantics match notes and tasks. CalDAV performs deterministic
conditional creates and 90-day expanded calendar-query reads. Absence reconciliation
is restricted to the successfully read time window. Records remain read-only on
the watch after creation; edits and recurring-series creation use a calendar client.

`bridge operation=collection-counts` sends task count in Index, note count in Flags,
and event count in EventSequence. Watch caches use ten keys per kind: 4480, 4490,
4500; base+1..8 hold titles, base+9 holds the full count.
`bridge operation=preferences` uses Flags for ripple enabled, Index for double-tap
required (both default 1). `bridge operation=agent-dispatched` starts the blue
request animation only after the phone submits an agent job over HTTP.
