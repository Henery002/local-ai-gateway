import type { ProviderAdapter } from "@local-ai-gateway/shared";
import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_PROVIDER_ID,
  DEFAULT_PROVIDER_MODEL_ID,
  GatewayModelDefinition,
  GatewayProviderSettings,
  OLLAMA_PROVIDER_ID,
  OPENAI_COMPAT_PROVIDER_ID,
  ProviderConfigurationSummary,
} from "@local-ai-gateway/shared";
import { OllamaAdapter } from "@local-ai-gateway/provider-ollama";
import { OpenAICompatibleAdapter } from "@local-ai-gateway/provider-openai-compatible";

export interface BootstrappedProviders {
  adapters: ProviderAdapter[];
  models: GatewayModelDefinition[];
  configurations: ProviderConfigurationSummary[];
}

const DEFAULT_CODEX_MODEL: GatewayModelDefinition = {
  alias: DEFAULT_MODEL_ALIAS,
  displayName: "Codex Default",
  provider: DEFAULT_PROVIDER_ID,
  providerModelId: DEFAULT_PROVIDER_MODEL_ID,
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  input: ["text"],
  reasoning: true,
};

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function moveDefaultModelToFront(
  models: GatewayModelDefinition[],
  defaultAlias: string | undefined,
): GatewayModelDefinition[] {
  if (!defaultAlias) {
    return models;
  }

  const index = models.findIndex((model) => model.alias === defaultAlias);
  if (index <= 0) {
    return models;
  }

  const next = [...models];
  const [selected] = next.splice(index, 1);
  next.unshift(selected as GatewayModelDefinition);
  return next;
}

function hasAnyValue(env: NodeJS.ProcessEnv, keys: string[]): boolean {
  return keys.some((key) => env[key]?.trim());
}

function findMissingKeys(env: NodeJS.ProcessEnv, keys: string[]): string[] {
  return keys.filter((key) => !env[key]?.trim());
}

function hasAnyConfiguredField(values: Array<string | number | boolean | undefined>): boolean {
  return values.some((value) => value !== undefined && `${value}`.trim() !== "");
}

function resolveString(configValue: string | undefined, envValue: string | undefined): string | undefined {
  return envValue?.trim() || configValue?.trim() || undefined;
}

function resolveBoolean(configValue: boolean | undefined, envValue: string | undefined, fallback = false): boolean {
  if (envValue !== undefined) {
    return envValue === "true";
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return fallback;
}

function resolveInt(configValue: number | undefined, envValue: string | undefined, fallback: number): number {
  if (envValue) {
    return parsePositiveInt(envValue, fallback);
  }
  if (typeof configValue === "number" && Number.isFinite(configValue) && configValue > 0) {
    return configValue;
  }
  return fallback;
}

function pickMissingKeys(
  source: "environment" | "config-file",
  fields: {
    envKey: string;
    configKey: string;
    value: string | undefined;
  }[],
): string[] {
  return fields
    .filter((field) => !field.value)
    .map((field) => (source === "environment" ? field.envKey : field.configKey));
}

export function bootstrapProvidersFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  settings: GatewayProviderSettings = {},
): BootstrappedProviders {
  const adapters: ProviderAdapter[] = [];
  const models: GatewayModelDefinition[] = [DEFAULT_CODEX_MODEL];
  const configurations: ProviderConfigurationSummary[] = [
    {
      id: DEFAULT_PROVIDER_ID,
      label: "OpenAI Codex",
      status: "active",
      registered: true,
      source: "openclaw-session",
      configuredVia: "OpenClaw 会话",
      authMode: "oauth-session",
      envKeys: [],
      notes: ["认证来源固定为 ~/.openclaw 会话元数据", "活动会话可在桌面端手动切换"],
    },
  ];

  const openAISettings = settings.openAICompatible ?? {};
  const openAIProviderId = OPENAI_COMPAT_PROVIDER_ID;
  const openAIUsesEnv = hasAnyValue(env, [
    "LOCAL_AI_GATEWAY_OPENAI_BASE_URL",
    "LOCAL_AI_GATEWAY_OPENAI_API_KEY",
    "LOCAL_AI_GATEWAY_OPENAI_MODEL",
    "LOCAL_AI_GATEWAY_OPENAI_ALIAS",
    "LOCAL_AI_GATEWAY_OPENAI_LABEL",
    "LOCAL_AI_GATEWAY_OPENAI_DISPLAY_NAME",
  ]);
  const openAILabel = resolveString(openAISettings.label, env.LOCAL_AI_GATEWAY_OPENAI_LABEL) || "OpenAI-Compatible";
  const openAIBaseUrl = resolveString(openAISettings.baseUrl, env.LOCAL_AI_GATEWAY_OPENAI_BASE_URL);
  const openAIApiKey = resolveString(openAISettings.apiKey, env.LOCAL_AI_GATEWAY_OPENAI_API_KEY);
  const openAIUsesConfig = hasAnyConfiguredField([
    openAISettings.baseUrl,
    openAISettings.apiKey,
    openAISettings.model,
    openAISettings.alias,
    openAISettings.displayName,
  ]);
  const openAISource = openAIUsesEnv ? "environment" : "config-file";
  const openAIEnabled = resolveBoolean(openAISettings.enabled, env.LOCAL_AI_GATEWAY_OPENAI_ENABLED, openAIUsesEnv);
  const openAIAnyConfigured = openAIUsesEnv || openAIUsesConfig || openAIEnabled;
  const openAIMissingKeys = pickMissingKeys(openAISource, [
    {
      envKey: "LOCAL_AI_GATEWAY_OPENAI_BASE_URL",
      configKey: "baseUrl",
      value: openAIBaseUrl,
    },
    {
      envKey: "LOCAL_AI_GATEWAY_OPENAI_API_KEY",
      configKey: "apiKey",
      value: openAIApiKey,
    },
  ]);
  const openAICanRegister = openAIEnabled && openAIMissingKeys.length === 0;
  const openAIStatus: ProviderConfigurationSummary["status"] = openAICanRegister
    ? "active"
    : openAIEnabled && openAIMissingKeys.length > 0
      ? "incomplete"
      : openAIAnyConfigured
        ? "disabled"
        : "disabled";
  const openAINotes = openAICanRegister
    ? ["API Key 仅用于运行时请求，不在桌面端明文展示"]
    : openAIEnabled && openAIMissingKeys.length > 0
      ? ["OpenAI-compatible provider 已启用，但仍缺少关键字段"]
      : openAIAnyConfigured
        ? ["OpenAI-compatible provider 已保存配置，但当前未启用"]
        : ["当前未配置 OpenAI-compatible provider"];

  if (openAICanRegister) {
    adapters.push(
      new OpenAICompatibleAdapter({
        id: openAIProviderId,
        label: openAILabel,
        baseUrl: openAIBaseUrl!,
        apiKey: openAIApiKey!,
      }),
    );
    models.push({
      alias: resolveString(openAISettings.alias, env.LOCAL_AI_GATEWAY_OPENAI_ALIAS) || "openai-compatible-default",
      displayName:
        resolveString(openAISettings.displayName, env.LOCAL_AI_GATEWAY_OPENAI_DISPLAY_NAME) ||
        "OpenAI-Compatible Default",
      provider: openAIProviderId,
      providerModelId: resolveString(openAISettings.model, env.LOCAL_AI_GATEWAY_OPENAI_MODEL) || "gpt-4o-mini",
      contextWindow: resolveInt(openAISettings.contextWindow, env.LOCAL_AI_GATEWAY_OPENAI_CONTEXT_WINDOW, 128_000),
      maxTokens: resolveInt(openAISettings.maxTokens, env.LOCAL_AI_GATEWAY_OPENAI_MAX_TOKENS, 16_384),
      input: ["text"],
      reasoning: resolveBoolean(openAISettings.reasoning, env.LOCAL_AI_GATEWAY_OPENAI_REASONING, false),
    });
    configurations.push({
      id: openAIProviderId,
      label: openAILabel,
      status: openAIStatus,
      registered: true,
      source: openAISource,
      configuredVia: openAIUsesEnv ? "环境变量" : "界面配置",
      authMode: "api-key",
      baseUrl: openAIBaseUrl,
      envKeys: [
        "LOCAL_AI_GATEWAY_OPENAI_BASE_URL",
        "LOCAL_AI_GATEWAY_OPENAI_API_KEY",
        "LOCAL_AI_GATEWAY_OPENAI_MODEL",
        "LOCAL_AI_GATEWAY_OPENAI_ALIAS",
      ],
      notes: openAINotes,
    });
  } else {
    configurations.push({
      id: openAIProviderId,
      label: openAILabel,
      status: openAIStatus,
      registered: false,
      source: openAISource,
      configuredVia: openAIUsesEnv ? "环境变量" : "界面配置",
      authMode: "api-key",
      baseUrl: openAIBaseUrl,
      envKeys: [
        "LOCAL_AI_GATEWAY_OPENAI_BASE_URL",
        "LOCAL_AI_GATEWAY_OPENAI_API_KEY",
        "LOCAL_AI_GATEWAY_OPENAI_MODEL",
        "LOCAL_AI_GATEWAY_OPENAI_ALIAS",
      ],
      missingEnvKeys: openAIAnyConfigured ? openAIMissingKeys : [],
      notes: openAINotes,
    });
  }

  const ollamaSettings = settings.ollama ?? {};
  const ollamaProviderId = OLLAMA_PROVIDER_ID;
  const ollamaUsesEnv = hasAnyValue(env, [
    "LOCAL_AI_GATEWAY_OLLAMA_BASE_URL",
    "LOCAL_AI_GATEWAY_OLLAMA_MODEL",
    "LOCAL_AI_GATEWAY_OLLAMA_ALIAS",
    "LOCAL_AI_GATEWAY_OLLAMA_LABEL",
    "LOCAL_AI_GATEWAY_OLLAMA_DISPLAY_NAME",
  ]);
  const ollamaLabel = resolveString(ollamaSettings.label, env.LOCAL_AI_GATEWAY_OLLAMA_LABEL) || "Ollama";
  const ollamaModel = resolveString(ollamaSettings.model, env.LOCAL_AI_GATEWAY_OLLAMA_MODEL);
  const ollamaUsesConfig = hasAnyConfiguredField([
    ollamaSettings.baseUrl,
    ollamaSettings.model,
    ollamaSettings.alias,
    ollamaSettings.displayName,
  ]);
  const ollamaSource = ollamaUsesEnv ? "environment" : "config-file";
  const ollamaEnabled = resolveBoolean(ollamaSettings.enabled, env.LOCAL_AI_GATEWAY_OLLAMA_ENABLED, ollamaUsesEnv);
  const ollamaAnyConfigured = ollamaUsesEnv || ollamaUsesConfig || ollamaEnabled;
  const ollamaMissingKeys = pickMissingKeys(ollamaSource, [
    {
      envKey: "LOCAL_AI_GATEWAY_OLLAMA_MODEL",
      configKey: "model",
      value: ollamaModel,
    },
  ]);
  const ollamaCanRegister = ollamaEnabled && ollamaMissingKeys.length === 0;
  const ollamaNotes = ollamaCanRegister
    ? ["当前按固定地址接入 Ollama，不涉及活动会话切换"]
    : ollamaEnabled && ollamaMissingKeys.length > 0
      ? ["Ollama provider 已启用，但仍缺少模型名"]
      : ollamaAnyConfigured
        ? ["Ollama provider 已保存配置，但当前未启用"]
        : ["当前未配置 Ollama provider"];
  const ollamaStatus: ProviderConfigurationSummary["status"] = ollamaCanRegister
    ? "active"
    : ollamaEnabled && ollamaMissingKeys.length > 0
      ? "incomplete"
      : "disabled";

  if (ollamaCanRegister) {
    adapters.push(
      new OllamaAdapter({
        id: ollamaProviderId,
        label: ollamaLabel,
        baseUrl: resolveString(ollamaSettings.baseUrl, env.LOCAL_AI_GATEWAY_OLLAMA_BASE_URL) || "http://127.0.0.1:11434",
      }),
    );
    models.push({
      alias: resolveString(ollamaSettings.alias, env.LOCAL_AI_GATEWAY_OLLAMA_ALIAS) || "ollama-default",
      displayName:
        resolveString(ollamaSettings.displayName, env.LOCAL_AI_GATEWAY_OLLAMA_DISPLAY_NAME) ||
        "Ollama Default",
      provider: ollamaProviderId,
      providerModelId: ollamaModel!,
      contextWindow: resolveInt(ollamaSettings.contextWindow, env.LOCAL_AI_GATEWAY_OLLAMA_CONTEXT_WINDOW, 32_768),
      maxTokens: resolveInt(ollamaSettings.maxTokens, env.LOCAL_AI_GATEWAY_OLLAMA_MAX_TOKENS, 8_192),
      input: ["text"],
      reasoning: resolveBoolean(ollamaSettings.reasoning, env.LOCAL_AI_GATEWAY_OLLAMA_REASONING, false),
    });
    configurations.push({
      id: ollamaProviderId,
      label: ollamaLabel,
      status: ollamaStatus,
      registered: true,
      source: ollamaSource,
      configuredVia: ollamaUsesEnv ? "环境变量" : "界面配置",
      authMode: "none",
      baseUrl: resolveString(ollamaSettings.baseUrl, env.LOCAL_AI_GATEWAY_OLLAMA_BASE_URL) || "http://127.0.0.1:11434",
      envKeys: [
        "LOCAL_AI_GATEWAY_OLLAMA_BASE_URL",
        "LOCAL_AI_GATEWAY_OLLAMA_MODEL",
        "LOCAL_AI_GATEWAY_OLLAMA_ALIAS",
      ],
      notes: ollamaNotes,
    });
  } else {
    configurations.push({
      id: ollamaProviderId,
      label: ollamaLabel,
      status: ollamaStatus,
      registered: false,
      source: ollamaSource,
      configuredVia: ollamaUsesEnv ? "环境变量" : "界面配置",
      authMode: "none",
      baseUrl: resolveString(ollamaSettings.baseUrl, env.LOCAL_AI_GATEWAY_OLLAMA_BASE_URL) || "http://127.0.0.1:11434",
      envKeys: [
        "LOCAL_AI_GATEWAY_OLLAMA_BASE_URL",
        "LOCAL_AI_GATEWAY_OLLAMA_MODEL",
        "LOCAL_AI_GATEWAY_OLLAMA_ALIAS",
      ],
      missingEnvKeys: ollamaAnyConfigured ? ollamaMissingKeys : [],
      notes: ollamaNotes,
    });
  }

  return {
    adapters,
    models: moveDefaultModelToFront(
      models,
      resolveString(settings.defaultModelAlias, env.LOCAL_AI_GATEWAY_DEFAULT_MODEL_ALIAS),
    ),
    configurations,
  };
}
