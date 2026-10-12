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
- The combined 16 GB local-inference target and an installation constrained to 8 GB still need dedicated peak-memory/load certification. The million-row benchmark does not certify million-object ontology publication.
- PostgreSQL 16 multi-table imports, authentication/TLS failures and schema drift were verified in an isolated container. Deployment-specific certificate chains and a real S3 service still require environment integration testing.
- Onboarding supports multi-table and multi-file selection, retaining one source record per table/file. Users explicitly choose selections; related tables are suggested from discovered foreign keys.
- The Advanced ontology graph shows the first 100 objects. Records uses 50-row pages with search and exact filters; relationship selection searches the workspace with 50 results at a time. Plain newest-first resource pages are served from storage-level ordered slices with batched enrichment; searched, filtered, or custom-sorted lists (records, datasets) still read their collections for exactness, so very large ontology deployments with heavy search use should be watched.
- Visual DAGs cover common relational transformations; specialized SQL remains editable. Rejected-row evidence is available for single-input pipelines that retain a candidate key. Ambiguous joins still require business review.
- Background assistance prepares repair drafts after changes. Repairs are bounded and may still need a larger model or developer edits. It never publishes automatically.
- Action history and imported values are separate. Rollback revalidates the previous definitions against current snapshots and rematerializes them, preserving manual overlays; it does not undo business actions.
- Query execution is isolated and capped; this release does not provide distributed transactions with external sources, CDC, SSO, billing, or per-record LLM enrichment.

## Architecture and performance hardening (11 October 2026)

Static review plus targeted fixes, all behavior-preserving unless noted. `pnpm typecheck`, `pnpm build`, and the full suite (218 tests, 48 files; 5 opt-in integration suites skipped as before) pass throughout. No live installation data was touched; scratch HelixDB containers used for verification were removed afterward.

- **Store v2 + query primitives.** `status` and `updatedAt` are promoted to indexed top-level HelixDB properties on every write, with a one-time v1-to-v2 backfill (docs byte-identical, revisions untouched). New `getMany` (single-batch reads) and `listPage` (status filter, newest-first ordering, offset/limit, totals) on both `HelixStore` and `MemoryStore`. Verified against a real HelixDB v0.0.6 instance: 14/14 checks including orphan recovery of pre-upgrade queued/running jobs, doc preservation, pagination partitioning, and idempotent re-init. Verification caught a real boot-blocking bug first: asc+desc range indexes on one field conflict on the server, so only the desc index is created (non-fatal guarded).
- **Hot loops indexed.** Worker tick claims queued/running runs+jobs via the status index (no full scans). The 2s live-events stream uses status-indexed active plus a recency-bounded scan and indexed ready-proposal count (exact union). Home fetches bounded collections full plus coverage-exact jobs and 300-item runs/audits windows. Per-question token-budget checks use date-prefix scans (exact, up to 20 full scans eliminated per question).
- **Compiled production runtime.** `pnpm build:server` emits NodeNext JS to `dist/`; app/worker/executor run from compiled entrypoints (tsx stays dev-only). The built `helix-foundry:local` image was verified in situ: correct CMD, dist payload present, modules load under plain node, executor boots and serves `/health`.
- **Module splits.** `assistant.ts` (2170 lines) into `assistant/{context,provider,validate,proposals,build}` and `discovery.ts` (1794) into `discovery/{names,keys,suggest,columns,confirm,bundle}`, both behind stable facades; no importer changes, no logic changes.
- **Security/deploy.** Tailnet port moved to opt-in `compose.tailnet.yaml` (fail-closed without `AUTH_PASSWORD`/`TAILSCALE_IP`); hardcoded machine IP removed. Static web assets under `/assets/*` served immutable (year cache) with a regression test; the shell stays fresh.
- **Attempted and reverted.** A short-circuit for explicit metrics regeneration was rejected by the suite (regenerate is an unconditional editor action by tested contract); reverted with no residual change.

The migration was rehearsed on `scripts/rehearse-v2.mts` against a scratch HelixDB v0.0.6 instance, but three real defects only surfaced at production scale and were fixed in sequence:

- **OOM (8-node rehearsal missed it).** The original backfill loaded every node of a scope at once via `store.list(scope)`, OOMing the app's 512 MB heap on a real workspace (20 k rows). Reimplemented memory-bounded: kinds are discovered from a lightweight `scopeKind` property scan (no docs), then each kind is re-put in key-ordered pages of 100.
- **Worker bumped the schema without backfilling (fired in production).** The app-process gate was placed only inside `backfillTopLevelProps`, so the worker still ran the schema version bump on its own. On a cold boot the worker's bump landed before the app's initial read, the app then saw version 2 and skipped the backfill, leaving one real workspace (4,516 rows, incl. 759 jobs and 13 runs) **permanently un-promoted** — status-filtered pages broke and any queued/running jobs stuck. Fixed by gating *both* the backfill and the version bump to the app process and making the worker **wait** for version 2 (poll) instead of bumping; `init()` runs before the server listens, so a normal backfill has no concurrent writers. Self-heals on app restart (idempotent backfill re-runs until the version is 2).
- **Flaky HelixDB cascades planner (pinned v0.0.6).** The 100-row write batches intermittently hit `internal_planner_error` ("unsupported cascades plan") — a transient server-side optimizer race, not a 409, so it was not retried and would crash a backfill or 500 a normal save. `commit()` now treats it (and `/planner error|cascades/`) as retryable, like a conflict.

Live repair: the 4,516 un-promoted rows were re-promoted in place (idempotent; each row re-read inside the CAS lock via `tx.get` before re-put so the active worker's writes were never clobbered). Final state verified on the running install: schema version 2, and all **9,135** nodes across the three scopes carry top-level `status`/`updatedAt` that exactly match their docs (`missing=0`, `mismatch=0`). A two-process integration test (real `server.js`/`worker.js` entrypoints racing on a scratch v1 DB, 754 rows) confirms the fix: the worker alone does **not** bump the version (it waits), and concurrent app+worker leaves every row promoted with schema 2. Scratch DBs and test fixtures were removed. `pnpm typecheck`, `pnpm build:server`, and the full suite (221 tests) pass.
