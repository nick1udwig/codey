# Collection server operations

## Run and configure

`codey-server --data-dir /absolute/private/path` stores `collections.db` with
SQLite WAL, foreign keys, a busy timeout, and `synchronous=FULL`. The default is
`~/.codey/data`. Keep this directory outside the agent workspace. Set
`CODEY_TOKEN`; collection endpoints reject unauthenticated requests even if the
legacy agent endpoint permits localhost without a token.

The phone sends its HTTPS server URL and selected sync service to the authenticated
management-session endpoint. No operator `public_url` is required. The supplied
base is tied to that individual ticket/session, including reverse-proxy prefixes.

Optional advanced configuration is loaded automatically from
`~/.codey/integrations.json` if present. `--integrations-config` overrides the path.
This is only needed for operator OAuth application credentials, private Nextcloud
hosts, or an optional default URL for older clients. The file accepts:

```json
{
  "public_url": "https://codey.example/prefix",
  "private_hosts": ["cloud.home.example"],
  "oauth": {
    "googletasks": {
      "client_id": "operator-client-id",
      "client_secret": "operator-client-secret",
      "redirect_url": "https://codey.example/prefix/integrations/oauth/callback"
    },
    "todoist": {
      "client_id": "operator-client-id",
      "client_secret": "operator-client-secret",
      "redirect_url": "https://codey.example/prefix/integrations/oauth/callback"
    }
  }
}
```

Restrict this file to the service account (0600), outside the agent workspace.
Register the exact callbacks with the providers. There is no hosted OAuth broker.
Google uses the Tasks scope, offline consent, server-held refresh tokens, and
serialized refresh rotation. External applications in Google's Testing mode can
have short-lived refresh grants; configure production consent appropriately.
Todoist also accepts a personal API token. Nextcloud accepts an app password and
username; it does not require a hosted OAuth application.

Use a TLS reverse proxy which strips the configured prefix before forwarding.
The phone server URL must use HTTPS. Redirects from
provider endpoints are refused. Explicitly allow private DNS hosts for self-hosted
Nextcloud; link-local/metadata destinations are denied. Preserve Nextcloud's base
path. Provider failures do not stop canonical reads/writes or agent requests.

If management setup fails, the settings page reopens with the server error.
Development HTTP permission for collection API calls does not enable HTTP browser
management sessions. Selecting a provider opens its setup section; authenticate,
preview a destination, then activate it. Merely choosing a provider in phone
settings does not switch or export existing records.

## Backup and restore

1. Run `codey-server --data-dir /data --collections-backup /backup/collections.db`.
   The output must not already exist. `VACUUM INTO` produces a consistent SQLite
   snapshot including canonical records, historical revisions, receipts,
   conflicts, mappings, and provider work.
2. Back up `/data/provider.key` separately with restricted access. The database's
   provider credentials are encrypted using AES-GCM and that key. Also preserve
   the operator integration configuration. Losing the key requires reconnecting
   providers; the server refuses to silently replace a missing key when secrets
   already exist.
3. Stop the server before replacing a database. Restore the database and original
   key with restrictive permissions. Remove stale WAL/SHM files from the stopped
   database installation.
4. Before restarting normal service, run
   `codey-server --data-dir /data --collections-restored`. This rotates the store
   epoch and pauses outbound delivery. Old phone cursors and writes are rejected
   for explicit recovery; they are not blindly replayed against rolled-back
   receipts.
5. Inspect restored outstanding operations and remote state before resuming.
   Keep outbound delivery paused until all uncertain operations are reconciled. Then use **Resume providers after restore** in management; it refuses to resume while uncertain/recovery-required jobs remain.
   Never copy only a live `.db` file or manually roll back an active SQLite store.

The first schema retains operation receipts, tombstone identities, and record
versions indefinitely. Monitor storage growth; no destructive garbage collector
runs in the background. Database restore is an operator workflow, not automatic
synchronization rollback.

## Validation boundaries

Automated coverage includes core transaction faults, duplicate replay, dependent
operations, fixed snapshots, Unicode ranges, phone journal failures/recovery,
provider uncertainty, older-revision acknowledgments, credential encryption,
management tickets/CSRF, and native persistence checks. Emulator execution is not
required for these tests; no emulator is left running by the build commands.

Authenticated provider account round trips, actual PebbleKit process termination,
OAuth browser return on each phone OS, and physical watch interaction remain
release qualification. Do not describe fixture tests as proof of those results.
Obsidian, Notion, legacy migration, and a downloadable adapter marketplace are
outside this branch's agreed scope.

Primary API references used for implementation:
[Todoist API v1](https://developer.todoist.com/api/v1/),
[Google Tasks](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks),
[Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
and [Nextcloud Notes API](https://github.com/nextcloud/notes/blob/main/docs/api/v1.md).
