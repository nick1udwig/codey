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
a stable ID for edits. The watch currently stores 24 notes, each up to 179 UTF-8
bytes, alongside 32 to-dos including archived items. Storage errors are reported
without replacing the previous record. Re-delivery of the most recent operation
on a record does not duplicate it. These are local watch collections; no remote
sync or provider connection is implemented.

## Identity and storage boundary

`capabilities/notes.c` and `capabilities/todos.c` own their records and persistence;
views and dictation invoke collection commands instead of owning storage.
`record_identity.h` allocates durable local IDs using a persisted sequence and
creation time. IDs survive note edits and todo archive/restore operations. An
explicit ID can also be supplied by a command. Existing to-dos without IDs are
migrated in place, retaining the old on-disk format, text, invocation ID, and
archive state. Failed migration writes preserve the original record and can be
retried on a later launch. UI row indexes are never remote identities.

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

Add versioned sync metadata (or sidecar records) for revisions, pending changes,
provider mappings, and deletion tombstones. Preserve existing records during that
migration. To-do archive means completed, not deleted; map it to provider task
completion and restore semantics. A future note deletion requires a tombstone.
Concurrent edits need an explicit conflict policy, such as retaining both
versions for resolution, rather than overwriting according to device clock time.
Provider adapters translate these operations and declare supported features;
settings select the account/collection for each provider. Provider credentials,
cursors, retries, and webhook/polling mechanics belong in that integration layer.
This boundary supports future Todoist/Google Tasks and note backends without
requiring provider-specific watch screens.
