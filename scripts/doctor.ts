import { config } from "../apps/api/src/config.js";
const checks: [string, string][] = [
  ["HelixDB", config.helix + "/readyz"],
  ["DuckDB executor", config.executor + "/health"],
  ["Local model", config.modelEndpoint.replace(/\/$/, "") + "/models"],
];
let errors = 0;
for (const [name, url] of checks) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    console.log("✓ " + name + " available");
  } catch (e) {
    errors++;
    console.log("✗ " + name + ": " + (e as Error).message);
  }
}
if (config.encryptionKey.length < 32 || config.internalKey.length < 32) {
  errors++;
  console.log("✗ Secrets missing: run scripts/setup.sh");
}
process.exitCode = errors ? 1 : 0;
