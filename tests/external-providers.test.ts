import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { OllamaAdapter } from "../packages/provider-ollama/src/index.js";
import { OpenAICompatibleAdapter } from "../packages/provider-openai-compatible/src/index.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

function startJsonServer(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);

  return new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind test server."));
        return;
      }

      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("external providers", () => {
  it("streams OpenAI-compatible text and tool calls", async () => {
    const baseUrl = await startJsonServer((request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
      });
      response.write("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n");
      response.write("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n");
      response.write("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup_weather\",\"arguments\":\"{\\\"city\\\":\"}}]},\"finish_reason\":null}]}\n\n");
      response.write("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Shanghai\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":5,\"total_tokens\":16,\"prompt_tokens_details\":{\"cached_tokens\":3},\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\n\n");
      response.write("data: [DONE]\n\n");
      response.end();
    });

    const adapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "sk-test",
    });

    const result = await adapter.createStream(
      {
        alias: "openai-compatible-default",
        displayName: "OpenAI-Compatible Default",
        provider: "openai-compatible",
        providerModelId: "gpt-4.1-mini",
        contextWindow: 128_000,
        maxTokens: 16_384,
        input: ["text"],
        reasoning: false,
      },
      {
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "lookup_weather",
            description: "weather lookup",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          },
        ],
      },
    );

    const events: string[] = [];
    for await (const event of result.stream) {
      events.push(event.type);
    }

    const finalMessage = await result.stream.result();
    expect(events).toContain("text_delta");
    expect(events).toContain("toolcall_end");
    expect(finalMessage.stopReason).toBe("toolUse");
    expect(finalMessage.usage.totalTokens).toBe(16);
    expect(finalMessage.usage.input).toBe(8);
    expect(finalMessage.usage.cacheRead).toBe(3);
    expect((finalMessage.usage as Record<string, unknown>).reasoningOutputTokens).toBe(2);
  });

  it("streams Ollama responses", async () => {
    const baseUrl = await startJsonServer((request, response) => {
      if (request.url !== "/api/chat") {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, {
        "content-type": "application/x-ndjson",
      });
      response.write("{\"message\":{\"role\":\"assistant\",\"content\":\"Hi\"},\"done\":false}\n");
      response.write("{\"message\":{\"role\":\"assistant\",\"tool_calls\":[{\"function\":{\"name\":\"local_lookup\",\"arguments\":{\"city\":\"Shanghai\"}}}]},\"done\":false}\n");
      response.write("{\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":4}\n");
      response.end();
    });

    const adapter = new OllamaAdapter({
      baseUrl,
    });

    const result = await adapter.createStream(
      {
        alias: "ollama-default",
        displayName: "Ollama Default",
        provider: "ollama",
        providerModelId: "qwen2.5-coder:7b",
        contextWindow: 32_768,
        maxTokens: 8_192,
        input: ["text"],
        reasoning: false,
      },
      {
        messages: [{ role: "user", content: "hello" }],
      },
    );

    const events: string[] = [];
    for await (const event of result.stream) {
      events.push(event.type);
    }

    const finalMessage = await result.stream.result();
    expect(events).toContain("text_delta");
    expect(events).toContain("toolcall_end");
    expect(finalMessage.usage.totalTokens).toBe(13);
  });
});
