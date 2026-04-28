import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamLocalOpenAICodexResponses } = vi.hoisted(() => ({
  streamLocalOpenAICodexResponses: vi.fn(),
}));

vi.mock("../packages/provider-codex/src/codex-stream.ts", () => ({
  streamLocalOpenAICodexResponses,
}));

import { CodexAdapter } from "../packages/provider-codex/src/index.ts";
import type {
  GatewayConversationContext,
  GatewayModelDefinition,
  ResolvedSession,
  SessionSource,
} from "../packages/shared/src/index.ts";

describe("CodexAdapter", () => {
  beforeEach(() => {
    streamLocalOpenAICodexResponses.mockReset();
    streamLocalOpenAICodexResponses.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {},
      result: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "codex-default",
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
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    });
  });

  it("不会向 codex 上游透传 temperature", async () => {
    const session: ResolvedSession = {
      id: "openai-codex:test",
      agentId: "main",
      profileId: "openai-codex:test",
      provider: "openai-codex",
      type: "oauth",
      status: "available",
      sourcePath: "/tmp/auth-profiles.json",
      apiKey: "test-api-key",
    };

    const sessionSource: SessionSource = {
      listSessions: () => [session],
      resolveSession: async () => session,
    };

    const model: GatewayModelDefinition = {
      alias: "codex-default",
      provider: "openai-codex",
      providerModelId: "gpt-5.4",
      displayName: "codex-default",
      reasoning: false,
      input: ["text"],
      contextWindow: 256000,
      maxTokens: 32000,
    };

    const context: GatewayConversationContext = {
      systemPrompt: "你是测试助手",
      messages: [{ role: "user", content: "只回复 OK" }],
    };

    const adapter = new CodexAdapter(sessionSource);
    await adapter.createStream(model, context, {
      sessionId: session.id,
      temperature: 0,
      maxTokens: 2048,
    });

    expect(streamLocalOpenAICodexResponses).toHaveBeenCalledTimes(1);
    const requestOptions = streamLocalOpenAICodexResponses.mock.calls[0]?.[2];
    expect(requestOptions).toMatchObject({
      apiKey: "test-api-key",
      sessionId: "openai-codex:test",
      maxTokens: 2048,
      textVerbosity: "medium",
      reasoningEffort: "medium",
    });
    expect(requestOptions).not.toHaveProperty("temperature");
  });
});
