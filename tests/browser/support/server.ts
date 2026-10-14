// Dedicated acceptance installation. Never connects to the user's HelixDB or account store.
import { rm, mkdir } from "node:fs/promises";
import { dataDir, ports } from "./ports.js";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = dataDir;
process.env.APP_ORIGIN = `http://localhost:${ports.web}`;
process.env.EXECUTOR_URL = `http://127.0.0.1:${ports.executor}`;
process.env.INTERNAL_KEY = "acceptance-executor-key-not-for-production";
// config.ts loads the repo root .env via dotenv, which carries the real
// install's AUTH_PASSWORD and LOCAL_DATA_PATH. Clear the password so the
// acceptance stack stays in loopback-owner mode (no sign-in), like
// NODE_ENV=test suites do, and point the lake at an empty dir so the
// worker's local-source auto-import does not flood the test store with the
// user's real Parquet files (each one churns the onboarding signature and
// starves the suggest job forever).
process.env.AUTH_PASSWORD ||= "";
process.env.LOCAL_DATA_PATH ||= dataDir + "/lake";
process.env.ENCRYPTION_KEY = "acceptance-encryption-key-not-for-production";
process.env.OLLAMA_URL = `http://127.0.0.1:${ports.api}/fixture`;
// Every spec shares one IP; polling helpers would exhaust the default budget.
process.env.RATE_LIMIT_MAX ||= "100000";
const { createApp } = await import("../../../apps/api/src/app.js");
const { MemoryStore } = await import("../../../apps/api/src/store.js");
const { startWorker } = await import("../../../apps/api/src/jobs.js");
const { referenceReply, orderRows } = await import(
  "../../fixtures-reference.js"
);
await rm(process.env.DATA_DIR, { recursive: true, force: true });
await mkdir(process.env.DATA_DIR, { recursive: true });
await mkdir(process.env.LOCAL_DATA_PATH as string, { recursive: true });
const store = new MemoryStore();
const app = await createApp(store);
app.get("/fixture/api/tags", async () => ({
  models: [
    {
      name: "qwen3:4b",
      digest:
        "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7",
    },
  ],
}));
app.post("/fixture/api/chat", async (req: any) => {
  const messages = req.body.messages;
  return {
    message: {
      content: JSON.stringify(
        referenceReply(messages[0].content, JSON.parse(messages[1].content)),
      ),
    },
    prompt_eval_count: 10,
    eval_count: 10,
  };
});
app.get("/fixture/orders", async (req: any) => {
  const offset = Number(req.query.offset || 0),
    limit = Number(req.query.limit || 2);
  return orderRows.slice(offset, offset + limit);
});
await app.listen({ port: ports.api, host: "127.0.0.1" });
const stop = startWorker(store);
process.on("SIGTERM", async () => {
  stop();
  await app.close();
  process.exit(0);
});
