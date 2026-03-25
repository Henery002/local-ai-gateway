import type {
  AssistantMessage,
  ToolCall,
} from "@mariozechner/pi-ai";

import {
  GatewayChatOptions,
  GatewayConversationContext,
  GatewayError,
  GatewayModelDefinition,
  OLLAMA_PROVIDER_ID,
  ProviderAdapter,
  ProviderStreamResult,
  QueuedProviderStream,
  createEmptyUsage,
  createSyntheticSession,
} from "@local-ai-gateway/shared";

export interface OllamaAdapterConfig {
  baseUrl: string;
  id?: string;
  label?: string;
  headers?: Record<string, string>;
}

interface OllamaChatLine {
  message?: {
    role?: "assistant";
    content?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    }>;
  };
  done?: boolean;
  done_reason?: "stop" | "length";
  prompt_eval_count?: number;
  eval_count?: number;
}

type OllamaMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: Record<string, unknown>;
        };
      }>;
    }
  | {
      role: "tool";
      content: string;
    };

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/api/chat")) {
    return trimmed.slice(0, -"/api/chat".length);
  }
  return trimmed;
}

function resolveChatEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/chat`;
}

function safeParseArguments(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toOllamaMessages(context: GatewayConversationContext): OllamaMessage[] {
  const messages: OllamaMessage[] = [];

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
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                function: {
                  name: toolCall.name,
                  arguments: safeParseArguments(toolCall.arguments),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    messages.push({
      role: "tool",
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

async function* iterateNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
        const boundary = buffer.indexOf("\n");
        if (boundary === -1) {
          break;
        }

        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line) {
          yield line;
        }
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}

class OllamaStreamAdapter {
  private readonly partial: AssistantMessage;
  private readonly stream = new QueuedProviderStream();
  private textContentIndex = -1;
  private finishReason: "stop" | "length" | "toolUse" = "stop";

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

  ingest(line: OllamaChatLine): void {
    if (line.prompt_eval_count !== undefined || line.eval_count !== undefined) {
      this.partial.usage = {
        ...createEmptyUsage(),
        input: line.prompt_eval_count ?? 0,
        output: line.eval_count ?? 0,
        totalTokens: (line.prompt_eval_count ?? 0) + (line.eval_count ?? 0),
      };
    }

    const textDelta = line.message?.content ?? "";
    if (textDelta) {
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
        text.text += textDelta;
        this.stream.push({
          type: "text_delta",
          contentIndex: this.textContentIndex,
          delta: textDelta,
          partial: this.partial,
        });
      }
    }

    for (const [index, tool] of (line.message?.tool_calls ?? []).entries()) {
      const contentIndex = this.partial.content.length + index;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: `ollama_tool_${contentIndex}`,
        name: tool.function?.name ?? "tool",
        arguments: tool.function?.arguments ?? {},
      };
      this.partial.content.push(toolCall);
      this.stream.push({
        type: "toolcall_start",
        contentIndex,
        partial: this.partial,
      });
      this.stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall,
        partial: this.partial,
      });
      this.finishReason = "toolUse";
    }

    if (line.done_reason === "length") {
      this.finishReason = "length";
    }
  }

  finish(): void {
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
}

export class OllamaAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly usesSessions = false;

  constructor(private readonly config: OllamaAdapterConfig) {
    this.id = config.id ?? OLLAMA_PROVIDER_ID;
    this.label = config.label ?? "Ollama";
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
        ...this.config.headers,
      },
      body: JSON.stringify({
        model: model.providerModelId,
        stream: true,
        messages: toOllamaMessages(context),
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
        options: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new GatewayError(
        response.status >= 500 ? 502 : response.status,
        "upstream_error",
        body || `Ollama upstream request failed with status ${response.status}.`,
      );
    }

    if (!response.body) {
      throw new GatewayError(502, "upstream_error", "Ollama upstream returned no response body.");
    }

    const streamAdapter = new OllamaStreamAdapter(this.id, model);
    streamAdapter.start();

    void (async () => {
      try {
        for await (const rawLine of iterateNdjson(response.body as ReadableStream<Uint8Array>)) {
          const line = JSON.parse(rawLine) as OllamaChatLine;
          streamAdapter.ingest(line);
          if (line.done) {
            break;
          }
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
      session: createSyntheticSession(this.id, endpoint),
      stream: streamAdapter.getProviderStream(),
    };
  }
}
