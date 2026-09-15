# PebbleOS Timeline

The Timeline frontend in `src/c/timeline_layout.h` and `src/c/timeline_ui.c`
adapts the layout dimensions, sidebar treatment, calendar card hierarchy, and
event relationship classification from PebbleOS:

- https://github.com/coredevices/PebbleOS/tree/5503dd403f39e1393b8684314dc299e611fe5a2d/src/fw/apps/system/timeline
- https://github.com/coredevices/PebbleOS/blob/5503dd403f39e1393b8684314dc299e611fe5a2d/src/fw/services/timeline/calendar_layout.c

Copyright 2024 Google LLC. Licensed under the Apache License, Version 2.0;
see [the included license](LICENSES/Apache-2.0.txt).

Modifications replace firmware-private layers, resources, pin database access,
and event handling with public Pebble SDK drawing and codey's collection data.
The calendar glyph is drawn with SDK primitives; no third-party font or bitmap
assets are bundled by this port. Fonts are provided by the watch OS.
