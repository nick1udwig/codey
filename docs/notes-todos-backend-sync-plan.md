# Notes and To-Dos Backend Sync: Implementation Plan

Implementation lives on `feat/sync-notes-to-dos-with-backend`. See
[implemented behavior](collections.md) and [operations / validation](collections-server-operations.md).
Hardware and authenticated provider qualification are release gates, not claims made by automated fixtures.

**Companion specification:** [notes-todos-backend-sync-spec.md](notes-todos-backend-sync-spec.md)  
**Baseline:** `db1f87610340748293eef22016f3d150265b0e98`  
**Scope (confirmed September 13, 2026):** Server-owned notes/tasks; durable phone queue; no watch collection persistence; Todoist, Google Tasks, and Nextcloud Notes. Obsidian, Notion, migration, and backward compatibility are excluded. Existing development data may be discarded.

The specification is the behavioral authority. This plan divides it into reviewable work packages. Do not ship provider enablement before the durable server/phone path, breaking rollout, and recovery behavior pass their gates.

## 1. Delivery sequence

| Package | Deliverable | Dependencies | Acceptance focus |
|---|---|---|---|
| WP01 | Protocol/domain contracts and fault-test harness | None | Stable identity, lossless data types, reproducible failure points. |
| WP02 | Durable SQLite collection store and independent server startup | WP01 | Canonical transactions, restart recovery, no Codex dependency. |
| WP03 | Mutation API, consistent snapshots, and change feed | WP02 | Server replay, conflicts, cursor safety, authenticated scope. |
| WP04 | Persistent phone journal and disposable cache | WP01, WP03 | Persist-before-ack, restart recovery, bounded storage. |
| WP05 | Thin watch views and collection protocol | WP04 | Phone-only writes, paging, explicit completion, no persistence. |
| WP06 | Breaking development rollout | WP03–WP05 | Ignore legacy stores; never fall back to local authority. |
| WP07 | Provider registry, settings, and authentication | WP03 | Generic descriptors, safe secrets, account/container selection. |
| WP08 | Durable provider synchronization engine | WP02, WP03, WP07 contract | Correct checkpointing, version-specific acknowledgments, uncertainty. |
| WP09 | Todoist adapter | WP07, WP08 | Task round trips, command UUIDs, recurrence. |
| WP10 | Google Tasks adapter | WP07, WP08 | OAuth, hidden/completed/deleted tasks, date-only semantics. |
| WP11 | Nextcloud Notes adapter | WP07, WP08 | Conditional updates, chunked enumeration, categories. |
| WP14 | Operational hardening and complete release qualification | All applicable packages | Hardware, provider accounts, backup/restore, security, documentation. |

WP04 storage work can proceed against WP01 fixtures before the HTTP implementation is complete. WP07 and WP08 can proceed in parallel after their interface is agreed. WP09–WP13 can proceed independently after the shared adapter conformance suite exists. Avoid five separate implementations of retries, OAuth storage, or conflict handling.

## 2. Work packages

### WP01 — Freeze the contracts and failure model

Define canonical record/operation types, statuses, capability descriptors, and versioning. Publish the HTTP schema and collection message additions from the specification in repository docs; add OpenAPI/JSON schemas as implementation outputs. Preserve existing AppMessage key values.

Build fake clocks, a fault-injectable storage interface, a fake provider, and transport fixtures supporting duplicate, lost, reordered, and partial responses. Give every persistence and acknowledgment boundary a named failure-injection point.

Record the ownership rules as architecture decisions: server canonical store; phone journal owns accepted-but-uncommitted work; no disconnected-watch mutations; Server only still requires the server. Document journal and body-size limits as testable configuration, not undocumented constants.

**Exit:** Contract fixtures can express every A01–A32 scenario in the specification. No provider SDK has entered the phone or watch build.

### WP02 — Implement the server-owned store

Add a durable data directory, SQLite migrations, foreign keys/indexes, record versions, receipts, tombstones, provider outbox placeholders, and monotonic change sequences. Implement transactional create/patch/complete/restore/append/replace/delete services.

Refactor `main.go` so collection initialization and HTTP service do not depend on Codex connecting. Agent health remains separately reported; existing agent endpoints must return meaningful unavailability rather than preventing startup. Keep database/secrets outside the agent workspace and OS cache directory.

Choose and pin the SQLite driver only after verifying the repository's release architecture/toolchain matrix. Add transactional rollback/restart tests and authenticated repository access tests.

**Exit:** A fresh server can save and retrieve notes/tasks, restart, and retain them without Codex. Record + change event + receipt + provider-job intent are committed together.

### WP03 — Add the client API and change model

Implement enrollment, collection descriptors, mutations, operation lookup, consistent snapshots, paginated changes, bounded revision-pinned body reads, and structured errors. Use opaque scope/epoch-bound cursors. Implement explicit base revisions and dependent operations.

Add durable conflicts/proposals and a minimum management view/API to inspect them. A client must be able to distinguish a safely recorded conflict from an input it still owns. Never treat a 202 scheduling response or an authentication failure as a record commit.

**Exit:** Lost HTTP responses cannot duplicate core writes; snapshot changes cannot be skipped under concurrent writes; expired cursors trigger resnapshot without touching pending work. Tests A04, A05, A08, A13, A18, A25, and A29 pass.

### WP04 — Build the phone journal and cache

Implement the alternating-slot journal, checksums/schema validation, atomic identity/sequence allocation, complete mutation payload retention, ingress receipts, and dependencies. Add an independent bounded cache with staged generations, explicit partial-coverage markers, query invalidation, and an overlay projection.

Implement startup recovery, persist-before-ack, HTTP submission/receipt handling, retries, scope quarantine, cache eviction, quota errors, and on-demand note bodies. Keep accepted operations independent of active screen/request cancellation. Retain uncertain/permanently rejected input until a durable handoff or explicit user discard.

Implement bounded deduplication retention without allowing old agent-job playback to create new operations. Distinguish raw input, queued operation, server receipt, and rendered status in tests.

**Exit:** Tests A02–A04, A06–A10, A14, A17, A25, and A26 pass under injected storage/network failures. Real phone runtime termination testing remains a release gate, not something Node mocks prove.

### WP05 — Replace native task ownership with transient views

Remove the normal 32-slot task database and local toggle path. Implement provider-neutral task pages, completed/archive pages, action capability flags, and explicit `complete`/`restore` messages. Route task/note capability commands into the phone collection client.

Add bridge-session/event identities and exact view-token/revision resolution. Keep note body pages bounded and pinned to a revision. Add sending/phone-saved/server-saved/backend-sync labels and disconnected-write gating. The watch may retain an unfinished transmission in RAM while open; it must never persist it.

Instrument native persistence and audit indirect content snapshots. Preserve unrelated alarms, timers, UI preferences, and passive refresh behavior.

**Exit:** Tests A11, A12, A15–A17, and A31 pass; both target builds fit measured RAM budgets. The watch can browse a collection larger than its current page without owning that collection.

### WP06 — Breaking development rollout

The user explicitly authorized discarding legacy collection data. Do not implement
an importer, compatibility protocol, or fallback to watch-owned tasks/phone-owned
notes. Leave old keys unused; new saves require enrollment in protocol version 1.

### WP07 — Build generic settings and integration authentication

Implement server-backed provider descriptors, availability reasons, schema rendering, remote-container discovery, and a staged connection wizard. Add the Server only choices and per-destination status. Preserve non-secret cached metadata during outages without pretending configuration was committed.

Implement short-lived management sessions, provider-secret isolation, OAuth state/redirect validation, refresh-token rotation, and self-host endpoint validation. Document operator-owned OAuth registrations; do not add an implicit hosted broker.

Implement binding preview/apply with generation checks, explicit initial export selection, and pending-work handling. Disconnect preserves canonical records and never deletes provider data automatically.

**Exit:** A fake provider can be configured without custom phone/watch code. Secrets do not appear in settings fragments, watch messages, logs, or agent inputs. Account-switch tests fail safely.

### WP08 — Implement the shared synchronization engine

Implement serialized per-binding workers, durable leases, retry/backoff, candidate/committed checkpoints, full-enumeration membership, mapping/base snapshots, conditional conflict handling, and revision-specific acknowledgments.

Implement `delivery_unknown` and `in_progress`, including reconciliation references and blocked dependents. Add status/metrics and recovery management. Do not use “retry everything” for potentially applied external operations.

Write a reusable conformance suite that every real adapter must pass. Simulate remote moves, partial enumeration, revoked permissions, newer local revisions during a push, and recurring occurrence changes.

**Exit:** Tests A18–A25 and A30 pass with the fake provider. A newly registered adapter can run without access to database internals or UI state.

### WP09 — Todoist

Implement the API v1 adapter, account/project selection, OAuth/personal-token setup, incremental reads, completed-task coverage, and stable command UUIDs. Preserve provider-only fields and occurrence semantics.

**Exit:** Authenticated create/read/edit/complete/restore and remote-to-server-to-watch round trips pass, including recurrence and response-loss cases. Record API/account limitations rather than hiding them.

### WP10 — Google Tasks

Implement task-list selection and registered OAuth flow with server-held refresh tokens. Explicitly include hidden/completed/deleted records, overlap incremental polling, and test full reconciliation. Keep due values date-only and assigned-task behavior out of the default scope.

**Exit:** Changes made in Google's own client return correctly to the watch. Auth expiration, uncertain creates, and completion restoration have tested outcomes.

### WP11 — Nextcloud Notes

Implement instance URL handling, Login Flow v2/app-password authentication, category selection, full content reads, ETag/If-Match updates, and safe chunk completion. Preserve title/category sanitation and read-only capabilities.

**Exit:** Authenticated note round trips and concurrent edits pass against a documented Notes API version. A partial list or moved category cannot delete server notes.

WP09–WP11 plus the preceding foundation complete the **initial provider milestone**. Do not describe the later Notion/Obsidian work as already supported at this point.

### WP14 — Qualify deployment and recovery

Run the existing repository suite, native sanitizer tests, both watch builds, the server cross-build matrix, and real phone/watch scenarios. Use dedicated provider test accounts; save scrubbed fixtures and conformance results.

Finish backups, restore-epoch behavior, connection revocation, journal export, conflict/unknown-delivery recovery, migration rollback guidance, and health/metrics. Verify actual restart durability, quota behavior, OAuth browser return, and platform lifecycle assumptions.

**Exit:** Applicable acceptance tests A01–A32 pass with evidence. No silent data-loss paths remain unclassified. Any weaker provider guarantee is surfaced in settings and the adapter report.

## 3. Release gates

### Gate A — Server-only ownership

WP01–WP06 complete. New notes/tasks are server-owned, the phone queues during server outages, legacy authority is removed, and disconnected-watch writes are disabled. No Codex installation is required to use collections. Backups and basic conflict recovery must already exist.

### Gate B — First external providers

Gate A plus WP07–WP11 and their operational qualification. Todoist, Google Tasks, and Nextcloud Notes pass actual round trips. Adding a fake provider requires no watch/phone integration-specific changes.

### Gate C — Full named integration scope

Gate B plus operational qualification for the three included providers. Obsidian/Markdown and Notion are outside this branch.

Optional downloadable server adapters belong to a later design/release. Do not delay Gates A–C for plugin packaging, signing infrastructure, or a marketplace.

## 4. Implementer handoff checklist

Before declaring a package complete, update the relevant specification/API documentation, add failure-injection tests, preserve existing non-collection behavior, and demonstrate the package's exit condition. Tests of only the successful request path are insufficient.

The final handoff includes database migrations, API schemas, native/JS protocol definitions, adapter conformance reports, platform test evidence, setup instructions, and recovery runbooks. Externally supplied credentials or deployment-specific URLs are configuration inputs—not reasons to leave the architectural behavior unspecified.
