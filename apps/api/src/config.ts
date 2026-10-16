import "dotenv/config";
import { resolve } from "node:path";
export const config = {
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || "127.0.0.1",
  // There is no sign-in, so listening beyond this computer must be explicit
  // (e.g. inside a container whose port is published only on loopback).
  allowNetwork: process.env.ALLOW_NETWORK_ACCESS === "true",
  origin: process.env.APP_ORIGIN || "http://localhost:5173",
  helix: process.env.HELIX_URL || "http://127.0.0.1:6969",
  executor: process.env.EXECUTOR_URL || "http://127.0.0.1:3002",
  executorTimeoutMs: Number(process.env.EXECUTOR_TIMEOUT_MS) || 900_000,
  internalKey: process.env.INTERNAL_KEY || "",
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  dataDir: resolve(process.env.DATA_DIR || ".data"),
  inlineWorker: process.env.INLINE_WORKER !== "false",
  modelEndpoint: process.env.MODEL_ENDPOINT || "http://framearch-juan:8000/v1",
  ollama: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  // Read-only root for the local Parquet connector. Inside Docker this must
  // match the mount in compose.yaml.
  localDataPath: process.env.LOCAL_DATA_PATH || "/mnt/parquet",
  localDataInclude: process.env.LOCAL_DATA_INCLUDE || "**/*.parquet",
  // Requests per minute per IP; local acceptance runs raise it.
  rateLimit: Number(process.env.RATE_LIMIT_MAX) || 240,
  // Bytes in one transaction's HelixDB write, below HelixDB's request limit.
  helixWriteLimit: Number(process.env.HELIX_WRITE_LIMIT) || 1_500_000,
  // Password for browser/API access over a network (e.g. Tailscale). When
  // set, every API route requires a password session or a workspace token;
  // when unset, loopback requests act as the local owner (no sign-in).
  authPassword: process.env.AUTH_PASSWORD || "",
  requireAuth: (process.env.AUTH_PASSWORD || "").length > 0,
};
export function requireSecrets() {
  if (config.encryptionKey.length < 32 || config.internalKey.length < 32)
    throw new Error(
      "Run ./scripts/setup.sh to generate ENCRYPTION_KEY and INTERNAL_KEY (32+ characters).",
    );
  if (config.authPassword && config.authPassword.length < 8)
    throw new Error("AUTH_PASSWORD must be at least 8 characters when set.");
  // Fail closed: a non-loopback origin means the deployment intends network
  // access, so password auth must be on. Loopback origins keep the no-sign-in
  // owner behavior for local use.
  let originHost = "";
  try {
    originHost = new URL(config.origin).hostname;
  } catch {
    originHost = "";
  }
  const originLoopback =
    originHost === "localhost" ||
    originHost.endsWith(".localhost") ||
    originHost === "127.0.0.1" ||
    originHost === "::1" ||
    originHost === "[::1]";
  if (!originLoopback && !config.requireAuth)
    throw new Error(
      `Refusing to serve non-loopback origin ${config.origin} without AUTH_PASSWORD. Set a password or use a loopback origin.`,
    );
}
