# Calendar Timeline frontend

The watch calendar uses an adaptation of PebbleOS Timeline's card layout and
event relationship rules. The existing CalDAV/server collection APIs, sync,
storage, event creation and phone journal are unchanged.

The frontend provides an expanded selected event, compact following events,
day separators, the blue future-Timeline rail and orange calendar glyphs.
Rectangular and round displays use different margins and rail notches.
Up/Down advance between events, fetching adjacent pages when necessary. Select
opens details; Back restores the prior page and selected event. Touch scrolling
snaps to an event on release; activation follows the app's double-tap preference.

## Data and resources

Calendar `collection-list` messages retain the bounded eight-title payload in
Value. Title now carries eight newline-separated attribute strings containing
the local date, time, start/end offsets and bounded location. Offsets are seconds
since that local day's midnight, preserving DST relationships and dates beyond
2038. All-day dates retain their date-only semantics. The watch persists metadata
alongside cached titles, invalidating the page before any writes.

Flags retain bits 0–4; bit 5 indicates a previous calendar page. Bits 8–10 select
the event restored after returning from details. View-token aliases continue to
protect page and event actions from stale requests.

The port uses public SDK drawing and fonts. It does not depend on firmware-private
pin storage, renderer internals or resource IDs. Source provenance and the
Apache-2.0 license are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The fixed ten-message outgoing queue is allocated once on the heap and freed at
exit. Its capacity is unchanged; moving it out of the static image leaves room
under Pebble's 65,535-byte app image limit. The build checks that the app metadata
header remains at address zero, in addition to its existing unsafe-symbol check.

## Verification

`npm test` covers collection aliases, page history, DST and all-day display
metadata, inbox size, cached metadata updates and native relationship rules.
`npm run build:watch` builds the complete app for Emery and Gabbro.

For a deterministic emulator fixture using the production rendering and routing:

```sh
node scripts/build-timeline-preview.mjs
pebble install --emulator emery build/timeline-preview/build/codey.pbw
```

The fixture has its own UUID and does not contact a backend. It supports event
selection, detail scrolling and physical Back. Repeat with `--emulator gabbro`.
Always stop the emulators with `pebble kill` when finished.

Emulator visual and button checks do not verify physical touchscreen gestures or
a paired phone's Bluetooth behavior; those remain hardware acceptance checks.
