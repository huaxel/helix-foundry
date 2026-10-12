# Operating Helix Foundry

## Installation

`./scripts/setup.sh --compose` starts the app, worker, DuckDB executor, and HelixDB. Local inference uses `MODEL_ENDPOINT` from `.env` (default `http://framearch-juan:8000/v1`) with the configured OpenAI-compatible llama.cpp server and model. Foundry does not start Ollama or download model weights. The endpoint must be reachable from app and worker containers; the app is available on `http://localhost:3001`.

Keep `.env`, data volumes, and backups private. The application encrypts connector/provider credentials using `ENCRYPTION_KEY`; losing that key makes those credentials unrecoverable. Do not rotate it by simply replacing the environment value. Helix Foundry has no sign-in, so do not admit other devices. The API refuses a non-loopback `HOST` unless `ALLOW_NETWORK_ACCESS=true`, which Compose sets because it publishes the app on `127.0.0.1` only. Do not expose it to a network through a reverse proxy, tunnel, or port forward. Internal HelixDB and executor ports are not published by Compose.

## Diagnostics and schema migration

`pnpm doctor` checks the database, executor, model endpoint, and local secrets. `/api/health` is a process health check. Startup applies the indexed version-1 metadata schema idempotently; `node dist/scripts/migrate.js` applies it explicitly. Startup rejects database schema versions newer than the application.

Jobs claim leases and periodically renew them. A worker restart reclaims expired leases. AI stages save definitions and usage after each completed stage; a failed/canceled run can be resumed through Activity or the API. Input changes invalidate cached stages. Failed connector/pipeline jobs retry three times with bounded backoff. A stopped worker does not stop published dashboard queries.

## Backup, restore, and upgrades

Database synchronization prefers native CDC. PostgreSQL needs logical WAL, a replication-capable login, a primary key/usable replica identity, table publication permission, and available replication slots. Foundry creates a publication and slot scoped to each selected table. MySQL needs row-format binary logging, SELECT access, and replication client/slave privileges. Read-only logins still import through the scheduled fallback. Foundry never changes server-wide database configuration or writes business records back to sources.

The capture service runs independently of inference, saves its dirty counter and log position atomically in HelixDB, and acknowledges PostgreSQL only after that durable write. One queued snapshot coalesces multiple commits; its starting counter prevents concurrent changes from being marked applied accidentally. Existing complete snapshots stay available during imports. Reconnects reconcile a new snapshot, including after restoration of old metadata; schema changes still need review. Transient stream failures retry from saved positions, then fall back to scheduled refreshes. This is native log capture with full-snapshot materialization, not row-at-a-time replication: existing two-million-row import and executor limits still apply.

Monitor source-side WAL/binlog disk retention. Configure PostgreSQL's `max_slot_wal_keep_size` and a suitable MySQL binlog expiration policy for the installation; the application does not alter either server setting. Stop capture before manually removing Foundry-owned slots/publications. Keep their names from the source's sync metadata when decommissioning a source or changing its endpoint. Do not drop other applications' replication resources.

1. Run `./scripts/backup.sh PATH`. It stops writers and HelixDB, archives the data volumes, saves the encryption configuration, then restarts services.
2. Copy the backup to private off-host storage.
3. For a replacement installation, use `./scripts/restore.sh PATH --replace`. This replaces that installation's data volumes and `.env`.
4. Set `COMPOSE_PROJECT_NAME` when using a nondefault project name; use the same name throughout backup and restore.
5. Before upgrades, retain the old application commit, lockfile, image, and backup. Rebuild and run diagnostics, sample ingestion, a saved query, and proposal validation before using the installation again. Revert the application plus matching data backup if an upgrade fails.

Model weights remain on the remote llama.cpp server and are not included in Foundry backups. Imported Parquet snapshots are immutable; mounted local Parquet sources are referenced in place and are not copied into Foundry's data volume. Their version guard uses file size and modification time, so keep source files unchanged to preserve queryability. Successful imports remove their staged input copy after the snapshot is committed. Unreferenced historical snapshots can still consume disk. From the Compose project directory, `docker compose exec app pnpm prune:data` performs a dry run using the app's internal Helix URL and `/data` volume. It retains each dataset's active and pending versions plus its two newest versions, and preserves any version referenced by other workspace metadata. Review the listed versions before running `docker compose exec app pnpm prune:data -- --apply`; this removes only eligible version metadata and its matching Parquet file. Keep a backup first. Mounted source files are never removed.

Repeated local Docker builds can leave untagged, unused image layers behind. Check `docker system df` first; when image reclaimable space is high, `docker image prune` offers to remove dangling images without pruning named images, containers, or volumes. Avoid broad `docker system prune -a` or volume pruning as routine maintenance.

## Deployment limits

Compose uses a small-machine resource budget: app 1 GB, worker 768 MB, and executor 2 GB memory caps. HelixDB remains uncapped because it is not being restarted as part of this update. The executor defaults to one DuckDB job, 768 MB DuckDB memory, one DuckDB thread, a 2 GB temporary-spill limit, and a 900-second (15-minute) timeout. These are ceilings, not reservations; raise them only after measuring representative workloads. Override the executor settings with `EXECUTOR_CONCURRENCY`, `DUCKDB_MEMORY`, `DUCKDB_THREADS`, `DUCKDB_TEMP_LIMIT`, and `DUCKDB_TEMP_DIR` in `.env`. The executor network remains internal-only. One worker performs one inference job at a time; use one worker replica in this single-server release.

The supported runtime is Node.js 24. There are no accounts: each installation serves one person on their own computer, who owns every workspace. API tokens are workspace scoped, optionally read-only, and revocable. See `VALIDATION.md` for benchmark scope and unverified deployment combinations.
