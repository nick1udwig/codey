# Notes and To-Dos Backend Sync: Implementation Specification

**Version:** 1.0  
**Date:** September 13, 2026  
**Repository baseline:** `nick1udwig/pebble-agent`, commit `db1f87610340748293eef22016f3d150265b0e98`  
**Status:** Implementation target with automated core/provider fixtures. Authenticated accounts and physical phone/watch qualification remain release gates.
**Scope override (user confirmed):** Include Todoist, Google Tasks, and Nextcloud Notes; exclude Obsidian, Notion, migration, and backward compatibility. Existing development collection data may be discarded.
**Runtime details:** [collections.md](collections.md) and [server operations](collections-server-operations.md) document shipped interfaces and explicit limits.  
**Companion:** [notes-todos-backend-sync-plan.md](notes-todos-backend-sync-plan.md) contains the ordered work packages and release gates.

## 1. Decision and scope

Implement server-owned notes and tasks with optional bidirectional provider synchronization. The phone component of the watch application is a caching client and durable relay. The physical watch is a transient interface.

```text
Watch: bounded RAM views and input
                |
        AppMessage / application acknowledgments
                |
Phone: disposable read cache + persistent mutation journal
                |
          Versioned HTTPS collection API
                |
Server: canonical collections + durable provider outbox
                |
      Provider-neutral synchronization engine
                |
      Selected server-side provider adapters
```

The server always stores the app's canonical records. Selecting **Server only**—the UI label for the requested “None” option—disables external synchronization, not server storage. External changes become canonical server revisions before the phone or watch displays them. On first initialization, create one server-only Tasks collection and one server-only Notes collection; no external account is required.

### 1.1 Fixed requirements

| ID | Requirement |
|---|---|
| R01 | Do not introduce a watch outbox, persistent collection database, offline note capture, or persistent task/note cache. |
| R02 | Disable new collection mutations when the phone bridge is unavailable, including button-only task completion. This is a deliberate product boundary, not a claim that every offline action requires dictation. |
| R03 | The phone must persist accepted mutations before acknowledging them to the watch. Pending changes must survive supported phone-app and JavaScript restarts. |
| R04 | The server must commit canonical changes and required provider work transactionally before acknowledging the phone. |
| R05 | The phone may accept supported collection actions during a server outage after successful initial server enrollment. It cannot supply unavailable dictation services. |
| R06 | Server-only collections, collection APIs, and provider workers must work without Codex. |
| R07 | Implement tasks through Todoist and Google Tasks; notes through Nextcloud Notes, with provider-specific capabilities disclosed. |
| R08 | Provider selection, authentication, endpoint configuration where applicable, collection selection, and status belong in settings. |
| R09 | All provider code and long-lived provider credentials live on the server or its explicitly configured local bridge processes. |
| R10 | Adding a compatible adapter must not require provider-specific watch code, voice parsing, or phone synchronization logic. |
| R11 | Never silently truncate stored content, drop pending changes, replay a toggle, overwrite a newer revision, or redirect an old operation to a newly selected account. |
| R12 | Breaking development rollout: ignore legacy data; do not add migration, compatibility fallback, or new watch collection persistence. |

### 1.2 First implementation boundaries

Support one active task collection and one active notes collection, each with at most one active external binding. The schema must permit additional connections and collections later. Do not build simultaneous Todoist-to-Google-Tasks multi-master replication.

Do not add a new native phone application, hosted OAuth broker, watch background service, dynamic adapter marketplace, attachment editor, general rich-document editor, or chat-history synchronization. Preserve unrelated timer/alarm behavior and ordinary UI preferences. The no-persistence rule applies to task/note content, collection mutations, cached bodies, summaries, and counts—not to all persistence elsewhere in the application.

Provider adapters ship in the Go server initially. Downloadable **server-side** adapters are an optional later extension; downloading executable provider code onto the watch or PebbleKit JS is outside this implementation.

The numeric limits and polling intervals below are proposed implementation defaults, not measured platform guarantees. They may be tuned after testing without weakening durability, isolation, or content-preservation requirements.

## 2. Repository changes and compatibility

At the reviewed commit, notes are stored in phone `localStorage` under `pebble-agent.notes.v1`. Their views already use eight summaries per list page and four 179-byte UTF-8 chunks per content page. Preserve this bounded presentation approach. [R-A, R-B]

Tasks currently live in 32 persistent watch slots beginning at key `4300`; archived state means completed. Task completion is currently a local storage update. Replace this ownership model rather than adding a parallel synchronized task database. [R-C]

The current phone bridge handles local note mutations, dispatches task capabilities to the watch, and replays capability commands from stored agent jobs. All note/task mutation paths must converge on the new collection client; otherwise agent-generated tasks will bypass server storage. [R-D]

Server startup currently requires a successful Codex connection, and the default session-state directory is an OS cache directory. Introduce a separate durable collections data directory and remove the Codex startup dependency for collection service availability. [R-E]

The existing configuration URL serializes normalized settings, including the endpoint bearer token, into a URL fragment. Do not add provider secrets to that mechanism; integration management uses a short-lived server session instead. [R-F]

### 2.1 Proposed module layout

Paths marked “new” are proposed implementation targets, not existing files.

| Path | Change |
|---|---|
| `internal/collections/` — new | Domain types, mutation validation, revision/conflict policy, repository interface. |
| `internal/collectionstore/` — new | SQLite migrations, repositories, transaction helpers, change feed, snapshots, backup/restore. |
| `internal/collectionsync/` — new | Durable provider jobs, scheduling, retry classification, inbound merge, operation recovery. |
| `internal/providers/` — new | Adapter contract, descriptor registry, provider contract-test fixtures. |
| `internal/providers/{todoist,googletasks,nextcloudnotes,markdown,notion}/` — new | Individual adapters. |
| `internal/integrationauth/` — new | OAuth flows, token storage/refresh, Nextcloud login, short-lived management sessions. |
| `internal/httpapi/` | Register authenticated collection and integration routes alongside existing agent routes. |
| `cmd/pebble-agent-server/main.go` | Durable data path, database lifecycle, independent collection startup, worker shutdown. |
| `src/common/collections/` — new | Models, two-slot journal, cache, API client, synchronization coordinator, mutation ingress. |
| `src/common/notes.js` | Convert to a presentation facade or split rendering out; remove authoritative note-store ownership after migration. |
| `src/common/collection-views.js` — new | Provider-neutral task/note PAM views, alias and revision mapping. |
| `src/pkjs/index.js` | Wire bridge readiness, collection requests, journal recovery, job capability routing, and settings. |
| `src/common/settings.js`, `docs/config/` | Server base URL, provider descriptors, connection status, integration-management entry point. |
| `src/common/watch-protocol.js`, `package.json`, native protocol handlers | Versioned collection messages and acknowledgments; retain existing key numbers. |
| `src/c/capabilities/todos.c` | Remove normal task storage and toggling; request transient pages and emit explicit actions. |
| Native Notes capability and app input/connection handlers | Capability-driven edits, connection gating, current-view revision, RAM-only retries. |
| `docs/collections.md`, `docs/architecture.md`, `docs/protocol.md`, `docs/server.md`, `docs/testing.md` | Replace obsolete ownership/offline descriptions; document final contracts and runbooks. |

The existing `npm test` and watch build paths remain release checks. Preserve Emery and Gabbro support and the server release architecture matrix. Pin a SQLite driver compatible with those targets and the chosen Go toolchain; verify cross-compilation before adopting it. [R-G, R-H]

## 3. Ownership, acknowledgments, and user-visible behavior

### 3.1 Durability handoff

| Stage | Durable owner | Watch text |
|---|---|---|
| Dictation/input exists only in watch RAM | None | `Sending…` or `Not saved` |
| Phone journal commit succeeded | Phone | `Saved on phone · Pending server` |
| Server transaction committed | Server | `Saved on server` |
| Selected provider accepted the corresponding revision | Server and provider | `Synced` |
| Server-only collection committed | Server | `Saved on server` — terminal success |
| Proposal preserved but requires intervention | Phone or server, explicitly identified | `Needs attention` |

A transport callback is never a storage acknowledgment. Phone acceptance must use an explicit application message. Do not show “Saved on watch.” Never imply that “Synced” covers a later revision that has not been delivered.

If Bluetooth drops after input starts, the watch may keep the unfinished attempt in RAM while the application remains open. It may retry the same attempt after reconnection. Closing or restarting the watch application can lose input that has not reached the phone; the interface must not have reported that input as saved.

### 3.2 Connectivity cases

| Condition | Reads | Mutations |
|---|---|---|
| Phone and server available | Cached response, then server refresh | Phone journal, server commit, optional provider work. |
| Phone available; server unavailable | Cached pages/bodies only; mark stale | Queue supported actions on phone. Dictation still needs its own service connectivity. |
| Phone unavailable | Current RAM view only | Disable new create/edit/complete/restore/delete actions. |
| Provider unavailable; server available | Normal canonical server reads | Save normally; show backend pending/error separately. |
| Server never configured/enrolled | Setup instructions | No new collection save; legacy data remains available for migration. |

PebbleKit JS provides `localStorage` and networking but is documented to run with the watchapp lifecycle, not as a permanently running background service. Drain the phone journal whenever its runtime is active and resume on the next launch/readiness handshake. The server continues provider synchronization independently. Do not promise immediate phone upload while the watchapp is closed. [P-A]

## 4. Server data model

Use SQLite in a durable application-data directory, proposed default `~/.pebble-agent/data`, overridable by `--data-dir`. Do not store the authoritative collection database under `os.UserCacheDir()` or the agent's writable workspace. Use restrictive directory/file permissions.

Use foreign keys, transactions, a busy timeout, and a documented crash-durability configuration. WAL with `synchronous=FULL` is the proposed baseline on a supported local filesystem. Do not treat copying a live `.db` file alone as a valid backup; use SQLite's backup facilities or a documented quiesced equivalent. [P-B, P-C]

### 4.1 Entities

| Entity | Required fields and rules |
|---|---|
| `store_metadata` | Schema version, immutable `server_instance_id`, restore-sensitive `store_epoch`. |
| `clients` | Server-assigned `client_id`, principal, enrollment time, last seen, revoked flag. Client ID is identity, not authentication. |
| `collections` | ID, owner, kind (`task`/`note`), name, active/default flag, active binding ID or null, binding generation. |
| `records` | Canonical ID, collection ID, kind, content revision, title, timestamps, deletion state, normalized task/note fields. |
| `record_versions` | Immutable prior contents required for conflicts, pending operations, and recovery. |
| `connections` | Provider ID/version, provider account identity, sanitized endpoint, non-secret configuration, secret reference, health. |
| `bindings` | Connection, canonical collection, remote container ID, generation, state, sync options, declared coverage. |
| `remote_mappings` | Binding + remote container + remote ID, canonical ID, remote version/ETag, last synchronized normalized base, preserved provider data, acknowledged local revision. |
| `client_operations` | Operation ID, client ID/sequence, unique scoped ingress ID, immutable request hash, request context, result, durable proposal where needed, commit sequence. |
| `provider_outbox` | Stable outbound operation ID, binding/generation, record, intended delta, base state/version, state, attempt count, lease, next attempt, reconciliation data. |
| `provider_checkpoints` | Committed incremental checkpoint, in-progress page cursor, full-scan membership generation. |
| `changes` | Monotonic sequence, principal/collection, entity ID, event kind, revision or deletion/status payload. |
| `conflicts` | Record, base, local proposal, remote/current value, cause, status, resolution receipt. |
| `legacy_imports` | Source namespace + legacy ID, payload hash, canonical mapping, migration receipt. |

Canonical data revisions and delivery status are separate. A token refresh or backend retry does not change a note's content revision. Status changes can still appear in the change feed.

### 4.2 IDs, dates, and content

Canonical IDs and provider IDs are opaque strings. Never identify a record by title, file path alone, list position, or a truncated provider ID. JSON revisions and change sequence values are decimal strings so they cannot overflow JavaScript's integer precision.

After initial enrollment, a phone can allocate identities without network access using a persisted server-issued client namespace and monotonic sequence, for example `op:<client_id>:<sequence>` and `rec:<client_id>:<sequence>`. The sequence allocation and queued operation must be in the same journal commit. Never wrap or reset it; re-enroll on exhaustion. Server-created records use an independent server identity allocator. IDs are not credentials.

Watch element IDs remain short aliases within the existing 31-byte usable limit. Maintain the canonical mapping on the phone, scoped to bridge session and view token. Never truncate canonical IDs to fit the watch. [R-B, R-I]

Tasks support title, description, explicit completed state, completion time, and an optional date-only or timezone-aware due value. Preserve parent/order/recurrence/provider extensions even when the watch cannot edit them. A task's archive view means completed, not deleted.

Notes support separate title and body, body format (`plain`, `markdown`, or provider-specific projection), body hash, body completeness, and write capabilities. Keep full server-side content when supported. Distinguish an incomplete provider projection from an ordinary complete note.

Initial core write limit: 256 KiB UTF-8 per note body. Provider ingestion may accept up to 8 MiB per body under a separately configured cap. Larger or inaccessible content becomes an explicitly marked metadata-only/read-only record; it must never be uploaded as a truncated replacement. The phone/watch can advertise lower input limits. Validate provider-specific limits without losing the canonical server record.

### 4.3 Retention

Keep deletion identities and operation deduplication receipts for the store lifetime in the first version. Do not implement opportunistic garbage collection of them.

Proposed change-feed retention: 90 days. An expired cursor requires a fresh snapshot, not replay from an arbitrary timestamp. Retain ordinary content versions for at least 90 days, and retain all bases/proposals referenced by unresolved conflicts or pending work regardless of age. Missing historical bases produce a recoverable conflict, not a blind overwrite.

## 5. Mutation semantics

Every entry point calls the same collection mutation service: direct watch actions, local dictation parsing, phone/settings edits, and agent capability results. Adapters never mutate the database directly.

Supported core operations:

| Operation | Required semantics |
|---|---|
| `task.create` | Stable client record ID; explicit fields; duplicate request returns prior result. |
| `task.patch` | Field patch with a base revision; omission leaves a field unchanged. |
| `task.complete` / `task.restore` | Explicit intent, never `toggle`; include occurrence identity for a recurring task. |
| `note.create` | Title/body/format; immutable operation identity. |
| `note.replace` | Full replacement text plus explicit whole-note intent and base revision; only where capability permits. |
| `note.append` | Exact text appended once within the core, with a base revision; provider delivery may require uncertainty handling. |
| `record.delete` | Explicit user action, base revision, and tombstone; never inferred from watch/cache eviction. |
| `conflict.resolve` | References conflict ID and observed current revision; creates a new recorded mutation. |

For first-version server-side conflicts, prefer conservatism: apply automatically when the relevant base still matches, recognize a no-op where appropriate, and otherwise preserve the proposal in a conflict. Do not silently rebase stale edits using device clocks. Safe disjoint-field merging may be added only with contract tests.

A dependent operation can carry `depends_on` and `base_operation_id` instead of an as-yet-unknown server revision. The latter refers to the committed result of that previous operation. This permits “create then complete” or consecutive queued edits without fabricating revisions. Dependents wait if their parent is unresolved, and remain blocked if it conflicts or is rejected.

### 5.1 Agent command replay

Existing job capability results can be reopened and replayed. Assign a deterministic ingress identity from the endpoint/server scope, job ID, and capability index, then durably map it to one collection operation. Do not generate a fresh operation every time the job result is rendered. Direct user input gets its own ingress identity. Starting a new chat must not reset collection identity or the mutation journal. [R-D]

Persist an `ingress_id` in the server operation receipt, unique within its authenticated source scope. For agent jobs, derive a stable operation lookup identity from the originating server/job/capability index, independent of a phone reinstall or current collection selection. Keep its original destination frozen. When a phone no longer has the corresponding local receipt, query the original server receipt before replay; while that lookup is unavailable, show the cached result without re-executing its mutation. The server must reject a reused ingress identity with inconsistent intent rather than accept it as a new action.

Override both `note` and `todo` phone capability dispatch. Do not send new task-create commands to the legacy native storage module. Rendering may be canceled when a screen closes; accepted persistence and delivery work must not be canceled with it.

Keep direct create/append/complete handling deterministic and independent of model availability. Legacy “edit a note OLD to NEW” parsing may resolve only a verified unique exact-text match across the complete selected collection. A partial cache cannot establish uniqueness; require server resolution or offer the ID-based note picker. Do not queue an edit against a guessed title match.

Agent-generated content is not authorized to reconfigure providers, obtain secrets, run adapter code, or silently resolve destructive conflicts. Existing PAM validation stays in place.

## 6. HTTP contract

Use versioned JSON routes alongside the existing agent API. The table lists routes relative to an explicitly configured `serverBaseUrl`, which may include a reverse-proxy prefix. Existing agent routes and transports remain unchanged.

All collection routes require server authentication. The initial deployment remains one trusted operator/principal, not a public multi-tenant service. Enforce ownership checks even with that deployment model; never use client-supplied IDs as authorization.

| Method and route | Purpose |
|---|---|
| `GET /v1/sync/info` | Server/store identity, protocol versions, limits, collection readiness, agent health separately. |
| `POST /v1/sync/clients` | Enroll phone and return its stable namespace. Persist before accepting new writes. |
| `GET /v1/collections` | Collection descriptors, active task/note selections, binding generations. |
| `GET /v1/collections/{id}/records` | Paginated summaries; explicit task-state filter; bounded results. |
| `GET /v1/records/{id}?revision=...` | Record metadata at a requested available revision; full body only by explicit size-bounded request. Support ETags. |
| `GET /v1/records/{id}/body?revision=...&cursor=...&max_bytes=...` | Bounded, UTF-8-safe body ranges pinned to one revision; proposed default 16 KiB, maximum 64 KiB per response. |
| `POST /v1/sync/snapshots` | Create a scoped, consistent summary snapshot with a high-water change cursor. |
| `GET /v1/sync/snapshots/{id}?page_token=...` | Read immutable snapshot pages. |
| `GET /v1/sync/changes?cursor=...&limit=100` | Durable changes after an opaque cursor; no full note bodies by default. |
| `POST /v1/sync/mutations` | Submit a batch of at most 20 operations, with per-operation results. |
| `GET /v1/sync/mutations/{id}` | Recover an operation's acceptance result after a lost response. |
| `GET /v1/sync/ingress/{id}` | Recover the recorded operation and original destination for a scoped ingress identity, including historical agent-job replay. |
| `GET /v1/sync/status` | Per-connection and per-record delivery errors, lag, and conflicts. |
| `POST /v1/sync/refresh` | Request refresh; enqueue work and return 202, respecting rate limits. |
| `GET /v1/providers` | Available provider descriptors, schemas, capabilities, and setup availability. |
| `GET /v1/conflicts`, `GET /v1/conflicts/{id}` | Recoverable conflict list and contents, authorized to the owner. |

Default summary/change page size is 100; maximum 200. Cap request/response sizes. Validate IDs, kinds, binding generations, field types, and note sizes. Unknown operation types are errors, not ignored commands.

### 6.1 Example request and result

```json
{
  "protocol_version": 1,
  "server_instance_id": "srv_example",
  "store_epoch": "epoch_example",
  "client_id": "client_example",
  "operations": [
    {
      "id": "op:client_example:42",
      "ingress_id": "watch:client_example:bridge_example:7",
      "sequence": "42",
      "collection_id": "col_tasks",
      "binding_generation": "3",
      "record_id": "rec:client_example:42",
      "type": "task.create",
      "base_revision": null,
      "depends_on": [],
      "payload": {"title": "Buy milk"}
    }
  ]
}
```

```json
{
  "results": [
    {
      "operation_id": "op:client_example:42",
      "outcome": "applied",
      "durably_recorded": true,
      "record_id": "rec:client_example:42",
      "revision": "1",
      "change_sequence": "184",
      "provider_state": "pending"
    }
  ]
}
```

A batch is not one indivisible business transaction. Process each operation in a transaction, respecting dependencies. Persist the request hash, result, canonical revision/change event, and any provider work together. The same ID and request must return its recorded outcome. The same ID with different content returns `idempotency_mismatch` and must not execute.

Terminal outcomes are `applied`, `conflict`, and `rejected`; a replay returns the original outcome and adds `duplicate: true`. Conflict results include `conflict_id`; durably stored rejected input includes a recoverable `proposal_id`. A conflict/rejection counts as durably recorded only when the complete proposed user change and reason are recoverable on the server. Otherwise the phone retains its copy. Temporary `blocked_dependency`, transport errors, authentication errors, and service-unavailable responses are not acceptance.

Structured errors contain `code`, safe `message`, `retryable`, and optional `retry_after_seconds`. Required codes include `auth_required`, `permission_denied`, `invalid_input`, `storage_full`, `stale_revision`, `stale_view`, `binding_changed`, `server_mismatch`, `store_epoch_changed`, `cursor_expired`, `dependency_failed`, and `idempotency_mismatch`.

Never advance the phone's change cursor to the sequence in a mutation response: intervening unrelated changes may still be unread. Merge its receipt/record provisionally, then advance only through a committed snapshot or change-feed page.

### 6.2 Snapshot consistency

A snapshot must reflect one fixed high-water sequence. Materialize summary rows or implement an equivalent historical read model; a mutable offset-paginated list is not sufficient. Pages are scoped to the principal, collection selection, and store epoch. Proposed snapshot expiry: 15 minutes.

The phone consumes snapshot pages into a staged, bounded cache generation, installs that generation and cursor together only when the snapshot is complete, then consumes changes after the snapshot high-water mark. It need not retain every enumerated record: retain its chosen summaries/query windows within the cache budget and mark coverage as partial. An interrupted/expired snapshot restarts without implying deletion of unseen records. The mutation journal is never replaced by a snapshot.

The server remains responsible for complete pagination beyond that working set. Changes affecting uncached records may be handled by durably invalidating affected query windows before advancing the cursor, rather than caching every changed record. Never claim a partial cache is an exhaustive collection or use absence from it as evidence of deletion. Bodies load through revision-pinned ranges; a large server note must not force an unbounded phone allocation. Range cursors include the record/revision and UTF-8 position; unavailable revisions return an explicit refresh-required error.

## 7. Phone persistence and synchronization

### 7.1 Separate irreplaceable and replaceable data

Implement a `CollectionJournal` and a separate `CollectionCache`.

The journal includes identity/sequence allocation, pending operations, complete unsent user input, ingress deduplication mappings, dependencies, submission state, and acknowledged receipts not yet incorporated into the cache. The cache contains server summaries, selected note bodies, cached query pages, and change cursors. Never evict journal data to make space for reads.

Use two alternating journal slots, each containing a schema version, generation number, payload, and integrity checksum. On recovery, choose the highest valid generation. Write the inactive slot, check for exceptions, read back and validate, then treat that generation as committed. Do not depend on an independently updated index for recovery. Keep the previous valid generation until a subsequent successful commit.

This supplies application-level crash recovery over `localStorage`, not an undocumented filesystem `fsync` guarantee. Platform termination/restart tests are a release gate. Clearing application storage or uninstalling the companion can still destroy unuploaded data; disclose that limitation. [P-A]

Proposed limits: 256 pending operations and 512 KiB of serialized UTF-16-equivalent journal payload per slot, plus a 1 MiB disposable cache. Actual quota/headroom must be verified on supported clients. Evict the cache first, then reject additional saves with a clear storage-full error rather than overwrite queued work. Legacy import can stream in smaller batches.

### 7.2 Accepting input

Resolve the view alias and its recorded revision, validate the action, check connection/account scope, allocate an operation and dependencies, and commit the journal. Only then emit `accepted_phone`. Build the visible optimistic projection from the cached server state plus journal operations; do not mutate the cached authoritative base in place.

Persist the ingress identity with the operation in the same commit. A retransmitted watch event or reopened agent job must recover the same operation. Ingress payload mismatch is an error.

### 7.3 Receiving server acknowledgment

Persist the server receipt in the journal before dropping an unsent state or modifying the cache. Acknowledged entries need not be retransmitted. Retain enough receipt/projection information until the change feed or snapshot incorporates their result; then compact them without losing ingress deduplication.

Compact watch-ingress receipts only after their operations are durably recorded by the server and the originating bridge session is permanently retired. A retired session's unknown events must be rejected, not allocated new operations. Keep all unresolved and active-session receipts. Historical agent-job receipts may leave the bounded phone journal only when the server lookup rule in section 5.1 prevents re-execution. Never prune a receipt merely to make a currently replayable event appear new.

For a durably recorded conflict, the server owns the preserved proposal. Keep a visible needs-attention reference. For an unrecorded permanent rejection, retain the original input locally until the user exports, edits, or explicitly discards it.

The visible projection must not regress when an old cached page or provider response arrives. Apply revisions monotonically; preserve overlays for pending mutations. Cached bodies are invalidated by changed body hash/revision and loaded on demand.

### 7.4 Scheduling and endpoint changes

On runtime readiness, recover the journal before network work. After the watch handshake, return available cached views promptly, then drain eligible mutations and pull changes. Reattempt on reconnection, explicit refresh, collection opening, and active-runtime scheduling. Use one-shot scheduling and bounded work; return promptly from the PebbleKit JS ready callback. [P-A]

Proposed active phone refresh floor: 60 seconds, with immediate user-triggered checks and a shared in-flight request. Respect the repository's existing passive repaint throttling; a sync does not require repainting every intermediate change. [R-J]

Namespace all journal/cache state by server instance and principal. Store the original base URL/server identity with each pending operation. A changed endpoint, credential/account identity, or restored store must never cause automatic delivery to the new destination. Quarantine incompatible pending work and offer recovery/export. Re-enrollment is required when its namespace no longer applies.

## 8. Watch protocol and UI

Reuse the existing PAM renderer and ordered AppMessage queue. Do not build a second provider-specific renderer. Existing message keys `0`–`12` are already assigned. Append new keys rather than renumbering them. [R-G]

### 8.1 New collection envelope

Reserve these proposed additional keys in both generated/native and JavaScript definitions:

| Key | Name | Meaning |
|---|---|---|
| 13 | `CollectionProtocol` | Collection protocol version, initially 1. |
| 14 | `BridgeSession` | Short session token; not an authentication credential. |
| 15 | `EventSequence` | Monotonic event number within bridge session; retries reuse it. |
| 16 | `ViewToken` | Identifies the exact alias/revision mapping used to render an action. |
| 17 | `DeliveryState` | `accepted_phone`, `accepted_server`, `synced`, `needs_attention`, or `rejected`. |
| 18 | `ErrorCode` | Structured bounded error code. |

Use existing `MessageType`, `Operation`, `Kind`, `ElementId`, `Action`, `Value`, and `Index` for collection operations and bounded content. Keep existing generic message types compatible.

Phone readiness advertises the collection protocol, bridge session, and capabilities. The watch must complete the existing readiness exchange before writes. A mutation uses a `(BridgeSession, EventSequence)` ingress identity and a `ViewToken`; existing-record actions carry a short alias. The phone resolves the alias to canonical ID **and the displayed revision**, not the latest revision at receipt time.

Persist accepted ingress receipts on the phone. Check for an existing receipt before rejecting a retransmission whose old view mapping has expired. Unknown stale sessions/views return `stale_view` and never act on a reused list slot. When session/sequence space is exhausted, negotiate a new session; do not wrap into a previous identity.

Any chunked input must be completely assembled and validated before journal acceptance. Preserve UTF-8 boundaries and verify declared length/completion. A partial transfer is not a saved note. Do not increase native input buffers without memory measurements and boundary tests.

### 8.2 Views and actions

Keep eight-item list pages and the existing four-chunk note content pages as initial defaults. Task lists become paginated server/phone projections rather than the complete native 32-slot store. The current page and pending UI attempt are RAM-only.

Use explicit task `complete` and `restore` actions. Show a sending state until phone acceptance, then pending/saved status as appropriate. A lost phone connection disables writes, even when a task row is still visible.

Pin multi-page note reads to a content revision. A changed or expired revision triggers a refresh rather than mixing pages from different bodies. Never submit displayed chunks as the full note.

For editable plain notes, distinguish **Append** from **Replace entire note**. Whole-note replacement requires explicit intent and the original base revision. Hide/disable unavailable actions based on per-record capabilities. Rich or incomplete Notion projections are not whole-note editable by default.

Opening a collection after a watch restart fetches it again. Counts are unknown until the phone supplies them; do not persist collection counts or rebuild a local authoritative task list. Unrelated remembered UI selection preferences may remain.

### 8.3 Persistence audit

Remove normal collection `persist_write_*` paths and prohibit indirect persistence through saved screen snapshots, notification payloads, or collection replay records. Tests must fail on task/note content persistence after migration mode completes. Existing timer/alarm and unrelated preference persistence is outside this prohibition.

## 9. Provider-neutral synchronization engine

### 9.1 Adapter contract

The following is a behavioral interface, not drop-in Go code. Define typed Go equivalents and version the descriptor/state schema.

```text
Describe() -> ProviderDescriptor
ValidateConnection(config, credentials) -> AccountIdentity + Capabilities
ListContainers(connection, page) -> RemoteContainers
FetchRecord(binding, remoteID) -> RemoteRecord or classified error
PullChanges(binding, checkpoint, continuation) -> ChangePage
ApplyMutation(binding, immutableIntent, lastSyncedBase) -> ApplyResult
```

Optional extension interfaces: `ReconcileUnknown`, `HandleWebhook`, and `MigrateProviderState`. Authentication flow helpers are shared services; providers supply the endpoints, scopes, and necessary custom behavior.

`ChangePage` includes normalized changes, opaque remote versions, preserved fields, continuation, candidate checkpoint, and an explicit indication of full-snapshot coverage/completion. Partial or filtered results cannot imply deletion.

`ApplyResult` includes `applied`, `conflict`, `retryable`, `auth_required`, `permanent_error`, `delivery_unknown`, or `in_progress`; any remote operation ID; the returned normalized record; and the exact submitted local revision it acknowledges. An HTTP 202 from an asynchronous provider operation is not completion: persist its remote operation reference and poll to a terminal outcome.

Descriptors include supported kinds, auth modes, safe configuration fields, container selection requirements, note-write modes, task completion/restoration, due-date precision, conditional-write strength, create deduplication, incremental-read support, and optional bridge prerequisites. Capabilities may become narrower per record because of permissions/content.

Adapters do not receive SQL handles or UI objects. The core owns retries, durable work, credentials access boundaries, transactions, and device delivery. Adding an adapter requires its implementation, registration, descriptor, and shared contract tests—not a new switch in the watch or voice parser.

### 9.2 Worker ordering

Start with one serialized worker per binding, coordinating pulls and outbound work; support multiple independent bindings through a bounded pool. Lease jobs durably and recover abandoned leases on restart. Never hold a database write transaction during external network calls.

For a new binding, finish initial discovery/import before enabling normal outbound synchronization. For an existing record, compare incoming/current remote state against the last synchronized base before applying a local change. Persist imported changes and checkpoint progress together.

A remote write acknowledgment may refer to an older local revision while a new local mutation has already committed. Update the mapping for the acknowledged version only; leave the newer version dirty. Do not overwrite it with the older provider response or mark it synced.

A provider normalization response—such as a sanitized note title or next recurring occurrence—is a typed reconciliation result, not an instruction to recreate the just-completed operation. Suppress echo loops through mappings and last-synchronized revisions, not through loose timestamps.

### 9.3 Retry, uncertainty, and conflicts

Use bounded exponential backoff with jitter; proposed range 2 seconds to 15 minutes. Honor provider `Retry-After`, quotas, and per-account concurrency. Persist next-attempt state across restarts. Suspend authentication failures pending reconnect; continue accepting canonical server writes.

Internal operation IDs make phone/server replay idempotent. They do **not** prove an external create/append is exactly-once. If the provider may have applied an operation but the response was lost, use documented provider deduplication or a verified reconciliation identity. Otherwise persist `delivery_unknown`, stop blind retries of that operation and its dependents, and offer explicit recovery. Matching a title alone is not proof.

Same-field concurrent edits and delete-versus-edit races preserve the base, current value, and proposal as a conflict. Do not silently resurrect deleted records. For providers without atomic conditional writes, document the weaker guarantee. Keep pre-write versions, prefer non-destructive operations, and disable unsafe full replacement by default where required. A preflight read followed by a write is not atomic compare-and-swap.

Recurring-task completion is an operation on the observed occurrence, not an indefinitely replayable `completed=true`. Persist provider command identity and occurrence context. If the task advances while a completion is pending, require reconciliation before any retry that might complete the next occurrence.

### 9.4 Deletion and movement

Distinguish `deleted`, `completed`, `moved_out_of_scope`, `permission_lost`, and `cache_evicted`. A 401/403, incomplete page, filtered list, missing selected folder, or inaccessible mount must never mass-delete canonical records.

Full-scan absence can remove a binding membership only after all pages complete and scope health is verified. Confirm actual deletion where the provider can distinguish it. Preserve detached canonical data for recovery, and never send a delete back merely because a record moved out of the selected project/category/folder. Do not recreate moved records automatically in the old container.

### 9.5 Scheduling

Polling is the baseline; a publicly reachable webhook endpoint is not required. Proposed remote polling interval: five minutes, configurable per provider and subject to quota. Trigger a prompt sync after a server-side user mutation; coalesce requests. Webhooks can later accelerate pulls but remain hints, not the sole source of truth.

Perform periodic full reconciliation, proposed daily, where the provider supports safe enumeration. Report coverage limitations instead of pretending incremental APIs supply unavailable history. Do not introduce an undisclosed completed-task history cutoff.

## 10. Provider requirements

### 10.1 Todoist — required task adapter

Use the current API v1, not retired Sync v9/REST v2 endpoints. Support one chosen project initially, OAuth plus an optional personal-token setup for self-hosting. Store command UUIDs durably and reuse them across retries; Todoist documents command deduplication and incremental sync tokens. Bootstrap completed-task coverage through the documented completed-task endpoints as needed. [P-D]

Map add/edit/complete/restore/delete; preserve descriptions, hierarchy, recurrence, labels, and unsupported fields. Follow full bootstrap with incremental synchronization. Test lost create responses, repeated recurring completion, completed tasks, remote moves, and permission loss. Report any account/API history limitation in the connection status.

### 10.2 Google Tasks — required task adapter

Use OAuth with the narrowest write scope supporting task synchronization and one selected task list. Paginate reads; explicitly set `showCompleted=true`, `showHidden=true`, and `showDeleted=true`. Use `updatedMin` with an overlap and durable deduplication, plus periodic full reconciliation; commit a polling watermark only after all pages succeed. Never derive it from an unsynchronized phone clock. [P-E]

Preserve date-only semantics: the API's `due` value discards the time component. Do not promise task time-of-day support or silently convert it. Leave assigned tasks excluded initially unless their side effects and permission differences are deliberately supported. [P-F]

Treat create-response loss as uncertain unless reconciliation is proven; do not infer universal create idempotency. Use field patches and verify conditional-write behavior rather than assuming an ETag's presence guarantees every desired operation supports `If-Match`.

### 10.3 Nextcloud Notes — required notes adapter

Accept a validated instance URL and discover/support the installed Notes API. Prefer Nextcloud Login Flow v2, with username/app-password entry as a fallback. Require Notes API 1.2 or later for conditional editable synchronization; older servers may be offered read-only access with an explicit explanation. [P-G, P-H]

Preserve separate title, content, category, favorite, read-only state, and returned sanitized names. Use the remote ETag with `If-Match` for edits and preserve conflicts on 412. Complete every chunked list response before evaluating missing records; pruned ID-only entries are still present, not empty notes. A category change is not automatically a deletion. [P-H]

Do not change the user's global Notes directory or file suffix as part of connection setup. No attachment editing is required.

## 11. Settings, authentication, and binding transitions

### 11.1 UI

```text
Server
  Base URL: [https://server.example/prefix/]
  Connection: [Connected]

To-dos
  Service: [Server only | Todoist | Google Tasks | ...]
  Account: [Connect / Reconnect]
  Collection: [Project or task list]

Notes
  Service: [Server only | Nextcloud Notes | ...]
  Account / endpoint / approved vault: [provider-specific fields]
  Collection: [Category, folder, parent page, or data source]

Sync status
  Phone pending / server saved / backend pending / needs attention
  [Sync now] [Resolve problems] [Disconnect]
```

The phone/settings renderer consumes `GET /v1/providers` descriptors using allowlisted field types: text, URL, secret input, enum, boolean, account selector, and remote-container selector. Descriptors are data, never executable JavaScript. Server validation remains authoritative.

Show only adapters installed on the server. Providers needing operator setup remain visible with a concrete unavailable reason rather than a Connect button that cannot work. Cached descriptors may be displayed during an outage, but new provider selection is not committed until server validation succeeds.

### 11.2 Management routes and browser flow

Add management APIs for connection create/validate/discover/disconnect, OAuth start/callback/status, binding preview/apply, and conflict resolution. All state-changing management requests require an authenticated principal, CSRF protection where cookies are used, and audited intent. Browser sessions are not authorized to run arbitrary commands or inspect unrelated secrets.

The phone obtains a short-lived, single-use integration-management ticket through authenticated `POST /v1/integration-sessions`. It opens a server-hosted settings page with that ticket, immediately exchanges it, and removes it from browser history. Proposed ticket lifetime: five minutes. Bind it to the issuing server/principal, restrict redirect destinations, set a restrictive content security policy and `Referrer-Policy: no-referrer`, and avoid third-party scripts.

Never return provider tokens in a Pebble close URL, settings fragment, provider descriptor, watch message, or saved browser state. Provider authorization and credential entry happen on the server-hosted integration flow. Also stop echoing the existing server bearer token into the ordinary settings URL: pass only a configured/not-configured flag, and preserve the saved token when a settings submission leaves its replacement blank. The phone refreshes connection metadata after that flow closes.

Use an external/system browser for provider login where required. Verify the complete callback/resume flow on supported phone platforms; do not assume an embedded configuration webview is accepted by Google. OAuth callback reachability and registered redirect URLs are part of deployment configuration, not something the adapter can invent.

### 11.3 Self-hosted OAuth policy

Version one uses operator-configured OAuth application credentials. No maintainer-operated broker is required. Document client registration, allowed redirect URLs, consent/scopes, refresh-token storage, and production-readiness steps for each OAuth provider.

In particular, Google's external Testing mode normally issues refresh tokens with a seven-day lifetime for non-basic scopes. Do not present a Testing-mode deployment as unattended production synchronization. [P-M]

Encrypt stored provider secrets with a server key held separately from the database, or use an explicitly configured OS secret store. Restrict file access, redact logs, and provide token revocation/reconnect. Serialize refresh-token rotation so concurrent workers cannot overwrite newer credentials. The database/master key and adapter secrets must not be exposed through the agent workspace, prompts, or inherited tool environment.

### 11.4 First connection, switching, and Server only

Initial provider connection is staged: authenticate, discover scope, preview remote import and existing server records, choose whether to copy existing records outward, then activate the binding. Do not upload the entire existing server collection by default or deduplicate by matching titles. Report count/coverage, permissions, and limitations before activation.

Binding changes increment the collection's generation. Pending operations retain their original collection, generation, and destination. Stale phone mutations return a recoverable `binding_changed` outcome rather than being redirected. Freeze the old worker at a safe boundary; resolve any in-flight/unknown delivery before claiming it was canceled.

Switching must explicitly handle pending provider work: finish it, or stop old delivery while retaining the canonical data and recording the user's choice. New mappings belong to the new binding and never reuse an old account's remote IDs. Rebinding the same provider/account/container can reuse verified mappings after reconciliation.

Selecting Server only preserves canonical content and disables the active external binding. It does not delete remote records or clear the phone queue. Changing a provider and deleting a collection are separate actions. Retain old mapping/history information for recovery and duplicate prevention.

## 12. Security and operational boundaries

Require HTTPS for non-local deployment by default. Any development HTTP/private-network exception must be explicit and must not silently disable certificate verification. Derive a legacy server base URL only from recognized agent endpoint shapes; arbitrary custom paths require explicit configuration. Validate returned server identity before enrollment or replay.

For self-hosted adapters, prevent unintended server-side requests: restrict URL schemes, validate resolved destinations and redirects, do not forward credentials across origins, and block metadata/link-local destinations. Private-network access requires an operator-approved host/mount policy. Preserve Nextcloud subdirectory deployments.

Treat provider content as untrusted text. Escape settings HTML and PAM attributes, limit payloads, and never execute note content or remote configuration. Connection setup must not install/run arbitrary code from a supplied URL.

A provider error must not take down the collection API. Limit worker concurrency, request time, body size, and memory. Continue serving canonical data when the provider or agent is unavailable. Readiness reports collection/database state separately from Codex and provider health.

Provide a backup/export command covering canonical records, mappings, receipts, conflicts, and outstanding work. Backups and secrets require a documented recovery procedure. Sync is not backup: it propagates deletions.

Restoring an older database changes `store_epoch`, invalidates change cursors, pauses outbound provider work, and requires reconciliation. Quarantine old phone operations rather than blindly replaying potentially already-delivered creates against rolled-back receipts. Resume only through an explicit recovery workflow. Uncoordinated manual database rollback cannot be made safe by a cursor alone.

## 13. Breaking development rollout

No legacy data preservation is required. Ignore the former phone notes store and
native task slots. Do not accept old watch-local create/toggle commands or fall
back to local authoritative writes. New collection mutations require protocol 1,
server authentication, and durable enrollment. Downgrading is unsupported.

## 14. Observability and validation

Record structured IDs, state transitions, retry counts, and durations—not note bodies, task titles, bearer tokens, or OAuth responses. Expose phone pending count, oldest pending age, provider outbox depth/age, last successful pull/push, conflicts, unknown deliveries, storage use, and migration status. Logs should let an operator trace one operation through phone/server/provider by ID.

### 14.1 Required acceptance matrix

| ID | Test | Required outcome |
|---|---|---|
| A01 | Fresh server with no Codex installed/available | Server-only create/read/edit/complete and collection API work. |
| A02 | Create on watch; phone storage write fails | No saved acknowledgment; existing journal unchanged. |
| A03 | Phone accepts; runtime is killed before upload | Complete input recovers and uploads once on next active runtime. |
| A04 | Server commits; HTTP response is lost | Retry returns recorded outcome; no duplicate canonical record. |
| A05 | Kill server around mutation/outbox transaction | Both canonical change and provider work exist, or neither exists. |
| A06 | Phone acknowledgment to watch is lost | Same ingress event recovers the original operation. |
| A07 | Duplicate event ID with changed payload | Error; no second mutation. |
| A08 | Create then edit/complete while server unavailable | Dependency ordering preserved; no fabricated base revision. |
| A09 | Full journal/cache pressure | Cache evicted first; pending input never evicted; new save rejected clearly if needed. |
| A10 | Open cached list/body during outage | Correct stale view; uncached body reports unavailable, not empty. |
| A11 | Phone disconnected, including checkbox tap | No new mutation or collection persistence on watch. |
| A12 | Watch restart before/after phone acknowledgment | Only phone-accepted input is recoverable; UI never falsely reported earlier success. |
| A13 | Snapshot/change paging interrupted or cursor expired | Safe restart; no skipped changes or false deletions; outbox preserved. |
| A14 | Incoming old page while a local mutation is pending | Optimistic projection does not regress or disappear. |
| A15 | View alias reused after list refresh | Old action rejected or deduplicated; never targets a different record. |
| A16 | Note changes between content pages | One pinned revision or explicit refresh; never mixed contents. |
| A17 | Long/Unicode note and partial transfer | No silent truncation, invalid UTF-8, or partial-save acknowledgment. |
| A18 | Server or provider concurrent edit; delete-versus-edit | Recoverable conflict; no silent overwrite/resurrection. |
| A19 | Provider create/append response lost | Verified dedup/reconciliation or delivery_unknown; no blind duplicate retry. |
| A20 | New local revision while old provider write finishes | Only old revision acknowledged; new work remains pending. |
| A21 | Recurring-task completion retried | No unintended completion of the next occurrence. |
| A22 | Remote completed/hidden/deleted tasks | Correct task state; completion remains distinct from deletion. |
| A23 | Partial provider page, 401/403, missing mount, remote move | No mass deletion, re-creation, or false empty collection. |
| A24 | Provider auth revoked, refreshed, or rotated | Canonical app stays usable; correct reconnect/retry behavior; secrets absent from logs. |
| A25 | Provider/account/server switch with pending work | Original destination preserved; stale generation quarantined; no cross-account delivery. |
| A26 | Reopen agent job / start new chat | No duplicate collection action; collection namespace unchanged. |
| A27 | Breaking development upgrade | Legacy stores ignored; no new local authority or compatibility fallback. |
| A29 | Backup restore with outstanding provider operations | New epoch, paused delivery, reconciliation; no blind replay. |
| A30 | Add a fake adapter to the registry | Works through generic settings, engine, phone, and watch without provider branches there. |
| A31 | Native persistence instrumentation after migration | Zero task/note content writes; unrelated native features still pass. |
| A32 | Supported phone/browser and watch hardware matrix | Readiness, journal recovery, OAuth return, paging, and memory budgets verified. |

Use fake clocks, fault-injected storage/HTTP, deterministic provider fixtures, and simulated lost/duplicate/reordered responses for automated tests. Use sandbox/test accounts for authenticated round trips. Record the provider/API version and limitations in each adapter's conformance report.

## 15. Definition of done

The server-only slice is complete when migrated notes/tasks and new watch actions are durably server-owned, the phone queue survives supported restarts/outages, the watch has no collection persistence, and collection use does not require Codex.

The initial provider slice additionally requires Todoist, Google Tasks, and Nextcloud Notes passing shared and provider-specific tests. Obsidian and Notion are outside the confirmed scope.

Every release includes schema migrations, API/protocol documentation, an adapter conformance report, migration/rollback and backup/restore runbooks, and passing repository test/build checks. Mock-only provider success is insufficient for a release claim of working bidirectional synchronization.

## 16. Source notes

Sources were inspected on September 13, 2026. Repository citations are pinned to the reviewed commit. External APIs can change; recheck provider versions at implementation time. The specification's proposed contracts, limits, and architecture are design decisions, not claims that these components already exist.

### Repository sources

- **[R-A]** [Existing collection behavior and planned boundary](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/docs/collections.md).
- **[R-B]** [Phone notes store and bounded rendering](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/src/common/notes.js).
- **[R-C]** [Native task storage, states, and actions](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/src/c/capabilities/todos.c).
- **[R-D]** [Phone bridge, capabilities, and job replay](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/src/pkjs/index.js).
- **[R-E]** [Server startup and default paths](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/cmd/pebble-agent-server/main.go).
- **[R-F]** [Settings serialization](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/src/common/settings.js).
- **[R-G]** [Package scripts, targets, and message keys](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/package.json).
- **[R-H]** [Server release build matrix](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/.github/workflows/release-server.yml).
- **[R-I]** [Legacy native record identity](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/src/c/capabilities/record_identity.h).
- **[R-J]** [Architecture, rendering, and refresh policy](https://github.com/nick1udwig/pebble-agent/blob/db1f87610340748293eef22016f3d150265b0e98/docs/architecture.md).

### Primary platform/provider sources

- **[P-A]** [PebbleKit JS storage, readiness, and lifecycle](https://developer.repebble.com/guides/communication/using-pebblekit-js/).
- **[P-B]** [SQLite write-ahead logging](https://www.sqlite.org/wal.html).
- **[P-C]** [SQLite backup API](https://www.sqlite.org/backup.html).
- **[P-D]** [Todoist API v1: OAuth, sync, command UUIDs, and completed tasks](https://developer.todoist.com/api/v1/).
- **[P-E]** [Google Tasks list parameters](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list).
- **[P-F]** [Google Tasks resource fields and limitations](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).
- **[P-G]** [Nextcloud Login Flow v2](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2).
- **[P-H]** [Nextcloud Notes API versions, chunking, and conditional writes](https://github.com/nextcloud/notes/blob/main/docs/api/v1.md).
- **[P-I]** [Obsidian Headless Sync](https://help.obsidian.md/sync/headless).
- **[P-J]** [Notion Markdown API guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content).
- **[P-K]** [Notion Markdown retrieval and incomplete blocks](https://developers.notion.com/reference/retrieve-page-markdown).
- **[P-L]** [Notion Markdown updates and asynchronous results](https://developers.notion.com/reference/update-page-markdown).
- **[P-M]** [Google OAuth lifecycle and refresh-token expiration](https://developers.google.com/identity/protocols/oauth2).
