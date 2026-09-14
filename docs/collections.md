# Notes and To-dos: server storage and backend sync

Notes and to-dos are canonical server records. The phone keeps a durable mutation
journal and a bounded disposable read cache. The watch persists up to eight truncated titles each for Notes and active To-dos.
It shows these noninteractive cached previews immediately while refreshing live
aliases from the phone; completed lists and later pages do not replace the preview.
Mutations and record identities are not stored in this display cache. Timers, alarms, and the remembered
Notes/To-dos tile selection retain their existing persistence.

This is a breaking development upgrade. Legacy phone notes and native task slots
are ignored; there is no migration or compatibility fallback. Existing collection
data was explicitly excluded from preservation for this implementation.

## Setup

Configure the server bearer token (`CODEY_TOKEN`) and server URL in phone settings.
Collections always use that same URL, stripping a trailing `/v1/agent` and
converting WebSocket schemes to HTTP(S). There is no separate collection URL.
HTTPS is required unless **Allow HTTP for local development collections** is
explicitly enabled. The server creates one To-dos and one Notes collection.
Collection APIs remain available when Codex is unavailable.

Choose a **Sync service to configure**, then **Save & manage sync services**.
The phone sends its HTTPS server URL and selected service to create a short-lived
management session; no separate public URL configuration is required.
Select Server only, Todoist, Google Tasks, or Nextcloud Notes; authenticate,
discover a project/list/category, preview the records, then activate it. Existing
server records are exported only when explicitly selected. Provider secrets are
entered on the server page and encrypted with a separately held server key.

## Saving and browsing

- Dictate “note: Call Jane” or “todo: Buy milk” to create a record. These commands
  and collection browsing do not need Codex.
- Open a note to read revision-pinned pages, **Append to note**, or **Replace
  entire note**. Replacement saves the complete new dictation, never the displayed
  page. Ambiguous text-based edits direct you to the record picker.
- Task checkboxes emit explicit complete/restore operations. Completed tasks have
  a separate paginated view. Completion is distinct from deletion.
- Lists contain at most eight records; bodies contain at most four UTF-8 chunks
  per page. Large collections remain server-owned. Uncached offline pages are
  reported unavailable; cached pages are marked stale.
- Saves first show Sending, then **Saved on phone · Pending server**, then
  **Saved on server**. External delivery is tracked separately in server settings.
  A transport acknowledgment alone never means that the input was saved.

The phone may accept supported writes while the server is unavailable after
initial enrollment. The watch cannot create collection mutations without its
phone connection/readiness handshake. Unaccepted input exists only in RAM and
can be lost when closing the watch app. Phone uploads resume when PebbleKit JS
runs again; it is not a permanent background service. Uninstalling/clearing phone
storage can destroy input that has not reached the server.

The journal has two checksummed slots with read-back verification. Defaults are
256 retained operations and 512 KiB per slot, plus a 1 MiB disposable cache.
Cache eviction never removes pending input. Queue exhaustion rejects the next
save. When more than eight uncommitted creates exist, the view explicitly reports
partial coverage; remaining records become browsable after server upload.

## Providers and recovery

Todoist uses API v1 incremental synchronization and stable command UUIDs. Completed
history discovery covers the last 89 days; previously imported canonical history
is retained. Recurring completion adopts the returned next occurrence. The API
has weaker concurrent-write guarantees than Nextcloud's conditional updates.

Google Tasks includes hidden, completed, and deleted tasks in full paginated
reads. Due values are date-only; assigned tasks are read-only. A create with an
unknown remote outcome requires review before retrying.

Nextcloud Notes uses API v1.2+ chunk cursors and `If-Match` updates. All chunks must
succeed before missing mapped notes are treated as deleted. Category moves are
not treated as deletions. Read-only or incomplete notes do not offer replacement.

Management displays conflicts and pending/error/unknown provider operations.
Resolve conflicts against the observed current revision. For uncertain delivery,
inspect the provider before linking a verified remote record, stopping delivery,
or explicitly confirming that retrying cannot duplicate a write. Switching
providers preserves records and requires a decision about pending delivery;
in-flight/unknown work prevents a switch.

Changing the server URL, bearer-token identity, or restored store epoch quarantines
old phone work. Restore the original connection to recover that journal rather
than redirecting it. For a restored original server, the phone settings recovery checkbox archives quarantined input as server conflicts without executing it, then re-enrolls only after durable handoff. Review those proposals before applying them. Developer recovery can also export complete JSON with
`CollectionClient.exportJournal()` from the running phone bridge.

See [server operations](collections-server-operations.md), the
[implementation plan](notes-todos-backend-sync-plan.md), and the
[implementation specification](notes-todos-backend-sync-spec.md).
