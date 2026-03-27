import { describe, expect, it } from "vitest";

import { bootstrapProvidersFromEnvironment } from "../apps/gateway/src/provider-bootstrap.js";

describe("provider bootstrap", () => {
  it("keeps codex by default and appends configured providers", () => {
    const bootstrapped = bootstrapProvidersFromEnvironment({
      LOCAL_AI_GATEWAY_OPENAI_BASE_URL: "https://example.com/v1",
      LOCAL_AI_GATEWAY_OPENAI_API_KEY: "sk-test",
      LOCAL_AI_GATEWAY_OPENAI_MODEL: "gpt-4.1-mini",
      LOCAL_AI_GATEWAY_OLLAMA_MODEL: "qwen2.5-coder:7b",
    });

    expect(bootstrapped.models.map((model) => model.alias)).toEqual([
      "codex-default",
      "codex-5.4",
      "codex-5.4-mini",
      "codex-5.3",
      "codex-5.2",
      "openai-compatible-default",
      "ollama-default",
    ]);
    expect(bootstrapped.adapters.map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "ollama",
    ]);
    expect(bootstrapped.configurations.map((item) => item.id)).toEqual([
      "openai-codex",
      "openai-compatible",
      "ollama",
    ]);
    expect(bootstrapped.configurations.map((item) => item.status)).toEqual([
      "active",
      "active",
      "active",
    ]);
  });

  it("moves configured default model alias to the front", () => {
    const bootstrapped = bootstrapProvidersFromEnvironment({
      LOCAL_AI_GATEWAY_OPENAI_BASE_URL: "https://example.com/v1",
      LOCAL_AI_GATEWAY_OPENAI_API_KEY: "sk-test",
      LOCAL_AI_GATEWAY_OPENAI_MODEL: "gpt-4.1-mini",
      LOCAL_AI_GATEWAY_DEFAULT_MODEL_ALIAS: "openai-compatible-default",
    });

    expect(bootstrapped.models[0]?.alias).toBe("openai-compatible-default");
  });

  it("marks partially configured providers as incomplete", () => {
    const bootstrapped = bootstrapProvidersFromEnvironment({
      LOCAL_AI_GATEWAY_OPENAI_BASE_URL: "https://example.com/v1",
      LOCAL_AI_GATEWAY_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    });

    expect(bootstrapped.configurations.find((item) => item.id === "openai-compatible")).toMatchObject({
      status: "incomplete",
      registered: false,
      missingEnvKeys: ["LOCAL_AI_GATEWAY_OPENAI_API_KEY"],
    });
    expect(bootstrapped.configurations.find((item) => item.id === "ollama")).toMatchObject({
      status: "incomplete",
      registered: false,
      missingEnvKeys: ["LOCAL_AI_GATEWAY_OLLAMA_MODEL"],
    });
  });

  it("supports selecting the codex upstream model from saved settings", () => {
    const bootstrapped = bootstrapProvidersFromEnvironment(
      {},
      {
        codex: {
          upstreamModel: "gpt-5.4-mini",
        },
      },
    );

    expect(bootstrapped.models[0]).toMatchObject({
      alias: "codex-default",
      provider: "openai-codex",
      providerModelId: "gpt-5.4-mini",
      displayName: "Codex gpt-5.4-mini",
    });
    expect(bootstrapped.models.map((model) => model.alias)).toContain("codex-5.4-mini");
    expect(bootstrapped.configurations[0]?.notes).toContain("当前上游模型：gpt-5.4-mini");
  });

  it("ignores unsupported codex upstream models and falls back to gpt-5.4", () => {
    const bootstrapped = bootstrapProvidersFromEnvironment(
      {},
      {
        codex: {
          upstreamModel: "not-a-real-model",
        },
      },
    );

    expect(bootstrapped.models[0]?.providerModelId).toBe("gpt-5.4");
  });

  it("supports codex multi-alias subset from saved settings", () => {
    const bootstrapped = bootstrapProvidersFromEnvironment(
      {},
      {
        codex: {
          upstreamModel: "gpt-5.4",
          exposedModels: ["gpt-5.4-mini", "gpt-5.2-codex"],
        },
      },
    );

    expect(bootstrapped.models.map((model) => model.alias)).toEqual([
      "codex-default",
      "codex-5.4-mini",
      "codex-5.2",
    ]);
    expect(bootstrapped.models.find((model) => model.alias === "codex-5.2"))
      .toMatchObject({
        providerModelId: "gpt-5.2-codex",
      });
  });
});
