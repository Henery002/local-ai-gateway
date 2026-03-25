import { randomUUID } from "node:crypto";

import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import { z } from "zod";

import {
  DEFAULT_MODEL_ALIAS,
  GatewayConversationContext,
  GatewayError,
  GatewayModelDefinition,
  GatewayToolDefinition,
} from "@local-ai-gateway/shared";

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const functionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional().default(""),
    parameters: z.record(z.string(), z.unknown()).default({}),
  }),
});

const assistantToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().default("{}"),
  }),
});

const systemOrUserMessageSchema = z.object({
  role: z.enum(["system", "user"]),
  content: z.union([z.string(), z.array(textPartSchema)]),
});

const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.union([z.string(), z.null(), z.array(textPartSchema)]).optional(),
  tool_calls: z.array(assistantToolCallSchema).optional(),
});

const toolMessageSchema = z.object({
  role: z.literal("tool"),
  tool_call_id: z.string().min(1),
  content: z.union([z.string(), z.array(textPartSchema)]),
});

export const chatCompletionsRequestSchema = z.object({
  model: z.string().min(1).default(DEFAULT_MODEL_ALIAS),
  messages: z.array(
    z.union([systemOrUserMessageSchema, assistantMessageSchema, toolMessageSchema]),
  ),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().optional(),
  tool_choice: z
    .union([
      z.literal("auto"),
      z.literal("none"),
      z.literal("required"),
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string().min(1),
        }),
      }),
    ])
    .optional(),
  tools: z.array(functionToolSchema).optional(),
});

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;

function flattenContent(content: string | null | Array<{ type: "text"; text: string }>): string {
  if (content === null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content.map((part) => part.text).join("");
}

function mapTools(
  tools: ChatCompletionsRequest["tools"] | undefined,
): GatewayToolDefinition[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters,
  }));
}

export function parseChatCompletionsRequest(input: unknown): ChatCompletionsRequest {
  const parsed = chatCompletionsRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new GatewayError(400, "invalid_request", parsed.error.message);
  }
  return parsed.data;
}

export function toGatewayConversationContext(
  request: ChatCompletionsRequest,
): GatewayConversationContext {
  const systemParts: string[] = [];
  const messages: GatewayConversationContext["messages"] = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      systemParts.push(flattenContent(message.content));
      continue;
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: flattenContent(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: flattenContent(message.content ?? ""),
        toolCalls: message.tool_calls?.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
      });
      continue;
    }

    if (message.role === "tool") {
      messages.push({
        role: "tool",
        toolCallId: message.tool_call_id,
        content: flattenContent(message.content),
      });
    }
  }

  return {
    systemPrompt: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages,
    tools: mapTools(request.tools),
  };
}

export function buildModelsResponse(models: GatewayModelDefinition[]) {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.alias,
      object: "model",
      owned_by: model.provider,
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
    })),
  };
}

function mapFinishReason(reason: AssistantMessage["stopReason"]): "stop" | "length" | "tool_calls" {
  if (reason === "toolUse") {
    return "tool_calls";
  }

  if (reason === "length") {
    return "length";
  }

  return "stop";
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractToolCalls(message: AssistantMessage) {
  return message.content
    .filter((part) => part.type === "toolCall")
    .map((part) => ({
      id: part.id,
      type: "function" as const,
      function: {
        name: part.name,
        arguments: JSON.stringify(part.arguments),
      },
    }));
}

function buildChatCompletionId(): string {
  return `chatcmpl_${randomUUID().replace(/-/g, "")}`;
}

export function buildChatCompletionResponse(
  message: AssistantMessage,
  requestedModel: string,
) {
  return {
    id: buildChatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: extractText(message) || null,
          ...(extractToolCalls(message).length > 0
            ? { tool_calls: extractToolCalls(message) }
            : {}),
        },
        finish_reason: mapFinishReason(message.stopReason),
      },
    ],
    usage: {
      prompt_tokens: message.usage.input,
      completion_tokens: message.usage.output,
      total_tokens: message.usage.totalTokens,
    },
  };
}

function buildStreamChunkBase(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

export async function* streamChatCompletionChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  requestedModel: string,
): AsyncGenerator<string> {
  const id = buildChatCompletionId();
  let sentRole = false;
  let toolIndex = 0;

  for await (const event of events) {
    if (!sentRole && (event.type === "start" || event.type === "text_delta" || event.type === "toolcall_end")) {
      sentRole = true;
      yield serializeSse({
        ...buildStreamChunkBase(id, requestedModel),
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
            },
            finish_reason: null,
          },
        ],
      });
    }

    if (event.type === "text_delta") {
      yield serializeSse({
        ...buildStreamChunkBase(id, requestedModel),
        choices: [
          {
            index: 0,
            delta: {
              content: event.delta,
            },
            finish_reason: null,
          },
        ],
      });
      continue;
    }

    if (event.type === "toolcall_end") {
      yield serializeSse({
        ...buildStreamChunkBase(id, requestedModel),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolIndex,
                  id: event.toolCall.id,
                  type: "function",
                  function: {
                    name: event.toolCall.name,
                    arguments: JSON.stringify(event.toolCall.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      toolIndex += 1;
      continue;
    }

    if (event.type === "done") {
      yield serializeSse({
        ...buildStreamChunkBase(id, requestedModel),
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mapFinishReason(event.message.stopReason),
          },
        ],
      });
      continue;
    }

    if (event.type === "error") {
      throw new GatewayError(
        502,
        "upstream_error",
        event.error.errorMessage ?? "Upstream streaming request failed.",
      );
    }
  }

  yield "data: [DONE]\n\n";
}

export function serializeSse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
