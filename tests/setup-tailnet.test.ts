import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("enables the tailnet overlay when credentials are configured in .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-setup-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "setup.sh"), readFileSync("scripts/setup.sh"));
  writeFileSync(join(dir, ".env"), "AUTH_PASSWORD=not-a-real-secret\nTAILSCALE_IP=100.64.0.1\n");
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$DOCKER_ARGS_FILE\"\n", { mode: 0o755 });

  const result = spawnSync("bash", ["scripts/setup.sh", "--compose"], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DOCKER_ARGS_FILE: join(dir, "docker-args"),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(readFileSync(join(dir, "docker-args"), "utf8")).toContain(
    "-f compose.yaml -f compose.tailnet.yaml up -d --build",
  );
});
