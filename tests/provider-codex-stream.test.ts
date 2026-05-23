import { afterEach, describe, expect, it, vi } from "vitest";

import { streamLocalOpenAICodexResponses } from "../packages/provider-codex/src/codex-stream.ts";

function makeCodexToken() {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function makeSseResponse() {
  const frames = [
    {
      type: "response.created",
      response: { id: "resp_test" },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");

  return new Response(frames, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Codex Responses stream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes long replayed tool call IDs before sending official Responses input", async () => {
    const rawCallId = `call_${"z".repeat(90)}`;
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return makeSseResponse();
      }),
    );

    const stream = streamLocalOpenAICodexResponses(
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      } as never,
      {
        systemPrompt: "You are helpful.",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `${rawCallId}|fc_${"i".repeat(80)}`,
                name: "lookup_weather",
                arguments: { city: "Shanghai" },
              },
            ],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.5",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: `${rawCallId}|fc_${"i".repeat(80)}`,
            toolName: "lookup_weather",
            content: [{ type: "text", text: "Sunny" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
        tools: [],
      } as never,
      {
        apiKey: makeCodexToken(),
        sessionId: "test-session",
        textVerbosity: "medium",
        reasoningEffort: "medium",
      },
    );

    await stream.result();
    const input = requestBody?.input as Array<Record<string, unknown>>;
    const call = input.find((item) => item.type === "function_call");
    const output = input.find((item) => item.type === "function_call_output");

    expect(call?.call_id).toBeTruthy();
    expect(String(call?.call_id).length).toBeLessThanOrEqual(64);
    expect(output?.call_id).toBe(call?.call_id);
  });
});
