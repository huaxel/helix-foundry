# Implementation and validation

This is an executable single-server MVP. Validation results below are from the local development machine on 23–24 September 2026; they are not a production SLA.

## Verified paths

- Native HelixDB v0.0.6 persistence, indexed workspace identities, conditional atomic metadata writes, stale-write rejection, native object relationships, and relationship deletion.
- Real DuckDB Parquet ingestion, profiling, aggregation, input filtering, visual DAG compilation, isolation from files/network/undeclared inputs, and rejected multi-statement SQL.
- Owner bootstrap, local sessions, one-use invitations, role checks, scoped read-only tokens, cross-workspace API denial, and cross-origin mutation denial.
- Golden customers/orders: exact metrics and key checks, reference coverage, source freshness guards, preserved manual descriptions, schema drift staging, resumable AI checkpoints, manual objects, and relationship edits surviving rematerialization.
- MySQL 8.4: information_schema discovery, keys/columns, bounded streaming, large unsigned integers, DECIMAL(30,8), temporal strings, Unicode, nulls, preservation through Parquet, schema changes, authentication/TLS errors, and a deliberately interrupted connection. Scheduling and duplicate job coalescing are tested separately with controlled connectors.
- REST offset pagination and cross-origin credential protection; S3-compatible listing and streaming with a local protocol fixture.
- Native Ollama, Claude Messages tool-output, and OpenAI Responses JSON-schema adapters have protocol tests. Provider errors do not trigger fallback.
- Chromium: login, empty and connected states, all six Add data options including MySQL/TLS, tested business-model review, publication, saved dashboard selection and deep links, related-record navigation, previewed edits and history, unchanged snapshot results, and viewer controls. Desktop and 390px mobile layouts were visually inspected; modal Escape/focus restoration and mobile navigation are covered.
- Docker image builds and the four data-platform services start. A Compose installation ingested and queried sample data. Backup/restore of its Helix and Parquet volumes retained one workspace, three datasets, and 340 rows.

## Connect, understand, and act redesign

The redesign passed 35 default unit/API/workflow tests and two browser acceptance tests, plus TypeScript checking and the production build. The default run skips the three opt-in Helix/MySQL integration tests; connector implementations were not changed by the redesign. The browser tests use an isolated workspace and remove its data afterward.

New coverage verifies answer/build automatic routing, accounted model usage, saved routing decisions on resumption, malformed output, call limits, cancellation, viewer denial before generation, authorized resource context and follow-ups, hosted masking, stable logical record routes, effective-value filters, and cross-workspace record denial. Existing tests continue to cover stale approvals and edits, definition rollback, refresh-preserved overlays, and publication validation. A live local Qwen request from an order record automatically chose an answer, executed SQL, and returned 35 delayed orders with source citations. Published views, record actions, data inspection, and the browser reference workflow do not require inference.

## Local AI workflow

A clean reference workspace completed the goal-to-review workflow using the digest-pinned local `qwen3:4b`. Given the sample datasets and a goal about customer revenue and delayed orders, it generated three catalog entries, one SQL pipeline, Customer and Order ontology types, a relationship, and a two-widget dashboard. Automatic validation repaired the ontology and dashboard drafts; all ten final checks passed without manual component edits. The reviewed bundle was then published through the API:

- 32 customer objects and 240 order objects.
- 240 customer/order relationships, covering all 32 customers.
- Revenue grouped by region and exactly 35 delayed orders.
- Every published query executed against declared snapshot versions.
- Six local model calls, 14,516 reported tokens, and approximately 153 seconds from the first stage to the ready proposal. Publication time is separate.

Dataset-name references are resolved only when they uniquely identify an authorized catalog entry. Chart presentation is inferred from executed result shape when a generated metric has multiple rows. These are technical corrections, not invented data or a template masquerading as model output. Business assumptions remain visible for human review. No hosted model calls were used for this workflow.

## Benchmark

On an Apple Silicon M1 Pro development machine with 16 GB RAM:

| Workload                              | Measurement |
| ------------------------------------- | ----------: |
| NDJSON to Parquet, 1,000,000 rows     |      472 ms |
| Concurrent analytical HTTP clients    |          25 |
| Executor slots                        |           2 |
| Median response including queue time  |    1,690 ms |
| Slowest response including queue time |    3,139 ms |

This is a historical two-slot benchmark, before the small-machine Compose defaults were reduced to one executor slot. It excludes inference and measures the executor workload, not 25 browser sessions. The recorded 149 MB RSS is the benchmark client only and must not be represented as combined platform memory; peak executor/container memory remains uncertified. Run `BENCH_HTTP=1 pnpm benchmark` with the executor available to reproduce it; set `EXECUTOR_CONCURRENCY=2` to match the recorded slot count. Hardware, warm caches, storage, and query shape change results.

## Guided onboarding validation (24 September 2026)

The resumable setup adds durable provider preparation and upload/import progress, explicit source selections, grounded outcome recommendations, inline revision and tested preview, and publication-bound completion. The suite passes 46 default tests, three isolated browser tests, four MySQL/PostgreSQL integration checks, and a real pinned-Qwen onboarding evaluation. TypeScript and the production build pass.

The local evaluation completed in 117 seconds with one recommendation call, five build/repair calls, 7,631 reported model tokens, ten passing validation checks, and one published dashboard. It used no hosted provider. Browser tests use a deterministic provider fixture plus real DuckDB; those are separate evidence from the real model run. Both desktop and 390px setup/review layouts were inspected. Existing publication, related-record edits, saved view selection and viewer screens still pass.

Browser acceptance now starts a separate installation on ports 3101/3102/5174 with its own metadata store and data directory. It cannot bootstrap or seed the live installation. No demo account or live sample data was created during this change. See [onboarding](onboarding.md) for routes, idempotency, recovery and fixture commands.

## Remaining validation and MVP limits

- Claude/OpenAI live checks require supplied credentials. No hosted credentials were available, so only protocol fixtures ran.
- The combined 16 GB local-inference target and an installation constrained to 8 GB still need dedicated peak-memory/load certification. The million-row benchmark does not certify million-object ontology publication or the multi-GB streaming query path.
- PostgreSQL 16 multi-table imports, authentication/TLS failures and schema drift were verified in an isolated container. Deployment-specific certificate chains and a real S3 service still require environment integration testing.
- Onboarding supports multi-table and multi-file selection, retaining one source record per table/file. Users explicitly choose selections; related tables are suggested from discovered foreign keys.
- The Advanced ontology graph shows the first 100 objects. Records uses 50-row pages with search and exact filters; relationship selection searches the workspace with 50 results at a time. Plain newest-first resource pages are served from storage-level ordered slices with batched enrichment; searched, filtered, or custom-sorted lists (records, datasets) still read their collections for exactness, so very large ontology deployments with heavy search use should be watched.
- Visual DAGs cover common relational transformations; specialized SQL remains editable. Rejected-row evidence is available for single-input pipelines that retain a candidate key. Ambiguous joins still require business review.
- Background assistance prepares repair drafts after changes. Repairs are bounded and may still need a larger model or developer edits. It never publishes automatically.
- Action history and imported values are separate. Rollback revalidates the previous definitions against current snapshots and rematerializes them, preserving manual overlays; it does not undo business actions.
- The streaming executor's isolation is certified (escape suite, real container), and its multi-GB performance is measured on the host **and inside the Docker container** under the shipping stream security config (below). The executor now ships a custom seccomp profile — tighter than `unconfined` — in `seccomp-stream.json` (see the in-container subsection).
- Partitioned ingestion is implemented end-to-end: uploads/sources can declare a partition column, each version stores a manifest of partition files and fingerprints, and query filters prune partitions before DuckDB scans. Incremental refresh reuses unchanged partitions. This feature is functionally tested, but has not been stress-tested with a 60 GB import or high partition cardinality.
- Query execution is isolated and capped; this release does not provide distributed transactions with external sources, CDC, SSO, billing, or per-record LLM enrichment.

## Architecture and performance hardening (11 October 2026)

Static review plus targeted fixes, all behavior-preserving unless noted. `pnpm typecheck`, `pnpm build`, and the full suite (218 tests, 48 files; 5 opt-in integration suites skipped as before) pass throughout. No live installation data was touched; scratch HelixDB containers used for verification were removed afterward.

- **Store v2 + query primitives.** `status` and `updatedAt` are promoted to indexed top-level HelixDB properties on every write, with a one-time v1-to-v2 backfill (docs byte-identical, revisions untouched). New `getMany` (single-batch reads) and `listPage` (status filter, newest-first ordering, offset/limit, totals) on both `HelixStore` and `MemoryStore`. Verified against a real HelixDB v0.0.6 instance: 14/14 checks including orphan recovery of pre-upgrade queued/running jobs, doc preservation, pagination partitioning, and idempotent re-init. Verification caught a real boot-blocking bug first: asc+desc range indexes on one field conflict on the server, so only the desc index is created (non-fatal guarded).
- **Hot loops indexed.** Worker tick claims queued/running runs+jobs via the status index (no full scans). The 2s live-events stream uses status-indexed active plus a recency-bounded scan and indexed ready-proposal count (exact union). Home fetches bounded collections full plus coverage-exact jobs and 300-item runs/audits windows. Per-question token-budget checks use date-prefix scans (exact, up to 20 full scans eliminated per question). The assistant's prior-turn chat history reads a 200-newest `updatedAt desc` run window instead of all runs — only the last 4 same-thread turns are used, so the bound far exceeds need.
- **Compiled production runtime.** `pnpm build:server` emits NodeNext JS to `dist/`; app/worker/executor run from compiled entrypoints (tsx stays dev-only). The built `meridian:local` image was verified in situ: correct CMD, dist payload present, modules load under plain node, executor boots and serves `/health`.
- **Module splits.** `assistant.ts` (2170 lines) into `assistant/{context,provider,validate,proposals,build}` and `discovery.ts` (1794) into `discovery/{names,keys,suggest,columns,confirm,bundle}`, both behind stable facades; no importer changes, no logic changes.
- **Security/deploy.** Tailnet port moved to opt-in `compose.tailnet.yaml` (fail-closed without `AUTH_PASSWORD`/`TAILSCALE_IP`); hardcoded machine IP removed. Static web assets under `/assets/*` served immutable (year cache) with a regression test; the shell stays fresh.
- **Attempted and reverted.** A short-circuit for explicit metrics regeneration was rejected by the suite (regenerate is an unconditional editor action by tested contract); reverted with no residual change.

The migration was rehearsed on `scripts/rehearse-v2.mts` against a scratch HelixDB v0.0.6 instance, but three real defects only surfaced at production scale and were fixed in sequence:

- **OOM (8-node rehearsal missed it).** The original backfill loaded every node of a scope at once via `store.list(scope)`, OOMing the app's 512 MB heap on a real workspace (20 k rows). Reimplemented memory-bounded: kinds are discovered from a lightweight `scopeKind` property scan (no docs), then each kind is re-put in key-ordered pages of 100.
- **Worker bumped the schema without backfilling (fired in production).** The app-process gate was placed only inside `backfillTopLevelProps`, so the worker still ran the schema version bump on its own. On a cold boot the worker's bump landed before the app's initial read, the app then saw version 2 and skipped the backfill, leaving one real workspace (4,516 rows, incl. 759 jobs and 13 runs) **permanently un-promoted** — status-filtered pages broke and any queued/running jobs stuck. Fixed by gating *both* the backfill and the version bump to the app process and making the worker **wait** for version 2 (poll) instead of bumping; `init()` runs before the server listens, so a normal backfill has no concurrent writers. Self-heals on app restart (idempotent backfill re-runs until the version is 2).
- **Flaky HelixDB cascades planner (pinned v0.0.6).** The 100-row write batches intermittently hit `internal_planner_error` ("unsupported cascades plan") — a transient server-side optimizer race, not a 409, so it was not retried and would crash a backfill or 500 a normal save. `commit()` now treats it (and `/planner error|cascades/`) as retryable, like a conflict.

Live repair: the 4,516 un-promoted rows were re-promoted in place (idempotent; each row re-read inside the CAS lock via `tx.get` before re-put so the active worker's writes were never clobbered). Final state verified on the running install: schema version 2, and all **9,135** nodes across the three scopes carry top-level `status`/`updatedAt` that exactly match their docs (`missing=0`, `mismatch=0`). A two-process integration test (real `server.js`/`worker.js` entrypoints racing on a scratch v1 DB, 754 rows) confirms the fix: the worker alone does **not** bump the version (it waits), and concurrent app+worker leaves every row promoted with schema 2. Scratch DBs and test fixtures were removed. `pnpm typecheck`, `pnpm build:server`, and the full suite (221 tests) pass.

## Scale architecture validation (October 2026)

The hard fork added a scale-up path so the same single-server release can serve workspaces whose datasets are tens of GB rather than a ≤1M-row MVP. Three layers, each validated on its own terms; the October 2026 real-lake series (below) certifies streaming queries against 63.5 GB of production Parquet — linear scaling, flat memory, exact counts. What it cannot cover, by construction: a *single* 60 GB query/table, which the heterogeneous lake has no instance of.

- **L2 — streaming, OS-isolated executor** (`EXECUTOR_MODE=stream`). The query path reads its inputs through `CREATE VIEW ... read_parquet(...)` inside a per-job user+mount namespace (`unshare -rm`) that bind-mounts only the job's authorized files and masks the data roots and system config. Validated by `tests/executor-sandbox.test.ts` (opt-in, `TEST_EXECUTOR_SANDBOX=1`): ten canary-based tests driving the **real** server → `unshare` → runner → engine, asserting on leaked data rather than on the throw. They cover an authorized snapshot reading correctly, cross-scope `read_parquet`, host-file `read_text`, `/proc` masking (no pid visibility), `COPY TO` a masked `/data` path (file not created), and absolute / `../` / symlink `sourcePath` escapes (all rejected, no leak). Verified in the real executor container: a legit view query returns correct rows while cross-scope and `/etc` escapes are blocked. Network egress is a deployment property (the execution network is `internal: true`), so it is not unit-tested. Measured on a real 3.91 GB Parquet fixture (30 M rows, high-entropy columns; recipe and script below): the streaming path answers filtered and full aggregates in **~0.7 s with ~190 MB peak process memory and zero temp disk**, versus **21–40 s and 1–8.3 GB peak memory (plus up to 7.4 GB of temp spill) for materialize** — a 30–60× wall-time reduction at the production single-threaded, 768 MB default configuration.
- **L1 — pre-aggregated, stale-while-revalidating Home metrics.** On an input-version change, `loadMetrics` answers from the last computed values with a `computing` flag and a background job recomputes only the metrics whose dataset changed. The job self-claims its target and commits guarded by the pending marker, so it converges even when a change lands in the gap after its commit. A regression test (pre-fix: 315 loop iterations over 10 s without converging; post-fix: exactly 2) pins the convergence. Composes with L2: with `EXECUTOR_MODE=stream` the background scans stream over Parquet instead of copying it.
- **L3 — lazy records and partitioned ingestion.** Beyond 1,000,000 staged rows, onboarding publishes dashboard-only; unstaged types are served as SQL over their active snapshots (paged, filtered, searched, sorted in the executor; constant memory in the API). Partitioned datasets are split into versioned Parquet files with manifests and fingerprints; queries prune files from partition-key filters, and unchanged partitions can be reused on refresh. Functional coverage includes `tests/records-lazy.test.ts`, `tests/partition-surface.test.ts`, `tests/partition-incremental.test.ts`, and assistant pruning tests. These do not certify 60 GB ingestion or high partition cardinality.

All three layers pass with `pnpm typecheck`, the full default suite (233 tests, opt-in integration suites skipped as before), and `pnpm build`. No live installation data was used; the sandbox and lazy-record suites use in-memory stores and temporary loopback ports.

**Remaining open at scale:** a single 60 GB end-to-end import and high partition cardinality. Query-side certification is done: the real-lake series below measures the stream path on 63.5 GB of production Parquet (per-file scaling to 79M rows, cross-file union, sustained parallel load, 84 MiB cgroup peak). Partitioned ingestion and per-query pruning are implemented and covered by functional tests, but their behavior at 60 GB/high partition cardinality remains unmeasured. See `OPERATIONS.md` for configuration and operational limits.

### Streaming vs materialize on a 3.9 GB Parquet fixture (October 2026)

| Case | Wall (s) | Peak process-tree RSS | Peak temp disk | Result check |
| ---- | -------: | --------------------: | -------------: | ------------ |
| materialize, production defaults (768 MB / 2 GB) — filtered aggregate | 40.3 | 1.0 GB | 7.4 GB | exact match |
| materialize, raised (16 GB / 4 GB) — filtered aggregate | 20.9 | 8.3 GB | 0 | exact match |
| materialize, raised (16 GB / 4 GB) — full aggregate | 21.3 | 8.3 GB | 0 | exact match |
| stream, production defaults (768 MB / 2 GB) — filtered aggregate | 0.7 | 190 MB | 0 | exact match |
| stream, production defaults (768 MB / 2 GB) — full aggregate | 0.7 | 193 MB | 0 | exact match |

**Fixture.** 30 M rows × 9 mixed-type columns (BIGINT, high-entropy VARCHAR×3, DOUBLE, TIMESTAMP, a 12-value VARCHAR `region` for the filter predicate), written ZSTD — **3.91 GB on disk**, deliberately not pathologically compressible. Generated by `scripts/bench-scale-generate.mts`, which also writes per-region ground-truth counts. Every case's result is checked against that ground truth before it is accepted.

**Method.** The real executor `dist` build runs as its own process over HTTP (the same code path as the container), one job at a time, `DUCKDB_THREADS=1` and the production `DUCKDB_MEMORY=768MB` / `DUCKDB_TEMP_LIMIT=2GB` defaults unless the case says otherwise. Wall time covers the full `/execute` round trip; peak RSS is the polled maximum of the server-plus-runner process tree; peak temp is the polled maximum of the job's spill directory. Queries: filtered aggregate (`WHERE region = 'us-east'`, ~1/12 of rows) and full aggregate (`GROUP BY region`), both single-group-shape results, so the work is dominated by scanning the snapshot.

**Reading the numbers.** In materialize mode the per-query cost is the full 3.9 GB copy into an in-memory table (~19–20 s of the 21 s wall time; 8.3 GB resident) plus the query itself; with the production 768 MB default the copy cannot fit and spills heavily (7.4 GB of temp, 40 s). In stream mode the aggregate reads only the columns it touches (`region` + `amount`, ~250 MB of the 3.9 GB file) through the view — projection and row-group pushdown — so wall time is ~0.7 s with ~190 MB peak and no spill, and the cost grows with the *queried* columns, not the file size. Extrapolated linearly, a 60 GB working set keeps the streaming aggregates in the low tens of seconds at these settings, while materialize needs ~128 GB of resident memory (or ~100+ GB of temp spill) for the same table.

**Caveats.** Measured on the host (WSL2, 12 cores, 23 GB RAM) **and** inside a disposable Docker container running the exact shipping stream security config (the custom `seccomp-stream.json` profile, `cap_drop: [ALL]`, `no-new-privileges`, 2 GB memory, 1.5 CPUs, pids limit 128) — in-container numbers are in the next subsection; page cache warm (the fixture was freshly written); single-threaded DuckDB (the production default) — raising `DUCKDB_THREADS` shrinks every row of the table roughly in proportion. `default-filter`'s 7.4 GB temp use exceeds the 2 GB `max_temp_directory_size` setting; the query still completed, but treat observed spill, not the cap, as the planning number. Before benchmarking, rebuild the executor (`pnpm build:server`): an earlier run against a stale `dist` silently measured the materialize path for every case — the *shipped Docker image* had the same problem (its baked-in `dist` predated the stream code), so a fresh image build is a prerequisite for the in-container run below.

**Recipe.**

```sh
pnpm build:server                                        # fresh dist
pnpm exec tsx scripts/bench-scale-generate.mts 30000000  # ~3.9 GB fixture in ~/meridian-bench
pnpm exec tsx scripts/bench-scale.mts                   # all five cases
# single case: pnpm exec tsx scripts/bench-scale.mts stream-full
rm -rf ~/meridian-bench                                  # ~4 GB
```

### Inside the Docker container (shipping stream security config)

The same 3.9 GB fixture was run through a **disposable** executor container built fresh from the current repo and started with the exact security envelope the `compose.stream.yaml` overlay ships:

| Case | HTTP | Wall (s) | Rows ok |
| ---- | ----: | -------: | ------- |
| stream — filtered aggregate | 200 | 0.7–1.0 | exact match |
| stream — full aggregate | 200 | 0.6–0.7 | exact match |

Container config: `--cap-drop ALL --security-opt no-new-privileges:true --security-opt seccomp=./seccomp-stream.json --memory 2g --cpus 1.5 --pids-limit 128`, `EXECUTOR_MODE=stream`, production `DUCKDB_MEMORY=768MB` / `DUCKDB_THREADS=1` / `DUCKDB_TEMP_LIMIT=2GB`, fixture mounted read-only at `DATA_DIR`. In-container peak memory (the container's own cgroup `memory.peak` high-water mark) was **~86 MB** against the 2 GB limit. This is the important result: the per-job user+mount namespace (`unshare -rm`) — the thing Docker's *default* seccomp blocks — **works inside the container under the bundled `seccomp-stream.json` profile** (deny-by-default + `unshare` restricted to user+mount namespaces + `mount`), and the 3.9 GB file is streamed (not copied) with a small transient footprint. The profile is a strict subset of `unconfined`, so the container is no looser than it needs to be (a regression test, `tests/seccomp-profile.test.ts`, pins its safety properties).

Isolation was re-probed in-container (mirroring the host escape suite): `read_text('/etc/hostname')` leaked **no** hostname (masked), and `COPY (…) TO '/tmp/evil-canary.csv'` returned 422 and created **no** file.

**Recipe.**

```sh
docker build -t meridian:bench .                         # fresh image (do NOT reuse a stale one)
docker run -d --name meridian-bench-executor \
  --cap-drop ALL --security-opt no-new-privileges:true --security-opt seccomp=$PWD/seccomp-stream.json \
  --memory 2g --cpus 1.5 --pids-limit 128 \
  -e INTERNAL_KEY=<key> -e DATA_DIR=/data -e LOCAL_DATA_PATH=/mnt/parquet \
  -e EXECUTOR_HOST=0.0.0.0 -e EXECUTOR_PORT=3002 -e EXECUTOR_MODE=stream \
  -e DUCKDB_MEMORY=768MB -e DUCKDB_THREADS=1 -e DUCKDB_TEMP_LIMIT=2GB -e DUCKDB_TEMP_DIR=/tmp \
  -e EXECUTOR_SANDBOX_ROOT=/tmp/executor-sbx \
  -v ~/meridian-bench/data:/data:ro -v ~/meridian-bench/local-mount:/mnt/parquet:ro \
  -p 127.0.0.1:3902:3002 --entrypoint node meridian:bench dist/services/executor/src/server.js
BENCH_EXECUTOR_URL=http://127.0.0.1:3902 BENCH_EXECUTOR_KEY=<key> \
  pnpm exec tsx scripts/bench-scale-container.mts
docker exec meridian-bench-executor cat /sys/fs/cgroup/memory.peak   # in-container peak bytes
docker rm -f meridian-bench-executor
```

### Real-lake certification series (October 2026)

No synthetic regen: the owner's machine cannot take a 25-minute 60 GB generation, so certification ran against the existing lake instead — 741 real Parquet files, 63.5 GB, heterogeneous schemas (7–162 columns, 1 M–127 M rows), which is arguably the harder and more representative target. A disposable executor container (`meridian:local`, the shipping `seccomp-stream.json` profile, `cap_drop ALL`, 4g/1.5 CPUs, DuckDB 2 GB / 4 threads, lake mounted read-only, loopback port) ran the series; the live stack was untouched. Per-file results (count checked exact against host-side ground truth, plus a group-by-first-column top-20 full scan+aggregate):

| File | Rows | Count | Group-by |
| ---- | ---: | ----: | -------: |
| stg_div/ZST_SIT_REGISTR | 37.5M | 0.7s | 0.9s (9 groups) |
| FICA/DFKKOP (162 cols) | 47.9M | 0.5s | 1.1s (1 group) |
| mobi/zcc_anpr_info | 13.4M | 0.4s | 0.6s |
| stg_pers/ZST_PERSADDR_X | 73.2M | 0.4s | 1.3s |
| stg_div/ZST_DIV_MUT (73 cols) | 24.4M | 0.4s | 0.7s |
| zbp/adrc (101 cols) | 17.8M | 0.5s | 1.8s |
| stg_pers/ZST_PERSRELATION | 63.0M | 0.5s | 1.4s |
| mobi/ZTX_VIAPASS_DTS | 79.4M | 0.4s | 0.7s |

Multi-file: the ANPR pair shares 13 of 15 columns, so a `UNION ALL` over the shared schema (18.76M rows / 2.9 GB) is a genuine cross-file streaming query — exact count in 1.7s. Concurrency (`EXECUTOR_CONCURRENCY=2`): 63M- and 79M-row full group-bys in parallel — both 200, 1.9s wall, no queue penalty. Executor cgroup peak across the whole series: **84 MiB**; ~33 GB cumulatively scanned. The widest real file (DFKKOP, 162 columns) aggregates exactly, so the 2 GB DuckDB budget holds with headroom. Honest scope: lake schemas are heterogeneous, so no single 60 GB query exists to run — certification here means linear scaling, flat memory, and exact counts, and all three hold. What remains unmeasured: a single 60 GB import and high partition cardinality (see above).
