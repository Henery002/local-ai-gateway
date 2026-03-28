import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";

export const APP_NAME = "Local AI Gateway";
export const APP_ID = "local-ai-gateway";
export const APP_VERSION = "0.1.0";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
export const DEFAULT_OPENAI_BASE_URL = `${DEFAULT_BASE_URL}/v1`;
export const DEFAULT_PROVIDER_ID = "openai-codex";
export const DEFAULT_MODEL_ALIAS = "codex-default";
export const DEFAULT_PROVIDER_MODEL_ID = "gpt-5.4";
export const SUPPORTED_CODEX_UPSTREAM_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
] as const;
export type SupportedCodexUpstreamModel =
  (typeof SUPPORTED_CODEX_UPSTREAM_MODELS)[number];
export const CODEX_MODEL_ALIAS_PRESETS: Record<
  SupportedCodexUpstreamModel,
  string
> = {
  "gpt-5.4": "codex-5.4",
  "gpt-5.4-mini": "codex-5.4-mini",
  "gpt-5.3-codex": "codex-5.3",
  "gpt-5.2-codex": "codex-5.2",
  "gpt-5.2": "codex-5.2-core",
  "gpt-5.1-codex-max": "codex-5.1-max",
  "gpt-5.1-codex-mini": "codex-5.1-mini",
};
export const OPENAI_COMPAT_PROVIDER_ID = "openai-compatible";
export const OLLAMA_PROVIDER_ID = "ollama";
export const DEFAULT_OPENCLAW_ROOT = join(homedir(), ".openclaw");
export const DEFAULT_APP_SUPPORT_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  APP_ID,
);

export interface GatewayPaths {
  rootDir: string;
  configPath: string;
  codexProfilesPath: string;
  dbPath: string;
  logsDir: string;
  logFilePath: string;
}

export interface GatewayModelDefinition {
  alias: string;
  displayName: string;
  provider: string;
  providerModelId: string;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
}

export interface GatewayStoredConfig {
  adminToken: string;
  activeSessionId?: string;
  providerSettings?: GatewayProviderSettings;
  routingSettings?: GatewayRoutingSettings;
  inferenceAuthSettings?: GatewayInferenceAuthSettings;
  desktopSettings?: DesktopSystemSettings;
  createdAt: string;
  updatedAt: string;
}

export interface CodexProviderSettings {
  upstreamModel?: string;
  exposedModels?: string[];
}

export interface OpenAICompatibleProviderSettings {
  enabled?: boolean;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  alias?: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface OllamaProviderSettings {
  enabled?: boolean;
  label?: string;
  baseUrl?: string;
  model?: string;
  alias?: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface GatewayProviderSettings {
  defaultModelAlias?: string;
  codex?: CodexProviderSettings;
  openAICompatible?: OpenAICompatibleProviderSettings;
  ollama?: OllamaProviderSettings;
}

export interface GatewayRoutingRuleCondition {
  clientTag?: string;
  requestedModelAlias?: string;
}

export interface GatewayRoutingRuleTarget {
  modelAlias?: string;
  sessionId?: string;
}

export interface GatewayRoutingRule {
  id: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  when?: GatewayRoutingRuleCondition;
  target?: GatewayRoutingRuleTarget;
}

export interface GatewayRoutingSettings {
  enabled?: boolean;
  rules?: GatewayRoutingRule[];
}

export type GatewayInferenceAuthMode = "none" | "api-key";

export interface GatewayInferenceAuthSettings {
  mode?: GatewayInferenceAuthMode;
  apiKey?: string;
}

export interface GatewayInferenceAuthPublicSettings {
  mode: GatewayInferenceAuthMode;
  enabled: boolean;
  hasApiKey: boolean;
}

export interface GatewayRoutingPreviewInput {
  clientTag?: string;
  requestedModelAlias?: string;
  currentModelAlias?: string;
  currentSessionId?: string;
}

export interface GatewayRoutingPreviewResult {
  enabled: boolean;
  matchedRuleId?: string;
  matchedRuleName?: string;
  resolvedModelAlias: string;
  resolvedSessionId?: string;
  reason: string;
  warnings: string[];
}

export interface GatewayRoutingHitEvent {
  timestamp: number;
  clientTag?: string;
  requestedModelAlias: string;
  resolvedModelAlias: string;
  resolvedSessionId?: string;
  matchedRuleId: string;
  matchedRuleName: string;
  modelApplied: boolean;
  sessionApplied: boolean;
  warnings?: string[];
}

export interface GatewayRoutingHitByRule {
  ruleId: string;
  ruleName: string;
  hits: number;
  lastMatchedAt?: number;
}

export interface GatewayRoutingHitByClient {
  clientTag: string;
  hits: number;
  lastMatchedAt?: number;
}

export interface GatewayRoutingObservability {
  totalMatched: number;
  matchedLast5m: number;
  matchedLast1h: number;
  matchedLast24h: number;
  lastMatchedAt?: number;
  byRule: GatewayRoutingHitByRule[];
  byClientTag: GatewayRoutingHitByClient[];
  recent: GatewayRoutingHitEvent[];
}

export interface DesktopSystemSettings {
  launchAtLogin?: boolean;
  autoRefreshIntervalSeconds?: number;
  gatewayPort?: number;
  pinnedSessionId?: string;
}

export type SessionStatus = "available" | "expired" | "invalid";
export type SessionSourceKind = "openclaw" | "local-import";

export interface SessionQuotaSnapshot {
  scope?: "hourly" | "weekly";
  percentage?: number;
  resetAt?: number;
  windowMinutes?: number;
  updatedAt?: number;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  profileId: string;
  provider: string;
  type: string;
  accountId?: string;
  displayName?: string;
  email?: string;
  planType?: string;
  quota?: SessionQuotaSnapshot;
  expiresAt?: number;
  status: SessionStatus;
  sourceKind?: SessionSourceKind;
  sourceLabel?: string;
  sourcePath: string;
  activity?: SessionActivitySnapshot;
}

export interface SessionActivitySnapshot {
  requestCount: number;
  successCount: number;
  failureCount: number;
  streamCount: number;
  nonStreamCount: number;
  byClientTag?: SessionClientTagActivitySnapshot[];
  recentRequestCount5m?: number;
  recentByClientTag5m?: SessionClientTagActivitySnapshot[];
  recentRequestCount1h?: number;
  recentRequestCount24h?: number;
  lastRequestAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

export interface SessionClientTagActivitySnapshot {
  clientTag: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  lastRequestAt?: number;
}

export interface ResolvedSession extends SessionSummary {
  apiKey: string;
}

export interface SessionUsageRefreshItem {
  sessionId: string;
  accountId?: string;
  sourceKind?: SessionSourceKind;
  planType?: string;
  quota?: SessionQuotaSnapshot;
}

export interface SessionUsageRefreshSummary {
  ok: boolean;
  refreshed: number;
  failed: number;
  data: SessionUsageRefreshItem[];
  errors: Array<{
    sessionId: string;
    message: string;
  }>;
}

export interface ProviderSummary {
  id: string;
  label: string;
  usesSessions: boolean;
  activeSessionId?: string;
  models: GatewayModelDefinition[];
  configuration?: ProviderConfigurationSummary;
}

export interface ProviderConfigurationSummary {
  id: string;
  label: string;
  status: "active" | "disabled" | "incomplete";
  registered: boolean;
  source: "openclaw-session" | "environment" | "config-file";
  configuredVia: string;
  authMode: "oauth-session" | "api-key" | "none";
  baseUrl?: string;
  envKeys: string[];
  missingEnvKeys?: string[];
  notes?: string[];
}

export interface DefaultModelSelectionSummary {
  alias: string;
  provider: string;
  reason: string;
  overridden: boolean;
}

export interface SessionSource {
  listSessions(): SessionSummary[];
  resolveSession(sessionId?: string): Promise<ResolvedSession>;
  refreshUsage?(sessionId?: string): Promise<SessionUsageRefreshSummary>;
}

export interface ProviderStream {
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  result(): Promise<AssistantMessage>;
}

export interface ProviderStreamResult {
  providerId: string;
  providerLabel: string;
  model: GatewayModelDefinition;
  session: ResolvedSession;
  stream: ProviderStream;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly usesSessions?: boolean;
  supportsModel(model: GatewayModelDefinition): boolean;
  createStream(
    model: GatewayModelDefinition,
    context: GatewayConversationContext,
    options?: GatewayChatOptions,
  ): Promise<ProviderStreamResult>;
}

export interface GatewayHealth {
  ok: boolean;
  service: string;
  version: string;
  host: string;
  port: number;
  provider: string;
  defaultModel: string;
  activeSessionId?: string;
  sessionCount: number;
  pid: number;
  uptimeMs: number;
  startedAt: string;
  providerConfigurations?: ProviderConfigurationSummary[];
  defaultSelection?: DefaultModelSelectionSummary;
  routingObservability?: GatewayRoutingObservability;
  inferenceAuth?: GatewayInferenceAuthPublicSettings;
}

export interface GatewayLogRecord {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface GatewayToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GatewayUserMessage {
  role: "user";
  content: string;
}

export interface GatewayAssistantToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface GatewayAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: GatewayAssistantToolCall[];
}

export interface GatewayToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type GatewayConversationMessage =
  | GatewayUserMessage
  | GatewayAssistantMessage
  | GatewayToolResultMessage;

export interface GatewayConversationContext {
  systemPrompt?: string;
  messages: GatewayConversationMessage[];
  tools?: GatewayToolDefinition[];
}

export interface GatewayChatOptions {
  sessionId?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  signal?: AbortSignal;
}

export class GatewayError extends Error {
  statusCode: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function resolveGatewayPaths(rootDir = DEFAULT_APP_SUPPORT_DIR): GatewayPaths {
  return {
    rootDir,
    configPath: join(rootDir, "config.json"),
    codexProfilesPath: join(rootDir, "codex-auth-profiles.json"),
    dbPath: join(rootDir, "gateway.db"),
    logsDir: join(rootDir, "logs"),
    logFilePath: join(rootDir, "logs", "gateway.log"),
  };
}

export function isSupportedCodexUpstreamModel(
  value: string,
): value is SupportedCodexUpstreamModel {
  return SUPPORTED_CODEX_UPSTREAM_MODELS.includes(
    value as SupportedCodexUpstreamModel,
  );
}

export function getCodexAliasForUpstreamModel(
  modelId: string,
): string | undefined {
  if (!isSupportedCodexUpstreamModel(modelId)) {
    return undefined;
  }
  return CODEX_MODEL_ALIAS_PRESETS[modelId];
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (
      lower.includes("bearer ") ||
      lower.includes("authorization") ||
      lower.includes("refresh") ||
      lower.includes("access")
    ) {
      return "[redacted]";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (
          /token|authorization|refresh|access|cookie/i.test(key)
        ) {
          return [key, "[redacted]"];
        }
        return [key, redactSensitiveValue(item)];
      }),
    );
  }

  return value;
}

export function toIsoNow(): string {
  return new Date().toISOString();
}

export function createEmptyUsage() {
  return {
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
  };
}

export function createSyntheticSession(
  provider: string,
  sourcePath: string,
  apiKey = "",
): ResolvedSession {
  return {
    id: `${provider}:default`,
    agentId: provider,
    profileId: `${provider}:default`,
    provider,
    type: "api-key",
    status: "available",
    sourcePath,
    apiKey,
  };
}

export class QueuedProviderStream implements ProviderStream {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
  private closed = false;
  private settled = false;
  private readonly finalMessagePromise: Promise<AssistantMessage>;
  private resolveFinalMessage!: (message: AssistantMessage) => void;

  constructor() {
    this.finalMessagePromise = new Promise<AssistantMessage>((resolve) => {
      this.resolveFinalMessage = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }

    this.queue.push(event);
  }

  finish(message: AssistantMessage): void {
    if (!this.settled) {
      this.resolveFinalMessage(message);
      this.settled = true;
    }
    this.closed = true;
    this.flushClosed();
  }

  async result(): Promise<AssistantMessage> {
    return this.finalMessagePromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      const next = await this.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }

  private next(): Promise<IteratorResult<AssistantMessageEvent>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift();
      return Promise.resolve({
        value: value as AssistantMessageEvent,
        done: false,
      });
    }

    if (this.closed) {
      return Promise.resolve({
        value: undefined,
        done: true,
      });
    }

    return new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private flushClosed(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({
        value: undefined,
        done: true,
      });
    }
  }
}
