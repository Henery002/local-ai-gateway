import { describe, expect, it } from "vitest";

import {
  buildResponsesApiResponseFromChatCompletion,
  buildChatCompletionResponse,
  buildModelsResponse,
  chatCompletionSseToResponsesApiSse,
  parseChatCompletionsRequest,
  streamChatCompletionChunks,
  toChatCompletionsRequestFromResponsesApi,
  toGatewayConversationContext,
} from "@local-ai-gateway/openai-compat";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";

describe("openai compat", () => {
  it("builds model lists for OpenAI clients and Codex Desktop", () => {
    const response = buildModelsResponse([
      {
        alias: "codex-5.4",
        displayName: "Codex 5.4",
        provider: "openai-codex",
        providerModelId: "gpt-5.4",
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        input: ["text"],
        reasoning: true,
      },
    ]);

    expect(response.data[0]).toMatchObject({
      id: "codex-5.4",
      object: "model",
      owned_by: "openai-codex",
    });
    expect(response.models[0]).toMatchObject({
      slug: "codex-5.4",
      display_name: "Codex 5.4",
      visibility: "list",
      default_reasoning_level: "medium",
      prefer_websockets: false,
    });
  });

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

  it("converts chat completion SSE into Codex-compatible Responses SSE events", () => {
    const chatSse = [
      `data: ${JSON.stringify({
        choices: [{ delta: { role: "assistant" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "OK" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup_weather", arguments: "{\"city\":\"Shanghai\"}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const responsesSse = chatCompletionSseToResponsesApiSse(chatSse, "gpt-5.5");
    const events = responsesSse
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => {
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        return JSON.parse(dataLine?.slice("data: ".length) ?? "{}");
      });

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const delta = events.find((event) => event.type === "response.output_text.delta");
    const done = events.find(
      (event) => event.type === "response.output_item.done" && event.item?.type === "message",
    );
    expect(delta.item_id).toBe(done.item.id);
    expect(delta.response_id).toBeUndefined();
    expect(events.at(-1).response).toMatchObject({
      status: "completed",
      model: "gpt-5.5",
      output_text: "OK",
    });
  });

  it("normalizes long Responses call IDs when converting to Chat Completions", () => {
    const rawCallId = `call_${"x".repeat(90)}`;
    const request = toChatCompletionsRequestFromResponsesApi({
      model: "gpt-5.5",
      input: [
        { role: "user", content: "Use the tool" },
        {
          type: "function_call",
          call_id: rawCallId,
          name: "lookup_weather",
          arguments: { city: "Shanghai" },
        },
        {
          type: "function_call_output",
          call_id: rawCallId,
          output: "Sunny",
        },
      ],
      stream: false,
    });

    const assistant = request.messages.find((message) => message.role === "assistant");
    const tool = request.messages.find((message) => message.role === "tool");
    const normalized = assistant?.role === "assistant" ? assistant.tool_calls?.[0]?.id : undefined;

    expect(normalized).toBeTruthy();
    expect(normalized?.length).toBeLessThanOrEqual(64);
    expect(tool?.role === "tool" ? tool.tool_call_id : undefined).toBe(normalized);
  });

  it("normalizes long Chat Completions tool IDs when building Responses output", () => {
    const rawCallId = `call_${"y".repeat(90)}`;
    const response = buildResponsesApiResponseFromChatCompletion({
      model: "gpt-5.5",
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: rawCallId,
                type: "function",
                function: { name: "lookup_weather", arguments: "{}" },
              },
            ],
          },
        },
      ],
      usage: {},
    });
    const call = response.output.find((item) => item.type === "function_call");

    expect(call?.id.length).toBeLessThanOrEqual(64);
    expect(call?.call_id.length).toBeLessThanOrEqual(64);
    expect(call?.id).toBe(call?.call_id);
  });
});
