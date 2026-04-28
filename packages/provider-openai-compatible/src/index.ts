import type {
  AssistantMessage,
  ToolCall,
} from "@mariozechner/pi-ai";

import {
  GatewayChatOptions,
  GatewayConversationContext,
  GatewayError,
  GatewayModelDefinition,
  OPENAI_COMPAT_PROVIDER_ID,
  ProviderAdapter,
  ProviderStreamResult,
  QueuedProviderStream,
  createEmptyUsage,
  createSyntheticSession,
} from "@local-ai-gateway/shared";

export interface OpenAICompatibleAdapterConfig {
  baseUrl: string;
  apiKey: string;
  id?: string;
  label?: string;
  headers?: Record<string, string>;
}

interface OpenAIChatCompletionChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  choices?: Array<{
    finish_reason?: "stop" | "length" | "tool_calls" | null;
    delta?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

interface OpenAIToolDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  return trimmed;
}

function resolveChatEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function toOpenAIMessages(context: GatewayConversationContext): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (context.systemPrompt) {
    messages.push({
      role: "system",
      content: context.systemPrompt,
    });
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                },
              })),
            }
          : {}),
      });
      continue;
    }

    messages.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    });
  }

  return messages;
}

function createPartialMessage(providerId: string, model: GatewayModelDefinition): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: providerId,
    model: model.providerModelId,
    timestamp: Date.now(),
    stopReason: "stop",
    usage: createEmptyUsage(),
    content: [],
  };
}

function createErrorMessage(
  providerId: string,
  model: GatewayModelDefinition,
  message: string,
  reason: "error" | "aborted" = "error",
): AssistantMessage {
  return {
    ...createPartialMessage(providerId, model),
    stopReason: reason,
    errorMessage: message,
  };
}

function mapFinishReason(reason: "stop" | "length" | "tool_calls" | null | undefined) {
  if (reason === "length") {
    return "length" as const;
  }
  if (reason === "tool_calls") {
    return "toolUse" as const;
  }
  return "stop" as const;
}

function createUsageFromChunk(chunk: OpenAIChatCompletionChunk) {
  const cachedTokens = chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens =
    chunk.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const usage = {
    ...createEmptyUsage(),
    input: Math.max(
      0,
      (chunk.usage?.prompt_tokens ?? 0) -
        (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    ),
    output: chunk.usage?.completion_tokens ?? 0,
    totalTokens: chunk.usage?.total_tokens ?? 0,
  } as ReturnType<typeof createEmptyUsage> & {
    reasoningOutputTokens: number;
  };
  if (chunk.usage?.prompt_tokens_details && "cached_tokens" in chunk.usage.prompt_tokens_details) {
    usage.cacheRead = cachedTokens;
  }
  if (
    chunk.usage?.completion_tokens_details &&
    "reasoning_tokens" in chunk.usage.completion_tokens_details
  ) {
    usage.reasoningOutputTokens = reasoningTokens;
  }
  return usage;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

async function* iterateSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) {
          break;
        }

        const rawBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawBlock
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");

        if (data) {
          yield data;
        }
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      const data = trailing
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (data) {
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class OpenAICompatibleStreamAdapter {
  private readonly partial: AssistantMessage;
  private readonly stream = new QueuedProviderStream();
  private readonly toolBuffers = new Map<number, string>();
  private finishReason: "stop" | "length" | "toolUse" = "stop";
  private textContentIndex = -1;

  constructor(
    private readonly providerId: string,
    private readonly model: GatewayModelDefinition,
  ) {
    this.partial = createPartialMessage(providerId, model);
  }

  start(): void {
    this.stream.push({
      type: "start",
      partial: this.partial,
    });
  }

  ingest(chunk: OpenAIChatCompletionChunk): void {
    if (chunk.usage) {
      this.partial.usage = createUsageFromChunk(chunk);
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      return;
    }

    if (choice.delta?.content) {
      if (this.textContentIndex === -1) {
        this.textContentIndex = this.partial.content.length;
        this.partial.content.push({
          type: "text",
          text: "",
        });
        this.stream.push({
          type: "text_start",
          contentIndex: this.textContentIndex,
          partial: this.partial,
        });
      }

      const text = this.partial.content[this.textContentIndex];
      if (text?.type === "text") {
        text.text += choice.delta.content;
        this.stream.push({
          type: "text_delta",
          contentIndex: this.textContentIndex,
          delta: choice.delta.content,
          partial: this.partial,
        });
      }
    }

    for (const toolDelta of choice.delta?.tool_calls ?? []) {
      const contentIndex = this.getOrCreateToolCall(toolDelta.index ?? 0, toolDelta);
      const delta = toolDelta.function?.arguments ?? "";
      if (!delta) {
        continue;
      }

      const current = this.toolBuffers.get(contentIndex) ?? "";
      this.toolBuffers.set(contentIndex, current + delta);
      this.stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta,
        partial: this.partial,
      });
    }

    if (choice.finish_reason) {
      this.finishReason = mapFinishReason(choice.finish_reason);
    }
  }

  finish(): void {
    for (const [contentIndex, rawArguments] of [...this.toolBuffers.entries()].sort((a, b) => a[0] - b[0])) {
      const content = this.partial.content[contentIndex];
      if (content?.type !== "toolCall") {
        continue;
      }

      content.arguments = parseToolArguments(rawArguments);
      this.stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: content,
        partial: this.partial,
      });
    }

    if (this.textContentIndex >= 0) {
      const text = this.partial.content[this.textContentIndex];
      if (text?.type === "text") {
        this.stream.push({
          type: "text_end",
          contentIndex: this.textContentIndex,
          content: text.text,
          partial: this.partial,
        });
      }
    }

    this.partial.stopReason = this.finishReason;
    this.stream.push({
      type: "done",
      reason: this.finishReason,
      message: this.partial,
    });
    this.stream.finish(this.partial);
  }

  fail(message: string, reason: "error" | "aborted" = "error"): void {
    const errorMessage = createErrorMessage(this.providerId, this.model, message, reason);
    this.stream.push({
      type: "error",
      reason,
      error: errorMessage,
    });
    this.stream.finish(errorMessage);
  }

  getProviderStream() {
    return this.stream;
  }

  private getOrCreateToolCall(
    relativeIndex: number,
    toolDelta: OpenAIToolDelta,
  ): number {
    const contentIndex = (this.textContentIndex >= 0 ? this.textContentIndex + 1 : 0) + relativeIndex;
    const current = this.partial.content[contentIndex];
    if (current?.type === "toolCall") {
      if (toolDelta.id) {
        current.id = toolDelta.id;
      }
      if (toolDelta.function?.name) {
        current.name = toolDelta.function.name;
      }
      return contentIndex;
    }

    const toolCall: ToolCall = {
      type: "toolCall",
      id: toolDelta.id ?? `call_${relativeIndex}`,
      name: toolDelta.function?.name ?? "tool",
      arguments: {},
    };

    this.partial.content[contentIndex] = toolCall;
    this.toolBuffers.set(contentIndex, "");
    this.stream.push({
      type: "toolcall_start",
      contentIndex,
      partial: this.partial,
    });

    return contentIndex;
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly usesSessions = false;

  constructor(private readonly config: OpenAICompatibleAdapterConfig) {
    this.id = config.id ?? OPENAI_COMPAT_PROVIDER_ID;
    this.label = config.label ?? "OpenAI-Compatible";
  }

  supportsModel(model: GatewayModelDefinition): boolean {
    return model.provider === this.id;
  }

  async createStream(
    model: GatewayModelDefinition,
    context: GatewayConversationContext,
    options: GatewayChatOptions = {},
  ): Promise<ProviderStreamResult> {
    const endpoint = resolveChatEndpoint(this.config.baseUrl);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.headers,
      },
      body: JSON.stringify({
        model: model.providerModelId,
        stream: true,
        stream_options: {
          include_usage: true,
        },
        messages: toOpenAIMessages(context),
        ...(context.tools?.length
          ? {
              tools: context.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
        ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new GatewayError(
        response.status >= 500 ? 502 : response.status,
        "upstream_error",
        body || `OpenAI-compatible upstream request failed with status ${response.status}.`,
      );
    }

    if (!response.body) {
      throw new GatewayError(502, "upstream_error", "OpenAI-compatible upstream returned no response body.");
    }

    const streamAdapter = new OpenAICompatibleStreamAdapter(this.id, model);
    streamAdapter.start();

    void (async () => {
      try {
        for await (const data of iterateSseData(response.body as ReadableStream<Uint8Array>)) {
          if (data === "[DONE]") {
            break;
          }

          streamAdapter.ingest(JSON.parse(data) as OpenAIChatCompletionChunk);
        }

        streamAdapter.finish();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        streamAdapter.fail(message, options.signal?.aborted ? "aborted" : "error");
      }
    })();

    return {
      providerId: this.id,
      providerLabel: this.label,
      model,
      session: createSyntheticSession(this.id, endpoint, this.config.apiKey),
      stream: streamAdapter.getProviderStream(),
    };
  }
}
