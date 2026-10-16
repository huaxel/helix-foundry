import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepScratch, SCRATCH_PREFIX } from "../services/executor/src/scratch.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scratch-sweep-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// An entry `ageMs` old, holding one file so a recursive remove is visible.
async function entry(name: string, ageMs: number) {
  const path = join(root, name);
  await mkdir(path);
  await writeFile(join(path, "spill.tmp"), "x");
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

it("removes only stale executor scratch directories", async () => {
  const hour = 3_600_000;
  await entry(SCRATCH_PREFIX + "stale", 2 * hour);
  await entry(SCRATCH_PREFIX + "fresh", 1000); // a job may still own this one
  await mkdir(join(root, "datasets")); // unrelated data is never touched
  await writeFile(join(root, "keep.txt"), "keep");

  const removed = await sweepScratch(root, hour);
  expect(removed).toEqual([SCRATCH_PREFIX + "stale"]);
  const left = (await readdir(root)).sort();
  expect(left).toEqual([SCRATCH_PREFIX + "fresh", "datasets", "keep.txt"].sort());
});

it("is a no-op when there is no scratch directory yet", async () => {
  await expect(sweepScratch(join(root, "absent"), 1000)).resolves.toEqual([]);
});