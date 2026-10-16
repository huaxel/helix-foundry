// A job's scratch directory is removed when the job ends, but a SIGKILL (the
// executor's timeout, or a container restart) skips that path, so dead
// `executor-*` directories accumulate. Nothing is running when the server
// boots, so the directories present then are stale — but they are only removed
// once they are older than one job timeout, which keeps a second executor
// sharing the same volume from deleting a live job's scratch.
import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const SCRATCH_PREFIX = "executor-";

export async function sweepScratch(
  root: string,
  graceMs: number,
  now = Date.now(),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return []; // no scratch directory yet
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = resolve(root, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory() || now - info.mtimeMs < graceMs) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* already gone, or not ours to remove */
    }
  }
  return removed;
}