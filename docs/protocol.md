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

Supported symbolic image icons are `info`, `check`, `warning`, `sun`/`weather`, `timer`, `up`, `down`, `left`, and `right`. The image element is deliberately symbolic: arbitrary remote bitmaps are not accepted into the watch heap.

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

`at` is a Unix timestamp in seconds; `in` is a duration. Up to four app reminders are persisted. A due reminder offers acknowledge and ten-minute snooze actions.

## Limits and failure behavior

- The watch stores up to 48 elements per screen.
- Text values are capped at 319 bytes on the watch. Larger values are streamed in UTF-8-safe append chunks and truncated at the final watch buffer boundary.
- Titles, subtitles, IDs, actions, and metadata have smaller fixed limits declared in `agent_ui.h`.
- Unknown kinds/layouts and invalid hierarchy produce a visible protocol error rather than partially executing an unrecognized node.
- A new response supersedes queued operations from an older request. The watch also rejects stale request IDs.
- Capability commands are allowlisted by registries; PAM cannot call arbitrary native functions.
