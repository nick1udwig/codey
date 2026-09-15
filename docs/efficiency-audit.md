# Efficiency audit — 2026-09-15

Source baseline: `200b0c6`. The original opportunity assessment follows; implementation results are recorded
at the end of this document. Measurements below use local builds and synthetic
data, not personal server logs or physical battery measurements.

## Recommended order

| Priority | Opportunity | Expected benefit | Scope |
| --- | --- | --- | --- |
| 1 | Remove write-only native element fields | 2,496 bytes less permanent watch heap; fewer copies | Small |
| 1 | Remove unused icons and exclude other-platform artwork | 4,180 / 6,056 bytes less resource data on Emery / Gabbro; six fewer bitmap allocations | Small |
| 1 | Bound opened phone job history | Stop unbounded retained results and whole-history save growth | Medium; preserve acknowledgment/replay |
| 1 | Commit collection receipts as one batch | Up to 20 full journal writes become one per response | Medium; preserve durability |
| 2 | Adapt idle polling and share dashboard status work | Fewer HTTP/Bluetooth requests and server RPCs | Medium |
| 2 | Store immutable snapshot rows with bounded page reads | Avoid decoding all summaries to return eight records | Medium |
| 2 | Remove bridge dead state and separate request serialization | Less JS allocation, bundle code, and maintenance | Small/medium |
| 3 | Avoid redrawing static dashboard artwork during animation | Fewer resource reads, allocations, and drawing calls | Measure target rendering first |

## 1. Remove write-only element fields

[AgentUiElement](../src/c/agent_ui.c#L53) stores `kind_name[16]`,
`parent_id[32]`, and `index` for each of 48 slots. Source references only declare
and assign these fields; rendering uses `kind`, array order, and other fields.
They are not persisted. Keep the incoming protocol fields accepted; remove the
unused retained copies and assignments.

GDB inspection of the Emery ELF: `sizeof(AgentUi) = 42888`,
`sizeof(AgentUiElement) = 868`, and the element array occupies 41,664 bytes.
The unused fields total 52 bytes per slot, giving an expected **2,496-byte**
heap reduction before further redesign. Confirm the resulting struct layout on
both targets. Most remaining memory is bounded text storage; consider a string
pool only after measuring actual occupancy and accounting for patch/append
capacity, fragmentation, and allocation failures.

Acceptance: remove only unread retained state; preserve add/patch/layout/input
behavior and 48-element capacity; build both targets and compare struct sizes.
KB: `issues/remove-write-only-watch-fields`.

## 2. Remove unused and wrong-platform image resources

[Icon initialization](../src/c/agent_ui.c#L2109) allocates 13 bitmaps for the
entire app lifetime. All calls to `prv_dashboard_icon` can select only indices
0, 1, 2, 4, 8, 9, and 12. The six unused resources are `DASH_CHAT`,
`DASH_TIMER`, `DASH_ALARM`, `DASH_BELL`, `DASH_BELL_SMALL`, and
`DASH_TODOS_SMALL`. Their unique resource payloads total **820 bytes**.

[package.json](../package.json) also includes both large Emery and Gabbro poses
in each target. The renderer selects only its own platform's pair. Opposite
platform payloads occupy **3,360 bytes on Emery** and **5,236 on Gabbro**.
Together, these removals would reduce each 14,643-byte resource pack by
**4,180 bytes (28.5%) / 6,056 bytes (41.4%)**. These are resource-pack savings,
not executable text savings or compressed PBW savings. Values come from actual
pack entries; `.reso` file sizes include serialization overhead and overstate
the savings. The pack's reserved table is fixed size.

Acceptance: remove six unused loads/resources, scope large artwork to its
target, verify both resource packs and dashboard/notification visuals, preserve
all reachable icon roles, and measure heap before/after. Replace numeric icon
indices with named roles while changing the table.
KB: `issues/prune-watch-artwork`.

## 3. Bound retained phone jobs

[Jobs.acknowledge](../src/common/jobs.js#L131) marks a job opened but retains
its result, request body, and command bookkeeping forever. `save()` serializes
the entire array; the 24-job submission limit only counts unopened jobs.
[The bridge](../src/pkjs/index.js#L531) sends only unopened jobs to the watch.

A fixture using the real `Jobs` class, in-memory storage, and a stubbed `http`
method acknowledged 100 jobs with 16 KiB results. It retained **100 entries,
zero unopened**, and **1,649,701 bytes per subsequent save**. This establishes
unbounded storage/serialization growth; it is not a phone heap measurement.

Acceptance: bound opened history and remove unnecessary large payloads after
safe handoff; retain pending acknowledgment retries and minimal replay identity
as needed. Verify late long-wait responses, duplicate retrieval, restart,
failed local writes, failed server acknowledgments, command idempotency, and
24 genuinely pending jobs. Do not delete unacknowledged results indiscriminately.
KB: `issues/bound-opened-phone-jobs`.

## 4. Batch durable journal receipts

[Client.drain and recover](../src/common/collections/client.js#L19) loop over
results and call [Journal.receipt](../src/common/collections/journal.js#L24)
separately. Every call clones, serializes, checksums, writes, reads back, and
validates the whole journal. Even unknown or nondurable receipts currently
enter that write path.

A real-Journal fixture with 20 pending notes, each with a 1 KiB body, then 20
durable applied receipts produced **20 storage writes / 2,072,804 UTF-8 bytes**
of serialized envelopes. Final logical journal length was 100,743 characters.
Local Node processing took approximately 40 ms; storage was an in-memory mock.

Acceptance: one verified two-slot commit for a changed response batch; zero
writes for an unchanged batch. Share this path between drain and recovery.
Preserve operation dependencies, replay receipts, mixed results, quota failure,
write/readback failure, and crash recovery. Measure writes/bytes per batch.
KB: `issues/batch-collection-journal-receipts`.

## 5. Reduce idle polling and repeated status scans

[syncCollections](../src/pkjs/index.js#L43) calls `connect` every minute, which
requests sync identity and collection metadata: **120 HTTP requests/hour**
while that loop runs successfully, before mutations. Count suppression already
avoids unchanged count messages, but does not avoid those requests.

[The capability clock](../src/c/agent_capabilities.c#L63) also emits a status
request every minute even outside the dashboard. Each
[DashboardStatus](../internal/agent/status.go#L42) call requests quota, lists
loaded threads, and reads each thread's status separately. With 100 loaded
threads in one page, that is **102 sequential RPCs per successful refresh**,
with complete RPC logging on the server. These are source-derived counts.

[The provider engine](../internal/collectionsync/engine.go#L35) pulls all
bindings each minute and after a wake. Google Tasks and Nextcloud enumerate
their selected collections; CalDAV requests the full agenda window. Todoist
already uses a checkpoint, so avoid applying a blanket full-scan diagnosis.

Acceptance: measure idle requests/bytes and RPC latency; add bounded freshness,
backoff, and shared in-flight status results; investigate provider incremental
support before choosing APIs. Preserve immediate mutation upload, explicit
refresh, external thread visibility, identity checks/quarantine, date-window
rollover, recurrence and safe deletion reconciliation. Verify disconnect,
reconnect, changed credentials, and stale responses. Physical power measurement
is needed to quantify battery improvement.
KB: existing `issues/incremental-collection-refresh`, plus
`issues/reduce-dashboard-status-scan-work`.

## 6. Bound snapshot pagination work

[snapshot](../internal/collectionstore/reads.go#L84) reads every record's JSON,
projects summaries, filters in Go, and persists one JSON array.
[SnapshotPage](../internal/collectionstore/reads.go#L157) reloads and decodes
that entire array before slicing out a page. Paging all N records in groups of
eight therefore decodes roughly N × ceil(N/8) summaries.

The existing 100-note fixture (approximately 67 KiB per body), ten iterations,
measured **15.48 ms / 268,221 allocated bytes per snapshot**. Indexed collection
counts already cost only **0.053 ms / 4,588 bytes**; they are not the priority.
Although SQL removes bodies from output, it still processes the source JSON.

Acceptance: retain small indexed summaries and store immutable snapshot rows
by position, enabling bounded page queries. Preserve exact totals, stable
pagination across edits/deletion, cursor scope/expiry, chronological calendar
order, timezone semantics, and complete canonical bodies. Benchmark first and
later pages at 100, 1,000, and 10,000 records. Do not substitute pagination over
mutable current rows for immutable snapshots.
KB: `issues/bound-collection-snapshot-page-cost`.

## 7. Simplify the phone bridge and JS dependency graph

In [src/pkjs/index.js](../src/pkjs/index.js), `sendNoteMessage` has no callers;
`activePipeline` is assigned but never read; the instantiated `AgentClient`
only receives `abort()` calls and never sends anything. Remote work uses
`jobManager.submit`. `requestAgent` still builds a parser/model pipeline before
determining whether input is local, allocating an unused pipeline for remote
jobs and retaining it through `activePipeline`.

[jobs.js](../src/common/jobs.js#L4) imports `buildRequest` from the whole
236-line transport module. Extract the shared request serializer so the watch
bridge does not pull HTTP/WebSocket transport implementations into its bundle.
The transport remains exported by [the library](../src/common/index.js#L9) and
has tests; it is not globally dead code.

Acceptance: remove bridge-only dead code/state, allocate pipelines where used,
share the request serializer, preserve the public library and transport tests,
and compare generated JS size and local/remote dispatch behavior. Avoid replacing
clear code with compressed one-line implementations to claim LOC savings.
KB: `issues/simplify-phone-bridge-dependencies`.

## 8. Reduce dashboard work during request animation

[prv_activity_tick](../src/c/agent_ui.c#L2279) marks the full content layer dirty
every 30 ms for a short 20-frame animation. Each dashboard repaint invokes
[prv_dashboard_codey](../src/c/agent_ui.c#L910), which allocates a row bitmap,
reads the image header and palette, and reads/draws every image row.
Current large artwork has 74 rows on Emery and 59 on Gabbro: **76 / 61 resource
API reads per full dashboard paint**, or approximately **1,520 / 1,220** over
20 paints. These count API calls, not physical flash transactions.

Acceptance: instrument real repaint counts and CPU time; evaluate an overlay
or bounded artwork cache with verified invalidation and heap headroom. Keep the
short animation, visual correctness, platform poses, and low-memory fallback.
Do not assume a separate layer automatically avoids background redraws on the
SDK. Cache only if measurements justify its retained memory cost.
KB: `issues/reduce-dashboard-animation-redraw-cost`.

## Validation and existing optimizations

- `pebble build` passes for Emery and Gabbro. Executable binaries are 61,448 /
  61,960 bytes; resource packs are 14,643 bytes each; generated JS is 127,857 bytes.
- ELF text/data/BSS: Emery 60,710 / 424 / 740 bytes; Gabbro 61,222 / 424 / 740.
  Heap allocations, including `AgentUi`, are additional to BSS.
- `go test ./internal/collectionstore -run '^$' -bench
  'Benchmark(CollectionCounts|NoteSnapshot)$' -benchtime=10x -benchmem` passes.
- A server release-style build with `CGO_ENABLED=0`, `-trimpath`, and
  `-ldflags='-s -w'` passes. Release CI already uses these size flags; stripping
  is not a new opportunity. Watch builds already use `-Os` and section GC.
- Existing minute redraw coalescing, bounded job long-waits, indexed counts,
  summary-only collection responses, and unchanged preview/count suppression
  should be preserved.
- No emulator was started or used. Battery percentages and production CPU/RSS
  reductions remain unmeasured. No runtime behavior changed, so this audit ran
  builds, focused existing benchmarks, and synthetic probes rather than a full
  behavioral regression suite.

## Implementation results

- **remove-write-only-watch-fields**: Removed three unread retained fields and their copies without changing protocol acceptance or capacity. Both watch builds and all nine native ASan/UBSan suites pass. On both targets AgentUi shrank from 42,888 to 40,392 bytes (2,496 bytes saved), and executable text/data shrank by 60 bytes.

- **prune-watch-artwork**: Removed six unused bitmap loads and resource entries, introduced named icon roles, and limited each large pose pair to its target. Both SDK builds pass; pack inspection confirms nine resources per target and no opposite-platform artwork. Emery resources are 10,463 bytes (-4,180); Gabbro 8,587 (-6,056); executable footprint saves another 64 bytes per target, with six fewer bitmap allocations and 24 fewer pointer bytes. Final rendering verification is combined with the animation change.

- **bound-opened-phone-jobs**: Opened jobs now durably replace delivered payloads with small acknowledgment receipts; successful/expired acknowledgments remove them, and reconnect/pane-open/submission retries preserve failed acknowledgments. A bounded receipt backlog prevents indefinite growth. Fixed terminal-result persistence rollback as well. 96 phone tests pass, including late responses, duplicate acknowledgment, restart, failed receipt/cleanup writes, 100 x 16 KiB results ending in a two-byte empty history, and the 24-pending-job limit.
