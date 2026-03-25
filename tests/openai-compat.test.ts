import { describe, expect, it } from "vitest";

import {
  buildChatCompletionResponse,
  parseChatCompletionsRequest,
  streamChatCompletionChunks,
  toGatewayConversationContext,
} from "@local-ai-gateway/openai-compat";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";

describe("openai compat", () => {
  it("parses chat completions payloads into gateway context", () => {
    const request = parseChatCompletionsRequest({
      model: "codex-default",
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        },
      ],
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What is the weather in Shanghai?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: "{\"city\":\"Shanghai\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "Sunny",
        },
      ],
    });

    const context = toGatewayConversationContext(request);

    expect(context.systemPrompt).toBe("You are helpful.");
    expect(context.messages).toHaveLength(3);
    expect(context.messages[1]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_1",
          name: "lookup_weather",
        },
      ],
    });
    expect(context.tools?.[0]?.name).toBe("lookup_weather");
  });

  it("builds openai-compatible responses and stream chunks", async () => {
    const message: AssistantMessage = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      timestamp: Date.now(),
      stopReason: "toolUse",
      usage: {
        input: 10,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 22,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      content: [
        { type: "text", text: "Calling tool..." },
        {
          type: "toolCall",
          id: "call_1",
          name: "lookup_weather",
          arguments: { city: "Shanghai" },
        },
      ],
    };

    const response = buildChatCompletionResponse(message, "codex-default");
    expect(response.choices[0]?.finish_reason).toBe("tool_calls");
    expect(response.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("lookup_weather");

    async function* makeEvents(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "start", partial: message };
      yield { type: "text_delta", contentIndex: 0, delta: "Calling tool...", partial: message };
      yield {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "call_1",
          name: "lookup_weather",
          arguments: { city: "Shanghai" },
        },
        partial: message,
      };
      yield { type: "done", reason: "toolUse", message };
    }

    const chunks = [];
    for await (const chunk of streamChatCompletionChunks(makeEvents(), "codex-default")) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.includes("\"role\":\"assistant\""))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("\"lookup_weather\""))).toBe(true);
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
  });
});

