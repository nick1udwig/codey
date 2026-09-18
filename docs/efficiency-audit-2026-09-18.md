# Efficiency and maintainability opportunities — 2026-09-18

Review baseline: `39be1f8`, with the user's existing uncommitted documentation,
artwork, and icon-generation changes present. The original assessment follows; implementation progress is recorded below.

The [September 15 audit](efficiency-audit.md) is already implemented. Its
completed changes—bounded opened jobs, batched phone receipts, indexed snapshot
pages, adaptive polling, shared status scans, artwork pruning/caching, and removed
bridge state—are not being proposed again.

## Recommended order

Priority means implementation order, not incident severity. Size is relative
engineering scope. Benefits are source-derived unless identified as measured.

| # | Priority | Opportunity | Main benefit | Scope |
| --- | --- | --- | --- | --- |
| 1 | First | Bound render text and send sparse patches | Bluetooth traffic, phone/watch CPU, battery | Small/medium |
| 2 | First | Replace accumulated response text with a presence flag | Server allocations, CPU, simplicity | Small |
| 3 | First | Back off watch delivery retries | Watch wakeups and radio traffic during outages | Medium |
| 4 | First | Produce a smaller release PBW | About 219 KB of removable package payload in this build | Small/medium |
| 5 | First | Index provider work by the keys actually queried | Server CPU and growing-history latency | Small |
| 6 | Next | Batch changed provider imports | Transactions, storage I/O, sync latency | Medium |
| 7 | Next | Evict phone cache entries selectively | Phone memory, serialization, offline usefulness | Medium |
| 8 | Next | Normalize durable phone journal storage | Phone memory, storage capacity, serialization | Medium |
| 9 | Next | Make body pagination independent of full body size | Server allocations and CPU | Medium/large |
| 10 | Next | Remove redundant native element clearing/copying | Watch CPU and peak stack use, simpler updates | Small/medium |
| 11 | Next | Separate clock paint from content layout | Watch CPU and battery | Medium |
| 12 | Next | Extract cohesive bridge and renderer modules | Modularity, readability, safer future changes | Medium; staged |
| 13 | Later | Reclaim inactive agent bookkeeping | Long-lived server memory and session-write cost | Medium |

The tasks below were approved for sequential implementation after the audit. See implementation results for completed work.

## 1. Bound render text and send sparse patches

**Evidence.** [elementMessages](../src/common/watch-protocol.js#L146) splits the
entire value into 180-byte chunks and emits all of them. The
[native value buffer](../src/c/agent_ui.h#L9) holds 320 bytes including its
terminator; [append](../src/c/agent_ui.c#L2274) silently stops copying once full
but still schedules a refresh. A valid 1,800-byte ASCII text value therefore
produces ten element messages although two suffice to reproduce its displayed
319-byte prefix. Eight messages carry no additional displayable text.

[ScreenModel patch handling](../src/common/model.js#L139) also passes a merged
copy of every existing attribute to the encoder. A title-only patch can resend
the unchanged value, action, subtitle, metadata, and flags, including all the
value's append messages.

**Implementation direction.** Bound only render-element values to the native
UTF-8 capacity before chunking. Preserve full canonical notes, job results, and
capability inputs. Then use the original patch attributes to decide which wire
fields to send, while retaining merged attributes for validation and for
rebuilding metadata/flag groups when one of their members changes. Keep an
explicit empty value distinct from an omitted field.

**Acceptance.** Verify final native fields for add, replacement,
title-only patches, empty-string clearing, flags, metadata changes, and UTF-8
characters crossing both chunk and buffer boundaries. Require a contiguous
UTF-8 prefix: later append chunks must not fill spare bytes left when an earlier
multibyte character cannot fit. Count packets: the ASCII
example should need at most two, and a title-only patch should not append value
data. Keep request ordering, queue bounds, and failure reporting intact. Start
with `tests/run.js` and native protocol/UI fixtures, then measure Bluetooth
bytes and completion latency on a paired watch.

**Tradeoff.** This preserves the documented bounded-prefix behavior; supporting longer
visible text is a different product/protocol change. Battery savings need device
measurement. KB: `issues/bound-render-wire-work`.

## 2. Replace accumulated response text with a presence flag

**Evidence.** [itemState](../internal/agent/agent.go#L242) retains `text`.
[push](../internal/agent/agent.go#L370) performs `item.text += delta` before
passing the same delta to `OutputStream`. The only subsequent use of the
accumulated string is [the empty check](../internal/agent/agent.go#L291), which
decides whether completed-item text is needed as a fallback.

For N similarly sized deltas, repeated concatenation copies a growing prefix:
O(N²) cumulative bytes. As a source-derived illustration, 64 KiB delivered in
16-byte deltas produces roughly 128 MiB of concatenation output, despite
requiring only a yes/no flag here. This is not a measured production allocation.

**Implementation direction.** Replace the retained string with whether
nonempty answer text has been pushed. Keep pre-start pending deltas and
commentary filtering; the existing bounded PAM stream remains responsible for
line buffering and the jobs store remains responsible for result retention.

**Acceptance.** Cover started/delta/completed ordering, delta-before-start,
completed text without deltas, empty deltas, commentary, multiple items, and
stream failures. Preserve exactly-once fallback emission. Add a focused benchmark
with increasing delta counts showing linear rather than quadratic allocation
growth; run `go test ./internal/agent ./internal/pam`.

**Tradeoff.** Very low behavioral scope if the flag follows the current empty
string semantics. KB: `issues/remove-turn-text-accumulation`.

## 3. Back off watch delivery retries

**Evidence.** [prv_collection_retry](../src/c/main.c#L146) always schedules
another callback after 3,000 ms while a collection acknowledgment is outstanding.
It continues waking when disconnected, although the connection check prevents
sending then. That is **1,200 callbacks per hour** for one pending save while
the app remains running. If the phone connection exists but the bridge does not
acknowledge, the same operation can also be enqueued again every three seconds.

There is a second path: [APP_MSG_BUSY handling](../src/c/main.c#L219) schedules
100 ms retries without consuming the normal failure budget. Persistent busy
status can therefore approach 36,000 retry callbacks/hour, ignoring API overhead.

**Implementation direction.** Keep the pending operation and its original
identity, but use a bounded exponential delay after an initial responsive retry
window. Suspend collection retry timers while disconnected and resume promptly
on connection/bridge readiness. Give sustained busy responses a bounded active
retry window too. Consolidate timer ownership so reconnect, acknowledgment,
navigation, and shutdown cannot leave duplicate timers.

**Acceptance.** Simulate long disconnection, connected-but-unresponsive JS,
persistent busy status, reconnection, acknowledgment loss, duplicate and stale
acknowledgments, and bridge-session changes. Assert a bounded timer/send count,
prompt reconnect retry, unchanged event identity, and no false “saved”
confirmation. A timeout must not discard uncertain user input.

**Tradeoff.** Backoff trades unattended retry latency for energy. Keep user
initiated retry responsive. This is separate from the already adaptive phone
HTTP poller. KB: `issues/backoff-watch-delivery-retries`.

## 4. Produce a smaller release PBW

**Measured evidence.** The current [bundle build](../wscript#L49) produces a
450,470-byte PBW. All nine ZIP entries are stored without compression:

- `pebble-js-app.js`: 135,083 bytes.
- `pebble-js-app.js.map`: 163,309 bytes.
- A temporary copy minified with the installed SDK's UglifyJS, using ordinary
  compression and identifier mangling, is **79,587 bytes** and passes
  `node --check`.

Minifying removes **55,496 bytes (41.1% of JS)**. Keeping the source map outside
the release bundle would remove another **163,309 bytes**. The combined payload
opportunity is **218,805 bytes**, about **48.6% of the current PBW**, before the
small ZIP-directory difference. No modified PBW was installed or published.

**Implementation direction.** Add a reproducible release packaging path in
`wscript`/a build script. Minify generated JS, preserve externally visible
property names, and retain matching maps as separate debug artifacts. Keep
normal development builds debuggable. Integrate at the source build boundary;
do not manually edit generated webpack files. ZIP deflation is a separate
experiment requiring installer compatibility checks.

**Acceptance.** Check package manifests/checksums and compare all watch binaries
and resources against the normal build. Exercise the actual generated release
bundle in PebbleKit JS, including module loading, settings, Unicode parsing,
jobs/actions, and collection recovery. A syntax check alone does not establish
runtime equivalence. Preserve license notices and a usable symbolication path.

**Tradeoff.** These are package and phone-JS size savings, **not smaller native
watch executables or proven watch RAM savings**. Server release CI already uses
`-trimpath -ldflags='-s -w'`; watch builds already use `-Os` and section GC.
KB: `issues/shrink-release-pbw-packaging`.

## 5. Index provider work by the keys actually queried

**Evidence.** The [schema](../internal/collectionstore/store.go#L52) indexes
provider jobs only by state and mappings by `(binding_id, remote_id)`.
[Mapping](../internal/collectionstore/providers.go#L168) searches by
`(binding_id, record_id)`; [Pending](../internal/collectionstore/providers.go#L180)
filters binding and unfinished state; [Import](../internal/collectionstore/providers.go#L314)
counts unfinished jobs for one binding/record.

`EXPLAIN QUERY PLAN` against the current schema in an empty scratch SQLite
database showed only a binding-prefix mapping search and **full provider_jobs
scans for both job queries**. These are planner observations, not timings from
the production database. Applied/stopped rows remain in that table, so costs
can grow with delivery history rather than current work.

**Implementation direction.** Add a nonunique mapping index on
`(binding_id, record_id)`. Evaluate partial indexes for unfinished jobs, scoped
by binding and by binding/record, matching the exact existing state predicate.
Choose the minimal index set that supports both ordered iteration and the
per-record count; preserve rowid/FIFO ordering. Do not declare uniqueness without
checking the mapping contract.

**Acceptance.** Check plans and timings with 100, 10,000, and 100,000 historical
jobs plus a small pending set. Verify migration of an existing store, binding
switching, per-record ordering, conflict detection, and all nonterminal states.
Measure write overhead and database size as well as reads.

**Tradeoff.** Extra indexes consume disk and add write work. This is not a reason
to delete idempotency receipts or history blindly.
KB: `issues/index-provider-work-lookups`.

## 6. Batch changed provider imports

**Evidence.** The [provider engine](../internal/collectionsync/engine.go#L243)
calls `Store.Import` separately for every record.
[Import](../internal/collectionstore/providers.go#L274) begins a transaction,
loads/validates binding and mapping state, and commits each changed record.
The store uses [WAL with synchronous=FULL](../internal/collectionstore/store.go#L84).
A pull containing 1,000 genuinely new/changed records therefore makes 1,000
import commits, plus other sync bookkeeping. Unchanged imports return without a
write commit; they should not be counted as 1,000 fsyncs.

**Implementation direction.** Extract transaction-scoped import logic and use it
from both the single-record API and a bounded page/batch import API. Reuse
prepared statements within a batch. Keep network calls outside transactions.
Only advance checkpoints after their data is durably committed, and reconcile
absence only after a complete successful enumeration.

**Acceptance.** Measure commits, WAL bytes, elapsed time, and foreground read
latency for unchanged, fully changed, and mixed pulls. Preserve atomic canonical
record/version/change/mapping updates, concurrent-edit conflicts, binding
changes, interrupted enumeration, failed commits, deterministic-create
deduplication, and deletion windows. Run collectionstore/provider/engine tests.

**Tradeoff.** The single database connection makes very large transactions block
watch reads. Bound both batch size and transaction duration instead of wrapping
an entire provider account in one transaction.
KB: `issues/batch-provider-record-imports`.

## 7. Evict phone cache entries selectively

**Evidence.** [saveCache](../src/common/collections/client.js#L5) serializes the
entire cache on each save. [List reads](../src/common/collections/client.js#L35)
store both page records and merged records; [body reads](../src/common/collections/client.js#L49)
add revision/cursor-keyed pages and save everything again, even on a repeated
identical response. When its estimated size exceeds 1 MiB, the implementation
discards **all** pages, records, and cached collection metadata.

Successive distinct pages thus cause growing whole-cache writes until a
clear-all event. If P similarly sized pages accumulate without eviction, the
bytes serialized while reading them grow as 1 + 2 + … + P, not just P.
The existing ceiling bounds eventual cache size; this is write amplification and
poor eviction behavior, not an unbounded-cache claim.

**Implementation direction.** Introduce explicit byte/count budgets and evict
least useful old pages before serialization. Retain the current page and useful
first pages. Key reusable body/record content by revision; snapshot membership
must continue identifying pinned revisions. Skip unchanged writes and consider
separate per-page storage only if its cleanup/manifest complexity pays off.
Disposable cache writes may be coalesced; durable journal writes may not.

**Acceptance.** Browse repeatedly across collections and large notes, then reopen
offline. Check peak heap, total bytes serialized/written, eviction counts, and
preservation of current navigation. Cover failed cache writes, credential/epoch
changes, immutable snapshots, and pending local overlays.

**Tradeoff.** Selective eviction adds bookkeeping but preserves useful offline
data at the budget boundary. KB: `issues/budget-phone-collection-cache`.

## 8. Normalize durable phone journal storage

**Evidence.** [Journal.accept](../src/common/collections/journal.js#L18) stores
an operation and its original input in `entries`, and another operation plus
the complete input serialized as `hash` in `receipts`. A mutation payload can
therefore appear four times in serialized journal data even when some objects
share references in memory. `update` JSON-clones the complete state, then
`commit` serializes, checksums, envelopes, writes, and verifies it.

[compact](../src/common/collections/journal.js#L38) intentionally preserves
watch receipts for the active bridge session. After entries are compacted,
those receipts still contain full operation payloads and the input string.
They are cleared on bridge replacement, not by normal compaction. The 512 KiB
estimated payload ceiling can eventually reject work during a long session.

**Implementation direction.** Normalize the persisted schema so each pending
operation/input payload has one authoritative representation. Let indexes and
receipt records reference it. For durably handed-off work, retain only the
replay information actually required, with an explicit bounded lifecycle.
Inspect the bridge's [duplicate-event path](../src/pkjs/index.js#L91), dependency
chaining, agent-ingress replay, and recovery before choosing that representation.

**Acceptance.** Measure serialized size, transient allocations, and bytes written
for 20/100 note mutations and a long stream of acknowledged watch events. Prove
exact replay and mismatched-input rejection across retries, failed readbacks,
restart, dependent edits, stale views, and bridge rollover. Upgrade both journal
slots without making already accepted input unreadable.

**Tradeoff.** Do not just delete live replay receipts or replace exact input
comparison with the existing short checksum. Payload deduplication is the
lower-risk first step; bounded tombstones require a deliberate replay policy.
The earlier receipt-batching optimization should remain.
KB: `issues/normalize-phone-journal-payloads`.

## 9. Make body pagination independent of full body size

**Evidence.** [Body](../internal/collectionstore/reads.go#L267) calls
[Record](../internal/collectionstore/store.go#L237), which reads and JSON-decodes
an entire retained revision, then slices out the requested range. The
[phone requests 704 bytes](../src/common/collections/client.js#L49) per page.
A 256 KiB ASCII note needs 373 pages, causing approximately **93.25 MiB of body
content** to pass through full-record decoding if all pages are read, before
JSON and allocation overhead. Each page remains O(body size).

**Implementation direction.** Separate revision metadata from body storage.
Evaluate fixed-size body chunks keyed by record/revision/chunk position, allowing
a page read to touch only the intersecting chunks. Preserve complete body
reconstruction for edits/providers, the full-body hash, and existing signed
byte-offset cursor semantics. A simpler raw-BLOB range query may reduce Go
allocations, but measure SQLite work rather than assuming it avoids full-body
loading internally.

**Acceptance.** Benchmark first, middle, and final pages at 1/64/256 KiB with
ASCII and multibyte text. Preserve revision pinning, Unicode boundaries, empty
bodies, final-page flags, cursor scope validation, event descriptions, old
revisions, and full-note replacement/append behavior. Test schema upgrade and
backup/restore.

**Tradeoff.** This is a storage-model change justified primarily by large-note
usage. The already fixed summary snapshot page path is a separate concern.
KB: `issues/bound-note-body-page-cost`.

## 10. Remove redundant native element clearing/copying

**Measured evidence.** Debug information from both target ELFs reports
`sizeof(AgentUiElement) = 816`, `sizeof(AgentUi) = 40,376`, and **39,168 bytes**
for its 48-element array.
[begin](../src/c/agent_ui.c#L2196) clears the whole array, then
[add](../src/c/agent_ui.c#L2243) clears each used slot again.
[patch](../src/c/agent_ui.c#L2262) places a complete 816-byte element copy on the
stack and compares the whole struct even for a one-field value change.

**Implementation direction.** Reset the logical count/selection at screen begin
and initialize slots when they become live, after verifying every reader is
bounded by the live count. Make field application report whether the normalized,
truncated stored value changed, eliminating the whole-element stack snapshot.
Use that result to preserve no-op repaint suppression.

**Acceptance.** Cover repeated small/maximum screens, remove/add, shrinking
screens, selected/editing element changes, partial/empty patches, long UTF-8
fields, and allocation/error paths. Measure bytes cleared/copied and compiled
stack-frame usage on both targets; run native sanitizers and SDK builds.

**Tradeoff.** The full array still occupies 39,168 bytes; this proposal reduces
CPU work and transient stack usage, not permanent heap. A packed string arena
would be a larger, separate change with fragmentation and patch-capacity risks.
KB: `issues/reduce-native-element-copy-work`.

## 11. Separate clock paint from content layout

**Evidence.** Every [capability minute tick](../src/c/agent_capabilities.c#L63)
calls `agent_ui_refresh_clock`, including on a static note or form. That
function [calls the general refresh path](../src/c/agent_ui.c#L563).
[prv_paint](../src/c/agent_ui.c#L516) always recalculates content layout and marks
content, action bar, and status bar dirty. Text row layout invokes text
measurement even when only the clock changed.

**Implementation direction.** Track geometry, content, and clock/status
invalidation separately. Clock-only updates should avoid explicit content layout
and content/action-bar dirtying. Preserve content invalidation for real
countdown, status-text, selection-dependent calendar layout, and data changes.
Defer hidden-window painting until appearance where that preserves required
notifications and state.

**Acceptance.** Instrument layout/text-measure calls during ten minutes of
unchanged notes/forms versus active timers/calendar. Keep the 60-second passive
refresh policy, immediate input geometry, structural navigation updates,
deadline wakeups, and correct return from NumberWindow/dictation. Check both
display shapes on hardware.

**Tradeoff.** Pebble may redraw underlying layers when another layer is dirtied.
SDK/device traces must establish drawing savings; skipping the explicit layout
call is independently testable. This is distinct from the implemented
dashboard artwork animation cache.
KB: `issues/separate-watch-clock-invalidation`.

## 12. Extract cohesive bridge and renderer modules

**Evidence.** [The phone entry point](../src/pkjs/index.js) is 693 lines combining
settings, collection orchestration, transport delivery, request ownership,
weather/status, persistent jobs, and automatic action execution. Several
durability/network routines in [client.js](../src/common/collections/client.js)
and [journal.js](../src/common/collections/journal.js) occupy hundreds of
characters per line, obscuring error paths. [agent_ui.c](../src/c/agent_ui.c)
is 2,402 lines mixing widget state, dashboard artwork, layout, menus, gestures,
numeric editing, animation, and screen-specific calendar behavior.

**Implementation direction.** Extract one boundary at a time:

- A phone collection controller owning handshake, polling, acknowledgments,
  view tokens, and collection input; inject storage/client, queue, and current
  request ownership instead of importing entry-point globals.
- A job presentation/action coordinator owning request IDs, action receipts,
  replay, and result presentation; retain durable job data in the existing
  Jobs module.
- Native dashboard drawing/layout and input-gesture handling behind small
  private interfaces, leaving the public AgentUi API as the state owner.
- Expand dense journal/client functions into readable steps and name durable
  versus disposable writes explicitly.

**Acceptance.** Preserve packet sequences, persisted formats, public library
exports, stale-callback checks, exactly-once action identities, and widget
behavior. Use the existing JS/collection/job/native fixtures and both builds.
Keep dependency direction explicit and avoid giving every module access to the
complete mutable UI/bridge state.

**Tradeoff.** File splitting alone saves neither CPU nor binary bytes.
The benefit is bounded responsibilities and reviewable state transitions.
Keep schema changes and behavior optimizations in separate commits from moves.
KB: `issues/extract-bridge-renderer-boundaries`.

## 13. Reclaim inactive agent bookkeeping

**Evidence.** [respond](../internal/agent/agent.go#L73) adds a session lock to
`sync.Map` for every distinct session and never removes it.
[markLoaded](../internal/agent/agent.go#L231) retains thread IDs from every
connection generation. The [session store](../internal/state/store.go#L55)
keeps every session mapping and copies/rewrites the entire map when adding a
thread. Phone [New Chat](../src/pkjs/index.js#L181) generates new session IDs,
so these structures grow with historical conversations rather than active ones.

**Implementation direction.** Use a lock registry that counts both owners and
waiters and removes an entry only when neither exists. Reset generation-scoped
loaded-thread bookkeeping on connection replacement under the appropriate lock.
Treat persistent session retention separately: older job results can reopen
their originating session, so only prune them under an explicit retention rule
or move growing mappings to incremental storage.

**Acceptance.** Exercise many completed/canceled sessions, repeated reconnects,
queued turns, concurrent lookup/removal, and late opening of old job results.
Run race tests and assert same-session serialization and unrelated-session
concurrency. Measure registry sizes and session-write latency after churn.

**Tradeoff.** Never delete a per-session lock on simple unlock: an existing
waiter could retain the old lock while a newcomer gets a new one, allowing
overlapping turns. Per-session growth is small, so this ranks behind hot-path
and radio changes. KB: `issues/reclaim-agent-session-bookkeeping`.

## Baseline measurements and limits

Existing commands/builds completed successfully:

- `pebble build` for Emery and Gabbro, including existing symbol checks.
- CGO-disabled Go builds with `-trimpath`, both with symbols and with the release
  `-ldflags='-s -w'` flags.
- `go test ./internal/agent ./internal/appserver ./internal/collectionstore ./internal/collectionsync`.
- Existing collection benchmarks with `-run '^$' -bench
  'Benchmark(CollectionCounts|NoteSnapshot|SnapshotScale)$' -benchtime=5x -benchmem`.
- Offline ELF inspection, ZIP inventory, scratch-schema query plans, and
  temporary JS minification/syntax checking. No test code was added.

| Current artifact | Size |
| --- | ---: |
| Emery native executable | 62,968 B |
| Gabbro native executable | 63,484 B |
| Emery resource pack | 10,719 B |
| Gabbro resource pack | 8,843 B |
| Generated phone JS | 135,083 B |
| Packaged JS source map | 163,309 B |
| PBW package | 450,470 B |
| Stripped linux/amd64 server | 14,762,144 B |
| AgentUi allocation, either watch target | 40,376 B |

The existing snapshot benchmarks confirm bounded later-page allocations:
approximately 20.7–22.6 KB/page at 100/1,000/10,000 rows. First-page time still
scales with creating a complete immutable snapshot: about 2.45/9.69/89.90 ms
respectively in this short local run. Preserve that already achieved page-read
improvement; these timings are a baseline, not savings from this review.

For native executable size, the prior obvious pruning/compiler changes are
already present. For server executable size, GNU nm attributes about 1.98 MB
of named text/data/read-only symbols to modernc packages, including about
1.81 MB to SQLite. This is not removable-size attribution: shared runtime/type
metadata complicates it. Replacing the database driver would require a separate
portability/behavior study across all five release targets and the CGO-disabled
distribution contract. No driver replacement is recommended merely from these
numbers.

Complete RPC logging is an explicit repository debugging requirement, so this
audit does not assume turning it off is an acceptable efficiency change.
Persistent revisions/receipts support recovery and replay; deleting them requires
a retention contract, not just a cleanup timer.

All numeric savings above are static counts or local artifact measurements.
No production CPU/RSS or physical battery-life improvement is claimed.
Personal server logs and provider accounts were not accessed. No emulator was
started or used. Only this report, proposed KB tasks/reference, and the KB backup
are audit deliverables; pre-existing user edits are preserved.

## Implementation results

1. **bound-render-wire-work** — Bound render values to a contiguous 319-byte UTF-8 prefix before chunking and encode sparse patches with complete merged flag/metadata groups. The 1,800-byte fixture sends two messages instead of ten. Validation: 102 phone tests, collection regressions, native ASan/UBSan suites, and both SDK targets pass. Physical Bluetooth and energy measurements remain part of `issues/backend-sync-release-qualification`.
