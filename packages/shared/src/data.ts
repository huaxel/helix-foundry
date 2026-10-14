// Area schemas for Data Connection: sources, syncs, datasets, data health.
// Owned by the data area. Import values only from "zod" (or other area modules):
// index.ts re-exports this file, so a value import from "./index.js" would be circular.
// Type-only imports from "./index.js" are fine.
import { z } from "zod";

export const sourceKinds = [
  "upload",
  "postgres",
  "mysql",
  "rest",
  "s3",
  "stripe",
  "workos",
  "posthog",
  "local",
] as const;
export const SourceSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(sourceKinds),
  config: z.record(z.string(), z.unknown()).default({}),
  schedule: z
    .string()
    .nullable()
    .optional()
    .describe(
      "UTC snapshot fallback schedule. Working PostgreSQL/MySQL CDC takes precedence; defaults to every five minutes when CDC is unavailable, hourly for Stripe and WorkOS, and every six hours for PostHog.",
    ),
  // Nullable so an update can CLEAR a previously set column (explicit null);
  // omitted keeps the stored value. Every reader treats null like unset.
  partitionColumn: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe(
      "Optional column to partition the imported snapshot by. When set, the dataset is stored as one Parquet per distinct value of this column so queries can prune to the partitions they touch. Choose a low-cardinality column (e.g. region, month).",
    ),
});
export type SourceSyncState = {
  mode: "auto" | "cdc" | "snapshot";
  status: "checking" | "starting" | "live" | "retrying" | "ready";
  reason?: string | null;
  lastEvent?: string;
  changes?: number;
  applied?: number;
};
