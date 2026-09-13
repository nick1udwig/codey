# Notes and To Do

## Current behavior

The dashboard's bottom-right tile initially shows To Do. A tap followed by a
hold opens the shared selection menu with Notes and To Do. Select an option
with two taps. The last collection opened occupies the tile, including after
restart. The physical Down shortcut continues to open To Do.

A first touchscreen tap arms that control and produces a thin expanding ripple.
The next contact stops it immediately, including the start of a hold. The ripple
reflects at rectangular edges or the circular bezel and fades over approximately
half the screen width in 600 ms. Pebble lacks alpha-composited layers, so fading
uses decreasing spatial coverage. This bounded input animation does not change
the once-per-minute passive refresh policy. A checkbox still needs two taps;
the second archives the task. Text panning cannot arm the adjacent checkbox.

Notes list entries open a scrollable full-text view with the time at the top.
Select **Edit note** to dictate replacement text directly to that note. This
input is literal replacement text, even if it contains a timer command.

These commands are recognized locally by the phone:

- “make a note Call Jane” or “create a note: Call Jane”
- “note: Call Jane”
- “edit a note Call Jane to Call John” (exact, case-sensitive old-text match)
- “edit a note” or “show my notes” (opens the list)

The explicit edit phrase uses the first ` to ` delimiter. Use the note's Edit
action when the old text contains that delimiter or multiple notes match.
Missing/ambiguous matches do not modify anything. The PAM capability also accepts
a stable ID for edits.

## Phone storage and on-demand loading

Notes live in PebbleKit JS phone storage (`pebble-agent.notes.v1`), owned by
`src/common/notes.js`. Opening Notes requests a fresh list from the phone: each
page contains at most eight titles/summaries and IDs, without downloading note
bodies. Opening a note requests its contents; long notes have Previous/Next page
actions. A content page contains at most four UTF-8 chunks of 179 bytes each.
The watch retains only the current rendered page in RAM, with no persistent
note copies. Returning to the list fetches it again. The phone store accepts
notes up to 65,536 JavaScript characters, subject to phone storage availability;
agent/dictation transports retain their own message limits. An overlong direct
edit dictation is rejected rather than silently saving a truncated replacement.

Edits replace the full note on the phone, preserving its ID. The store commits
records and replay keys together before reporting success. Failed writes leave
previous records intact. Notes use phone storage only; there is no watch-to-phone
migration or reader for earlier watch note formats.

The watch retains the selected collection preference and note count in the UI,
not the phone's note database. Opening a collection requires a connected phone;
a missing reply times out after 15 seconds. Per-request tokens reject stale
Notes replies, and successful browsing completes quietly without a buzz.

To-dos remain watch-owned (32 including archived items) and retain their stable
IDs and existing storage format. Notes and to-dos do not sync to external
providers yet.

## First-tap animation preference

The phone settings page includes **First-tap ripple animation**, enabled by
default. Saving it sends the preference to the watch, where it survives restart.
Disabling it stops an active ripple and prevents future ripple timers. It does
not disable the first-tap guard: checkbox completion and other touch actions
still require their arming tap. Physical buttons are unchanged.

## Planned sync boundary — not implemented

Keep provider integration in the phone/server layer, outside watch rendering,
voice regexes, and the native record format. A future canonical collection store
should expose the same operations for every provider: list changes using a
cursor, create/update by stable ID, mark tasks completed/restored, and acknowledge
committed mutations. Views can request a refresh on opening while displaying the
cached collection immediately. Local writes must remain usable offline.

Scope local IDs with a persisted installation namespace at first synchronization;
store a separate mapping from canonical ID to provider/account/collection and
provider record ID. Do not replace local IDs when a provider assigns its ID.
Use a durable outbox with mutation IDs, revisions, and acknowledged cursors so
retries are idempotent in both directions. Persist records before advancing a
cursor or acknowledging delivery. Server-side storage can retain complete note
bodies; the watch should request bounded pages/previews and selected bodies,
rather than truncating and uploading a long remote note as its replacement.

Add sync metadata for revisions, pending changes, provider mappings, and
deletion tombstones. To-do archive means completed, not deleted; map it to provider task
completion and restore semantics. A future note deletion requires a tombstone.
Concurrent edits need an explicit conflict policy, such as retaining both
versions for resolution, rather than overwriting according to device clock time.
Provider adapters translate these operations and declare supported features;
settings select the account/collection for each provider. Provider credentials,
cursors, retries, and webhook/polling mechanics belong in that integration layer.
This boundary supports future Todoist/Google Tasks and note backends without
requiring provider-specific watch screens.
