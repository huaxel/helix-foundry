import { request } from "node:http";
import { config } from "./config.js";
import type { Execution } from "../../../services/executor/src/engine.js";
import type { DatasetProfile } from "../../../packages/shared/src/index.js";
import { AppError } from "./security.js";
export async function execute(job: Execution): Promise<{
  profile: DatasetProfile;
  version: string;
  rows: Record<string, any>[];
  partitions?: { key: string; file: string; rows: number; size: number }[];
}> {
  const { statusCode, body } = await new Promise<{
    statusCode: number;
    body: any;
  }>((resolve, reject) => {
    const req = request(
      config.executor + "/execute",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-key": config.internalKey,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > 10_000_000) {
            req.destroy(new Error("Executor response exceeded 10 MB"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode || 502,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new Error("Executor request timed out")),
      config.executorTimeoutMs + 30_000,
    );
    req.on("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.end(JSON.stringify(job));
  });
  if (statusCode < 200 || statusCode >= 300)
    throw new AppError(422, body.error || "Dataset execution failed");
  return body;
}
