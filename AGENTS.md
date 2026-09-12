# Knowledge base and issues

This repository uses `git kb` for searchable documentation, code intelligence,
and issue tracking. Consult it when investigating or planning changes:
`git kb search "topic" --json` and `git kb code symbols "name" --json`.
Check the actual source before editing; documentation imports are snapshots.

Record bugs and follow-up work as KB tasks under `issues/`, including context
and acceptance criteria. Commit KB edits with `git kb commit --all -m "..." --json`.
Refresh the code index after changes with `git kb code index src internal cmd
scripts examples tests --index-only`. Keep documentation snapshots current.
The portable backup is `.kb/repository-backup.json`; after cloning, run `git kb
init`, restore that backup, and rebuild the code index. Refresh the backup with
`git kb backup --output .kb/repository-backup.json` after KB changes.

# Runtime debugging

Start server-side incident investigation with `~/.pebble-agent/server.log`. The Go service mirrors all structured logs there, including complete Codex app-server input and output payloads. If the relevant event has rotated, inspect `server.log.1` (newest) through `server.log.5` (oldest). Each file rotates at 10 MiB.

Treat these files as sensitive conversation data. Watch process exits still require Pebble watch logs because server logs end at the phone/server boundary.

# Emulator cleanup

Always clean up emulators when finished with them. Stop emulator instances and
associated processes started or used for the task (for example, with `pebble kill`),
and verify that they have exited before handing work back to the user.
