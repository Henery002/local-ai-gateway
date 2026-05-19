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
  poolSettings?: GatewaySessionPoolSettings;
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

export type GatewayRoutingDispatchMode =
  | "active-session"
  | "fixed-session"
  | "dynamic-pool";

export type GatewayPoolSelectionStrategy =
  | "priority"
  | "quota-desc"
  | "least-recently-used"
  | "hybrid";

export type GatewayPoolVisibility =
  | "private"
  | "shared-lan"
  | "public-ready";

export type GatewayPoolFailureClass =
  | "auth_invalid"
  | "quota_exhausted"
  | "rate_limited"
  | "network_retryable"
  | "upstream_retryable"
  | "non_retryable";

export interface GatewaySessionPoolMember {
  selector: string;
  label?: string;
  enabled?: boolean;
  priority?: number;
}

export interface GatewaySessionPoolDefinition {
  id: string;
  name: string;
  enabled?: boolean;
  description?: string;
  visibility?: GatewayPoolVisibility;
  members?: GatewaySessionPoolMember[];
  selectionStrategy?: GatewayPoolSelectionStrategy;
  minRemainingPercentage?: number;
  allowUnknownQuota?: boolean;
  cooldownSeconds?: number;
  quotaExhaustedCooldownSeconds?: number;
  maxRetryCandidates?: number;
  fallbackToActiveSession?: boolean;
}

export interface GatewaySessionPoolSettings {
  enabled?: boolean;
  pools?: GatewaySessionPoolDefinition[];
}

export type GatewayPoolMemberObservabilityStatus =
  | "available"
  | "cooldown"
  | "quota-low"
  | "expired"
  | "invalid"
  | "missing"
  | "disabled"
  | "unknown-quota";

export interface GatewayPoolMemberObservability {
  selector: string;
  label?: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionSubtitle?: string;
  quotaPercentage?: number;
  resetAt?: number;
  eligible: boolean;
  selected: boolean;
  status: GatewayPoolMemberObservabilityStatus;
  statusLabel: string;
  note?: string;
  cooldownUntil?: number;
  lastSelectedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailureClass?: GatewayPoolFailureClass;
  consecutiveFailures: number;
}

export interface GatewayPoolObservability {
  poolId: string;
  poolName: string;
  enabled: boolean;
  selectionStrategy?: GatewayPoolSelectionStrategy;
  selectedSessionId?: string;
  selectedSelector?: string;
  selectionReason?: string;
  memberCount: number;
  eligibleMemberCount: number;
  coolingMemberCount: number;
  lastSelectedAt?: number;
  lastFailureAt?: number;
  warnings: string[];
  recentEvents?: GatewayPoolSelectionEvent[];
  members: GatewayPoolMemberObservability[];
}

export type GatewayPoolSelectionEventType = "selected" | "failover";

export interface GatewayPoolSelectionEvent {
  timestamp: number;
  poolId: string;
  poolName: string;
  eventType: GatewayPoolSelectionEventType;
  clientTag?: string;
  requestedModelAlias?: string;
  selectedSessionId?: string;
  fromSessionId?: string;
  toSessionId?: string;
  failureClass?: GatewayPoolFailureClass;
  reason?: string;
}

export interface GatewayRoutingRuleCondition {
  clientTag?: string;
  requestedModelAlias?: string;
}

export interface GatewayRoutingRuleTarget {
  dispatchMode?: GatewayRoutingDispatchMode;
  modelAlias?: string;
  sessionId?: string;
  poolId?: string;
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

export interface GatewayInferenceAuthClientMapping {
  name: string;
  apiKey: string;
  clientTag: string;
  enabled?: boolean;
  allowHeaderOverride?: boolean;
}

export type GatewayAccessConsumerType =
  | "local-owner"
  | "lan-member"
  | "public-user"
  | "system-client";

export type GatewayAccessStatus =
  | "enabled"
  | "paused"
  | "expired"
  | "rotated";

export interface GatewayAccessConsumer {
  id: string;
  name: string;
  type: GatewayAccessConsumerType;
  status: Exclude<GatewayAccessStatus, "rotated">;
  clientTag: string;
  note?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GatewayAccessKey {
  id: string;
  consumerId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  keySuffix: string;
  status: GatewayAccessStatus;
  expiresAt?: string;
  lastUsedAt?: string;
  lastUsedFromHash?: string;
  createdAt: string;
  rotatedAt?: string;
}

export interface GatewayAccessPolicy {
  consumerId: string;
  allowedModelAliases?: string[];
  allowedPoolIds?: string[];
  quota?: {
    dailyTokenLimit?: number;
    monthlyTokenLimit?: number;
    totalTokenLimit?: number;
    periodDays?: number;
    periodTokenLimit?: number;
    periodStartedAt?: string;
    resetTimezone?: string;
  };
  limits?: {
    requestsPerMinute?: number;
    maxConcurrentRequests?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    speedMultiplier?: number;
  };
  modelSwitching?: {
    enabled: boolean;
    defaultModelAlias?: string;
  };
  expiresAt?: string;
}

export interface GatewayAccessAlertThresholds {
  dailyQuotaWarningRatio?: number;
  runtimeWarningRatio?: number;
  failureRateWarningRatio?: number;
}

export interface GatewayAccessControlSettings {
  consumers?: GatewayAccessConsumer[];
  keys?: GatewayAccessKey[];
  policies?: GatewayAccessPolicy[];
  alertThresholds?: GatewayAccessAlertThresholds;
}

export interface GatewayAccessKeyPublic {
  id: string;
  consumerId: string;
  name: string;
  keyPrefix: string;
  keySuffix: string;
  status: GatewayAccessStatus;
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  rotatedAt?: string;
  hasKey: boolean;
}

export interface GatewayAccessControlPublicSettings {
  consumers: GatewayAccessConsumer[];
  keys: GatewayAccessKeyPublic[];
  policies: GatewayAccessPolicy[];
  alertThresholds?: GatewayAccessAlertThresholds;
}

export interface GatewayLanAccessSettings {
  enabled?: boolean;
}

export interface GatewayInferenceAuthSettings {
  mode?: GatewayInferenceAuthMode;
  apiKey?: string;
  resolveClientTagByApiKey?: boolean;
  clientMappings?: GatewayInferenceAuthClientMapping[];
  lanAccess?: GatewayLanAccessSettings;
  accessControl?: GatewayAccessControlSettings;
}

export interface GatewayInferenceAuthPublicClientMapping {
  name: string;
  clientTag: string;
  enabled: boolean;
  allowHeaderOverride: boolean;
  hasApiKey: boolean;
}

export interface GatewayInferenceAuthPublicSettings {
  mode: GatewayInferenceAuthMode;
  enabled: boolean;
  hasApiKey: boolean;
  resolveClientTagByApiKey: boolean;
  mappingCount: number;
  enabledMappingCount: number;
  clientMappings: GatewayInferenceAuthPublicClientMapping[];
  lanAccess: {
    enabled: boolean;
  };
  accessControl: GatewayAccessControlPublicSettings;
}

export interface GatewayRoutingPreviewInput {
  accessConsumerId?: string;
  clientTag?: string;
  requestedModelAlias?: string;
  currentModelAlias?: string;
  currentSessionId?: string;
}

export interface GatewayRoutingAccessDecision {
  status: "allowed" | "denied";
  reason: string;
  consumerId: string;
  consumerName?: string;
  consumerType?: GatewayAccessConsumerType;
  clientTag?: string;
  modelAlias?: string;
  poolId?: string;
  poolVisibility?: GatewayPoolVisibility;
  errorType?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface GatewayRoutingPreviewResult {
  enabled: boolean;
  matchedRuleId?: string;
  matchedRuleName?: string;
  resolvedModelAlias: string;
  resolvedSessionId?: string;
  resolvedPoolId?: string;
  reason: string;
  warnings: string[];
  selectionReason?: string;
  candidateCount?: number;
  rejectedCandidates?: GatewayPoolRejectedCandidate[];
  accessDecision?: GatewayRoutingAccessDecision;
}

export interface GatewayPoolRejectedCandidate {
  selector: string;
  label?: string;
  sessionId?: string;
  reason: string;
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

export interface GatewayUsageCounters {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export type GatewayUsageClientFilter =
  | "all"
  | "openclaw"
  | "hermes"
  | "other";

export interface GatewayUsageEvent {
  timestamp: number;
  sessionId?: string;
  accountId?: string;
  email?: string;
  clientTag?: string;
  consumerId?: string;
  accessKeyId?: string;
  poolId?: string;
  providerId: string;
  modelAlias: string;
  upstreamModelId?: string;
  success: boolean;
  stream: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cachedTokensPresent?: boolean;
  reasoningTokensPresent?: boolean;
  sourceKind?: string;
  sourceEventKey?: string;
}

export interface GatewayUsageAccountSummary {
  accountId: string;
  email?: string;
  usage: GatewayUsageCounters;
  updatedAt?: number;
}

export interface GatewayUsageClientSummary {
  clientTag: string;
  usage: GatewayUsageCounters;
  updatedAt?: number;
}

export interface GatewayUsageConsumerSummary {
  consumerId: string;
  accessKeyId?: string;
  clientTag?: string;
  usage: GatewayUsageCounters;
  updatedAt?: number;
}

export interface GatewayUsageConsumerTimelinePoint {
  bucketStart: number;
  bucketEnd: number;
  consumerId: string;
  accessKeyId?: string;
  clientTag?: string;
  usage: GatewayUsageCounters;
}

export interface GatewayUsageModelTimelinePoint {
  bucketStart: number;
  bucketEnd: number;
  modelAlias: string;
  usage: GatewayUsageCounters;
}

export interface GatewayUsageAccessKeyTimelinePoint {
  bucketStart: number;
  bucketEnd: number;
  accessKeyId: string;
  consumerId?: string;
  clientTag?: string;
  usage: GatewayUsageCounters;
}

export interface GatewayUsagePoolTimelinePoint {
  bucketStart: number;
  bucketEnd: number;
  poolId: string;
  clientTag?: string;
  usage: GatewayUsageCounters;
}

export interface GatewayUsageAccessKeySummary {
  accessKeyId: string;
  consumerId?: string;
  clientTag?: string;
  usage: GatewayUsageCounters;
  updatedAt?: number;
}

export interface GatewayUsagePoolSummary {
  poolId: string;
  clientTag?: string;
  usage: GatewayUsageCounters;
  updatedAt?: number;
}

export interface GatewayUsageModelSummary {
  modelAlias: string;
  usage: GatewayUsageCounters;
  updatedAt?: number;
}

export interface GatewayUsageWindowSummary {
  since: number;
  updatedAt: number;
  totals: GatewayUsageCounters;
  cachedSignalCount: number;
  reasoningSignalCount: number;
  importedEventCount: number;
  accounts: GatewayUsageAccountSummary[];
  clients: GatewayUsageClientSummary[];
  consumers: GatewayUsageConsumerSummary[];
  consumerTimeline?: GatewayUsageConsumerTimelinePoint[];
  modelTimeline?: GatewayUsageModelTimelinePoint[];
  accessKeyTimeline?: GatewayUsageAccessKeyTimelinePoint[];
  poolTimeline?: GatewayUsagePoolTimelinePoint[];
  accessKeys: GatewayUsageAccessKeySummary[];
  pools: GatewayUsagePoolSummary[];
  models: GatewayUsageModelSummary[];
}

export interface GatewayUsageObservability {
  clientFilter: GatewayUsageClientFilter;
  history: GatewayUsageWindowSummary;
  daily: GatewayUsageWindowSummary;
  weekly: GatewayUsageWindowSummary;
  monthly: GatewayUsageWindowSummary;
}

export type GatewayAccessAlertSeverity = "info" | "warning" | "critical";

export interface GatewayAccessAlertEvent {
  id?: number;
  timestamp: number;
  severity: GatewayAccessAlertSeverity;
  consumerId?: string;
  accessKeyId?: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  dedupeKey?: string;
  occurrenceCount?: number;
  lastSeenAt?: number;
}

export interface GatewayAccessAlertAcknowledgeAllResult {
  updatedCount: number;
  acknowledgedAt: number;
  acknowledgedBy: string;
}

export interface GatewayAccessAlertClearAcknowledgedResult {
  deletedCount: number;
}

export interface GatewayAccessAlertList {
  events: GatewayAccessAlertEvent[];
}

export interface DesktopSystemSettings {
  launchAtLogin?: boolean;
  autoRefreshIntervalSeconds?: number;
  gatewayPort?: number;
  pinnedSessionId?: string;
}

export type SessionStatus = "available" | "expired" | "invalid";
export type SessionSourceKind = "openclaw" | "local-import";
export type CredentialRefreshMode = "managed" | "external-readonly";

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
  credentialRefreshMode?: CredentialRefreshMode;
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
  recentByClientTag1h?: SessionClientTagActivitySnapshot[];
  recentRequestCount24h?: number;
  recentByClientTag24h?: SessionClientTagActivitySnapshot[];
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
  usageObservability?: GatewayUsageObservability;
  poolObservability?: GatewayPoolObservability[];
  inferenceObservability?: GatewayInferenceObservability;
  inferenceAuth?: GatewayInferenceAuthPublicSettings;
}

export interface GatewayInferenceObservability {
  inFlightCount: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  currentSessionId?: string;
  currentPoolId?: string;
  currentClientTag?: string;
  currentModelAlias?: string;
  accessConsumers?: Array<{
    consumerId: string;
    recentRequestCount1m: number;
    inFlightCount: number;
    requestsPerMinute?: number;
    maxConcurrentRequests?: number;
  }>;
  blockedClients?: Array<{
    clientTag: string;
    retryAfterSeconds: number;
    lastFailureClass?: GatewayPoolFailureClass;
    lastFailureAt?: number;
  }>;
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
    const trimmed = value.trim();
    if (
      /^bearer\s+[a-z0-9._\-+/=]{12,}$/i.test(trimmed) ||
      /^(sk|sess|rt|at)-[a-z0-9._-]{10,}$/i.test(trimmed) ||
      (/^[a-z0-9+/_=-]{80,}$/i.test(trimmed) &&
        /[a-z]/.test(trimmed) &&
        /\d/.test(trimmed))
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
          /(token|authorization|api[-_]?key|cookie|secret|password|refresh[_-]?token|access[_-]?token)/i.test(
            key,
          )
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
