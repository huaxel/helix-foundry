import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, realpath, link, copyFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute, sep } from "node:path";
import type { DatasetProfile } from "../../../packages/shared/src/index.js";
export const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
const lit = (v: string) => "'" + v.replaceAll("'", "''") + "'";
const safePart = (s: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(s);
const isMemoryLimitError = (error: unknown) =>
  /out of memory|memory limit|could not allocate/i.test(String(error));
export type Execution = {
  mode: "ingest" | "query" | "export";
  scope: string;
  version?: string;
  file?: string;
  sourcePath?: string;
  sourceFingerprint?: { size: number; mtimeMs: number };
  format?: string;
  schema?: { name: string; type: string }[];
  // Ingest only: when set, the snapshot is split into one Parquet file per
  // distinct value of this column (a partitioned dataset) and a manifest is
  // returned in `partitions`.
  partitionColumn?: string;
  // Ingest only: partitions from a previous version of this dataset whose
  // content fingerprint matches; the engine reuses (hard-links) their Parquet
  // files instead of re-writing them. `file` is relative to datasets/<scope>/.
  reusePartitions?: { key: string; file: string; fingerprint: string }[];
  inputs?: {
    table: string;
    version: string;
    sourcePath?: string;
    sourceFingerprint?: { size: number; mtimeMs: number };
    // Partitioned dataset: the (already pruned) set of partition Parquet
    // files, each relative to datasets/<scope>/. When present and non-empty
    // the input is read as one logical table over the whole file list. It is
    // mutually exclusive with sourcePath.
    files?: string[];
    aliases?: string[];
    filters?: { column: string; value: string | number | boolean | null }[];
  }[];
  sql?: string;
  persist?: boolean;
  offset?: number;
  limit?: number;
  approximateProfile?: boolean;
  // Stream mode only: the executor server bind-mounted each authorized input's
  // files into private paths (sandbox.in[i] is the list of bound paths for
  // inputs[i] — one per partition file) and masked the rest of the filesystem
  // in a mount namespace. The engine reads through views and leaves external
  // access ON; the namespace is the isolation boundary.
  sandbox?: { in: string[][]; tmp?: string };
};
// Sanitize a partition key into a safe Parquet file name (null -> __null__).
const partitionFileName = (key: string | null) =>
  (
    key === null || key === undefined || key === ""
      ? "__null__"
      : key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
  ) + ".parquet";

// Split the `result` view into one Parquet file per distinct value of
// `column`, under datasets/<scope>/<version>/. Returns the manifest
// (partition -> file -> rows). Keys are handled as VARCHAR so the split is
// type-agnostic; NULL forms its own partition.
async function writePartitions(
  c: DuckDBConnection,
  opts: {
    root: string;
    scope: string;
    version: string;
    column: string;
    reuse?: { key: string; file: string; fingerprint: string }[];
  },
): Promise<
  { key: string; file: string; rows: number; size: number; fingerprint: string }[]
> {
  const { root, scope, version, column } = opts;
  if (!safePart(column)) throw new Error("Invalid partition column");
  const q = quote(column);
  const keys = (
    await c.runAndReadAll(`SELECT DISTINCT ${q}::VARCHAR AS k FROM result`)
  ).getRowObjectsJson();
  const keyList: (string | null)[] = keys.map((k) => k.k as string | null);
  if (keyList.length > 10000)
    throw new Error(
      "Too many partitions (" +
        keyList.length +
        "); choose a lower-cardinality partition column",
    );
  const partDir = resolve(root, "datasets", scope, version);
  await mkdir(partDir, { recursive: true });
  // The content fingerprint packs every result column, so any schema change
  // (added/removed/renamed column) alters it and blocks reuse of stale files.
  const cols = (
    await c.runAndReadAll("DESCRIBE result")
  ).getRowObjectsJson().map((r) => String(r.column_name));
  const pack = "struct_pack(" + cols.map(quote).join(", ") + ")";
  const reuseMap = new Map((opts.reuse ?? []).map((r) => [r.key, r]));
  const partitions: {
    key: string;
    file: string;
    rows: number;
    size: number;
    fingerprint: string;
  }[] = [];
  for (const key of keyList) {
    const where =
      key === null
        ? `${q}::VARCHAR IS NULL`
        : `${q}::VARCHAR IS NOT DISTINCT FROM ${lit(key)}`;
    const file = version + "/" + partitionFileName(key);
    const real = resolve(root, "datasets", scope, file);
    // Order-independent (sum), NULL-safe, 128-bit (no overflow) content hash.
    const fp = (
      await c.runAndReadAll(
        `SELECT count(*) n, coalesce(sum(hash(${pack})::HUGEINT), 0)::VARCHAR h FROM result WHERE ${where}`,
      )
    ).getRowObjectsJson()[0];
    const rows = Number(fp.n);
    const fingerprint = rows + ":" + fp.h;
    // Reuse: a previous version's partition with the same key + fingerprint is
    // byte-for-byte reusable, so hard-link it (copy fallback, then fresh write).
    const prev = reuseMap.get(key === null ? "" : key);
    let reused = false;
    if (prev && prev.fingerprint === fingerprint) {
      const prevReal = resolve(root, "datasets", scope, prev.file);
      try {
        await stat(prevReal);
        await link(prevReal, real);
        reused = true;
      } catch {
        try {
          await copyFile(prevReal, real);
          reused = true;
        } catch {
          reused = false;
        }
      }
    }
    if (!reused)
      await c.run(
        `COPY (SELECT * FROM result WHERE ${where}) TO ${lit(real)} (FORMAT PARQUET)`,
      );
    const st = await stat(real);
    partitions.push({
      key: key === null ? "" : key,
      file,
      rows,
      size: st.size,
      fingerprint,
    });
  }
  return partitions;
}

export async function execute(
  job: Execution,
  root = resolve(process.env.DATA_DIR || ".data"),
  localRoot = process.env.LOCAL_DATA_PATH || "/mnt/parquet",
) {
  if (!safePart(job.scope) || (job.version && !safePart(job.version)))
    throw new Error("Invalid storage identity");
  const out = resolve(root, "datasets", job.scope, `${job.version}.parquet`);
  // Stream-query mode runs inside a mount namespace that masks /data and /mnt,
  // so the engine must not create or validate any path there: the server has
  // already bound the authorized inputs into the sandbox and pointed
  // DUCKDB_TEMP_DIR at a writable scratch outside the masked roots.
  const streamQuery =
    process.env.EXECUTOR_MODE === "stream" && job.mode === "query";
  if (!job.sourcePath && !streamQuery)
    await mkdir(dirname(out), { recursive: true });
  const resolveSource = async (
    sourcePath: string,
    expected: { size: number; mtimeMs: number },
  ) => {
    if (
      isAbsolute(sourcePath) ||
      !expected ||
      !Number.isFinite(expected.size) ||
      !Number.isFinite(expected.mtimeMs)
    )
      throw new Error("Invalid mounted source reference");
    const sourceRoot = await realpath(localRoot);
    const source = await realpath(resolve(sourceRoot, sourcePath));
    if (
      !source.startsWith(sourceRoot + sep) ||
      !source.toLowerCase().endsWith(".parquet")
    )
      throw new Error(
        "Mounted source must be a Parquet file inside the configured root",
      );
    const current = await stat(source);
    if (!current.isFile())
      throw new Error("Mounted source is not a regular file");
    if (current.size !== expected.size || current.mtimeMs !== expected.mtimeMs)
      throw new Error(
        "Mounted Parquet source changed; re-import it to refresh the dataset",
      );
    return source;
  };
  // Create the default on-disk scratch only when it will actually be used
  // (DUCKDB_TEMP_DIR unset). Stream mode sets DUCKDB_TEMP_DIR to the sandbox's
  // scratch, which lives outside the masked /data.
  let scratch: string | undefined;
  if (!process.env.DUCKDB_TEMP_DIR) {
    const scratchRoot = resolve(root, "scratch");
    await mkdir(scratchRoot, { recursive: true });
    scratch = await mkdtemp(resolve(scratchRoot, "executor-"));
  }
  let db: DuckDBInstance | undefined;
  let c: DuckDBConnection | undefined;
  let inputFingerprint = job.sourceFingerprint;
  try {
    db = await DuckDBInstance.create(":memory:", {
      memory_limit: process.env.DUCKDB_MEMORY || "512MB",
      threads: process.env.DUCKDB_THREADS || "1",
      temp_directory: process.env.DUCKDB_TEMP_DIR || scratch!, // scratch is set whenever DUCKDB_TEMP_DIR is unset
      max_temp_directory_size: process.env.DUCKDB_TEMP_LIMIT || "2GB",
      allow_unsigned_extensions: "false",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      // Large snapshots and DISTINCT profiling need headroom; the order of
      // result rows is never relied on, so skip insertion-order bookkeeping.
      preserve_insertion_order: "false",
    });
    c = await db.connect();
    if (job.mode === "ingest") {
      if (
        !job.sourcePath &&
        (!job.file || !/^[-\w]+\.(csv|json|jsonl|parquet)$/.test(job.file))
      )
        throw new Error("Invalid input file");
      if (job.sourcePath && job.file) throw new Error("Ambiguous input");
      const file = job.sourcePath
        ? await resolveSource(job.sourcePath, job.sourceFingerprint!)
        : resolve(root, "incoming", job.scope, job.file!);
      const info = await stat(file);
      inputFingerprint ??= { size: info.size, mtimeMs: info.mtimeMs };
      const fn = file.toLowerCase().endsWith(".csv")
        ? "read_csv_auto"
        : file.toLowerCase().endsWith(".parquet")
          ? "read_parquet"
          : "read_json_auto";
      if (info.size === 0 && job.schema?.length) {
        const typeMap: Record<string, string> = {
          int: "BIGINT",
          integer: "BIGINT",
          bigint: "VARCHAR",
          smallint: "INTEGER",
          tinyint: "INTEGER",
          float: "DOUBLE",
          double: "DOUBLE",
          boolean: "BOOLEAN",
          date: "DATE",
        };
        await c.run(
          `CREATE TABLE result (${job.schema.map((col) => quote(col.name) + " " + (typeMap[col.type.toLowerCase()] || "VARCHAR")).join(",")})`,
        );
      } else
        // A view keeps the snapshot streaming: profiling and the parquet copy
        // read the file column-wise instead of materializing it in memory, so
        // large or very wide tables fit within the executor's memory budget.
        await c.run(`CREATE VIEW result AS SELECT * FROM ${fn}(${lit(file)})`);
    } else {
      // Stream mode (EXECUTOR_MODE=stream): the OS mount namespace is the
      // sandbox. The server bind-mounted each authorized snapshot into
      // job.sandbox.in and masked everything else, so we read through a VIEW
      // (column + row-group pushdown, no per-query materialization) and leave
      // external access ON. Stream mode is only entered when the server set
      // job.sandbox — without the namespace, external-access-on would be a leak.
      const inputs = job.inputs || [];
      const stream =
        streamQuery && !!job.sandbox && job.sandbox.in.length === inputs.length;
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        if (!safePart(input.table) || !safePart(input.version))
          throw new Error("Invalid input");
        // A partitioned input is a *set* of Parquet files (one per partition)
        // read as one logical table; a single-file input is a one-element set.
        const scopeDir = resolve(root, "datasets", job.scope);
        const fileList: string[] = stream
          ? job.sandbox!.in[i]
          : input.files && input.files.length
            ? input.files.map((f) => {
                const p = resolve(scopeDir, f);
                if (isAbsolute(f) || !p.startsWith(scopeDir + sep))
                  throw new Error("Invalid partition file");
                return p;
              })
            : [
                input.sourcePath
                  ? await resolveSource(input.sourcePath, input.sourceFingerprint!)
                  : resolve(scopeDir, input.version + ".parquet"),
              ];
        if (fileList.length === 0)
          throw new Error("Input has no readable files");
        const conditions = (input.filters || []).map((filter) => {
          const value =
            filter.value === null
              ? "NULL"
              : typeof filter.value === "string"
                ? lit(filter.value)
                : String(filter.value);
          return `${quote(filter.column)} IS NOT DISTINCT FROM ${value}`;
        });
        const where = conditions.length
          ? ` WHERE ${conditions.join(" AND ")}`
          : "";
        // One file keeps the plain string form; several files are passed as a
        // list so DuckDB unions them (read_parquet(['a.parquet','b.parquet'])).
        const readExpr =
          fileList.length === 1
            ? lit(fileList[0])
            : `[${fileList.map(lit).join(",")}]`;
        if (stream)
          // A view over the mounted Parquet lets DuckDB prune columns and skip
          // row-groups the query never touches — no full snapshot copy.
          await c.run(
            `CREATE VIEW ${quote(input.table)} AS SELECT * FROM read_parquet(${readExpr})${where}`,
          );
        else
          // Materialize only the authorized, filtered snapshot before external
          // access is disabled for the user query below.
          await c.run(
            `CREATE TABLE ${quote(input.table)} AS SELECT * FROM read_parquet(${readExpr})${where}`,
          );
      }
      const aliasCounts = new Map<string, number>();
      for (const input of job.inputs || [])
        for (const alias of input.aliases || [])
          aliasCounts.set(
            alias.toLowerCase(),
            (aliasCounts.get(alias.toLowerCase()) || 0) + 1,
          );
      const taken = new Set(
        (job.inputs || []).map((i) => i.table.toLowerCase()),
      );
      taken.add("result");
      for (const input of job.inputs || [])
        for (const alias of input.aliases || []) {
          if (
            aliasCounts.get(alias.toLowerCase()) === 1 &&
            !taken.has(alias.toLowerCase())
          ) {
            await c.run(
              `CREATE VIEW ${quote(alias)} AS SELECT * FROM ${quote(input.table)}`,
            );
            taken.add(alias.toLowerCase());
          }
        }
      const sql = job.sql?.trim().replace(/;\s*$/, "");
      if (!sql || !/^\s*(select|with)\b/i.test(sql))
        throw new Error("Only a single SELECT query is allowed");
      const extracted = await c.extractStatements(sql);
      if (extracted.count !== 1)
        throw new Error("Only a single SELECT query is allowed");
      if (!stream) {
        // Materialize mode: the inputs are now in-memory tables, so hard-lock
        // the database down — the user query can no longer reach the filesystem.
        await c.run(`SET allowed_paths = [${lit(out)}]`);
        await c.run("SET enable_external_access = false");
        await c.run("SET lock_configuration = true");
      }
      // Stream mode: the mount namespace is the boundary, so external access
      // stays ON (otherwise the input views couldn't read their Parquet files).
      await c.run(
        `CREATE TABLE result AS SELECT * FROM (${sql}) AS foundry_result`,
      );
    }
    if (job.mode === "export") {
      const path = out.replace(/\.parquet$/, ".csv");
      throw new Error("Use dataset Parquet export or paginated CSV export");
    }
    // Partitioned ingest: write one Parquet per partition value and return a
    // manifest; the aggregate profile below is computed over the full result.
    let partitions: { key: string; file: string; rows: number; size: number }[] | undefined;
    if (job.mode === "ingest" && job.partitionColumn) {
      partitions = await writePartitions(c, {
        root,
        scope: job.scope,
        version: job.version!,
        column: job.partitionColumn,
        reuse: job.reusePartitions,
      });
    } else if ((job.mode === "ingest" && !job.sourcePath) || job.persist) {
      await c.run(`COPY result TO ${lit(out)} (FORMAT PARQUET)`);
    }
    const rows = Number(
      (
        await c.runAndReadAll("SELECT count(*) n FROM result")
      ).getRowObjectsJson()[0].n,
    );
    const schema = (
      await c.runAndReadAll("DESCRIBE result")
    ).getRowObjectsJson();
    const sample = (
      await c.runAndReadAll(
        `SELECT * FROM result LIMIT ${Math.min(job.limit || 50, 1000)} OFFSET ${Math.max(job.offset || 0, 0)}`,
      )
    ).getRowObjectsJson();
    // Profile one column at a time: exact counts with a per-column fallback
    // to approximate under memory pressure, so a single wide column never
    // strips key evidence from the other columns.
    let approximateDistincts = job.approximateProfile === true;
    const columns = [];
    for (const [i, col] of schema.entries()) {
      const name = String(col.column_name),
        q = quote(name);
      let null_count: unknown, distincts: unknown, exact = !approximateDistincts;
      if (exact) {
        try {
          const row = (
            await c.runAndReadAll(
              `SELECT count(*)-count(${q}) AS null_count, count(DISTINCT ${q}) AS distincts FROM result`,
            )
          ).getRowObjectsJson()[0];
          null_count = row.null_count;
          distincts = row.distincts;
        } catch (error) {
          if (!isMemoryLimitError(error)) throw error;
          approximateDistincts = true;
          exact = false;
        }
      }
      if (!exact) {
        const row = (
          await c.runAndReadAll(
            `SELECT count(*)-count(${q}) AS null_count, approx_count_distinct(${q}) AS distincts FROM result`,
          )
        ).getRowObjectsJson()[0];
        null_count = row.null_count;
        distincts = row.distincts;
      }
      columns.push({
        name,
        type: String(col.column_type),
        nulls: Number(null_count),
        distinct: Number(distincts),
        examples: sample.slice(0, 3).map((r) => r[name]),
        sensitive:
          /email|phone|ssn|password|secret|token|address|birth|credit/i.test(
            name,
          ),
        primaryKey:
          exact &&
          rows > 0 &&
          Number(null_count) === 0 &&
          Number(distincts) === rows,
      });
    }
    // Avoid hashing/materializing whole rows in explicitly low-memory mode.
    let approximateDuplicates = job.approximateProfile === true;
    let duplicateRows: number | undefined;
    let rowFingerprint: unknown = inputFingerprint ?? sample;
    if (!approximateDuplicates) {
      let rowStats: Record<string, unknown> | undefined;
      try {
        rowStats = (
          await c.runAndReadAll(
            "WITH row_hashes AS (SELECT hash(result) AS h FROM result) SELECT bit_xor(h) AS fingerprint, sum(h::HUGEINT) AS hash_sum, count(*) - count(DISTINCT h) AS duplicate_rows FROM row_hashes",
          )
        ).getRowObjectsJson()[0];
      } catch (error) {
        if (!isMemoryLimitError(error)) throw error;
        approximateDuplicates = true;
        try {
          rowStats = (
            await c.runAndReadAll(
              "WITH row_hashes AS (SELECT hash(result) AS h FROM result) SELECT bit_xor(h) AS fingerprint, approx_count_distinct(h) AS unique_rows FROM row_hashes",
            )
          ).getRowObjectsJson()[0];
        } catch (approximateError) {
          if (!isMemoryLimitError(approximateError)) throw approximateError;
        }
      }
      if (rowStats) {
        rowFingerprint = approximateDuplicates
          ? rowStats.fingerprint
          : { fingerprint: rowStats.fingerprint, hash_sum: rowStats.hash_sum };
        duplicateRows = approximateDuplicates
          ? Math.max(0, rows - Number(rowStats.unique_rows))
          : Number(rowStats.duplicate_rows);
      }
    }
    const profile: DatasetProfile = {
      rows,
      ...(duplicateRows === undefined ? {} : { duplicateRows }),
      columns,
      sample,
      fingerprint: createHash("sha256")
        .update(JSON.stringify([schema, rows, rowFingerprint]))
        .digest("hex"),
      ...(approximateDistincts || approximateDuplicates
        ? { approximate: true }
        : {}),
    };
    if (!streamQuery) {
      if (job.mode === "ingest" && job.sourcePath)
        await resolveSource(job.sourcePath, job.sourceFingerprint!);
      for (const input of job.inputs || [])
        if (input.sourcePath)
          await resolveSource(input.sourcePath, input.sourceFingerprint!);
    }
    return {
      profile,
      version: job.version,
      rows: sample,
      ...(partitions ? { partitions } : {}),
    };
  } finally {
    c?.closeSync();
    db?.closeSync();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
