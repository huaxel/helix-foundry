import { it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Provider } from "../apps/api/src/providers.js";
import { ProviderSchema } from "../packages/shared/src/index.js";
afterEach(() => vi.unstubAllGlobals());
for (const provider of ["local", "claude", "openai"] as const)
  it(`uses the native ${provider} protocol without fallbacks`, async () => {
    const requests: any[] = [];
    // The local provider talks to Ollama over node:http, not fetch.
    const ollama = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({
        url: req.url,
        body: JSON.parse(body),
        headers: req.headers,
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          message: { content: '{"ready":true}' },
          prompt_eval_count: 2,
          eval_count: 3,
          done_reason: "stop",
        }),
      );
    });
    ollama.listen(0, "127.0.0.1");
    await once(ollama, "listening");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requests.push({
          url,
          body: JSON.parse(init.body),
          headers: init.headers,
        });
        return Response.json(
          provider === "local"
            ? {
                message: { content: '{"ready":true}' },
                prompt_eval_count: 2,
                eval_count: 3,
              }
            : provider === "claude"
              ? {
                  content: [
                    {
                      type: "tool_use",
                      name: "submit",
                      input: { ready: true },
                    },
                  ],
                  usage: { input_tokens: 2, output_tokens: 3 },
                }
              : {
                  output: [
                    {
                      content: [
                        { type: "output_text", text: '{"ready":true}' },
                      ],
                    },
                  ],
                  usage: { total_tokens: 5 },
                },
        );
      }),
    );
    const p = new Provider(
      ProviderSchema.parse({
        provider,
        ...(provider === "local" ? { localApi: "ollama" as const } : {}),
        model: "test",
        apiKey: "test-only",
        baseUrl: "http://127.0.0.1:" + (ollama.address() as any).port,
      }),
    );
    const r = await p.generate(
      "system",
      { safe: "profile" },
      {
        type: "object",
        properties: { ready: { type: "boolean" } },
        required: ["ready"],
        additionalProperties: false,
      },
    );
    expect(r).toEqual({ value: { ready: true }, tokens: 5 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain(
      provider === "local"
        ? "/api/chat"
        : provider === "claude"
          ? "/v1/messages"
          : "/v1/responses",
    );
    if (provider === "openai") {
      expect(requests[0].body.store).toBe(false);
      expect(requests[0].body.text.format.strict).toBe(true);
    }
    if (provider === "local")
      expect(requests[0].body.options).toEqual({
        temperature: 0,
        num_ctx: 8192,
        num_predict: expect.any(Number),
      });
    ollama.close();
  });
it("uses llama.cpp through its OpenAI-compatible endpoint without Ollama calls", async () => {
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8080/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer local-secret",
      );
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen-local");
      expect(body.response_format.json_schema.schema.type).toBe("object");
      return Response.json({
        choices: [{ message: { content: '{"ready":true}' } }],
        usage: { total_tokens: 7 },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const provider = new Provider(
    ProviderSchema.parse({
      provider: "local",
      localApi: "openai-compatible",
      model: "qwen-local",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "local-secret",
    }),
  );
  const result = await provider.generate(
    "system",
    { safe: "profile" },
    {
      type: "object",
      properties: { ready: { type: "boolean" } },
      required: ["ready"],
    },
  );
  expect(result).toEqual({ value: { ready: true }, tokens: 7 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("requires a base URL for the OpenAI-compatible local backend", () => {
  expect(() =>
    ProviderSchema.parse({
      provider: "local",
      localApi: "openai-compatible",
      model: "qwen-local",
    }),
  ).toThrow("Endpoint URL is required");
});
it("rejects URL credentials and non-HTTP schemes for llama.cpp", () => {
  for (const baseUrl of [
    "file:///tmp/model",
    "http://user:pass@localhost:8080/v1",
  ])
    expect(() =>
      ProviderSchema.parse({
        provider: "local",
        localApi: "openai-compatible",
        model: "qwen-local",
        baseUrl,
      }),
    ).toThrow();
});
it("sizes the local context window to the prompt and refuses what cannot fit", async () => {
  const seen: number[] = [];
  const ollama = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const options = JSON.parse(body).options;
    seen.push(options.num_ctx);
    res.end(
      JSON.stringify({
        message: { content: '{"ready":true}' },
        prompt_eval_count: 1,
        eval_count: 1,
        done_reason: options.num_ctx === 16384 ? "length" : "stop",
      }),
    );
  });
  ollama.listen(0, "127.0.0.1");
  await once(ollama, "listening");
  const p = new Provider(
    ProviderSchema.parse({
      provider: "local",
      localApi: "ollama",
      model: "test",
      baseUrl: "http://127.0.0.1:" + (ollama.address() as any).port,
    }),
  );
  try {
    await expect(
      p.generate("", { data: "x".repeat(20_000) }, {}),
    ).rejects.toThrow("ran out of room");
    expect(seen).toEqual([16384]);
    await expect(
      p.generate("", { data: "x".repeat(200_000) }, {}),
    ).rejects.toThrow("Too much data for the local model");
    expect(seen).toHaveLength(1);
  } finally {
    ollama.close();
  }
});
it("reports provider outage without contacting another provider", async () => {
  const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    new Provider(
      ProviderSchema.parse({
        provider: "openai",
        model: "test",
        apiKey: "test",
      }),
    ).generate("", {}, {}),
  ).rejects.toThrow("HTTP 503");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
