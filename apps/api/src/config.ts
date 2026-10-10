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
};
export function requireSecrets() {
  if (config.encryptionKey.length < 32 || config.internalKey.length < 32)
    throw new Error(
      "Run ./scripts/setup.sh to generate ENCRYPTION_KEY and INTERNAL_KEY (32+ characters).",
    );
}
