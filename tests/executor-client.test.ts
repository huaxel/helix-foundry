import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { afterEach, expect, it } from "vitest";
import { config } from "../apps/api/src/config.js";
import { execute } from "../apps/api/src/executor.js";

const previous = {
  executor: config.executor,
  executorTimeoutMs: config.executorTimeoutMs,
  internalKey: config.internalKey,
};
let server: Server | undefined;

afterEach(async () => {
  config.executor = previous.executor;
  config.executorTimeoutMs = previous.executorTimeoutMs;
  config.internalKey = previous.internalKey;
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  server = undefined;
});

it("accepts delayed executor responses and sends the internal job payload", async () => {
  let requestBody = "";
  let authHeader = "";
  server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => (requestBody += chunk));
    request.on("end", () => {
      authHeader = String(request.headers["x-internal-key"] || "");
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            profile: {
              rows: 0,
              duplicateRows: 0,
              columns: [],
              sample: [],
              fingerprint: "fixture",
            },
            version: "v1",
            rows: [],
          }),
        );
      }, 150);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  config.executor = `http://127.0.0.1:${address.port}`;
  config.executorTimeoutMs = 1_000;
  config.internalKey = "test-key-".repeat(8);
  const job = {
    mode: "query" as const,
    scope: "workspace",
    version: "v1",
    inputs: [],
    sql: "SELECT 1",
  };

  const result = await execute(job);

  expect(authHeader).toBe(config.internalKey);
  expect(JSON.parse(requestBody)).toEqual(job);
  expect(result.version).toBe("v1");
});
