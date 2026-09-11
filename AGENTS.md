# Runtime debugging

Start server-side incident investigation with `~/.pebble-agent/server.log`. The Go service mirrors all structured logs there, including complete Codex app-server input and output payloads. If the relevant event has rotated, inspect `server.log.1` (newest) through `server.log.5` (oldest). Each file rotates at 10 MiB.

Treat these files as sensitive conversation data. Watch process exits still require Pebble watch logs because server logs end at the phone/server boundary.
