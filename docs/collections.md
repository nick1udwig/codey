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

Choose **To-do sync setup** or **Notes sync setup** independently; both default
to Server only. Selecting Nextcloud Notes reveals its URL/username/app-password
fields; Todoist reveals a token field. Connect, choose a destination, preview, and
activate directly in the settings page. Errors remain visible there. No setup
button closes and reopens the Pebble settings webview. Google authorization
navigates within the current webview after its server OAuth prerequisites are met.

A setup-only session is issued by the phone before opening settings. First save an
HTTPS server URL and token; reopening settings then supplies a 30-minute session.
The static settings page never receives the main server bearer token. Provider
secrets are sent directly to the server, excluded from responses and phone settings,
and encrypted when activated. The displayed active backend is authoritative;
changing a selector alone does not change it. See [setup instructions](../README.md#backend-sync-setup).

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

## Read efficiency

Opening the first list page uses one snapshot POST with `limit: 8`; subsequent
pages use the same immutable snapshot. Counts use a SQLite expression index,
and SQLite maintains body-free summaries when canonical records change.
Immutable snapshot rows are indexed by position, so an eight-row page only
decodes eight summaries. Existing snapshots survive the schema upgrade.
Canonical bodies and revision-pinned body reads remain intact.

The phone sends one bounded list payload instead of building a second PAM list.
Unchanged collection metadata does not rewrite its read cache, and unchanged
counts do not generate Bluetooth traffic. A watch readiness handshake or delivery
failure resets count suppression. List changes also trigger count reconciliation.
Journal compaction writes only when durable work can actually be removed; pending
operations and watch ingress receipts retain their existing guarantees.

Watch preview updates invalidate the page, write only changed title rows, then
mark it valid. An interrupted update cannot display a mixture of old and new rows.
See [repeatable measurements](testing.md#collection-efficiency-regressions).

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

## Calendar

Calendar is a third, independent collection, defaulting to Server only. Choose
CalDAV in phone settings to connect a calendar with its URL, username, and app
password. Setup shows four numbered steps and a completion message. The same
phone journal, server receipts, encrypted credentials, and cached watch titles
apply. The agenda imports 90 days of events with server-expanded recurrences;
new single events sync outward using conditional, deterministic resource URLs.
Use your calendar app for edits, invitations, and recurring-series creation.
See [README setup](../README.md#backend-sync-setup) and [protocol](protocol.md).

Background collection metadata and unchanged provider scans back off from one
minute to at most five minutes. Pending phone operations retain the short retry
interval, accepted server mutations wake provider writes immediately, and Sync
now bypasses the scan cooldown. Calendar scan deadlines stop at the next UTC
day boundary. Unchanged counts still generate no Bluetooth messages.

Receipt batches use one verified journal commit. Once a job result is delivered
to the watch or dismissed, the phone retains only a small server-acknowledgment
receipt, retrying it on reconnect, Notifications refresh, or a new submission.
Confirmed or expired server acknowledgments remove the receipt.
