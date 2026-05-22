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

export const responsesApiRequestSchema = z
  .object({
    model: z.string().min(1).default(DEFAULT_MODEL_ALIAS),
    input: z.union([z.string(), z.array(z.unknown())]).default(""),
    instructions: z.string().optional(),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    top_p: z.number().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough();

export type ResponsesApiRequest = z.infer<typeof responsesApiRequestSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function parseResponsesApiRequest(input: unknown): ResponsesApiRequest {
  const parsed = responsesApiRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new GatewayError(400, "invalid_request", parsed.error.message);
  }
  return parsed.data;
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "{}";
  }
  return JSON.stringify(value);
}

function extractResponsesText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item)) {
          const text = item.text ?? item.output ?? item.content;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  if (isRecord(value)) {
    const text = value.text ?? value.output ?? value.content;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function toChatCompletionTools(
  tools: ResponsesApiRequest["tools"],
): ChatCompletionsRequest["tools"] {
  const mapped = (tools ?? [])
    .map((tool) => {
      if (!isRecord(tool) || tool.type !== "function") {
        return undefined;
      }

      const nested = isRecord(tool.function) ? tool.function : undefined;
      const name = typeof tool.name === "string" ? tool.name : nested?.name;
      if (typeof name !== "string" || !name.trim()) {
        return undefined;
      }

      const description =
        typeof tool.description === "string"
          ? tool.description
          : typeof nested?.description === "string"
            ? nested.description
            : "";
      const parameters = isRecord(tool.parameters)
        ? tool.parameters
        : isRecord(nested?.parameters)
          ? nested.parameters
          : {};

      return {
        type: "function" as const,
        function: {
          name,
          description,
          parameters,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return mapped.length ? mapped : undefined;
}

function toChatCompletionToolChoice(
  toolChoice: ResponsesApiRequest["tool_choice"],
): ChatCompletionsRequest["tool_choice"] {
  if (
    toolChoice === "auto" ||
    toolChoice === "none" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  if (isRecord(toolChoice) && toolChoice.type === "function") {
    const name =
      typeof toolChoice.name === "string"
        ? toolChoice.name
        : isRecord(toolChoice.function) && typeof toolChoice.function.name === "string"
          ? toolChoice.function.name
          : undefined;
    if (name) {
      return {
        type: "function",
        function: { name },
      };
    }
  }
  return undefined;
}

export function toChatCompletionsRequestFromResponsesApi(
  request: ResponsesApiRequest,
): ChatCompletionsRequest {
  const messages: ChatCompletionsRequest["messages"] = [];
  const systemParts: string[] = [];

  if (request.instructions?.trim()) {
    systemParts.push(request.instructions);
  }

  if (typeof request.input === "string") {
    messages.push({ role: "user", content: request.input });
  } else {
    request.input.forEach((item, index) => {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        return;
      }
      if (!isRecord(item)) {
        return;
      }

      const type = typeof item.type === "string" ? item.type : undefined;
      const role = typeof item.role === "string" ? item.role : undefined;
      if (role === "system" || role === "developer") {
        const content = extractResponsesText(item.content);
        if (content) {
          systemParts.push(content);
        }
        return;
      }

      if (type === "function_call_output" || role === "tool") {
        const toolCallId =
          typeof item.call_id === "string"
            ? item.call_id
            : typeof item.tool_call_id === "string"
              ? item.tool_call_id
              : `call_${index}`;
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: extractResponsesText(item.output ?? item.content),
        });
        return;
      }

      if (type === "function_call") {
        const toolCallId =
          typeof item.call_id === "string"
            ? item.call_id
            : typeof item.id === "string"
              ? item.id
              : `call_${index}`;
        const name = typeof item.name === "string" ? item.name : "unknown_tool";
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name,
                arguments: stringifyToolArguments(item.arguments),
              },
            },
          ],
        });
        return;
      }

      if (role === "assistant") {
        messages.push({
          role: "assistant",
          content: extractResponsesText(item.content),
        });
        return;
      }

      messages.push({
        role: "user",
        content: extractResponsesText(item.content ?? item),
      });
    });
  }

  if (systemParts.length) {
    messages.unshift({
      role: "system",
      content: systemParts.join("\n\n"),
    });
  }

  return {
    model: request.model,
    messages,
    stream: request.stream,
    temperature: request.temperature,
    max_tokens: request.max_output_tokens,
    top_p: request.top_p,
    tools: toChatCompletionTools(request.tools),
    tool_choice: toChatCompletionToolChoice(request.tool_choice),
  };
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
  const supportedReasoningLevels = [
    {
      effort: "minimal",
      description: "Fastest responses with minimal reasoning",
    },
    {
      effort: "low",
      description: "Fast responses with lighter reasoning",
    },
    {
      effort: "medium",
      description: "Balances speed and reasoning depth for everyday tasks",
    },
    {
      effort: "high",
      description: "Greater reasoning depth for complex problems",
    },
    {
      effort: "xhigh",
      description: "Extra high reasoning depth for complex problems",
    },
  ];

  return {
    object: "list",
    data: models.map((model) => ({
      id: model.alias,
      object: "model",
      owned_by: model.provider,
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
    })),
    models: models.map((model) => ({
      slug: model.alias,
      display_name: model.displayName,
      description: model.displayName,
      default_reasoning_level: "medium",
      supported_reasoning_levels: supportedReasoningLevels,
      context_window: model.contextWindow,
      max_context_window: model.contextWindow,
      prefer_websockets: false,
      visibility: "list",
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

function buildResponseId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function normalizeChatCompletionMessage(input: unknown): {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
} {
  if (!isRecord(input)) {
    return { content: "", toolCalls: [] };
  }

  const content = typeof input.content === "string" ? input.content : "";
  const rawToolCalls = Array.isArray(input.tool_calls) ? input.tool_calls : [];
  const toolCalls = rawToolCalls
    .map((toolCall, index) => {
      if (!isRecord(toolCall)) {
        return undefined;
      }
      const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
      const name = typeof fn?.name === "string" ? fn.name : undefined;
      if (!name) {
        return undefined;
      }
      return {
        id:
          typeof toolCall.id === "string" && toolCall.id
            ? toolCall.id
            : `call_${index}`,
        name,
        arguments:
          typeof fn?.arguments === "string"
            ? fn.arguments
            : stringifyToolArguments(fn?.arguments),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return { content, toolCalls };
}

function buildResponsesOutputItems(input: {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  messageItemId?: string;
}) {
  const output = [];
  if (input.content) {
    output.push({
      id: input.messageItemId ?? buildResponseId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: input.content,
          annotations: [],
        },
      ],
    });
  }

  for (const toolCall of input.toolCalls) {
    output.push({
      id: toolCall.id,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
  }

  return output;
}

function normalizeChatCompletionUsage(input: unknown) {
  const usage = isRecord(input) ? input : {};
  const numberOrZero = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    input_tokens: numberOrZero(usage.prompt_tokens),
    output_tokens: numberOrZero(usage.completion_tokens),
    total_tokens: numberOrZero(usage.total_tokens),
    input_tokens_details: {
      cached_tokens: numberOrZero(
        isRecord(usage.prompt_tokens_details)
          ? usage.prompt_tokens_details.cached_tokens
          : undefined,
      ),
    },
    output_tokens_details: {
      reasoning_tokens: numberOrZero(
        isRecord(usage.completion_tokens_details)
          ? usage.completion_tokens_details.reasoning_tokens
          : undefined,
      ),
    },
  };
}

export function buildResponsesApiResponseFromChatCompletion(input: unknown) {
  if (!isRecord(input)) {
    throw new GatewayError(502, "invalid_upstream_response", "Invalid chat response body.");
  }
  const choice = Array.isArray(input.choices) ? input.choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const normalized = normalizeChatCompletionMessage(message);
  const output = buildResponsesOutputItems(normalized);
  const model = typeof input.model === "string" ? input.model : DEFAULT_MODEL_ALIAS;

  return {
    id: buildResponseId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: normalized.content,
    parallel_tool_calls: true,
    usage: normalizeChatCompletionUsage(input.usage),
  };
}

function parseChatCompletionSseFrames(body: string): unknown[] {
  return body
    .split(/\n\n+/)
    .flatMap((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length).trim()),
    )
    .filter((line) => line.length > 0 && line !== "[DONE]")
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
}

function serializeResponsesEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function buildResponsesStreamEnvelope(input: {
  responseId: string;
  model: string;
  status: "in_progress" | "completed";
  output?: unknown[];
  outputText?: string;
  usage?: unknown;
}) {
  return {
    id: input.responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: input.status,
    model: input.model,
    output: input.output ?? [],
    output_text: input.outputText ?? "",
    parallel_tool_calls: true,
    usage: normalizeChatCompletionUsage(input.usage),
  };
}

export function chatCompletionSseToResponsesApiSse(
  body: string,
  requestedModel: string,
): string {
  const responseId = buildResponseId("resp");
  const messageItemId = buildResponseId("msg");
  let content = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  const chunks: string[] = [];
  let sequenceNumber = 0;
  let messageStarted = false;

  const nextSequenceNumber = () => sequenceNumber++;

  chunks.push(
    serializeResponsesEvent("response.created", {
      response: buildResponsesStreamEnvelope({
        responseId,
        model: requestedModel,
        status: "in_progress",
      }),
      sequence_number: nextSequenceNumber(),
    }),
  );
  chunks.push(
    serializeResponsesEvent("response.in_progress", {
      response: buildResponsesStreamEnvelope({
        responseId,
        model: requestedModel,
        status: "in_progress",
      }),
      sequence_number: nextSequenceNumber(),
    }),
  );

  const ensureMessageStarted = () => {
    if (messageStarted) {
      return;
    }
    messageStarted = true;
    chunks.push(
      serializeResponsesEvent("response.output_item.added", {
        output_index: 0,
        item: {
          id: messageItemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
        sequence_number: nextSequenceNumber(),
      }),
    );
    chunks.push(
      serializeResponsesEvent("response.content_part.added", {
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "",
          annotations: [],
        },
        sequence_number: nextSequenceNumber(),
      }),
    );
  };

  for (const frame of parseChatCompletionSseFrames(body)) {
    if (!isRecord(frame)) {
      continue;
    }
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
    if (!delta) {
      continue;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      ensureMessageStarted();
      content += delta.content;
      chunks.push(
        serializeResponsesEvent("response.output_text.delta", {
          item_id: messageItemId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
          logprobs: [],
          sequence_number: nextSequenceNumber(),
        }),
      );
    }
    const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawToolCall of rawToolCalls) {
      if (!isRecord(rawToolCall)) {
        continue;
      }
      const fn = isRecord(rawToolCall.function) ? rawToolCall.function : undefined;
      const name = typeof fn?.name === "string" ? fn.name : undefined;
      if (!name) {
        continue;
      }
      const toolCall = {
        id:
          typeof rawToolCall.id === "string" && rawToolCall.id
            ? rawToolCall.id
            : `call_${toolCalls.length}`,
        name,
        arguments:
          typeof fn?.arguments === "string"
            ? fn.arguments
            : stringifyToolArguments(fn?.arguments),
      };
      toolCalls.push(toolCall);
    }
  }

  const output = buildResponsesOutputItems({ content, toolCalls, messageItemId });
  if (content) {
    chunks.push(
      serializeResponsesEvent("response.output_text.done", {
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        text: content,
        logprobs: [],
        sequence_number: nextSequenceNumber(),
      }),
    );
    chunks.push(
      serializeResponsesEvent("response.content_part.done", {
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: content,
          annotations: [],
        },
        sequence_number: nextSequenceNumber(),
      }),
    );
  }

  for (const [index, item] of output.entries()) {
    if (isRecord(item) && item.type === "function_call") {
      chunks.push(
        serializeResponsesEvent("response.output_item.added", {
          output_index: index,
          item: {
            ...item,
            status: "in_progress",
            arguments: "",
          },
          sequence_number: nextSequenceNumber(),
        }),
      );
      chunks.push(
        serializeResponsesEvent("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: index,
          delta: typeof item.arguments === "string" ? item.arguments : "",
          sequence_number: nextSequenceNumber(),
        }),
      );
      chunks.push(
        serializeResponsesEvent("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: index,
          arguments: typeof item.arguments === "string" ? item.arguments : "",
          sequence_number: nextSequenceNumber(),
        }),
      );
    }
    chunks.push(
      serializeResponsesEvent("response.output_item.done", {
        output_index: index,
        item,
        sequence_number: nextSequenceNumber(),
      }),
    );
  }

  chunks.push(
    serializeResponsesEvent("response.completed", {
      response: buildResponsesStreamEnvelope({
        responseId,
        model: requestedModel,
        status: "completed",
        output,
        outputText: content,
      }),
      sequence_number: nextSequenceNumber(),
    }),
  );

  return chunks.join("");
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
