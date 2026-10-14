# Operating Meridian

## Installation

`./scripts/setup.sh --compose` starts the app, worker, DuckDB executor, and HelixDB. Local inference uses `MODEL_ENDPOINT` from `.env` (default `http://framearch-juan:8000/v1`) with the configured OpenAI-compatible llama.cpp server and model. Foundry does not start Ollama or download model weights. The endpoint must be reachable from app and worker containers; the app is available on `http://localhost:3001`.

Keep `.env`, data volumes, and backups private. The application encrypts connector/provider credentials using `ENCRYPTION_KEY`; losing that key makes those credentials unrecoverable. Do not rotate it by simply replacing the environment value. Meridian has no sign-in, so do not admit other devices. The API refuses a non-loopback `HOST` unless `ALLOW_NETWORK_ACCESS=true`, which Compose sets because it publishes the app on `127.0.0.1` only. Do not expose it to a network through a reverse proxy, tunnel, or port forward. Internal HelixDB and executor ports are not published by Compose.

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

## Scale architecture (streaming executor)

The default executor query path is **materialize**: for each query it copies the authorized, filtered snapshot into an in-memory DuckDB table, then locks the database down (`allowed_paths`, external access off, configuration locked) before running the user's SQL. Correct and safe, but the copy is O(snapshot) per query, so it degrades past a few hundred MB.

**Stream mode** removes the copy. Each query runs inside a per-job user+mount namespace (`unshare -rm`). The executor bind-mounts only that job's authorized Parquet files into a private directory and masks the data roots and system config (`/data`, the mounted-Parquet root, `/etc`, `/root`, `/home`, `/sys`, `/proc`, `/run`), then reads the inputs through `CREATE VIEW ... read_parquet(...)`. (`/proc` matters because the mount namespace shares the host PID namespace; `/dev` stays visible — the child needs `/dev/null` and `/dev/urandom`.) Because the inputs are views, DuckDB prunes columns and skips row-groups the query never touches — a filtered query over a multi-GB snapshot reads only what it needs, with no per-query full copy. The mount namespace, not DuckDB settings, is the isolation boundary, so external access stays on (the views would otherwise be unreadable).

The two modes are selected by `EXECUTOR_MODE` (default `materialize` = existing behavior, untouched):

| Mode | Reads inputs as | Isolation boundary | Scales to |
| ---- | --------------- | ------------------ | --------- |
| `materialize` | in-memory table (full filtered copy) | DuckDB `allowed_paths` + external access off | a few hundred MB per query |
| `stream` | view over the mounted Parquet (column + row-group pushdown) | per-job user+mount namespace | tens of GB per query |

**Enabling stream mode.** Creating a user namespace (`CLONE_NEWUSER`) is blocked by Docker's default seccomp profile, so you enable it with the opt-in overlay `compose.stream.yaml`, which sets the executor's seccomp to the bundled `seccomp-stream.json` profile — Docker's default allow-list plus `unshare` (restricted to user+mount namespaces) and `mount`, meaningfully tighter than `unconfined`. That allowance is scoped to the executor container only — the one that already runs untrusted (model-generated) SQL on an internal network with `cap_drop: [ALL]` — and keeps `no-new-privileges` (verified: `CLONE_NEWUSER` works under no-new-privileges).

```sh
# One-off, or persist EXECUTOR_MODE=stream in .env and use the overlay in your start command:
EXECUTOR_MODE=stream docker compose -f compose.yaml -f compose.stream.yaml up -d
```

The profile path is resolved by the Docker daemon, so the overlay defaults to `$PWD/seccomp-stream.json` (run compose from the repository root) and honors `SECCOMP_PROFILE` for other layouts, e.g. remote Docker contexts.

The executor probes for user namespaces at boot and fails streaming jobs loudly with a clear message if the allowance is missing, so the overlay is the difference between "streaming works" and "streaming refuses to run". The bundled profile is validated in a real container (streaming queries + escape probes; see `VALIDATION.md`) and `tests/seccomp-profile.test.ts` pins its safety properties. On an older Docker that cannot load a custom profile, fall back to `seccomp=unconfined` (looser, but valid).

**Lazy records (large workspaces).** Onboarding decides at publish time whether to materialize the ontology's rows as objects. Beyond **1,000,000** total rows across the published types it publishes **dashboard-only** (`stageRecords: false`) instead: the workspace keeps the datasets, metrics and dashboards, and queries live data. A type with no staged rows is **lazy** — the Explorer pages, searches, filters and sorts it as SQL over the active snapshot with constant memory in the API, rather than holding every row in the object store. For the rows a page actually shows, the API writes a tiny `recordRef` (type + key only, never the row) so a deep link, an edit, or a related reference resolves back to the snapshot row. Manual records you create in the workspace are real objects and join a lazy type's first page; edits to lazy rows use the normal overlay/audit flow. Known v1 limits of lazy records: the links column reads 0 for snapshot rows, you cannot create a relationship to/from a never-staged row, and a row that has never been paged 404s until it is shown once.

**Tuning the executor.** The small-machine Compose defaults are ceilings, not reservations. Override them in `.env` after measuring your workloads:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `EXECUTOR_CONCURRENCY` | `1` | DuckDB jobs the executor runs at once |
| `DUCKDB_MEMORY` | `768MB` | Per-query DuckDB memory before it spills |
| `DUCKDB_THREADS` | `1` | DuckDB threads per query |
| `DUCKDB_TEMP_LIMIT` | `2GB` | Spill-to-disk cap per query |
| `DUCKDB_TEMP_DIR` | `/tmp` | Where spill writes go — keep free disk here for large sorts/hashes |
| `EXECUTOR_TIMEOUT_MS` | `900000` | 15-minute cap per job |
| `EXECUTOR_MODE` | `materialize` | `stream` to use the OS-isolated streaming path |
| `EXECUTOR_SANDBOX_ROOT` | `/tmp/executor-sbx` | Per-job sandbox scratch (must be outside the masked trees) |

The executor container is capped at 2 GB memory, 1.5 CPUs and 128 pids, on an internal-only network. For multi-GB streaming workloads, raise `DUCKDB_MEMORY`/`DUCKDB_TEMP_LIMIT` and the container's `mem_limit` together, and make sure `DUCKDB_TEMP_DIR` has room: a query that spills past `DUCKDB_TEMP_LIMIT` is cancelled. Input filters are pushed into the Parquet scan (a `WHERE` on `read_parquet`) in both modes, so DuckDB prunes row-groups before any row is read.

**What is and isn't certified at scale.** The streaming path's isolation was verified in the real executor container (an escape suite driving the real server → `unshare` → runner → engine, asserting on leaked data, not just "did it throw"): cross-scope reads, host-file reads, `COPY TO` to a masked path, and absolute / `../` / symlink source escapes are all blocked with no leak. Network egress is a deployment property (the execution network is `internal: true`), not something the unit suite exercises. Its multi-GB performance is now measured on a 3.9 GB Parquet fixture **both on the host and inside the Docker container** under the shipping stream security config (the bundled `seccomp-stream.json` profile, `cap_drop: [ALL]`, `no-new-privileges`, 2 GB memory): ~0.7 s and ~190 MB (host) / ~86 MB cgroup peak (container) for filtered/full aggregates in stream mode, versus 21–40 s and 1–8.3 GB peak (plus heavy spill) for materialize; the full table, method, 60 GB extrapolation, in-container isolation re-probes and caveats are in `VALIDATION.md`. Still open: partitioned ingestion (per-partition snapshots + a manifest, pruned per query). See `VALIDATION.md` for the full validation scope.

## Deployment limits

Compose uses a small-machine resource budget: app 1 GB, worker 768 MB, and executor 2 GB memory caps. HelixDB remains uncapped because it is not being restarted as part of this update. The executor defaults to one DuckDB job, 768 MB DuckDB memory, one DuckDB thread, a 2 GB temporary-spill limit, and a 900-second (15-minute) timeout. These are ceilings, not reservations; raise them only after measuring representative workloads. Override the executor settings with `EXECUTOR_CONCURRENCY`, `DUCKDB_MEMORY`, `DUCKDB_THREADS`, `DUCKDB_TEMP_LIMIT`, and `DUCKDB_TEMP_DIR` in `.env`. The executor network remains internal-only. One worker performs one inference job at a time; use one worker replica in this single-server release.

The supported runtime is Node.js 24. There are no accounts: each installation serves one person on their own computer, who owns every workspace. API tokens are workspace scoped, optionally read-only, and revocable. See `VALIDATION.md` for benchmark scope and unverified deployment combinations.
