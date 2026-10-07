# Checks implementation plan

## Behavior

Checks records repeated events on named lists. `check new baby sleep` creates an
empty list; `check baby sleep` records one occurrence at the command's current
time. Names match case-insensitively after whitespace normalization. Duplicate
creation must not erase a list or add a check. Unknown names produce an actionable
error and do not implicitly create lists.

The lower-right collection picker gains Checks alongside To-dos and Notes.
Its list rows show each name and lifetime count, including zero. Opening a list
shows newest occurrences first, grouped by local calendar day (Today, Yesterday,
then dated headings), with bounded pagination to older history. Empty lists have
a useful empty state. This first version covers creation, recording, and browsing;
editing or deleting recorded events and external provider integration are outside
this request.

## Architecture and sequence

1. Extend `internal/collections`, `internal/collectionstore`, and the HTTP API
   with a server-owned Checks collection, checklist records, and individually
   stored timestamped occurrences. Preserve existing data on upgrade. Store
   occurrences transactionally with mutation receipts and count updates; replay
   must never duplicate an occurrence. Index history by checklist and timestamp
   and bound history responses; do not embed an ever-growing array in a record.
2. Extend local dictation and capability routing in `src/common` and `src/pkjs`.
   Capture occurrence time before asynchronous connection/upload work. Resolve
   complete normalized names safely, including lists beyond the first page and
   locally queued creations. Reserve the explicit `check new` prefix for creation.
3. Extend the existing phone collection client, journal projection, and views.
   Preserve durability acknowledgments, ingress identity, dependency ordering,
   offline replay, and bounded caches. Consecutive independent occurrences are
   additive and must not conflict merely because an older revision was observed.
   Pending counts/history must reconcile without double counting after replay.
4. Extend native collection registration, dashboard selection, counts, cached
   previews, and read routing. Reuse native collection rows and bounded PAM detail
   views as appropriate. Preserve current To-dos, Notes, and Calendar behavior.
   Display local day groups and readable times; keep navigation usable with touch
   and buttons, and label unavailable offline history accurately.
5. Add meaningful Go, JavaScript, and native regression coverage. Run `npm test`
   and `npm run build:watch`; inspect both platforms' build results. If emulators
   are used, stop them and verify all associated processes exit.
6. Update collection/user/protocol documentation, record any discovered bugs or
   follow-ups as KB tasks with context and acceptance criteria, refresh snapshots
   and code index, commit KB edits, and refresh `.kb/repository-backup.json`.

## Acceptance checks

- Creating `baby`, `baby sleep`, and `baby wake` produces independent empty lists.
- Five separate commands produce five timestamped entries and a count of five.
- Duplicate transport delivery produces one occurrence, while repeated user
  commands produce separate occurrences, including within the same second.
- Creation followed by checks while offline retains command times across restart
  and synchronizes in order without losing or double-counting entries.
- Long collections and histories remain fully browsable with bounded pages;
  day headings and ordering work across midnight and local timezone boundaries.
- Existing data survives server reopen/upgrade and all existing collection tests
  continue to pass. Both Emery and Gabbro compile successfully.
