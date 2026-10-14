<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="Meridian" width="320">
  </picture>
</h1>

<p align="center">
  <strong>Your company's data, connected into one ontology, on your own computer.</strong>
</p>

Meridian is a local-first data workspace built on [HelixDB](https://docs.helix-db.com) and [DuckDB](https://duckdb.org). Connect the tools your company already runs on, such as your database, Stripe, WorkOS, PostHog, files and APIs, and it suggests one connected ontology across them that you can explore and ask questions of. There are no accounts and nothing to host: it runs on your computer, and AI runs locally by default.

> **Meridian** is a hard fork of [Helix Foundry](https://github.com/helixdb/helix-foundry). The product and packages are rebranded, but the Docker Compose project and data volumes intentionally keep the `helix-foundry` name so existing installs keep their data on upgrade. The fork also adds a **scale-up path**: an opt-in, OS-isolated streaming executor (`EXECUTOR_MODE=stream`) that queries multi-GB Parquet without a per-query copy, and lazy records that browse very large types as SQL instead of materialized objects. See [docs/OPERATIONS.md](docs/OPERATIONS.md#scale-architecture-streaming-executor).

<p align="center">
  <img src="docs/assets/hero.png" width="720" alt="The Meridian Explorer showing accounts, users, invoices, subscriptions, campaigns, SSO connections and support tickets as one connected graph">
</p>

## Get started with your coding agent

You need [Docker](https://docs.docker.com/get-started/get-docker/) installed and running. The first run downloads several GB, so give it a few minutes.

Paste this prompt into Claude Code, Codex, Cursor or any coding agent that can run terminal commands:

```text
Set up Meridian on this computer.

Clone https://github.com/helixdb/helix-foundry.git (or use the copy I already
have), cd into it, then read AGENTS.md and follow it to install, start and
verify the app. Ask me before doing anything that deletes data or stops
something that is already running. When it is ready, give me the URL and
tell me what to do next.
```

Your agent will ask you to approve `git`, `docker` and network commands as it goes. Approve them one at a time rather than allowing every `docker` command up front; the runbook asks before anything that deletes data.

**What your agent will do**

- Check that Docker is running and that the app's port (3001 by default) is free, and pick another port if it is not.
- Generate local encryption keys in `.env` with `scripts/setup.sh`.
- Build and start the stack with Docker Compose, using the configured remote llama.cpp server for local inference.
- Wait for the health check to pass, then give you the URL.

**What you do next**

1. Open the URL (http://localhost:3001 by default). There is no account to create.
2. Guided setup takes you through **AI → Data → Ontology**. Choose Local, Claude or OpenAI. Connect your data, or choose **Continue with sample data**. Then confirm the suggested ontology.
3. Home opens with your key metrics. Ask anything about your data from the box at the top.

You enter Claude or OpenAI keys and database credentials yourself, in the browser. Your agent never needs them.

## Manual quick start

You need Docker with Compose v2 (see [requirements](#requirements)).

```sh
git clone https://github.com/helixdb/helix-foundry.git
cd helix-foundry
./scripts/setup.sh --compose
```

`setup.sh` writes fresh keys to `.env` if it does not exist yet, then builds and starts the app, a background worker, the DuckDB executor and HelixDB. Local inference uses the configured OpenAI-compatible llama.cpp endpoint; Foundry does not download or store model weights.

It is ready when the health check answers:

```sh
curl -fsS http://localhost:3001/api/health
# {"ok":true,"service":"meridian"}
```

Then open **http://localhost:3001**. The configured remote model endpoint is tested during setup; its weights remain on that server.

**Port 3001 already in use?** Create `.env` first, then set the port and the matching origin together:

```sh
./scripts/setup.sh                                   # creates .env with fresh keys
echo 'PUBLIC_PORT=3005' >> .env
echo 'PUBLIC_ORIGIN=http://localhost:3005' >> .env
./scripts/setup.sh --compose
```

Add the two lines once; if `.env` already has them, change their values instead. Always change both. If only the port changes, pages load but every save fails with `403 Origin is not allowed`.

**Remote local inference.** Point `MODEL_ENDPOINT` in `.env` at the llama.cpp OpenAI-compatible `/v1` endpoint, then start the stack normally:

```sh
./scripts/setup.sh
grep -q '^MODEL_ENDPOINT=' .env || echo 'MODEL_ENDPOINT=http://framearch-juan:8000/v1' >> .env
docker compose up -d --build
```

For another llama.cpp server, set `MODEL_ENDPOINT` to its reachable OpenAI-compatible `/v1` URL.

## Requirements

- **Docker** with the Compose v2 plugin (`docker compose`, not `docker-compose`). Checked with Compose 2.29.
- **git, bash and openssl** for the setup scripts.
- **Disk:** the app image and HelixDB; model weights remain on the remote llama.cpp server.
- **Memory:** Docker needs headroom for HelixDB and DuckDB imports; local model inference runs on the configured remote llama.cpp server.
- **Node.js 24 and pnpm 10.7**, only for [local development](#local-development).

Meridian is developed and validated on macOS with Apple Silicon, and CI runs on Linux. Windows is untested, and the scripts need bash.

## What you get

- **Connectors** for Neon, Supabase, PlanetScale, PostgreSQL, MySQL, Stripe, WorkOS, PostHog, REST APIs, S3-compatible storage, file uploads (CSV, JSON, JSONL, Parquet) and an ingestion API.
- **Automatic sync** through native PostgreSQL and MySQL change capture where the database allows it, and scheduled snapshot refreshes otherwise.
- **A suggested ontology** that matches the same customers and records across sources, stored as real objects and relationships in HelixDB.
- **Versioned data:** imported datasets are immutable Parquet snapshots; mounted local Parquet sources are read directly with file metadata guards, avoiding a second stored copy.
- **Home and Analyst:** key metrics, and answers to your questions backed by executed SQL with snapshot citations.
- **Your choice of AI:** the configured llama.cpp OpenAI-compatible endpoint by default, Claude or OpenAI. AI-proposed changes are tested and wait for your review.
- **Developer access:** OpenAPI at `/api/docs`, a TypeScript SDK, scoped API tokens, and backup and restore scripts.
- **A scale-up path:** an opt-in streaming executor that reads multi-GB Parquet through views inside a per-job OS sandbox (column + row-group pushdown, no per-query copy), and lazy records that keep very large workspaces usable by browsing types as SQL. Off by default; the existing materialize path is unchanged.

The full feature list, connector details and architecture are in the [guide](docs/GUIDE.md).

## Everyday commands

Run these from the repository. Set `MODEL_ENDPOINT` to the remote llama.cpp `/v1` URL in `.env`; the local inference setup uses this endpoint.

```sh
docker compose ps                                  # status
docker compose logs -f app worker                  # follow logs (Ctrl+C to stop)
docker compose stop                                # stop
docker compose up -d                               # start again
```

The stack starts again with Docker unless you stopped it.

**Upgrade.** Back up first, then pull and rebuild:

```sh
./scripts/backup.sh ~/helix-foundry-backups/$(date +%Y%m%d-%H%M%S)
git pull
docker compose up -d --build
```

**Back up and restore.** `./scripts/backup.sh PATH` briefly stops the services, archives the HelixDB and data volumes, and copies `.env` as `config.env`. Keep backups private and outside the repository, because `config.env` holds your encryption key. `./scripts/restore.sh PATH --replace` replaces the current data and `.env` with a backup.

Never run `docker compose down -v` unless you mean to delete everything. It removes all workspaces, imported data and stored credentials. See [operations](docs/OPERATIONS.md) for upgrades, change capture and limits.

## Local development

Use Node.js 24 and pnpm 10.7. Run HelixDB in Docker and the app natively:

```sh
pnpm install
./scripts/setup.sh
docker run -d --name helix-foundry-dev -p 127.0.0.1:6996:8080 \
  -e HELIX_DATA_DIR=/var/lib/helix -v helix-foundry-dev:/var/lib/helix \
  ghcr.io/helixdb/helixdb:v0.0.6@sha256:94b29942658ebdca0a91bf15edffe921a46da3e26e1223ea333ccce58c6212dd
pnpm dev
```

Open **http://localhost:5173**. `pnpm dev` runs the API on 3001, the executor on 3002 and the web app on 5173. Set `MODEL_ENDPOINT` to a reachable llama.cpp `/v1` endpoint for local inference. Before opening a pull request, run the same checks as CI: `pnpm typecheck`, `pnpm test` and `pnpm build`. The [guide](docs/GUIDE.md#local-development) covers tests, ports and the SDK.

## Security model

This fork serves one owner over their Tailscale network with password sign-in (see `AGENTS.md` for the full architecture). Set `AUTH_PASSWORD`, `PUBLIC_ORIGIN`, and `TAILSCALE_IP` in `.env`; the app refuses non-loopback origins without a password. Tailnet exposure is opt-in: `docker compose up` publishes loopback only, and the Tailscale IP binding lives in `compose.tailnet.yaml` (`docker compose -f compose.yaml -f compose.tailnet.yaml up -d`, or `./scripts/setup.sh --compose`).

- The app is published on `127.0.0.1` (healthchecks, local use) and, only when the tailnet overlay is used, on this machine's Tailscale IP. Never expose it beyond the tailnet: no public internet, no LAN/WiFi, no reverse proxy or tunnel outward, and never publish the internal HelixDB or executor ports.
- Every `/api/*` route requires a password session (browser cookie) or a workspace Bearer token, except `/api/health` and `/api/auth/*`. The predictable local-session id is never accepted via cookie. Login is rate-limited.
- The API rejects requests whose `Host` is not the configured origin's host, and browser changes from any other origin, with `403`.
- Connector and AI credentials are encrypted with `ENCRYPTION_KEY` from `.env`. Keep `.env` and backups private and out of git. If you lose the key, stored credentials cannot be recovered. Do not try to rotate it by replacing the value.
- Generated SQL runs in a separate DuckDB executor on an internal network with no internet access, no connector credentials, no Linux capabilities, and memory and process limits.
- Scripts and the SDK use workspace-scoped API tokens from **Settings → Developer tools**. Tokens are read-only unless you grant write access.

## Documentation

| Document                                 | What it covers                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                   | Runbook for coding agents: preflight, setup, verification and troubleshooting     |
| [docs/GUIDE.md](docs/GUIDE.md)           | Features, connectors, AI and review, architecture, development and testing        |
| [docs/DESIGN.md](docs/DESIGN.md)         | Existing visual standards, UI tokens, progress feedback and accessibility         |
| [docs/onboarding.md](docs/onboarding.md) | Onboarding API routes, SDK methods and import limits                              |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Installation, diagnostics, change capture, backup, restore, upgrades, limits and the streaming scale architecture |
| [docs/HOSTING.md](docs/HOSTING.md)       | Neon, Supabase and PlanetScale sign-in, scopes and permissions                    |
| [docs/API.md](docs/API.md)               | REST API reference, authentication and the TypeScript SDK                         |
| [docs/VALIDATION.md](docs/VALIDATION.md) | Test results, benchmarks and known limits from the September–October 2026 validation runs, including the scale architecture |

## License

Meridian is released under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
