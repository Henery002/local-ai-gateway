import type {
  Context as PiContext,
  Message as PiMessage,
  Model as PiModel,
  Tool as PiTool,
} from "@mariozechner/pi-ai";
import { streamOpenAICodexResponses } from "@mariozechner/pi-ai/openai-codex-responses";

import {
  DEFAULT_PROVIDER_ID,
  GatewayChatOptions,
  GatewayConversationContext,
  GatewayModelDefinition,
  ProviderAdapter,
  ProviderStreamResult,
  ResolvedSession,
  SessionSource,
} from "@local-ai-gateway/shared";

function buildPiModel(model: GatewayModelDefinition): PiModel<"openai-codex-responses"> {
  return {
    id: model.providerModelId,
    name: model.displayName,
    api: "openai-codex-responses",
    provider: DEFAULT_PROVIDER_ID,
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: model.reasoning,
    input: model.input,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function buildPiContext(context: GatewayConversationContext): PiContext {
  const messages: PiMessage[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content,
        timestamp: Date.now(),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content = [];
      if (message.content) {
        content.push({
          type: "text" as const,
          text: message.content,
        });
      }

      for (const toolCall of message.toolCalls ?? []) {
        content.push({
          type: "toolCall" as const,
          id: toolCall.id,
          name: toolCall.name,
          arguments: safeParseArguments(toolCall.arguments),
        });
      }

      messages.push({
        role: "assistant",
        content,
        api: "openai-codex-responses",
        provider: DEFAULT_PROVIDER_ID,
        model: "gateway-replay",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      continue;
    }

    messages.push({
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: "tool",
      content: [
        {
          type: "text",
          text: message.content,
        },
      ],
      isError: false,
      timestamp: Date.now(),
    });
  }

  return {
    systemPrompt: context.systemPrompt ?? "You are a helpful AI assistant.",
    messages,
    tools: (context.tools ?? []).map(
      (tool) =>
        ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }) as PiTool,
    ),
  };
}

function safeParseArguments(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = DEFAULT_PROVIDER_ID;
  readonly label = "OpenAI Codex";
  readonly usesSessions = true;

  constructor(private readonly sessionSource: SessionSource) {}

  supportsModel(model: GatewayModelDefinition): boolean {
    return model.provider === this.id;
  }

  async createStream(
    model: GatewayModelDefinition,
    context: GatewayConversationContext,
    options: GatewayChatOptions = {},
  ): Promise<ProviderStreamResult> {
    const session = await this.sessionSource.resolveSession(options.sessionId);
    const upstreamModel = buildPiModel(model);
    const upstreamContext = buildPiContext(context);

    const stream = streamOpenAICodexResponses(upstreamModel, upstreamContext, {
      apiKey: session.apiKey,
      sessionId: session.id,
      transport: "auto",
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      textVerbosity: "medium",
      reasoningEffort: "medium",
      signal: options.signal,
    });

    return {
      providerId: this.id,
      providerLabel: this.label,
      model,
      session,
      stream,
    };
  }
}
