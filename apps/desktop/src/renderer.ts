import { buildCodexAccountGroups } from "./account-groups.js";
import {
  CODEX_MODEL_ALIAS_PRESETS,
  formatCodexUpstreamModelLabel,
  SUPPORTED_CODEX_UPSTREAM_MODELS,
  type SupportedCodexUpstreamModel,
} from "./codex-models.js";
import {
  buildAccountActivitySummary,
  formatQuotaWindowLabel,
  getAvatarToneIndex,
  getQuotaPercentage,
  getQuotaToneClass,
  getSessionTitle,
  sortAccountGroups,
  type AccountSortDirection,
  type AccountSortKey,
} from "./account-view-model.js";
import {
  buildRuntimeDiagnostics,
  normalizeErrorMessage,
  type RuntimeDiagnostic,
  type RuntimeDiagnosticLoadFailure,
} from "./runtime-diagnostics.js";
import {
  collectAccountDeletionTargets,
  normalizeAccountSelection,
} from "./account-bulk-actions.js";
import {
  deleteSelectedPools,
  normalizePoolSelection,
} from "./pool-bulk-actions.js";
import {
  buildAccessPolicyAlertRules,
  buildAccessPolicyErrorSummaryRule,
  buildAccessPolicyRuntimeSnapshot,
  buildAccessPolicyUsageSnapshot,
} from "./access-policy-usage.js";

const ACTIVE_VIEW_STORAGE_KEY = "local-ai-gateway.desktop.active-view";
const COLLAPSED_GROUPS_STORAGE_KEY =
  "local-ai-gateway.desktop.collapsed-groups";
const EXPANDED_GROUPS_STORAGE_KEY = "local-ai-gateway.desktop.expanded-groups";
const STALE_QUOTA_AFTER_REFRESH_ERROR_MS = 15 * 60_000;

declare global {
  interface Window {
    localAIGateway?: {
      getHealth: () => Promise<DashboardHealth>;
      getProviders: () => Promise<DashboardProviders>;
      getUsageSummary: (
        clientFilter?: UsageClientFilter,
      ) => Promise<UsageSummaryResponse>;
      getAccessAlerts: () => Promise<AccessAlertListResponse>;
      acknowledgeAccessAlert: (
        id: number,
      ) => Promise<{ ok: boolean; data: AccessAlertEvent }>;
      acknowledgeAllAccessAlerts: () => Promise<AccessAlertAcknowledgeAllResponse>;
      clearAcknowledgedAccessAlerts: () => Promise<AccessAlertClearAcknowledgedResponse>;
      getProviderSettings: () => Promise<ProviderSettingsResponse>;
      saveProviderSettings: (
        payload: ProviderSettings,
      ) => Promise<{ ok: boolean; requiresRestart: boolean }>;
      getRoutingSettings: () => Promise<RoutingSettingsResponse>;
      saveRoutingSettings: (
        payload: RoutingSettings,
      ) => Promise<{ ok: boolean; data: RoutingSettings }>;
      previewRouting: (
        payload: RoutingPreviewInput,
      ) => Promise<RoutingPreviewResponse>;
      getPoolSettings: () => Promise<PoolSettingsResponse>;
      savePoolSettings: (
        payload: PoolSettings,
      ) => Promise<{ ok: boolean; data: PoolSettings }>;
      getSecuritySettings: () => Promise<SecuritySettingsResponse>;
      saveSecuritySettings: (
        payload: SecuritySettingsInput,
      ) => Promise<SecuritySettingsResponse>;
      getSystemSettings: () => Promise<SystemSettingsResponse>;
      saveSystemSettings: (
        payload: SystemSettings,
      ) => Promise<SystemSettingsResponse>;
      getAppDataStatus: () => Promise<AppDataStatusResponse>;
      exportAppData: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        selectedPath?: string;
        fileCount?: number;
        totalBytes?: number;
      }>;
      previewImportAppData: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        data?: {
          selectedPath: string;
          fileName: string;
          exportedAt?: string;
          appVersion?: string;
          fileCount: number;
          totalBytes: number;
        };
      }>;
      importAppData: (selectedPath?: string) => Promise<{
        ok: boolean;
        canceled?: boolean;
        selectedPath?: string;
        safetyBackupPath?: string;
        restoredFiles?: number;
        restoredBytes?: number;
        managedRestarted?: boolean;
        requiresManualRestart?: boolean;
      }>;
      openBackupsFolder: () => Promise<string>;
      getSessions: () => Promise<DashboardSessions>;
      setActiveSession: (sessionId: string) => Promise<any>;
      refreshSessionUsage: (
        sessionId?: string,
      ) => Promise<SessionUsageRefreshResponse>;
      resetTelemetry?: () => Promise<{ ok: boolean; reset: boolean }>;
      deleteCodexAccount: (sessionId: string) => Promise<{
        ok: boolean;
        data: {
          removed: boolean;
          profileId: string;
          filePath: string;
          poolCleanup?: {
            removedMemberCount: number;
            affectedPoolIds: string[];
          };
        };
      }>;
      restartGateway: () => Promise<any>;
      copyOpenClawSnippet: () => Promise<any>;
      copyText?: (text: string) => Promise<{ ok: boolean }>;
      openLogs: () => Promise<any>;
      loginCodexOAuth: () => Promise<{
        ok: boolean;
        data: {
          sessionId: string;
          profileId: string;
          accountId?: string;
          filePath: string;
        };
      }>;
      submitCodexOAuthInput: (input: string) => Promise<{ ok: boolean }>;
      cancelCodexOAuth: () => Promise<{ ok: boolean }>;
      importCodexJson: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        imported?: number;
        updated?: number;
        profileIds?: string[];
        selectedPath?: string;
      }>;
      importAccountConfig: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        imported?: number;
        updated?: number;
        skipped?: number;
        profileIds?: string[];
        selectedPath?: string;
      }>;
      importOpenClawSession: (sessionId: string) => Promise<{
        ok: boolean;
        data: {
          sessionId: string;
          profileId: string;
          accountId?: string;
          filePath: string;
        };
      }>;
    };
  }
}

type ProviderConfigurationStatus = "active" | "disabled" | "incomplete";
type UsageClientFilter = "all" | "openclaw" | "hermes" | "other";
type UsageObserveWindow = "history" | "daily" | "weekly" | "monthly";

type UsageCounters = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
};

type UsageAccountSummary = {
  accountId: string;
  email?: string;
  updatedAt?: number;
  usage: UsageCounters;
};

type UsageClientSummary = {
  clientTag: string;
  updatedAt?: number;
  usage: UsageCounters;
};

type UsageConsumerSummary = {
  consumerId: string;
  accessKeyId?: string;
  clientTag?: string;
  updatedAt?: number;
  usage: UsageCounters;
};

type UsageConsumerTimelinePoint = {
  bucketStart: number;
  bucketEnd: number;
  consumerId: string;
  accessKeyId?: string;
  clientTag?: string;
  usage: UsageCounters;
};

type UsageAccessKeySummary = {
  accessKeyId: string;
  consumerId?: string;
  clientTag?: string;
  updatedAt?: number;
  usage: UsageCounters;
};

type UsagePoolSummary = {
  poolId: string;
  clientTag?: string;
  updatedAt?: number;
  usage: UsageCounters;
};

type UsageModelSummary = {
  modelAlias: string;
  updatedAt?: number;
  usage: UsageCounters;
};

type UsageWindowSummary = {
  since: number;
  updatedAt: number;
  totals: UsageCounters;
  cachedSignalCount: number;
  reasoningSignalCount: number;
  importedEventCount: number;
  accounts: UsageAccountSummary[];
  clients: UsageClientSummary[];
  consumers: UsageConsumerSummary[];
  consumerTimeline?: UsageConsumerTimelinePoint[];
  accessKeys: UsageAccessKeySummary[];
  pools: UsagePoolSummary[];
  models: UsageModelSummary[];
};

type UsageObservability = {
  clientFilter: UsageClientFilter;
  history: UsageWindowSummary;
  daily: UsageWindowSummary;
  weekly: UsageWindowSummary;
  monthly: UsageWindowSummary;
};

type UsageSummaryResponse = {
  ok: boolean;
  data: UsageObservability;
};

type AccessAlertEvent = {
  id?: number;
  timestamp: number;
  severity: "info" | "warning" | "critical";
  consumerId?: string;
  accessKeyId?: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  occurrenceCount?: number;
  lastSeenAt?: number;
};

type AccessAlertListResponse = {
  ok: boolean;
  data: {
    events: AccessAlertEvent[];
  };
};

type AccessAlertAcknowledgeAllResponse = {
  ok: boolean;
  data: {
    updatedCount: number;
    acknowledgedAt: number;
    acknowledgedBy: string;
  };
};

type AccessAlertClearAcknowledgedResponse = {
  ok: boolean;
  data: {
    deletedCount: number;
  };
};

type DashboardHealth = {
  ok: boolean;
  managed: boolean;
  version: string;
  host?: string;
  port?: number;
  desktopNetwork?: {
    localNetworkAddresses?: string[];
    lanBaseUrl?: string;
  };
  defaultModel?: string;
  openclaw?: { baseUrl?: string; provider?: string; model?: string };
  recentErrors?: Array<{
    level: string;
    message: string;
    details?: Record<string, unknown>;
    createdAt: string;
  }>;
  providerConfigurations?: Array<{
    id: string;
    label: string;
    status: ProviderConfigurationStatus;
    registered: boolean;
    source: "openclaw-session" | "environment" | "config-file";
    configuredVia: string;
    authMode: "oauth-session" | "api-key" | "none";
    baseUrl?: string;
    envKeys: string[];
    missingEnvKeys?: string[];
    notes?: string[];
  }>;
  defaultSelection?: {
    alias: string;
    provider: string;
    reason: string;
    overridden: boolean;
  };
  inferenceAuth?: {
    mode: "none" | "api-key";
    enabled: boolean;
    hasApiKey: boolean;
    resolveClientTagByApiKey?: boolean;
    mappingCount?: number;
    enabledMappingCount?: number;
    lanAccess?: {
      enabled: boolean;
    };
  };
  inferenceObservability?: {
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
  };
  usageObservability?: UsageObservability;
  routingObservability?: {
    totalMatched: number;
    matchedLast5m: number;
    matchedLast1h: number;
    matchedLast24h: number;
    lastMatchedAt?: number;
    byRule: Array<{
      ruleId: string;
      ruleName: string;
      hits: number;
      lastMatchedAt?: number;
    }>;
    byClientTag: Array<{
      clientTag: string;
      hits: number;
      lastMatchedAt?: number;
    }>;
    recent: Array<{
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
    }>;
  };
  poolObservability?: Array<{
    poolId: string;
    poolName: string;
    enabled: boolean;
    selectionStrategy?: PoolDefinition["selectionStrategy"];
    selectedSessionId?: string;
    selectedSelector?: string;
    selectionReason?: string;
    memberCount: number;
    eligibleMemberCount: number;
    coolingMemberCount: number;
    lastSelectedAt?: number;
    lastFailureAt?: number;
    warnings: string[];
    recentEvents?: Array<{
      timestamp: number;
      poolId: string;
      poolName: string;
      eventType: "selected" | "failover";
      clientTag?: string;
      requestedModelAlias?: string;
      selectedSessionId?: string;
      fromSessionId?: string;
      toSessionId?: string;
      failureClass?:
        | "auth_invalid"
        | "quota_exhausted"
        | "rate_limited"
        | "network_retryable"
        | "upstream_retryable"
        | "non_retryable";
      reason?: string;
    }>;
    members: Array<{
      selector: string;
      label?: string;
      sessionId?: string;
      sessionTitle?: string;
      sessionSubtitle?: string;
      quotaPercentage?: number;
      resetAt?: number;
      eligible: boolean;
      selected: boolean;
      status:
        | "available"
        | "cooldown"
        | "quota-low"
        | "expired"
        | "invalid"
        | "missing"
        | "disabled"
        | "unknown-quota";
      statusLabel: string;
      note?: string;
      cooldownUntil?: number;
      lastSelectedAt?: number;
      lastSuccessAt?: number;
      lastFailureAt?: number;
      lastFailureClass?:
        | "auth_invalid"
        | "quota_exhausted"
        | "rate_limited"
        | "network_retryable"
        | "upstream_retryable"
        | "non_retryable";
      consecutiveFailures: number;
    }>;
  }>;
};

type StartupCheckTone = "active" | "neutral" | "incomplete" | "disabled";

type StartupCheckItem = {
  title: string;
  description: string;
  badgeTone: StartupCheckTone;
  badgeLabel: string;
};

type DashboardSessions = {
  activeSessionId?: string;
  data: Array<{
    id: string;
    agentId: string;
    profileId: string;
    accountId?: string;
    displayName?: string;
    email?: string;
    planType?: string;
    quota?: {
      scope?: "hourly" | "weekly";
      percentage?: number;
      resetAt?: number;
      windowMinutes?: number;
      updatedAt?: number;
    };
    activity?: {
      requestCount: number;
      successCount: number;
      failureCount: number;
      streamCount: number;
      nonStreamCount: number;
      byClientTag?: Array<{
        clientTag: string;
        requestCount: number;
        successCount: number;
        failureCount: number;
        lastRequestAt?: number;
      }>;
      recentRequestCount5m?: number;
      recentByClientTag5m?: Array<{
        clientTag: string;
        requestCount: number;
        successCount: number;
        failureCount: number;
        lastRequestAt?: number;
      }>;
      recentRequestCount1h?: number;
      recentByClientTag1h?: Array<{
        clientTag: string;
        requestCount: number;
        successCount: number;
        failureCount: number;
        lastRequestAt?: number;
      }>;
      recentRequestCount24h?: number;
      recentByClientTag24h?: Array<{
        clientTag: string;
        requestCount: number;
        successCount: number;
        failureCount: number;
        lastRequestAt?: number;
      }>;
      lastRequestAt?: number;
      lastSuccessAt?: number;
      lastFailureAt?: number;
      lastError?: string;
    };
    status: "available" | "expired" | "invalid";
    expiresAt?: number;
    sourceKind?: "openclaw" | "local-import";
    sourceLabel?: string;
    sourcePath: string;
    credentialRefreshMode?: "managed" | "external-readonly";
  }>;
};

type DashboardProviders = {
  data: Array<{
    id: string;
    label: string;
    usesSessions: boolean;
    activeSessionId?: string;
    configuration?: {
      source: "openclaw-session" | "environment" | "config-file";
      configuredVia: string;
      authMode: "oauth-session" | "api-key" | "none";
      baseUrl?: string;
      envKeys: string[];
      notes?: string[];
    };
    models: Array<{
      alias: string;
      providerModelId: string;
      displayName: string;
    }>;
  }>;
};

type ProviderSettings = {
  defaultModelAlias?: string;
  codex?: {
    upstreamModel?: string;
    exposedModels?: string[];
  };
  openAICompatible?: {
    enabled?: boolean;
    label?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    alias?: string;
    displayName?: string;
  };
  ollama?: {
    enabled?: boolean;
    label?: string;
    baseUrl?: string;
    model?: string;
    alias?: string;
    displayName?: string;
  };
};

type ProviderSettingsResponse = {
  data: ProviderSettings;
};

type RoutingRule = {
  id: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  when?: {
    clientTag?: string;
    requestedModelAlias?: string;
  };
  target?: {
    dispatchMode?: "active-session" | "fixed-session" | "dynamic-pool";
    modelAlias?: string;
    sessionId?: string;
    poolId?: string;
  };
};

type RoutingDispatchMode = "active-session" | "fixed-session" | "dynamic-pool";

type RoutingSettings = {
  enabled?: boolean;
  rules?: RoutingRule[];
};

type RoutingSettingsResponse = {
  data: RoutingSettings;
};

type RoutingPreviewInput = {
  accessConsumerId?: string;
  clientTag?: string;
  requestedModelAlias?: string;
  currentModelAlias?: string;
  currentSessionId?: string;
};

type RoutingPreviewResponse = {
  ok: boolean;
  data: {
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
    rejectedCandidates?: Array<{
      selector: string;
      label?: string;
      sessionId?: string;
      reason: string;
    }>;
    accessDecision?: {
      status: "allowed" | "denied";
      reason: string;
      consumerId: string;
      consumerName?: string;
      consumerType?: SecurityAccessConsumer["type"];
      clientTag?: string;
      modelAlias?: string;
      poolId?: string;
      poolVisibility?: PoolDefinition["visibility"];
      errorType?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
  };
};

type PoolDefinition = {
  id: string;
  name: string;
  enabled?: boolean;
  description?: string;
  visibility?: "private" | "shared-lan" | "public-ready";
  members?: Array<{
    selector: string;
    label?: string;
    enabled?: boolean;
    priority?: number;
  }>;
  selectionStrategy?:
    | "priority"
    | "quota-desc"
    | "least-recently-used"
    | "hybrid";
  minRemainingPercentage?: number;
  allowUnknownQuota?: boolean;
  cooldownSeconds?: number;
  quotaExhaustedCooldownSeconds?: number;
  maxRetryCandidates?: number;
  fallbackToActiveSession?: boolean;
};

type PoolSettings = {
  enabled?: boolean;
  pools?: PoolDefinition[];
};

type PoolSettingsResponse = {
  ok: boolean;
  data: PoolSettings;
};

type PoolMemberCandidateView = {
  selector: string;
  title: string;
  subtitle: string;
  quotaPercentage?: number;
  quotaLabel: string;
  quotaToneClass: string;
  resetAt?: number;
  resetLabel: string;
  statusLabel: string;
  statusToneClass: string;
  matchers: string[];
};

type PoolRuntimeMember = NonNullable<
  NonNullable<DashboardHealth["poolObservability"]>[number]["members"]
>[number];

type PoolRuntimeSummary = NonNullable<
  DashboardHealth["poolObservability"]
>[number];

type PoolMemberSortKey = "quota" | "resetAt" | "name";
type PoolMemberSortDirection = "asc" | "desc";
type PoolMemberPanelState = {
  search: string;
  sortKey: PoolMemberSortKey;
  sortDirection: PoolMemberSortDirection;
  collapsed: boolean;
  cardCollapsed: boolean;
};

function normalizePoolVisibility(
  visibility?: PoolDefinition["visibility"],
): NonNullable<PoolDefinition["visibility"]> {
  return visibility === "shared-lan" || visibility === "public-ready"
    ? visibility
    : "private";
}

function formatPoolVisibilityLabel(
  visibility?: PoolDefinition["visibility"],
): string {
  const normalized = normalizePoolVisibility(visibility);
  if (normalized === "shared-lan") {
    return "局域网共享";
  }
  if (normalized === "public-ready") {
    return "外网预留";
  }
  return "私有";
}

type SecuritySettingsInput = {
  mode?: "none" | "api-key";
  apiKey?: string;
  resolveClientTagByApiKey?: boolean;
  clientMappings?: SecurityClientMappingInput[];
  lanAccess?: {
    enabled?: boolean;
  };
  accessControl?: SecurityAccessControlInput;
};

type SecurityClientMappingInput = {
  name: string;
  apiKey: string;
  clientTag: string;
  enabled?: boolean;
  allowHeaderOverride?: boolean;
};

type SecurityClientMapping = {
  name: string;
  clientTag: string;
  enabled: boolean;
  allowHeaderOverride: boolean;
  hasApiKey: boolean;
  draftApiKey?: string;
};

type SecurityAccessConsumer = {
  id: string;
  name: string;
  type: "local-owner" | "lan-member" | "public-user" | "system-client";
  status: "enabled" | "paused" | "expired";
  clientTag: string;
  note?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

type SecurityAccessKey = {
  id: string;
  consumerId: string;
  name: string;
  keyPrefix: string;
  keySuffix: string;
  status: "enabled" | "paused" | "expired" | "rotated";
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  rotatedAt?: string;
  hasKey: boolean;
};

type SecurityAccessKeyInput = SecurityAccessKey & {
  apiKey?: string;
};

type SecurityAccessPolicy = {
  consumerId: string;
  allowedModelAliases?: string[];
  allowedPoolIds?: string[];
  quota?: {
    dailyTokenLimit?: number;
    monthlyTokenLimit?: number;
    totalTokenLimit?: number;
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
};

type SecurityAccessControl = {
  consumers: SecurityAccessConsumer[];
  keys: SecurityAccessKey[];
  policies: SecurityAccessPolicy[];
};

type SecurityAccessControlInput = {
  consumers: SecurityAccessConsumer[];
  keys: SecurityAccessKeyInput[];
  policies: SecurityAccessPolicy[];
};

type SecuritySettings = {
  mode: "none" | "api-key";
  enabled: boolean;
  hasApiKey: boolean;
  resolveClientTagByApiKey: boolean;
  mappingCount: number;
  enabledMappingCount: number;
  clientMappings: SecurityClientMapping[];
  lanAccess: {
    enabled: boolean;
  };
  accessControl: SecurityAccessControl;
};

type SecuritySettingsResponse = {
  ok: boolean;
  data: SecuritySettings;
};

type SessionUsageRefreshResponse = {
  ok: boolean;
  refreshed: number;
  failed: number;
  data: Array<{
    sessionId: string;
    accountId?: string;
    sourceKind?: "openclaw" | "local-import";
    planType?: string;
    quota?: {
      scope?: "hourly" | "weekly";
      percentage?: number;
      resetAt?: number;
      windowMinutes?: number;
      updatedAt?: number;
    };
  }>;
  errors: Array<{
    sessionId: string;
    message: string;
  }>;
};

type SystemSettings = {
  launchAtLogin?: boolean;
  autoRefreshIntervalSeconds?: number;
  gatewayPort?: number;
  pinnedSessionId?: string;
};

type SystemSettingsResponse = {
  ok: boolean;
  data: SystemSettings;
};

type AppDataStatus = {
  rootDir: string;
  backupDir: string;
  fileCount: number;
  totalBytes: number;
  latestBackup?: {
    path: string;
    fileName: string;
    createdAt?: number;
    sizeBytes?: number;
  };
};

type AppDataStatusResponse = {
  ok: boolean;
  data: AppDataStatus;
};

type DashboardView =
  | "overview"
  | "access"
  | "accounts"
  | "routing"
  | "pools"
  | "models"
  | "usage"
  | "system";
type IntegrationTemplateKey = "openclaw" | "hermes" | "curl";
type RoutingObserveWindow = "5m" | "1h" | "24h";
const state: {
  health?: DashboardHealth;
  providers?: DashboardProviders;
  usageSummary?: UsageObservability;
  accessAlerts?: AccessAlertEvent[];
  sessions?: DashboardSessions;
  settings?: ProviderSettings;
  routingSettings?: RoutingSettings;
  poolSettings?: PoolSettings;
  securitySettings?: SecuritySettings;
  systemSettings?: SystemSettings;
  appDataStatus?: AppDataStatus;
  oauthInFlight?: boolean;
  lastUsageRefresh?: SessionUsageRefreshResponse;
  activeView: DashboardView;
  accountSearch: string;
  accountSortKey: AccountSortKey;
  accountSortDirection: AccountSortDirection;
  backgroundRefreshInFlight?: boolean;
  sessionPulseInFlight?: boolean;
  isViewStackScrolling?: boolean;
  lastViewStackScrollAt?: number;
  pendingVisibleRefresh?: boolean;
  runtimeDiagnostics: RuntimeDiagnostic[];
  usageClientFilter: UsageClientFilter;
  usageObserveWindow: UsageObserveWindow;
  routingClientFilter: string;
  routingObserveWindow: RoutingObserveWindow;
  activePoolEventsModalId?: string;
  usageDetailsModalOpen?: boolean;
  selectedAccessConsumerId?: string;
} = {
  activeView: "overview",
  accountSearch: "",
  accountSortKey: "quota",
  accountSortDirection: "desc",
  runtimeDiagnostics: [],
  usageClientFilter: "all",
  usageObserveWindow: "daily",
  routingClientFilter: "all",
  routingObserveWindow: "5m",
};

let autoRefreshTimer: number | undefined;
let sessionActivityTimer: number | undefined;
let viewStackScrollIdleTimer: number | undefined;
let visibleRefreshFrame: number | undefined;
let accountRenderFrame: number | undefined;
let accountRenderToken = 0;
const poolMemberFieldFrames = new Map<string, number>();
const poolMemberPanelState = new Map<string, PoolMemberPanelState>();
const selectedAccountKeys = new Set<string>();
const selectedPoolIds = new Set<string>();
let pendingConfirmResolver: ((confirmed: boolean) => void) | undefined;

function getGatewayApi() {
  const api = window.localAIGateway;
  if (!api) {
    throw new Error(
      "Electron preload 未成功注入，桌面桥接不可用。请重启桌面端。",
    );
  }
  return api;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderActionIcon(
  type: "activate" | "active" | "pin" | "unpin" | "refresh" | "delete",
): string {
  if (type === "activate") {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.75a6.25 6.25 0 1 1 0 12.5A6.25 6.25 0 0 1 8 1.75Zm0 1.5A4.75 4.75 0 1 0 8 12.75 4.75 4.75 0 0 0 8 3.25Z" fill="currentColor"/>
        <path d="M8 5.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Zm0 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" fill="currentColor"/>
      </svg>
    `;
  }
  if (type === "active") {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.25A6.75 6.75 0 1 0 14.75 8 6.76 6.76 0 0 0 8 1.25Zm3.14 5.47-3.6 4.18a.75.75 0 0 1-1.1.06L4.8 9.45a.75.75 0 1 1 1.02-1.1l1.06.98 3.12-3.62a.75.75 0 1 1 1.14 1.01Z" fill="currentColor"/>
      </svg>
    `;
  }
  if (type === "pin") {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M10.9 1.75a.75.75 0 0 1 .53 1.28l-.86.86 1.57 1.57.86-.86a.75.75 0 1 1 1.06 1.06l-2.6 2.6a2 2 0 0 1-.57.4l-1.62.64-2.92 2.92a.75.75 0 0 1-1.06 0l-.11-.11-.88 2.06a.75.75 0 0 1-1.39-.6l1.11-2.61a.75.75 0 0 1 .74-.46l1.88-1.88-1.85-1.85a.75.75 0 0 1 0-1.06l2.92-2.92.64-1.62a2 2 0 0 1 .4-.57l2.6-2.6a.75.75 0 0 1 .53-.22Z" fill="currentColor"/>
      </svg>
    `;
  }
  if (type === "unpin") {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M10.9 1.75a.75.75 0 0 1 .53 1.28l-.86.86 1.57 1.57.86-.86a.75.75 0 1 1 1.06 1.06l-2.6 2.6a2 2 0 0 1-.57.4l-1.62.64-2.92 2.92a.75.75 0 0 1-1.06 0L3.8 10.9a.75.75 0 0 1 0-1.06l2.92-2.92.64-1.62a2 2 0 0 1 .4-.57l2.6-2.6a.75.75 0 0 1 .53-.22Z" fill="currentColor"/>
        <path d="M2.47 2.47a.75.75 0 0 1 1.06 0l10 10a.75.75 0 0 1-1.06 1.06l-10-10a.75.75 0 0 1 0-1.06Z" fill="currentColor"/>
      </svg>
    `;
  }
  if (type === "refresh") {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M13.25 2.75a.75.75 0 0 1 .75.75v2.9a.75.75 0 0 1-.75.75h-2.9a.75.75 0 1 1 0-1.5h1.02a4.75 4.75 0 1 0 1.02 4.36.75.75 0 0 1 1.46.34A6.25 6.25 0 1 1 12 4.58V3.5a.75.75 0 0 1 .75-.75Z" fill="currentColor"/>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.25 2A1.25 1.25 0 0 0 4 3.25V4H2.75a.75.75 0 0 0 0 1.5H3v7.25C3 13.44 3.56 14 4.25 14h7.5c.69 0 1.25-.56 1.25-1.25V5.5h.25a.75.75 0 0 0 0-1.5H12v-.75A1.25 1.25 0 0 0 10.75 2h-5.5Zm1.5 3a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-1.5 0v-5A.75.75 0 0 1 6.75 5Zm3.25.75a.75.75 0 0 0-1.5 0v5a.75.75 0 0 0 1.5 0v-5Z" fill="currentColor"/>
    </svg>
  `;
}

function getClientTagToneIndex(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash) % 12;
}

function normalizeClientTagLabel(clientTag: string): string {
  return clientTag === "unknown" ? "未标记" : clientTag;
}

function routingWindowLabel(window: RoutingObserveWindow): string {
  if (window === "1h") {
    return "1 小时命中";
  }
  if (window === "24h") {
    return "24 小时命中";
  }
  return "5 分钟命中";
}

function getRoutingWindowCount(
  routing: DashboardHealth["routingObservability"],
  window: RoutingObserveWindow,
): number {
  if (!routing) {
    return 0;
  }
  if (window === "1h") {
    return routing.matchedLast1h ?? routing.matchedLast5m;
  }
  if (window === "24h") {
    return (
      routing.matchedLast24h ?? routing.matchedLast1h ?? routing.matchedLast5m
    );
  }
  return routing.matchedLast5m;
}

function usageWindowLabel(window: UsageObserveWindow): string {
  if (window === "history") {
    return "历史累计";
  }
  if (window === "weekly") {
    return "近 7 天";
  }
  if (window === "monthly") {
    return "近 30 天";
  }
  return "近 24 小时";
}

function usageClientFilterLabel(filter: UsageClientFilter): string {
  if (filter === "openclaw") {
    return "OpenClaw";
  }
  if (filter === "hermes") {
    return "Hermes";
  }
  if (filter === "other") {
    return "其他客户端";
  }
  return "全部客户端";
}

function getActiveUsageWindowSummary(): UsageWindowSummary | undefined {
  const summary = state.usageSummary;
  if (!summary) {
    return undefined;
  }
  if (state.usageObserveWindow === "history") {
    return summary.history;
  }
  if (state.usageObserveWindow === "weekly") {
    return summary.weekly;
  }
  if (state.usageObserveWindow === "monthly") {
    return summary.monthly;
  }
  return summary.daily;
}

function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  }
  if (abs >= 10_000) {
    return `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  }
  return String(Math.round(value));
}

function formatUsageLatency(usage: UsageCounters): string {
  if (!usage.successCount) {
    return "暂无";
  }
  const seconds = usage.totalLatencyMs / usage.successCount / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

function formatUsageSuccessRate(usage: UsageCounters): string {
  if (!usage.requestCount) {
    return "暂无";
  }
  return `${Math.round((usage.successCount / usage.requestCount) * 100)}%`;
}

function normalizeUsageClientTagLabel(clientTag: string): string {
  if (!clientTag || clientTag === "unknown") {
    return "未标记";
  }
  if (clientTag === "openclaw") {
    return "OpenClaw";
  }
  if (clientTag === "hermes") {
    return "Hermes";
  }
  if (clientTag === "localraghub") {
    return "localRagHub";
  }
  return clientTag;
}

function formatUsageHourLabel(value: number): string {
  return `${String(new Date(value).getHours()).padStart(2, "0")}:00`;
}

function getAccessConsumerDisplayName(consumerId: string, clientTag?: string): string {
  const consumer = state.securitySettings?.accessControl?.consumers.find(
    (item) => item.id === consumerId,
  );
  return consumer?.name || clientTag || consumerId;
}

function renderClientTagBadges(
  rows: Array<{ clientTag: string; requestCount: number }>,
): string {
  if (!rows.length) {
    return `<span style="font-size: 14px; color: var(--text-tertiary);">暂无来源明细</span>`;
  }

  return rows
    .slice(0, 4)
    .map((item) => {
      const label = normalizeClientTagLabel(item.clientTag);
      const tone = getClientTagToneIndex(label);
      return `<span class="client-tag-chip" data-tone="${tone}">${escapeHtml(label)} <em>${item.requestCount}次</em></span>`;
    })
    .join("");
}

function renderRecentClientTagBadges(
  rows: Array<{ clientTag: string; requestCount: number }>,
  total: number,
): string {
  return renderWindowClientTagBadges(rows, total, "最近 5 分钟暂无请求");
}

function renderWindowClientTagBadges(
  rows: Array<{ clientTag: string; requestCount: number }>,
  total: number,
  emptyLabel: string,
): string {
  if (!rows.length || total <= 0) {
    return `<span style="font-size: 14px; color: var(--text-tertiary);">${escapeHtml(emptyLabel)}</span>`;
  }

  return rows
    .slice(0, 4)
    .map((item) => {
      const label = normalizeClientTagLabel(item.clientTag);
      const tone = getClientTagToneIndex(label);
      const percentage = Math.max(
        1,
        Math.round((item.requestCount / total) * 100),
      );
      return `<span class="client-tag-chip recent" data-tone="${tone}">${escapeHtml(label)} <em>${percentage}%</em></span>`;
    })
    .join("");
}

function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
}

function formatBytes(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function setBanner(
  message: string,
  tone: "info" | "success" | "error" = "info",
): void {
  const node = document.getElementById("status-banner");
  if (!node) {
    return;
  }
  node.textContent = message;
  node.setAttribute("data-tone", tone);
}

function loadPersistedView(): DashboardView {
  try {
    const saved = window.localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY);
    if (
      saved === "overview" ||
      saved === "access" ||
      saved === "accounts" ||
      saved === "routing" ||
      saved === "pools" ||
      saved === "models" ||
      saved === "usage" ||
      saved === "system"
    ) {
      return saved;
    }
    if (saved === "providers") {
      return "models";
    }
    if (saved === "diagnostics") {
      return "system";
    }
  } catch {
    // ignore
  }
  return "overview";
}

function loadCollapsedGroupIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((item) => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function loadExpandedGroupIds(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_GROUPS_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((item) => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsedGroupIds(collapsedIds: Set<string>): void {
  try {
    localStorage.setItem(
      COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify(Array.from(collapsedIds)),
    );
  } catch {
    // ignore storage failures
  }
}

function saveExpandedGroupIds(expandedIds: Set<string>): void {
  try {
    localStorage.setItem(
      EXPANDED_GROUPS_STORAGE_KEY,
      JSON.stringify(Array.from(expandedIds)),
    );
  } catch {
    // ignore storage failures
  }
}

function initCollapsibleSettingsGroups(): void {
  const groups = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".settings-group, .provider-config-panel",
    ),
  );
  const collapsedIds = loadCollapsedGroupIds();
  const expandedIds = loadExpandedGroupIds();

  groups.forEach((group, index) => {
    const header = group.querySelector<HTMLElement>(".settings-header");
    const body = group.querySelector<HTMLElement>(".settings-body");
    if (!header || !body) {
      return;
    }

    const groupId =
      group.dataset.collapsibleId || `settings-group-${index + 1}`;
    group.dataset.collapsibleId = groupId;
    group.classList.add("collapsible");

    const shouldCollapseByDefault =
      group.dataset.defaultCollapsed === "true" &&
      !collapsedIds.has(groupId) &&
      !expandedIds.has(groupId);

    if (collapsedIds.has(groupId) || shouldCollapseByDefault) {
      group.classList.add("collapsed");
    }

    if (header.dataset.collapsibleBound === "true") {
      return;
    }

    header.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, input, select, textarea, label, a")) {
        return;
      }
      group.classList.toggle("collapsed");
      const nextCollapsed = loadCollapsedGroupIds();
      const nextExpanded = loadExpandedGroupIds();
      if (group.classList.contains("collapsed")) {
        nextCollapsed.add(groupId);
        nextExpanded.delete(groupId);
      } else {
        nextCollapsed.delete(groupId);
        nextExpanded.add(groupId);
      }
      saveCollapsedGroupIds(nextCollapsed);
      saveExpandedGroupIds(nextExpanded);
    });
    header.dataset.collapsibleBound = "true";
  });
}

function setActiveView(view: DashboardView): void {
  state.activeView = view;
  if (view !== "accounts") {
    cancelAccountRenderFrame();
  }
  try {
    window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view);
  } catch {
    // ignore
  }

  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>("[data-nav-target]"),
  )) {
    node.dataset.active = node.dataset.navTarget === view ? "true" : "false";
  }

  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>("[data-view]"),
  )) {
    node.hidden = node.dataset.view !== view;
  }

  if (hasHydratedDashboardState()) {
    cancelVisibleRefreshFrame();
    renderActiveViewContent();
    applyActiveViewFormState();
  }
}

function setButtonLoading(
  button: HTMLButtonElement | null,
  loading: boolean,
  loadingText?: string,
): void {
  if (!button) {
    return;
  }

  if (loading) {
    if (!button.dataset.originalHtml) {
      button.dataset.originalHtml = button.innerHTML;
    }
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent ?? "";
    }
    if (!button.dataset.originalTitle) {
      button.dataset.originalTitle = button.title ?? "";
    }
    button.dataset.loading = "true";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (button.classList.contains("icon-btn")) {
      button.innerHTML = `<span class="icon-btn-spinner" aria-hidden="true"></span>`;
      if (loadingText) {
        button.title = loadingText;
      }
    } else {
      button.textContent = loadingText ?? `${button.dataset.originalText}...`;
    }
    return;
  }

  button.disabled = false;
  button.removeAttribute("aria-busy");
  delete button.dataset.loading;
  if (button.classList.contains("icon-btn") && button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
  } else if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
  }
  if (button.dataset.originalTitle !== undefined) {
    button.title = button.dataset.originalTitle;
  }
}

function formatDate(value?: number): string {
  if (!value) {
    return "待同步";
  }
  return new Date(value).toLocaleString("zh-CN");
}

function formatCountdown(value?: number): string {
  if (!value) {
    return "待同步";
  }

  const diff = value - Date.now();
  if (diff <= 0) {
    return "已到期";
  }

  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}天 ${hours}小时`;
  }
  if (hours > 0) {
    return `${hours}小时 ${minutes}分钟`;
  }
  return `${minutes}分钟`;
}

function formatRecentCall(value?: number): string {
  if (!value) {
    return "暂无调用";
  }

  const deltaMs = Date.now() - value;
  if (deltaMs < 60_000) {
    return "刚刚";
  }
  if (deltaMs < 3_600_000) {
    return `${Math.floor(deltaMs / 60_000)} 分钟前`;
  }
  if (deltaMs < 86_400_000) {
    return `${Math.floor(deltaMs / 3_600_000)} 小时前`;
  }
  return new Date(value).toLocaleString("zh-CN");
}

function normalizeAutoRefreshIntervalSeconds(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 120;
  }
  return Math.max(30, Math.min(1_800, Math.round(value)));
}

function normalizeGatewayPort(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 8787;
  }
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 65_535) {
    return 8787;
  }
  return rounded;
}

function formatAutoRefreshInterval(value?: number): string {
  const seconds = normalizeAutoRefreshIntervalSeconds(value);
  if (seconds % 60 === 0) {
    return `${seconds / 60} 分钟`;
  }
  return `${seconds} 秒`;
}

function clearAutoRefreshTimer(): void {
  if (autoRefreshTimer) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }
}

function clearSessionActivityTimer(): void {
  if (sessionActivityTimer) {
    window.clearInterval(sessionActivityTimer);
    sessionActivityTimer = undefined;
  }
}

function clearViewStackScrollIdleTimer(): void {
  if (viewStackScrollIdleTimer) {
    window.clearTimeout(viewStackScrollIdleTimer);
    viewStackScrollIdleTimer = undefined;
  }
}

function cancelVisibleRefreshFrame(): void {
  if (visibleRefreshFrame) {
    window.cancelAnimationFrame(visibleRefreshFrame);
    visibleRefreshFrame = undefined;
  }
}

function cancelAccountRenderFrame(): void {
  if (accountRenderFrame) {
    window.cancelAnimationFrame(accountRenderFrame);
    accountRenderFrame = undefined;
  }
  accountRenderToken += 1;
}

function cancelPoolMemberFieldFrame(poolId: string): void {
  const frame = poolMemberFieldFrames.get(poolId);
  if (frame) {
    window.cancelAnimationFrame(frame);
    poolMemberFieldFrames.delete(poolId);
  }
}

function hasHydratedDashboardState(): boolean {
  return Boolean(
    state.health ||
      state.sessions ||
      state.providers ||
      state.settings ||
      state.routingSettings ||
      state.poolSettings ||
      state.securitySettings ||
      state.systemSettings,
  );
}

function renderActiveViewContent(options?: { liveOnly?: boolean }): void {
  const liveOnly = Boolean(options?.liveOnly);
  renderTopSummary();
  renderUsageOverview();

  if (state.activeView === "overview") {
    renderOverview();
    return;
  }

  if (state.activeView === "accounts") {
    renderCodexAccounts();
    return;
  }

  if (state.activeView === "models") {
    renderProviderRegistry();
    return;
  }

  if (state.activeView === "routing") {
    renderRoutingObservability();
    if (!liveOnly) {
      renderRoutingRules();
    }
    return;
  }

  if (state.activeView === "pools") {
    renderRoutingObservability();
    if (!liveOnly) {
      renderRoutingRules();
    }
    if (!liveOnly) {
      renderPoolCards();
    }
    return;
  }

  if (state.activeView === "usage") {
    renderUsageWorkbench();
    return;
  }

  if (state.activeView === "access") {
    renderAccessAndKeys();
    return;
  }

  renderDiagnostics();
  renderErrors();
  if (!liveOnly) {
    renderGuide();
  }
}

function applyActiveViewFormState(): void {
  if (state.activeView === "models") {
    applySettingsToForm();
    return;
  }

  if (state.activeView === "routing") {
    applyRoutingSettingsToForm();
    resetRoutingPreviewResult();
    return;
  }

  if (state.activeView === "pools") {
    applyRoutingSettingsToForm();
    resetRoutingPreviewResult();
    applyPoolSettingsToForm();
    return;
  }

  if (state.activeView === "system") {
    applySecuritySettingsToForm();
    applySystemSettingsToForm();
  }
}

function flushDeferredVisibleRefresh(): void {
  cancelVisibleRefreshFrame();
  state.pendingVisibleRefresh = false;
  renderActiveViewContent({ liveOnly: true });
}

function scheduleVisibleRefresh(): void {
  if (!hasHydratedDashboardState()) {
    return;
  }

  if (state.isViewStackScrolling) {
    state.pendingVisibleRefresh = true;
    return;
  }

  if (visibleRefreshFrame) {
    return;
  }

  visibleRefreshFrame = window.requestAnimationFrame(() => {
    visibleRefreshFrame = undefined;
    flushDeferredVisibleRefresh();
  });
}

function markViewStackScrolling(): void {
  state.isViewStackScrolling = true;
  state.lastViewStackScrollAt = Date.now();
  clearViewStackScrollIdleTimer();
  viewStackScrollIdleTimer = window.setTimeout(() => {
    state.isViewStackScrolling = false;
    if (state.pendingVisibleRefresh) {
      scheduleVisibleRefresh();
    }
  }, 140);
}

function statusLabel(status: "available" | "expired" | "invalid"): string {
  if (status === "available") {
    return "可用";
  }
  if (status === "expired") {
    return "已过期";
  }
  return "异常";
}

function statusTone(status: ProviderConfigurationStatus): string {
  if (status === "active") {
    return "已启用";
  }
  if (status === "incomplete") {
    return "配置不完整";
  }
  return "未启用";
}

function diagnosticBadgeClass(
  severity: RuntimeDiagnostic["severity"],
): "active" | "neutral" | "incomplete" | "disabled" {
  if (severity === "success") {
    return "active";
  }
  if (severity === "warning") {
    return "incomplete";
  }
  if (severity === "error") {
    return "disabled";
  }
  return "neutral";
}

function diagnosticSeverityLabel(
  severity: RuntimeDiagnostic["severity"],
): string {
  if (severity === "success") {
    return "正常";
  }
  if (severity === "warning") {
    return "关注";
  }
  if (severity === "error") {
    return "异常";
  }
  return "提示";
}

function getPrimaryRuntimeDiagnostic(): RuntimeDiagnostic | undefined {
  return (
    state.runtimeDiagnostics.find((item) => item.severity === "error") ??
    state.runtimeDiagnostics.find((item) => item.severity === "warning") ??
    state.runtimeDiagnostics.find((item) => item.severity === "info") ??
    state.runtimeDiagnostics[0]
  );
}

function isMissingRefreshUsageHandler(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("gateway:refresh-session-usage") &&
    (message.includes("No handler registered") ||
      message.includes("Admin request failed (404)"))
  );
}

function getProviderConfiguration(id: string) {
  return state.health?.providerConfigurations?.find((item) => item.id === id);
}

function getActiveProviderLabel(): string {
  const health = state.health;
  const providers = state.providers;
  if (!health || !providers) {
    return "加载中";
  }

  const matched = providers.data.find((provider) =>
    provider.models.some((model) => model.alias === health.defaultModel),
  );

  return matched?.label ?? providers.data[0]?.label ?? "OpenAI Codex";
}

function getCodexAliasPreset(modelId: string): string {
  return (
    CODEX_MODEL_ALIAS_PRESETS[modelId as SupportedCodexUpstreamModel] ??
    "codex-custom"
  );
}

function getAccountGroups() {
  return buildCodexAccountGroups(
    state.sessions?.data ?? [],
    state.sessions?.activeSessionId,
  );
}

function getVisibleLocalImportAccountGroups(): ReturnType<
  typeof getAccountGroups
>["groups"] {
  return sortAccountGroups(
    getAccountGroups().groups.filter((group) => group.sourceKind === "local-import"),
    {
      search: state.accountSearch,
      sortKey: state.accountSortKey,
      sortDirection: state.accountSortDirection,
      pinnedSessionId: state.systemSettings?.pinnedSessionId,
    },
  );
}

function reconcileSelectedAccountKeys(
  accounts: ReturnType<typeof getAccountGroups>["groups"],
): void {
  const normalized = normalizeAccountSelection(accounts, selectedAccountKeys);
  selectedAccountKeys.clear();
  for (const accountKey of normalized) {
    selectedAccountKeys.add(accountKey);
  }
}

function buildAccountBulkToolbarMarkup(
  accounts: ReturnType<typeof getAccountGroups>["groups"],
): string {
  const selectedCount = selectedAccountKeys.size;
  const allSelected = accounts.length > 0 && selectedCount === accounts.length;
  const hasSelection = selectedCount > 0;
  return `
    <div class="account-bulk-toolbar">
      <div class="account-bulk-toolbar-main">
        <label class="account-bulk-select" data-account-select-control="true">
          <input
            type="checkbox"
            data-field="account-bulk-select-all"
            aria-label="选择全部当前账号"
            ${allSelected ? "checked" : ""}
          />
          <span>选择当前账号</span>
        </label>
        <span class="badge neutral">已选 ${escapeHtml(String(selectedCount))} / 当前 ${escapeHtml(String(accounts.length))}</span>
        <span class="account-bulk-hint">删除会移除 local-ai-gateway 本地账号副本，并同步清理号池成员引用。</span>
      </div>
      <div class="account-bulk-actions">
        <button
          type="button"
          class="btn ghost mini"
          data-action="account-clear-selection"
          ${hasSelection ? "" : "disabled"}
        >清空选择</button>
        <button
          type="button"
          class="btn danger-ghost mini"
          data-action="account-delete-selected"
          ${hasSelection ? "" : "disabled"}
        >删除选中账号</button>
      </div>
    </div>
  `;
}

function isPinnedAccountSession(sessionId: string): boolean {
  return state.systemSettings?.pinnedSessionId === sessionId;
}

function updateAccountToolbarState(): void {
  const searchInput = document.getElementById(
    "account-search",
  ) as HTMLInputElement | null;
  const sortSelect = document.getElementById(
    "account-sort-key",
  ) as HTMLSelectElement | null;
  const sortDirectionButton = document.getElementById(
    "account-sort-direction",
  ) as HTMLButtonElement | null;

  if (searchInput && searchInput.value !== state.accountSearch) {
    searchInput.value = state.accountSearch;
  }

  if (sortSelect && sortSelect.value !== state.accountSortKey) {
    sortSelect.value = state.accountSortKey;
  }

  if (sortDirectionButton) {
    sortDirectionButton.textContent =
      state.accountSortDirection === "asc" ? "升序" : "降序";
    sortDirectionButton.setAttribute(
      "aria-label",
      `当前为${state.accountSortDirection === "asc" ? "升序" : "降序"}排序，点击切换`,
    );
    sortDirectionButton.title = `当前为${state.accountSortDirection === "asc" ? "升序" : "降序"}排序`;
  }
}

function renderTopSummary(): void {
  const health = state.health;
  if (!health) {
    return;
  }
  const primaryDiagnostic = getPrimaryRuntimeDiagnostic();

  const statusNode = document.getElementById("top-summary-status");
  if (statusNode) {
    const label =
      primaryDiagnostic?.severity === "error"
        ? primaryDiagnostic.title
        : primaryDiagnostic?.severity === "warning"
          ? primaryDiagnostic.title
          : health.ok
            ? "服务运行中"
            : "服务异常";
    statusNode.textContent = label;
    statusNode.className = `service-status-badge ${
      primaryDiagnostic?.severity === "error"
        ? "error"
        : primaryDiagnostic?.severity === "warning"
          ? "warning"
          : health.ok
            ? "active"
            : "error"
    }`;
  }
}

function renderOverview(): void {
  const health = state.health;
  const sessions = state.sessions;
  const providers = state.providers;
  if (!health || !sessions || !providers) {
    return;
  }

  setText("service-state", health.ok ? "运行中" : "异常");
  setText("service-mode", health.managed ? "桌面托管" : "外部服务");
  setText("default-provider", getActiveProviderLabel());
  setText(
    "default-model",
    health.openclaw?.model ?? health.defaultModel ?? "codex-default",
  );
  const activeSession = sessions.data.find(
    (session) => session.id === sessions.activeSessionId,
  );
  setText(
    "runtime-active-session",
    activeSession ? getSessionTitle(activeSession) : "未选择活动会话",
  );
  setText(
    "runtime-inference-auth",
    (state.securitySettings?.enabled ?? health.inferenceAuth?.enabled)
      ? (state.securitySettings?.hasApiKey ?? health.inferenceAuth?.hasApiKey)
        ? "API Key 鉴权"
        : "鉴权缺少密钥"
      : "无鉴权",
  );
  setText(
    "openclaw-base-url",
    health.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1",
  );
  const routing = health.routingObservability;
  setText(
    "runtime-routing-hit",
    routing
      ? `${routingWindowLabel(state.routingObserveWindow).replace("命中", "")} ${getRoutingWindowCount(routing, state.routingObserveWindow)} 次 / 累计 ${routing.totalMatched} 次`
      : "暂无命中",
  );
  const sourceCounts = getAccountGroups();
  setText("local-account-count", String(sourceCounts.localImport));
  setText("openclaw-source-count", String(sourceCounts.openclaw));
  setText(
    "default-selection",
    health.defaultSelection?.reason ?? "使用默认规则",
  );
  renderDashboardPhaseTwoOverview();
  renderAccountActivityOverview();
  renderRoutingObservability();
}

function renderDashboardPhaseTwoOverview(): void {
  const health = state.health;
  const summary = getActiveUsageWindowSummary();
  const usage = summary?.totals;
  const baseUrl = health?.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1";
  const authEnabled = Boolean(
    state.securitySettings?.enabled ?? health?.inferenceAuth?.enabled,
  );
  const hasApiKey = Boolean(
    state.securitySettings?.hasApiKey ?? health?.inferenceAuth?.hasApiKey,
  );
  const lanEnabled = Boolean(
    state.securitySettings?.lanAccess?.enabled ??
      health?.inferenceAuth?.lanAccess?.enabled,
  );
  const localStatus = health?.ok
    ? authEnabled
      ? hasApiKey
        ? "运行中，API Key 鉴权"
        : "运行中，鉴权缺少密钥"
      : "运行中，无鉴权"
    : "等待服务状态";

  setText("dashboard-local-status", localStatus);
  setText("dashboard-local-url", baseUrl);
  setText(
    "dashboard-local-tokens",
    usage ? `${formatCompactCount(usage.totalTokens)} Token` : "暂无统计",
  );
  setText(
    "dashboard-lan-status",
    lanEnabled ? "已开启，强制 API Key" : "默认关闭，等待显式开启",
  );
  setText(
    "dashboard-lan-url",
    lanEnabled ? "本机局域网 IP + 端口 /v1" : "未开启",
  );
  setText("dashboard-lan-tokens", "0 Token");
  setText("dashboard-public-status", "三期预留，当前禁用");
  setText(
    "dashboard-token-window",
    summary ? usageWindowLabel(state.usageObserveWindow) : "暂无统计",
  );

  renderDashboardTokenChart(summary);
  renderDashboardSharedSummary(summary);
  renderDashboardAlertSummary();
}

function renderAccessAndKeys(): void {
  const health = state.health;
  const security = state.securitySettings ?? health?.inferenceAuth;
  const baseUrl = health?.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1";
  const authEnabled = Boolean(security?.enabled);
  const hasApiKey = Boolean(security?.hasApiKey);
  const lanEnabled = Boolean(security?.lanAccess?.enabled);
  const mappings = state.securitySettings?.clientMappings ?? [];
  const accessControl = state.securitySettings?.accessControl;
  const accessKeyCount =
    accessControl?.keys.filter((item) => item.status === "enabled").length ?? 0;

  setText(
    "access-local-status",
    health?.ok ? "本机推理面可用" : "等待服务状态",
  );
  setText("access-local-url", baseUrl);
  setText(
    "access-local-auth",
    authEnabled
      ? hasApiKey
        ? "API Key 鉴权"
        : "鉴权缺少密钥"
      : "无鉴权",
  );
  setText(
    "access-lan-status",
    lanEnabled ? "已开启，需重启后监听局域网" : "默认关闭",
  );
  setText(
    "access-lan-url",
    lanEnabled ? "本机局域网 IP + 端口 /v1" : "未开启",
  );
  setText(
    "access-lan-keys",
    accessKeyCount > 0
      ? `${formatCompactCount(accessKeyCount)} 个访问者 key`
      : `${formatCompactCount(
          state.securitySettings?.enabledMappingCount ??
            health?.inferenceAuth?.enabledMappingCount ??
            0,
        )} 个兼容 key`,
  );

  renderAccessConsumerList(mappings, accessControl);
  renderAccessPolicyPreview();
  renderAccessMemberDrawer(accessControl);
}

function renderAccessConsumerList(
  mappings: SecurityClientMapping[],
  accessControl?: SecurityAccessControl,
): void {
  const node = document.getElementById("access-consumer-list");
  if (!node) {
    return;
  }

  const consumers = accessControl?.consumers ?? [];
  if (consumers.length > 0) {
    if (
      state.selectedAccessConsumerId &&
      !consumers.some((item) => item.id === state.selectedAccessConsumerId)
    ) {
      state.selectedAccessConsumerId = undefined;
    }
    const keysByConsumer = new Map<string, SecurityAccessKey[]>();
    for (const key of accessControl?.keys ?? []) {
      keysByConsumer.set(key.consumerId, [
        ...(keysByConsumer.get(key.consumerId) ?? []),
        key,
      ]);
    }
    const rows = consumers
      .map((consumer) => {
        const keys = keysByConsumer.get(consumer.id) ?? [];
        const enabledKeys = keys.filter((key) => key.status === "enabled").length;
        const policy = accessControl?.policies.find(
          (item) => item.consumerId === consumer.id,
        );
        const selected = consumer.id === state.selectedAccessConsumerId;
        return `
          <div class="figma-table-row access-consumer-row" role="row" data-selected="${selected ? "true" : "false"}">
            <div class="figma-table-cell">
              <strong>${escapeHtml(consumer.name || consumer.clientTag || "未命名访问者")}</strong>
              <span>${escapeHtml(consumer.clientTag || "未设置 clientTag")}</span>
            </div>
            <div class="figma-table-cell">
              <small>Key 状态</small>
              <strong>${formatCompactCount(enabledKeys)} / ${formatCompactCount(keys.length)} 可用</strong>
            </div>
            <div class="figma-table-cell">
              <small>模型权限</small>
              <strong>${policy?.allowedModelAliases?.length ? `${policy.allowedModelAliases.length} 个模型` : "未限制"}</strong>
            </div>
            <div class="figma-table-cell access-consumer-actions">
              <span class="badge ${consumer.status === "enabled" ? "active" : "neutral"}">${formatAccessStatusLabel(consumer.status)}</span>
              <button class="btn ghost mini" type="button" data-access-member-select="${escapeHtml(consumer.id)}">${selected ? "已选择" : "查看"}</button>
            </div>
          </div>
        `;
      })
      .join("");
    node.innerHTML = `
      <div class="figma-table access-consumer-table" role="table" aria-label="访问成员">
        <div class="figma-table-head access-consumer-table-head" role="row">
          <span>成员</span>
          <span>Key 状态</span>
          <span>模型权限</span>
          <span>状态 / 操作</span>
        </div>
        ${rows}
      </div>
    `;
    return;
  }

  if (mappings.length === 0) {
    node.innerHTML = `
      <div class="empty-card">当前暂无访问者或客户端密钥映射。后续可在这里创建 LAN 成员并分发独立 API key。</div>
    `;
    return;
  }

  const rows = mappings
    .map(
      (mapping) => `
        <div class="figma-table-row access-consumer-row" role="row">
          <div class="figma-table-cell">
            <strong>${escapeHtml(mapping.name || mapping.clientTag || "未命名客户端")}</strong>
            <span>${escapeHtml(mapping.clientTag || "未设置 clientTag")}</span>
          </div>
          <div class="figma-table-cell">
            <small>Key 状态</small>
            <strong>${mapping.hasApiKey ? "已保存" : "缺少密钥"}</strong>
          </div>
          <div class="figma-table-cell">
            <small>Header 覆盖</small>
            <strong>${mapping.allowHeaderOverride ? "允许" : "禁止"}</strong>
          </div>
          <div class="figma-table-cell access-consumer-actions">
            <span class="badge ${mapping.enabled ? "active" : "neutral"}">${mapping.enabled ? "启用" : "暂停"}</span>
          </div>
        </div>
      `,
    )
    .join("");
  node.innerHTML = `
    <div class="figma-table access-consumer-table" role="table" aria-label="兼容客户端密钥">
      <div class="figma-table-head access-consumer-table-head" role="row">
        <span>客户端</span>
        <span>Key 状态</span>
        <span>Header 覆盖</span>
        <span>状态</span>
      </div>
      ${rows}
    </div>
  `;
}

function formatAccessStatusLabel(
  status: SecurityAccessConsumer["status"] | SecurityAccessKey["status"],
): string {
  if (status === "enabled") {
    return "启用";
  }
  if (status === "paused") {
    return "暂停";
  }
  if (status === "expired") {
    return "过期";
  }
  if (status === "rotated") {
    return "已轮换";
  }
  return status;
}

function isPastIsoDate(value?: string): boolean {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function formatAccessIsoDate(value?: string, fallback = "未设置"): string {
  if (!value) {
    return fallback;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return fallback;
  }
  return new Date(timestamp).toLocaleString("zh-CN");
}

function formatAccessDateTimeLocalValue(value?: string): string {
  if (!value) {
    return "";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const date = new Date(timestamp);
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000;
  return new Date(localTimestamp).toISOString().slice(0, 16);
}

function parseAccessDateTimeLocalValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("到期时间格式无效，请重新选择。");
  }
  return date.toISOString();
}

function parseAccessPositiveIntegerInput(
  selector: string,
  label: string,
): number | undefined {
  const value =
    (document.querySelector(selector) as HTMLInputElement | null)?.value.trim() ??
    "";
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label}必须是大于 0 的整数。`);
  }
  return Math.floor(parsed);
}

function parseAccessModelAliasesInput(selector: string): string[] {
  const value =
    (
      document.querySelector(selector) as HTMLTextAreaElement | null
    )?.value.trim() ?? "";
  if (!value) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .split(/[\n,，]+/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function formatAccessPolicyTokenLimit(value?: number): string {
  return typeof value === "number" && value > 0
    ? `${formatCompactCount(value)} Token`
    : "未限制";
}

function formatAccessPolicyNumberLimit(value?: number, unit = ""): string {
  return typeof value === "number" && value > 0
    ? `${formatCompactCount(value)}${unit}`
    : "未限制";
}

function renderAccessPolicyUsageSnapshot(
  consumerId: string,
  policy: SecurityAccessPolicy | undefined,
): string {
  const snapshot = buildAccessPolicyUsageSnapshot({
    consumerId,
    dailyTokenLimit: policy?.quota?.dailyTokenLimit,
    dailyUsageSummary: state.usageSummary?.daily,
  });
  const progressPercent =
    typeof snapshot.usageRatio === "number"
      ? Math.round(snapshot.usageRatio * 100)
      : 0;
  const title = snapshot.configured ? "日额度余量" : "日额度未限制";
  const detail = snapshot.configured
    ? `已用 ${formatCompactCount(snapshot.usedTokens)} / ${formatCompactCount(
        snapshot.limitTokens ?? 0,
      )} Token，剩余 ${formatCompactCount(snapshot.remainingTokens ?? 0)} Token`
    : `近 24 小时已用 ${formatCompactCount(snapshot.usedTokens)} Token`;
  const resetLabel = snapshot.resetAt
    ? `重置参考：${formatDate(snapshot.resetAt)}`
    : "重置参考：近 24 小时滚动窗口";
  const updatedLabel = snapshot.updatedAt
    ? `统计更新：${formatDate(snapshot.updatedAt)}`
    : "统计更新：暂无";

  return `
    <div class="access-policy-usage-snapshot ${snapshot.tone}">
      <div class="access-policy-usage-head">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
        <span class="badge ${snapshot.tone === "warning" ? "warning" : snapshot.configured ? "active" : "neutral"}">${snapshot.configured ? `${progressPercent}%` : "不限"}</span>
      </div>
      <div class="access-policy-usage-bar" aria-hidden="true">
        <span style="width: ${Math.min(100, Math.max(0, progressPercent))}%"></span>
      </div>
      <div class="access-policy-usage-meta">
        <span>${escapeHtml(resetLabel)}</span>
        <span>${escapeHtml(updatedLabel)}</span>
      </div>
    </div>
  `;
}

function getAccessPolicyRuntimeEntry(consumerId: string):
  | NonNullable<
      NonNullable<DashboardHealth["inferenceObservability"]>["accessConsumers"]
    >[number]
  | undefined {
  return state.health?.inferenceObservability?.accessConsumers?.find(
    (item) => item.consumerId === consumerId,
  );
}

function formatAccessPolicyRuntimeLimit(
  used: number,
  limit: number | undefined,
  unit: string,
): string {
  return typeof limit === "number" && limit > 0
    ? `${formatCompactCount(used)} / ${formatCompactCount(limit)} ${unit}`
    : `${formatCompactCount(used)} ${unit} · 未限制`;
}

function renderAccessPolicyRuntimeSnapshot(
  consumerId: string,
  policy: SecurityAccessPolicy | undefined,
): string {
  const runtime = getAccessPolicyRuntimeEntry(consumerId);
  const snapshot = buildAccessPolicyRuntimeSnapshot({
    requestsPerMinute:
      runtime?.requestsPerMinute ?? policy?.limits?.requestsPerMinute,
    maxConcurrentRequests:
      runtime?.maxConcurrentRequests ?? policy?.limits?.maxConcurrentRequests,
    recentRequestCount1m: runtime?.recentRequestCount1m,
    inFlightRequests: runtime?.inFlightCount,
    updatedAt: state.health ? Date.now() : undefined,
  });
  const requestPercent =
    typeof snapshot.requestUsageRatio === "number"
      ? Math.round(snapshot.requestUsageRatio * 100)
      : 0;
  const concurrencyPercent =
    typeof snapshot.concurrencyUsageRatio === "number"
      ? Math.round(snapshot.concurrencyUsageRatio * 100)
      : 0;
  const requestDetail = snapshot.requestLimitConfigured
    ? `近 60 秒请求 ${formatAccessPolicyRuntimeLimit(
        snapshot.recentRequestCount1m,
        snapshot.requestLimit,
        "次",
      )}，剩余 ${formatCompactCount(snapshot.remainingRequests1m ?? 0)} 次`
    : `近 60 秒请求 ${formatCompactCount(snapshot.recentRequestCount1m)} 次，当前未限制`;
  const concurrencyDetail = snapshot.concurrencyLimitConfigured
    ? `当前并发 ${formatAccessPolicyRuntimeLimit(
        snapshot.inFlightRequests,
        snapshot.concurrencyLimit,
        "路",
      )}，剩余 ${formatCompactCount(snapshot.remainingConcurrency ?? 0)} 路`
    : `当前并发 ${formatCompactCount(snapshot.inFlightRequests)} 路，当前未限制`;
  const updatedLabel = snapshot.updatedAt
    ? `运行态更新：${formatDate(snapshot.updatedAt)}`
    : "运行态更新：暂无";

  return `
    <div class="access-policy-runtime-snapshot ${snapshot.tone}">
      <div class="access-policy-usage-head">
        <div>
          <strong>QPS / 并发状态</strong>
          <span>${escapeHtml(requestDetail)}</span>
          <span>${escapeHtml(concurrencyDetail)}</span>
        </div>
        <span class="badge ${snapshot.tone === "warning" ? "warning" : snapshot.tone === "active" ? "active" : "neutral"}">${snapshot.tone === "warning" ? "接近上限" : snapshot.tone === "active" ? "正常" : "未限制"}</span>
      </div>
      <div class="access-policy-runtime-bars" aria-hidden="true">
        <div class="access-policy-runtime-bar">
          <small>请求</small>
          <span><i style="width: ${Math.min(100, Math.max(0, requestPercent))}%"></i></span>
        </div>
        <div class="access-policy-runtime-bar">
          <small>并发</small>
          <span><i style="width: ${Math.min(100, Math.max(0, concurrencyPercent))}%"></i></span>
        </div>
      </div>
      <div class="access-policy-usage-meta">
        <span>${escapeHtml(updatedLabel)}</span>
        <span>限流窗口：滚动 60 秒；并发：当前请求中</span>
      </div>
    </div>
  `;
}

function accessKeyBadgeClass(key: SecurityAccessKey): string {
  if (key.status === "enabled" && !isPastIsoDate(key.expiresAt)) {
    return "active";
  }
  if (key.status === "paused" || key.status === "rotated") {
    return "neutral";
  }
  return "warning";
}

function renderAccessMemberDrawer(
  accessControl?: SecurityAccessControl,
): void {
  const node = document.getElementById("access-member-drawer");
  if (!node) {
    return;
  }

  const consumers = accessControl?.consumers ?? [];
  const selectedConsumer = consumers.find(
    (item) => item.id === state.selectedAccessConsumerId,
  );

  if (!selectedConsumer) {
    node.dataset.state = "placeholder";
    node.innerHTML = `
      <div class="dashboard-panel-head">
        <div>
          <strong id="access-member-detail-name">成员详情抽屉</strong>
          <span id="access-member-detail-client-tag">${consumers.length > 0 ? "请选择一个访问成员查看 Key 状态。" : "创建 LAN 成员后，这里会展示 Key、额度、模型权限和号池授权。"}</span>
        </div>
        <span class="badge neutral">未选择成员</span>
      </div>
      <div id="access-member-detail-keys" class="access-key-list mt-3">
        <div class="empty-card">${consumers.length > 0 ? "点击成员行右侧“查看”进入详情。" : "当前暂无访问成员。"}</div>
      </div>
      <div id="access-rotated-key-result" class="settings-note compact mt-3" hidden>
        <strong>轮换后一次性 API Key</strong>
        <p>此明文只在本次轮换后展示。保存后配置文件只保留 hash、前缀、后缀和状态。</p>
        <div class="secret-field-stack">
          <div class="secret-inline-row">
            <input id="access-rotated-one-time-key" class="input-field" type="password" readonly />
            <button class="btn secondary mini" id="copy-access-rotated-key" type="button">复制新 Key</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const keys = (accessControl?.keys ?? []).filter(
    (key) => key.consumerId === selectedConsumer.id,
  );
  const policy = accessControl?.policies.find(
    (item) => item.consumerId === selectedConsumer.id,
  );
  const pools = state.poolSettings?.pools ?? [];
  const allowedPoolIds = new Set(policy?.allowedPoolIds ?? []);
  const poolPolicyRows =
    pools.length > 0
      ? pools
          .map((pool) => {
            const visibility = normalizePoolVisibility(pool.visibility);
            const checked = allowedPoolIds.has(pool.id);
            return `
              <label class="access-policy-pool-option">
                <input
                  type="checkbox"
                  data-access-policy-pool="${escapeHtml(pool.id)}"
                  ${checked ? "checked" : ""}
                />
                <span>
                  <strong>${escapeHtml(pool.name || pool.id)}</strong>
                  <small>${escapeHtml(formatPoolVisibilityLabel(visibility))} · ${escapeHtml(pool.id)}</small>
                </span>
              </label>
            `;
          })
          .join("")
      : `<div class="empty-card">当前还没有可授权号池。请先在“号池与路由”页创建号池。</div>`;
  const keyRows =
    keys.length > 0
      ? keys
          .map((key) => {
            const expiredByTime = isPastIsoDate(key.expiresAt);
            const statusLabel = expiredByTime
              ? "过期"
              : formatAccessStatusLabel(key.status);
            const toggleLabel = key.status === "paused" ? "启用 Key" : "暂停 Key";
            return `
              <div class="access-key-card">
                <div class="access-key-card-head">
                  <div>
                    <strong>${escapeHtml(key.name || key.id)}</strong>
                    <span>${escapeHtml(key.keyPrefix || "lagw")}...${escapeHtml(key.keySuffix || "****")}</span>
                  </div>
                  <span class="badge ${accessKeyBadgeClass(key)}">${escapeHtml(statusLabel)}</span>
                </div>
                <div class="access-key-meta">
                  <span>创建：${escapeHtml(formatAccessIsoDate(key.createdAt))}</span>
                  <span>最近使用：${escapeHtml(formatAccessIsoDate(key.lastUsedAt, "暂无调用"))}</span>
                  <span>到期：${escapeHtml(formatAccessIsoDate(key.expiresAt, "未限制"))}</span>
                  <span>轮换：${escapeHtml(formatAccessIsoDate(key.rotatedAt, "尚未轮换"))}</span>
                </div>
                <div class="access-key-actions">
                  <input
                    class="input-field"
                    type="datetime-local"
                    data-access-key-expiry="${escapeHtml(key.id)}"
                    value="${escapeHtml(formatAccessDateTimeLocalValue(key.expiresAt))}"
                    aria-label="Key 到期时间"
                  />
                  <button class="btn secondary mini" type="button" data-access-key-save-expiry="${escapeHtml(key.id)}">保存到期</button>
                  <button class="btn ghost mini" type="button" data-access-key-toggle="${escapeHtml(key.id)}">${toggleLabel}</button>
                  <button class="btn danger-ghost mini" type="button" data-access-key-rotate="${escapeHtml(key.id)}">轮换 Key</button>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="empty-card">当前成员暂无 Key。可后续补充多 Key 创建能力。</div>`;

  node.dataset.state = "selected";
  node.innerHTML = `
    <div class="dashboard-panel-head">
      <div>
        <strong id="access-member-detail-name">${escapeHtml(selectedConsumer.name || selectedConsumer.clientTag || "未命名成员")}</strong>
        <span id="access-member-detail-client-tag">${escapeHtml(selectedConsumer.clientTag || "未设置 clientTag")}</span>
      </div>
      <span class="badge ${selectedConsumer.status === "enabled" ? "active" : "neutral"}">${formatAccessStatusLabel(selectedConsumer.status)}</span>
    </div>
    <div class="access-member-summary mt-3">
      <div>
        <small>成员类型</small>
        <strong>${escapeHtml(selectedConsumer.type)}</strong>
      </div>
      <div>
        <small>Key 数量</small>
        <strong>${formatCompactCount(keys.length)}</strong>
      </div>
      <div>
        <small>日限额</small>
        <strong>${escapeHtml(formatAccessPolicyTokenLimit(policy?.quota?.dailyTokenLimit))}</strong>
      </div>
      <div>
        <small>QPS / 并发</small>
        <strong>${escapeHtml(formatAccessPolicyNumberLimit(policy?.limits?.requestsPerMinute, "/min"))} / ${escapeHtml(formatAccessPolicyNumberLimit(policy?.limits?.maxConcurrentRequests))}</strong>
      </div>
      <div>
        <small>模型 / 号池</small>
        <strong>${policy?.allowedModelAliases?.length ? `${policy.allowedModelAliases.length} 模型` : "模型不限"} / ${policy?.allowedPoolIds?.length ? `${policy.allowedPoolIds.length} 号池` : "号池不限"}</strong>
      </div>
    </div>
    ${renderAccessPolicyUsageSnapshot(selectedConsumer.id, policy)}
    ${renderAccessPolicyRuntimeSnapshot(selectedConsumer.id, policy)}
    <div class="access-member-note">${escapeHtml(selectedConsumer.note || "暂无备注。")}</div>
    <div class="access-policy-panel mt-3">
      <div class="access-policy-panel-head">
        <div>
          <strong>访问策略编辑</strong>
          <span>配置成员可用模型、日限额、QPS、并发和允许号池；保存后立即进入推理面前置拦截。</span>
        </div>
        <button
          class="btn secondary mini"
          type="button"
          data-access-policy-save-settings="${escapeHtml(selectedConsumer.id)}"
          data-access-policy-save-pools="${escapeHtml(selectedConsumer.id)}"
        >保存访问策略</button>
      </div>
      <div class="pool-config-form-grid access-policy-edit-grid">
        <div class="form-field">
          <label>日 Token 限额</label>
          <input
            class="input-field"
            type="number"
            min="1"
            step="1"
            data-access-policy-daily-token-limit="${escapeHtml(selectedConsumer.id)}"
            value="${typeof policy?.quota?.dailyTokenLimit === "number" ? String(policy.quota.dailyTokenLimit) : ""}"
            placeholder="留空表示不限制"
          />
        </div>
        <div class="form-field">
          <label>每分钟请求数</label>
          <input
            class="input-field"
            type="number"
            min="1"
            step="1"
            data-access-policy-requests-per-minute="${escapeHtml(selectedConsumer.id)}"
            value="${typeof policy?.limits?.requestsPerMinute === "number" ? String(policy.limits.requestsPerMinute) : ""}"
            placeholder="留空表示不限制"
          />
        </div>
        <div class="form-field">
          <label>最大并发请求</label>
          <input
            class="input-field"
            type="number"
            min="1"
            step="1"
            data-access-policy-max-concurrent="${escapeHtml(selectedConsumer.id)}"
            value="${typeof policy?.limits?.maxConcurrentRequests === "number" ? String(policy.limits.maxConcurrentRequests) : ""}"
            placeholder="留空表示不限制"
          />
        </div>
        <div class="form-field full">
          <label>允许模型别名</label>
          <textarea
            class="input-field"
            rows="2"
            data-access-policy-model-aliases="${escapeHtml(selectedConsumer.id)}"
            placeholder="留空表示不限制；多个模型可用逗号或换行分隔"
          >${escapeHtml((policy?.allowedModelAliases ?? []).join("\n"))}</textarea>
        </div>
      </div>
      <div class="access-policy-pool-list">
        ${poolPolicyRows}
      </div>
    </div>
    <div id="access-member-detail-keys" class="access-key-list mt-3">
      ${keyRows}
    </div>
    <div id="access-rotated-key-result" class="settings-note compact mt-3" hidden>
      <strong>轮换后一次性 API Key</strong>
      <p>此明文只在本次轮换后展示。保存后配置文件只保留 hash、前缀、后缀和状态。</p>
      <div class="secret-field-stack">
        <div class="secret-inline-row">
          <input id="access-rotated-one-time-key" class="input-field" type="password" readonly />
          <button class="btn secondary mini" id="copy-access-rotated-key" type="button">复制新 Key</button>
        </div>
      </div>
    </div>
  `;
}

function renderAccessPolicyPreview(): void {
  const node = document.getElementById("access-policy-preview");
  if (!node) {
    return;
  }

  const authEnabled = Boolean(
    state.securitySettings?.enabled ?? state.health?.inferenceAuth?.enabled,
  );
  const mappingCount =
    state.securitySettings?.enabledMappingCount ??
    state.health?.inferenceAuth?.enabledMappingCount ??
    0;
  const accessControl = state.securitySettings?.accessControl;
  const policies = accessControl?.policies ?? [];
  const policiesWithQuota = policies.filter(
    (policy) => typeof policy.quota?.dailyTokenLimit === "number",
  ).length;
  const policiesWithRateLimit = policies.filter(
    (policy) =>
      typeof policy.limits?.requestsPerMinute === "number" ||
      typeof policy.limits?.maxConcurrentRequests === "number",
  ).length;
  const allowedPoolCount = policies.reduce(
    (sum, policy) => sum + (policy.allowedPoolIds?.length ?? 0),
    0,
  );
  const allowedModelCount = policies.reduce(
    (sum, policy) => sum + (policy.allowedModelAliases?.length ?? 0),
    0,
  );

  node.innerHTML = [
    {
      title: "推理面鉴权",
      detail: authEnabled
        ? "当前兼容使用 Gateway API Key / 客户端专属 key。"
        : "当前未启用鉴权，仅建议本机自用场景使用。",
      value: authEnabled ? "api-key" : "none",
    },
    {
      title: "成员级额度",
      detail:
        policiesWithQuota > 0
          ? `${formatCompactCount(policiesWithQuota)} 个成员已配置日 Token 限额。`
          : "服务端已支持成员日限额；可在后续策略编辑 UI 中配置。",
      value: policiesWithQuota > 0 ? "已接入" : "待配置",
    },
    {
      title: "QPS / 并发限制",
      detail:
        policiesWithRateLimit > 0
          ? `${formatCompactCount(policiesWithRateLimit)} 个成员已配置请求频率或并发限制。`
          : "服务端已支持 QPS 与并发前置拦截；UI 编辑仍待补齐。",
      value: policiesWithRateLimit > 0 ? "已配置" : "待配置",
    },
    {
      title: "模型与号池授权",
      detail: `当前策略合计 ${formatCompactCount(allowedModelCount)} 个模型授权、${formatCompactCount(allowedPoolCount)} 个号池授权。`,
      value: allowedPoolCount > 0 || allowedModelCount > 0 ? "已接入" : "未限制",
    },
    {
      title: "兼容客户端 key",
      detail: "来自现有 clientMappings，可继续用于来源归因。",
      value: `${formatCompactCount(mappingCount)} 个`,
    },
  ]
    .map(
      (item) => `
        <div class="access-policy-item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.detail)}</span>
          </div>
          <small>${escapeHtml(item.value)}</small>
        </div>
      `,
    )
    .join("");
}

function renderDashboardTokenChart(
  summary: UsageWindowSummary | undefined,
): void {
  const node = document.getElementById("dashboard-token-chart");
  if (!node) {
    return;
  }

  if (!summary || summary.totals.totalTokens <= 0) {
    node.innerHTML = `
      <div class="empty-card" style="width: 100%;">当前窗口暂无 Token 趋势数据。</div>
    `;
    return;
  }

  const values = [
    summary.totals.inputTokens,
    summary.totals.outputTokens,
    summary.totals.cachedTokens,
    summary.totals.reasoningTokens,
    ...summary.clients.slice(0, 4).map((client) => client.usage.totalTokens),
  ].filter((value) => value > 0);
  const normalizedValues = values.length > 0 ? values : [summary.totals.totalTokens];
  const maxValue = Math.max(...normalizedValues, 1);

  node.innerHTML = normalizedValues
    .slice(0, 8)
    .map((value, index) => {
      const height = Math.max(12, Math.round((value / maxValue) * 140));
      return `<div class="dashboard-token-bar" data-muted="${index > 3 ? "true" : "false"}" style="height: ${height}px;" title="${escapeHtml(formatCompactCount(value))} Token"></div>`;
    })
    .join("");
}

function renderDashboardSharedSummary(
  summary: UsageWindowSummary | undefined,
): void {
  const node = document.getElementById("dashboard-shared-summary");
  if (!node) {
    return;
  }

  const totalTokens = summary?.totals.totalTokens ?? 0;
  const topClient = summary?.clients[0];
  const mappingCount =
    state.securitySettings?.enabledMappingCount ??
    state.health?.inferenceAuth?.enabledMappingCount ??
    0;

  node.innerHTML = [
    {
      title: "本机自用消耗",
      detail: "当前仍以本机自用路径归因",
      value: `${formatCompactCount(totalTokens)} Token`,
    },
    {
      title: "共享成员消耗",
      detail: "LAN 成员模型尚未落地",
      value: "0 Token",
    },
    {
      title: "已启用客户端 key",
      detail: "兼容现有 clientMappings",
      value: `${formatCompactCount(mappingCount)} 个`,
    },
    {
      title: "主要来源",
      detail: topClient
        ? normalizeUsageClientTagLabel(topClient.clientTag)
        : "暂无真实请求",
      value: topClient
        ? `${formatCompactCount(topClient.usage.totalTokens)} Token`
        : "暂无",
    },
  ]
    .map(
      (item) => `
        <div class="dashboard-summary-item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.detail)}</span>
          </div>
          <small>${escapeHtml(item.value)}</small>
        </div>
      `,
    )
    .join("");
}

function renderDashboardAlertSummary(): void {
  const node = document.getElementById("dashboard-alert-summary");
  if (!node) {
    return;
  }

  const primaryDiagnostic = getPrimaryRuntimeDiagnostic();
  const recentErrors = state.health?.recentErrors ?? [];
  const authNeedsKey =
    (state.securitySettings?.enabled ?? state.health?.inferenceAuth?.enabled) &&
    !(state.securitySettings?.hasApiKey ?? state.health?.inferenceAuth?.hasApiKey);
  const alerts = [
    ...(primaryDiagnostic
      ? [
          {
            title: primaryDiagnostic.title,
            detail: primaryDiagnostic.message,
            value: primaryDiagnostic.severity,
          },
        ]
      : []),
    ...(authNeedsKey
      ? [
          {
            title: "鉴权缺少密钥",
            detail: "API Key 模式已开启，但尚未保存可用密钥。",
            value: "warning",
          },
        ]
      : []),
    ...recentErrors.slice(0, 2).map((error) => ({
      title: error.level,
      detail: error.message,
      value: formatDate(Date.parse(error.createdAt)),
    })),
  ];

  if (alerts.length === 0) {
    node.innerHTML = `
      <div class="dashboard-summary-item">
        <div>
          <strong>暂无活动告警</strong>
          <span>共享能力仍默认关闭，外网共享处于三期预留态。</span>
        </div>
        <small>normal</small>
      </div>
    `;
    return;
  }

  node.innerHTML = alerts
    .map(
      (alert) => `
        <div class="dashboard-summary-item">
          <div>
            <strong>${escapeHtml(alert.title)}</strong>
            <span>${escapeHtml(alert.detail)}</span>
          </div>
          <small>${escapeHtml(alert.value)}</small>
        </div>
      `,
    )
    .join("");
}

function renderUsageOverview(): void {
  const container = document.getElementById("header-usage-observe-panel");
  if (!container) {
    return;
  }

  const shouldShowUsageOverview =
    state.activeView === "overview" || state.activeView === "usage";
  container.hidden = !shouldShowUsageOverview;
  if (!shouldShowUsageOverview) {
    return;
  }

  const summary = getActiveUsageWindowSummary();
  if (!summary) {
    container.innerHTML = "<div class='empty-card'>当前尚无 Token 用量统计。</div>";
    return;
  }

  const usage = summary.totals;
  const topAccount = summary.accounts[0];
  const topClient = summary.clients[0];
  const topModel = summary.models[0];
  const hasCachedSignal = summary.cachedSignalCount > 0;
  const hasReasoningSignal = summary.reasoningSignalCount > 0;
  const cachedAndReasoningLabel =
    hasReasoningSignal
      ? `${formatCompactCount(usage.cachedTokens)} / ${formatCompactCount(usage.reasoningTokens)}`
      : `${formatCompactCount(usage.cachedTokens)} / --`;
  const coverageLabel = `${hasCachedSignal ? "缓存已接入" : "缓存待接入"} / ${
    hasReasoningSignal ? "思考已接入" : "思考待接入"
  }`;
  const windowLabel = usageWindowLabel(state.usageObserveWindow);

  container.innerHTML = `
    <section class="usage-overview-card">
    <div class="card-header usage-card-header">
      <div>
        <strong class="card-title">Token 用量总览</strong>
        <div class="card-description">持续观察 ${escapeHtml(usageClientFilterLabel(state.usageClientFilter))} 在本地网关中的请求量、Token 消耗、缓存命中与延迟表现。当前窗口：${escapeHtml(windowLabel)}。</div>
      </div>
      <div class="usage-observe-controls">
        <button class="btn secondary mini" data-action="open-usage-details">查看明细</button>
        <button class="btn secondary mini" data-action="reset-telemetry">清除统计</button>
        <div class="usage-filter-group">
          <label for="usage-client-filter">统计对象</label>
          <select id="usage-client-filter" class="input-field usage-select">
            <option value="all"${state.usageClientFilter === "all" ? " selected" : ""}>全部客户端</option>
            <option value="openclaw"${state.usageClientFilter === "openclaw" ? " selected" : ""}>OpenClaw</option>
            <option value="hermes"${state.usageClientFilter === "hermes" ? " selected" : ""}>Hermes</option>
            <option value="other"${state.usageClientFilter === "other" ? " selected" : ""}>其他客户端</option>
          </select>
        </div>
        <div class="usage-window-group" role="tablist" aria-label="Token 用量时间窗口">
          ${(["daily", "weekly", "monthly", "history"] as UsageObserveWindow[])
            .map(
              (window) => `
                <button
                  class="usage-window-chip"
                  data-action="usage-window"
                  data-usage-window="${window}"
                  data-active="${state.usageObserveWindow === window ? "true" : "false"}"
                >${escapeHtml(window === "daily" ? "日" : window === "weekly" ? "周" : window === "monthly" ? "月" : "总")}</button>
              `,
            )
            .join("")}
        </div>
      </div>
    </div>
    <div class="usage-observe-grid stat-card-grid">
      <div class="usage-kpi-card stat-card usage-kpi-primary">
        <small>总请求数</small>
        <strong>${escapeHtml(formatCompactCount(usage.requestCount))}</strong>
        <span>成功 ${escapeHtml(formatCompactCount(usage.successCount))} / 失败 ${escapeHtml(formatCompactCount(usage.failureCount))}</span>
      </div>
      <div class="usage-kpi-card stat-card">
        <small>总 Token 数</small>
        <strong>${escapeHtml(formatCompactCount(usage.totalTokens))}</strong>
        <span>输入 ${escapeHtml(formatCompactCount(usage.inputTokens))} / 输出 ${escapeHtml(formatCompactCount(usage.outputTokens))}</span>
      </div>
      <div class="usage-kpi-card stat-card">
        <small>缓存 / 思考</small>
        <strong>${escapeHtml(cachedAndReasoningLabel)}</strong>
        <span>缓存 ${hasCachedSignal ? escapeHtml(formatCompactCount(usage.cachedTokens)) : "待接入"} / 思考 ${hasReasoningSignal ? escapeHtml(formatCompactCount(usage.reasoningTokens)) : "待接入"}</span>
      </div>
      <div class="usage-kpi-card stat-card">
        <small>平均延迟</small>
        <strong>${escapeHtml(formatUsageLatency(usage))}</strong>
        <span>成功率 ${escapeHtml(formatUsageSuccessRate(usage))}</span>
      </div>
    </div>
    <div class="usage-observe-meta">
      <span>历史累计起点：${escapeHtml(formatDate(summary.since))}</span>
      <span>最近更新：${escapeHtml(formatDate(summary.updatedAt))}</span>
      <span>历史导入：${escapeHtml(summary.importedEventCount > 0 ? `${formatCompactCount(summary.importedEventCount)} 条` : "无")}</span>
      <span>${escapeHtml(coverageLabel)}</span>
      <span>主要客户端：${escapeHtml(topClient ? `${normalizeUsageClientTagLabel(topClient.clientTag)} (${formatCompactCount(topClient.usage.requestCount)})` : "暂无")}</span>
      <span>最忙账号：${escapeHtml(topAccount ? `${topAccount.email ?? topAccount.accountId} (${formatCompactCount(topAccount.usage.totalTokens)})` : "暂无")}</span>
      <span>主要模型：${escapeHtml(topModel ? `${topModel.modelAlias} (${formatCompactCount(topModel.usage.totalTokens)})` : "暂无")}</span>
    </div>
    </section>
  `;
}

function renderUsageWorkbench(): void {
  const summary = getActiveUsageWindowSummary();
  renderUsageTrendChart(summary);
  renderUsageDimensionInsights(summary);
  renderUsageAlertRules(summary);
  renderUsageAlertEvents();
}

function renderUsageTrendChart(summary: UsageWindowSummary | undefined): void {
  const node = document.getElementById("usage-trend-chart");
  if (!node) {
    return;
  }
  if (!summary || summary.totals.totalTokens <= 0) {
    node.innerHTML = `
      <div class="empty-card">当前窗口暂无 Token 用量统计。发起请求后这里会展示输入、输出、缓存与思考 Token 的结构。</div>
    `;
    return;
  }

  const consumerTimeline =
    state.usageObserveWindow === "daily" ? summary.consumerTimeline ?? [] : [];
  if (consumerTimeline.length > 0) {
    renderUsageConsumerTimelineChart(node, summary, consumerTimeline);
    return;
  }

  const bars = [
    {
      label: "输入",
      value: summary.totals.inputTokens,
      className: "primary",
    },
    {
      label: "输出",
      value: summary.totals.outputTokens,
      className: "secondary",
    },
    {
      label: "缓存",
      value: summary.totals.cachedTokens,
      className: "tertiary",
    },
    {
      label: "思考",
      value: summary.totals.reasoningTokens,
      className: "quaternary",
    },
  ];
  const maxValue = Math.max(...bars.map((item) => item.value), 1);

  node.innerHTML = `
    <div class="usage-chart-bars">
      ${bars
        .map((item) => {
          const height = Math.max(10, Math.round((item.value / maxValue) * 100));
          return `
            <div class="usage-chart-bar-wrap">
              <div class="usage-chart-bar-track">
                <div
                  class="usage-chart-bar ${item.className}"
                  style="height: ${height}%"
                  title="${escapeHtml(item.label)} ${escapeHtml(formatCompactCount(item.value))} Token"
                ></div>
              </div>
              <strong>${escapeHtml(formatCompactCount(item.value))}</strong>
              <span>${escapeHtml(item.label)}</span>
            </div>
          `;
        })
        .join("")}
    </div>
    <div class="usage-chart-legend">
      <span>窗口：${escapeHtml(usageWindowLabel(state.usageObserveWindow))}</span>
      <span>总 Token：${escapeHtml(formatCompactCount(summary.totals.totalTokens))}</span>
      <span>请求：${escapeHtml(formatCompactCount(summary.totals.requestCount))}</span>
      <span>成功率：${escapeHtml(formatUsageSuccessRate(summary.totals))}</span>
    </div>
  `;
}

function renderUsageConsumerTimelineChart(
  node: HTMLElement,
  summary: UsageWindowSummary,
  timeline: UsageConsumerTimelinePoint[],
): void {
  const hourMs = 60 * 60 * 1000;
  const currentHour = Math.floor(Date.now() / hourMs) * hourMs;
  const firstBucketStart = currentHour - 23 * hourMs;
  const byBucket = new Map<
    number,
    {
      totalTokens: number;
      requestCount: number;
      failureCount: number;
      byConsumer: Map<string, number>;
    }
  >();
  const byConsumer = new Map<
    string,
    {
      label: string;
      totalTokens: number;
    }
  >();

  for (const point of timeline) {
    if (point.bucketStart < firstBucketStart || point.bucketStart > currentHour) {
      continue;
    }
    const bucket = byBucket.get(point.bucketStart) ?? {
      totalTokens: 0,
      requestCount: 0,
      failureCount: 0,
      byConsumer: new Map<string, number>(),
    };
    bucket.totalTokens += point.usage.totalTokens;
    bucket.requestCount += point.usage.requestCount;
    bucket.failureCount += point.usage.failureCount;
    const label = getAccessConsumerDisplayName(point.consumerId, point.clientTag);
    bucket.byConsumer.set(
      label,
      (bucket.byConsumer.get(label) ?? 0) + point.usage.totalTokens,
    );
    byBucket.set(point.bucketStart, bucket);

    const consumer = byConsumer.get(point.consumerId) ?? {
      label,
      totalTokens: 0,
    };
    consumer.totalTokens += point.usage.totalTokens;
    byConsumer.set(point.consumerId, consumer);
  }

  const buckets = Array.from({ length: 24 }, (_, index) => {
    const bucketStart = firstBucketStart + index * hourMs;
    return {
      bucketStart,
      data: byBucket.get(bucketStart),
    };
  });
  const maxValue = Math.max(
    ...buckets.map((bucket) => bucket.data?.totalTokens ?? 0),
    1,
  );
  const topConsumers = Array.from(byConsumer.values())
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .slice(0, 3);

  node.innerHTML = `
    <div class="usage-timeline-bars">
      ${buckets
        .map((bucket) => {
          const totalTokens = bucket.data?.totalTokens ?? 0;
          const height =
            totalTokens > 0
              ? Math.max(8, Math.round((totalTokens / maxValue) * 100))
              : 0;
          const topConsumer = bucket.data
            ? Array.from(bucket.data.byConsumer.entries()).sort(
                (left, right) => right[1] - left[1],
              )[0]
            : undefined;
          const titleParts = [
            `${formatUsageHourLabel(bucket.bucketStart)}-${formatUsageHourLabel(bucket.bucketStart + hourMs)}`,
            `${formatCompactCount(totalTokens)} Token`,
            bucket.data
              ? `${formatCompactCount(bucket.data.requestCount)} 次请求`
              : "暂无请求",
            topConsumer
              ? `Top ${topConsumer[0]} ${formatCompactCount(topConsumer[1])}`
              : undefined,
          ].filter(Boolean);
          return `
            <div class="usage-timeline-bar-wrap">
              <div class="usage-timeline-bar-track">
                <div
                  class="usage-chart-bar primary"
                  style="height: ${height}%; min-height: ${totalTokens > 0 ? "8px" : "0"}"
                  title="${escapeHtml(titleParts.join(" · "))}"
                ></div>
              </div>
              <span>${escapeHtml(formatUsageHourLabel(bucket.bucketStart).slice(0, 2))}</span>
            </div>
          `;
        })
        .join("")}
    </div>
    <div class="usage-chart-legend">
      <span>成员 24h 趋势：${escapeHtml(formatCompactCount(timeline.length))} 个小时成员桶</span>
      <span>窗口：${escapeHtml(usageWindowLabel(state.usageObserveWindow))}</span>
      <span>总 Token：${escapeHtml(formatCompactCount(summary.totals.totalTokens))}</span>
      <span>峰值小时：${escapeHtml(formatCompactCount(maxValue))} Token</span>
      <span>Top 成员：${escapeHtml(topConsumers.length > 0 ? topConsumers.map((item) => `${item.label} ${formatCompactCount(item.totalTokens)}`).join(" / ") : "暂无")}</span>
    </div>
  `;
}

function renderUsageDimensionInsights(
  summary: UsageWindowSummary | undefined,
): void {
  const node = document.getElementById("usage-dimension-insights");
  if (!node) {
    return;
  }

  if (!summary) {
    node.innerHTML = "<div class='empty-card'>当前尚无维度统计。</div>";
    return;
  }

  const topConsumer = summary.consumers[0];
  const topAccount = summary.accounts[0];
  const topPool = (summary.pools ?? [])[0];
  const topModel = summary.models[0];
  const failureRate =
    summary.totals.requestCount > 0
      ? summary.totals.failureCount / summary.totals.requestCount
      : 0;
  const sharedPoolCount = (state.poolSettings?.pools ?? []).filter(
    (pool) => normalizePoolVisibility(pool.visibility) === "shared-lan",
  ).length;

  const cards = [
    {
      label: "成员用量",
      value: topConsumer
        ? topConsumer.clientTag || topConsumer.consumerId
        : "暂无成员请求",
      detail: topConsumer
        ? `${formatCompactCount(topConsumer.usage.totalTokens)} Token · ${formatCompactCount(topConsumer.usage.requestCount)} 次请求`
        : "创建 LAN 成员并使用独立 API key 后，会按 consumerId / accessKeyId 聚合。",
    },
    {
      label: "账号与号池",
      value: topPool?.poolId ?? (topAccount ? topAccount.email ?? topAccount.accountId : "暂无账号消耗"),
      detail: topPool
        ? `${formatCompactCount(topPool.usage.totalTokens)} Token · ${formatCompactCount(topPool.usage.requestCount)} 次号池请求`
        : topAccount
          ? `${formatCompactCount(topAccount.usage.totalTokens)} Token · shared 号池 ${formatCompactCount(sharedPoolCount)} 个`
          : `当前配置 shared 号池 ${formatCompactCount(sharedPoolCount)} 个。`,
    },
    {
      label: "模型分布",
      value: topModel ? topModel.modelAlias : "暂无模型请求",
      detail: topModel
        ? `${formatCompactCount(topModel.usage.totalTokens)} Token · ${formatCompactCount(topModel.usage.requestCount)} 次请求`
        : "模型别名统计会随 /v1/chat/completions 请求自动积累。",
    },
    {
      label: "失败与限流",
      value:
        summary.totals.failureCount > 0
          ? `${formatCompactCount(summary.totals.failureCount)} 次失败`
          : "暂无失败",
      detail: `成功率 ${formatUsageSuccessRate(summary.totals)} · 失败率 ${Math.round(failureRate * 100)}%`,
    },
  ];

  node.innerHTML = cards
    .map(
      (card) => `
        <div class="usage-insight-card">
          <small>${escapeHtml(card.label)}</small>
          <strong>${escapeHtml(card.value)}</strong>
          <span>${escapeHtml(card.detail)}</span>
        </div>
      `,
    )
    .join("");
}

function renderUsageAlertRules(summary: UsageWindowSummary | undefined): void {
  const node = document.getElementById("usage-alert-rule-list");
  if (!node) {
    return;
  }

  const consumers = state.securitySettings?.accessControl?.consumers ?? [];
  const policies = state.securitySettings?.accessControl?.policies ?? [];
  const sharedPools = (state.poolSettings?.pools ?? []).filter(
    (pool) => normalizePoolVisibility(pool.visibility) === "shared-lan",
  );
  const failureRate =
    summary && summary.totals.requestCount > 0
      ? summary.totals.failureCount / summary.totals.requestCount
      : 0;
  const policiesWithoutPools = policies.filter(
    (policy) => (policy.allowedPoolIds ?? []).length === 0,
  ).length;
  const accessPolicyRules = buildAccessPolicyAlertRules({
    policies,
    dailyUsageSummary: state.usageSummary?.daily,
    runtimeConsumers: state.health?.inferenceObservability?.accessConsumers,
  });
  const policyErrorRule = buildAccessPolicyErrorSummaryRule(
    state.health?.recentErrors ?? [],
  );
  const recentAccessAlertEvents = state.accessAlerts ?? [];
  const unacknowledgedAccessAlerts = recentAccessAlertEvents.filter(
    (event) => !event.acknowledgedAt,
  );
  const acknowledgedAccessAlerts = recentAccessAlertEvents.filter(
    (event) => event.acknowledgedAt,
  );
  const latestAccessAlert =
    unacknowledgedAccessAlerts[0] ?? recentAccessAlertEvents[0];
  const latestAccessAlertOccurrenceNote =
    latestAccessAlert && (latestAccessAlert.occurrenceCount ?? 1) > 1
      ? ` · 重复 ${formatCompactCount(latestAccessAlert.occurrenceCount ?? 1)} 次，最近 ${formatDate(latestAccessAlert.lastSeenAt ?? latestAccessAlert.timestamp)}`
      : "";
  type UsageAlertRule = {
    title: string;
    detail: string;
    status: string;
    tone: string;
    action?: string;
    actionLabel?: string;
    eventId?: number;
    secondaryAction?: string;
    secondaryActionLabel?: string;
    cleanupAction?: string;
    cleanupActionLabel?: string;
  };
  const accessAlertEventRule = latestAccessAlert
    ? {
        title: "正式告警事件",
        detail: latestAccessAlert.acknowledgedAt
          ? `${latestAccessAlert.type} · 已于 ${formatDate(latestAccessAlert.acknowledgedAt)} 确认${latestAccessAlertOccurrenceNote}`
          : `${latestAccessAlert.type} · ${latestAccessAlert.message}${latestAccessAlertOccurrenceNote}`,
        status:
          unacknowledgedAccessAlerts.length > 0
            ? `${formatCompactCount(unacknowledgedAccessAlerts.length)} 条未确认`
            : "已确认",
        tone:
          latestAccessAlert.acknowledgedAt
            ? "active"
            : latestAccessAlert.severity === "critical"
              ? "danger"
              : "warning",
        action:
          latestAccessAlert.id && !latestAccessAlert.acknowledgedAt
            ? "ack-access-alert"
            : undefined,
        actionLabel: "确认",
        eventId: latestAccessAlert.id,
        secondaryAction:
          unacknowledgedAccessAlerts.length > 1
            ? "ack-all-access-alerts"
            : undefined,
        secondaryActionLabel: "全部确认",
        cleanupAction:
          acknowledgedAccessAlerts.length > 0
            ? "clear-acknowledged-access-alerts"
            : undefined,
        cleanupActionLabel: `清理已确认 ${formatCompactCount(acknowledgedAccessAlerts.length)}`,
      }
    : {
        title: "正式告警事件",
        detail: "暂无持久化访问策略告警事件。",
        status: "正常",
        tone: "active",
      };
  const rules: UsageAlertRule[] = [
    ...accessPolicyRules,
    accessAlertEventRule,
    policyErrorRule,
    {
      title: "共享号池可用账号过低",
      detail:
        sharedPools.length > 0
          ? `当前 shared-lan 号池 ${formatCompactCount(sharedPools.length)} 个。`
          : "尚无 shared-lan 号池；共享成员不应直接使用 private 号池。",
      status: sharedPools.length > 0 ? "正常" : "待配置",
      tone: sharedPools.length > 0 ? "active" : "warning",
    },
    {
      title: "成员号池授权缺口",
      detail:
        consumers.length > 0
          ? `${formatCompactCount(policiesWithoutPools)} 个成员策略尚未配置允许号池。`
          : "创建访问成员后，这里会提示 allowedPoolIds 配置缺口。",
      status: policiesWithoutPools > 0 ? "需检查" : "正常",
      tone: policiesWithoutPools > 0 ? "warning" : "active",
    },
    {
      title: "失败率异常",
      detail: summary
        ? `当前窗口失败 ${formatCompactCount(summary.totals.failureCount)} 次，成功率 ${formatUsageSuccessRate(summary.totals)}。`
        : "暂无请求统计。",
      status: failureRate > 0.1 ? "偏高" : "正常",
      tone: failureRate > 0.1 ? "warning" : "active",
    },
  ];

  node.innerHTML = rules
    .map((rule) => {
      const actionMarkup =
        rule.action === "ack-access-alert" && rule.eventId
          ? `<button class="btn secondary mini" data-action="ack-access-alert" data-alert-id="${escapeHtml(String(rule.eventId))}">${escapeHtml(rule.actionLabel ?? "处理")}</button>`
          : "";
      const secondaryActionMarkup =
        rule.secondaryAction === "ack-all-access-alerts"
          ? `<button class="btn secondary mini" data-action="ack-all-access-alerts">${escapeHtml(rule.secondaryActionLabel ?? "全部处理")}</button>`
          : "";
      const cleanupActionMarkup =
        rule.cleanupAction === "clear-acknowledged-access-alerts"
          ? `<button class="btn secondary mini" data-action="clear-acknowledged-access-alerts">${escapeHtml(rule.cleanupActionLabel ?? "清理已确认")}</button>`
          : "";
      return `
        <div class="usage-alert-rule">
          <strong>${escapeHtml(rule.title)}</strong>
          <span>${escapeHtml(rule.detail)}</span>
          <em class="badge ${escapeHtml(rule.tone)}">${escapeHtml(rule.status)}</em>
          ${actionMarkup || secondaryActionMarkup || cleanupActionMarkup ? `<div class="usage-alert-actions">${actionMarkup}${secondaryActionMarkup}${cleanupActionMarkup}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

function formatAccessAlertSeverityLabel(severity: AccessAlertEvent["severity"]): string {
  if (severity === "critical") {
    return "严重";
  }
  if (severity === "warning") {
    return "警告";
  }
  return "提示";
}

function accessAlertSeverityTone(severity: AccessAlertEvent["severity"]): string {
  if (severity === "critical") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "neutral";
}

function renderUsageAlertEvents(): void {
  const node = document.getElementById("usage-alert-event-list");
  if (!node) {
    return;
  }

  const events = state.accessAlerts ?? [];
  if (!events.length) {
    node.innerHTML = "<div class='empty-card'>暂无正式访问告警事件。</div>";
    return;
  }

  node.innerHTML = events
    .map((event) => {
      const isAcknowledged = Boolean(event.acknowledgedAt);
      const occurrenceCount = event.occurrenceCount ?? 1;
      const lastSeenAt = event.lastSeenAt ?? event.timestamp;
      const meta = [
        event.consumerId ? `成员 ${event.consumerId}` : undefined,
        event.accessKeyId ? `Key ${event.accessKeyId}` : undefined,
        `首次 ${formatDate(event.timestamp)}`,
        occurrenceCount > 1
          ? `重复 ${formatCompactCount(occurrenceCount)} 次，最近 ${formatDate(lastSeenAt)}`
          : undefined,
      ].filter(Boolean);
      const ackText = isAcknowledged
        ? `已确认 · ${formatDate(event.acknowledgedAt)}${event.acknowledgedBy ? ` · ${event.acknowledgedBy}` : ""}`
        : "未确认";
      const ackAction =
        event.id && !isAcknowledged
          ? `<button class="btn secondary mini" data-action="ack-access-alert" data-alert-id="${escapeHtml(String(event.id))}">确认</button>`
          : "";

      return `
        <div class="usage-alert-event-card ${isAcknowledged ? "acknowledged" : "unacknowledged"}">
          <div class="usage-alert-event-main">
            <div class="usage-alert-event-title">
              <strong>${escapeHtml(event.type)}</strong>
              <span class="badge ${escapeHtml(accessAlertSeverityTone(event.severity))}">${escapeHtml(formatAccessAlertSeverityLabel(event.severity))}</span>
              <span class="badge ${isAcknowledged ? "active" : "warning"}">${escapeHtml(ackText)}</span>
            </div>
            <p>${escapeHtml(event.message)}</p>
            <span>${escapeHtml(meta.join(" · "))}</span>
          </div>
          <div class="usage-alert-actions">${ackAction}</div>
        </div>
      `;
    })
    .join("");
}

function buildAccountUsageRankingMarkup(): string {
  const summary = getActiveUsageWindowSummary();
  if (!summary) {
    return "<div class='empty-card'>当前尚无账号级 Token 用量统计。</div>";
  }

  const rows = summary.accounts.slice(0, 6);
  const topAccount = rows[0];

  return `
    <div class="card routing-observe-panel" style="margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px; flex-wrap: wrap;">
        <div>
          <strong style="font-size: 16px;">账号级 Token 用量排行</strong>
          <div style="font-size: 14px; color: var(--text-secondary);">按 ${escapeHtml(usageWindowLabel(state.usageObserveWindow))} 观察桌面端账号的 Token 消耗排行，帮助把总览消耗视图落到具体账号。</div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span class="badge neutral">${escapeHtml(usageClientFilterLabel(state.usageClientFilter))}</span>
          <div class="usage-window-group" role="tablist" aria-label="账号级 Token 用量窗口">
            ${(["daily", "weekly", "monthly", "history"] as UsageObserveWindow[])
              .map(
                (window) => `
                  <button
                    class="usage-window-chip"
                    data-action="usage-window"
                    data-usage-window="${window}"
                    data-active="${state.usageObserveWindow === window ? "true" : "false"}"
                  >${escapeHtml(window === "daily" ? "日" : window === "weekly" ? "周" : window === "monthly" ? "月" : "总")}</button>
                `,
              )
              .join("")}
          </div>
        </div>
      </div>
      <div class="routing-observe-grid" style="grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 12px;">
        <div class="routing-observe-kpi">
          <small>${escapeHtml(usageWindowLabel(state.usageObserveWindow))}账号数</small>
          <strong>${escapeHtml(formatCompactCount(summary.accounts.length))}</strong>
        </div>
        <div class="routing-observe-kpi">
          <small>Top 账号</small>
          <strong>${escapeHtml(topAccount ? (topAccount.email ?? topAccount.accountId) : "暂无")}</strong>
        </div>
        <div class="routing-observe-kpi">
          <small>Top 账号 Token</small>
          <strong>${escapeHtml(topAccount ? formatCompactCount(topAccount.usage.totalTokens) : "0")}</strong>
        </div>
        <div class="routing-observe-kpi">
          <small>历史导入</small>
          <strong>${escapeHtml(summary.importedEventCount > 0 ? `${formatCompactCount(summary.importedEventCount)} 条` : "无")}</strong>
        </div>
      </div>
      <div class="usage-details-list">
        ${
          rows.length > 0
            ? rows
                .map(
                  (row, index) => `
                    <div class="usage-details-item">
                      <div class="usage-details-item-head">
                        <div style="display: grid; gap: 2px;">
                          <strong>#${index + 1} ${escapeHtml(row.email ?? row.accountId)}</strong>
                          <small>${escapeHtml(row.accountId)}</small>
                        </div>
                        <span class="badge neutral">${escapeHtml(formatCompactCount(row.usage.totalTokens))} Token</span>
                      </div>
                      <span>请求 ${escapeHtml(formatCompactCount(row.usage.requestCount))} · 成功率 ${escapeHtml(formatUsageSuccessRate(row.usage))} · 平均延迟 ${escapeHtml(formatUsageLatency(row.usage))}</span>
                      <span>输入 ${escapeHtml(formatCompactCount(row.usage.inputTokens))} / 输出 ${escapeHtml(formatCompactCount(row.usage.outputTokens))} / 缓存 ${escapeHtml(formatCompactCount(row.usage.cachedTokens))} / 思考 ${escapeHtml(formatCompactCount(row.usage.reasoningTokens))}</span>
                    </div>
                  `,
                )
                .join("")
            : "<div class='empty-card'>当前窗口暂无账号级 Token 用量记录。</div>"
        }
      </div>
    </div>
  `;
}

function renderAccountUsageRankingPanel(): void {
  const panel = document.getElementById("account-usage-ranking-panel");
  if (!panel) {
    return;
  }
  panel.innerHTML = buildAccountUsageRankingMarkup();
}

function renderUsagePanelsForWindowChange(): void {
  renderUsageOverview();
  if (state.activeView === "usage") {
    renderUsageWorkbench();
  }
  if (state.activeView === "accounts") {
    renderAccountUsageRankingPanel();
  }
  renderUsageDetailsModal();
}

function renderAccountActivityOverview(): void {
  const groups = getAccountGroups();
  const activitySummary = buildAccountActivitySummary(groups.groups);
  const topClientTag = activitySummary.topClientTag5m
    ? `${normalizeClientTagLabel(activitySummary.topClientTag5m.clientTag)} (${activitySummary.topClientTag5m.requestCount})`
    : "暂无";
  const topAccount = activitySummary.topAccount1h
    ? `${activitySummary.topAccount1h.title} (${activitySummary.topAccount1h.requestCount})`
    : "暂无";

  setText(
    "account-activity-summary-5m",
    String(activitySummary.totalRequestCount5m),
  );
  setText(
    "account-activity-summary-1h",
    String(activitySummary.totalRequestCount1h),
  );
  setText(
    "account-activity-summary-24h",
    String(activitySummary.totalRequestCount24h),
  );
  setText(
    "account-activity-summary-active-5m",
    `${activitySummary.activeAccountCount5m} 个`,
  );
  setText(
    "account-activity-summary-active-1h",
    `${activitySummary.activeAccountCount1h} 个`,
  );
  setText(
    "account-activity-summary-active-24h",
    `${activitySummary.activeAccountCount24h} 个`,
  );
  setText("account-activity-summary-top-client", topClientTag);
  setText(
    "account-activity-summary-top-client-1h",
    activitySummary.topClientTag1h
      ? `${normalizeClientTagLabel(activitySummary.topClientTag1h.clientTag)} (${activitySummary.topClientTag1h.requestCount})`
      : "暂无",
  );
  setText(
    "account-activity-summary-top-client-24h",
    activitySummary.topClientTag24h
      ? `${normalizeClientTagLabel(activitySummary.topClientTag24h.clientTag)} (${activitySummary.topClientTag24h.requestCount})`
      : "暂无",
  );
  setText("account-activity-summary-top-account", topAccount);

  const source5m = document.getElementById("account-activity-source-5m");
  const source1h = document.getElementById("account-activity-source-1h");
  const source24h = document.getElementById("account-activity-source-24h");
  if (source5m) {
    source5m.innerHTML = renderWindowClientTagBadges(
      activitySummary.byClientTag5m,
      activitySummary.totalRequestCount5m,
      "最近 5 分钟暂无来源分布",
    );
  }
  if (source1h) {
    source1h.innerHTML = renderWindowClientTagBadges(
      activitySummary.byClientTag1h,
      activitySummary.totalRequestCount1h,
      "最近 1 小时暂无来源分布",
    );
  }
  if (source24h) {
    source24h.innerHTML = renderWindowClientTagBadges(
      activitySummary.byClientTag24h,
      activitySummary.totalRequestCount24h,
      "最近 24 小时暂无来源分布",
    );
  }
}

function renderRoutingObservability(): void {
  const routing = state.health?.routingObservability;
  const recentContainer = document.getElementById("routing-observe-recent");
  const filterSelect = document.getElementById(
    "routing-observe-client-filter",
  ) as HTMLSelectElement | null;
  const windowSelect = document.getElementById(
    "routing-observe-window",
  ) as HTMLSelectElement | null;
  const windowLabelNode = document.getElementById(
    "routing-observe-window-label",
  );
  if (!routing) {
    setText("routing-observe-window-count", "0");
    if (windowLabelNode) {
      windowLabelNode.textContent = routingWindowLabel(
        state.routingObserveWindow,
      );
    }
    setText("routing-observe-total", "0");
    setText("routing-observe-last-hit", "暂无");
    setText("routing-observe-top-rule", "暂无");
    setText("routing-observe-top-client", "暂无");
    if (filterSelect) {
      filterSelect.innerHTML = `<option value="all">全部客户端</option>`;
      filterSelect.value = "all";
      state.routingClientFilter = "all";
    }
    if (windowSelect) {
      windowSelect.value = state.routingObserveWindow;
    }
    if (recentContainer) {
      recentContainer.innerHTML =
        "<div class='empty-state'>当前没有路由命中记录。启用规则并有真实请求经过后会在这里显示。</div>";
    }
    return;
  }

  const topRule = routing.byRule[0];
  const topClient = routing.byClientTag[0];
  if (windowLabelNode) {
    windowLabelNode.textContent = routingWindowLabel(
      state.routingObserveWindow,
    );
  }
  if (windowSelect) {
    windowSelect.value = state.routingObserveWindow;
  }
  setText(
    "routing-observe-window-count",
    String(getRoutingWindowCount(routing, state.routingObserveWindow)),
  );
  setText("routing-observe-total", String(routing.totalMatched));
  setText(
    "routing-observe-last-hit",
    routing.lastMatchedAt ? formatRecentCall(routing.lastMatchedAt) : "暂无",
  );
  setText(
    "routing-observe-top-rule",
    topRule ? `${topRule.ruleName} (${topRule.hits})` : "暂无",
  );
  setText(
    "routing-observe-top-client",
    topClient
      ? `${normalizeClientTagLabel(topClient.clientTag)} (${topClient.hits})`
      : "暂无",
  );

  const clientOptions = routing.byClientTag.map((item) => item.clientTag);
  if (
    state.routingClientFilter !== "all" &&
    !clientOptions.includes(state.routingClientFilter)
  ) {
    state.routingClientFilter = "all";
  }
  if (filterSelect) {
    const options = [
      `<option value="all">全部客户端</option>`,
      ...clientOptions.map((clientTag) => {
        const selected =
          clientTag === state.routingClientFilter ? " selected" : "";
        return `<option value="${escapeHtml(clientTag)}"${selected}>${escapeHtml(normalizeClientTagLabel(clientTag))}</option>`;
      }),
    ].join("");
    filterSelect.innerHTML = options;
    filterSelect.value = state.routingClientFilter;
  }

  const filteredRecent =
    state.routingClientFilter === "all"
      ? routing.recent
      : routing.recent.filter(
          (event) =>
            (event.clientTag ?? "unknown").toLowerCase() ===
            state.routingClientFilter.toLowerCase(),
        );

  if (!recentContainer) {
    return;
  }

  if (!filteredRecent.length) {
    recentContainer.innerHTML =
      state.routingClientFilter === "all"
        ? "<div class='empty-state'>当前没有路由命中记录。启用规则并有真实请求经过后会在这里显示。</div>"
        : "<div class='empty-state'>当前筛选客户端暂无命中记录。</div>";
    return;
  }

  recentContainer.innerHTML = filteredRecent
    .map((event) => {
      const warnings = event.warnings?.length
        ? `<span class="badge incomplete">回退告警 ${event.warnings.length}</span>`
        : "";
      return `
        <div class="routing-event-item">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <strong style="font-size: 14px;">${escapeHtml(event.matchedRuleName)}</strong>
            <span style="font-size: 14px; color: var(--text-secondary);">${escapeHtml(formatRecentCall(event.timestamp))}</span>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px;">
            <span class="badge neutral">客户端 ${escapeHtml(normalizeClientTagLabel(event.clientTag ?? "unknown"))}</span>
            <span class="badge neutral">模型 ${escapeHtml(event.requestedModelAlias)} → ${escapeHtml(event.resolvedModelAlias)}</span>
            ${event.sessionApplied && event.resolvedSessionId ? `<span class="badge active">会话切换 ${escapeHtml(event.resolvedSessionId)}</span>` : ""}
            ${warnings}
          </div>
        </div>
      `;
    })
    .join("");
}

function renderCodexAccounts(): void {
  const container = document.getElementById("codex-accounts");
  if (!container) {
    return;
  }
  const refreshErrorBySessionId = new Map(
    (state.lastUsageRefresh?.errors ?? []).map((item) => [
      item.sessionId,
      item.message,
    ]),
  );
  const getAccountRefreshError = (
    account: ReturnType<typeof getAccountGroups>["groups"][number],
  ) =>
    account.sessions
      .map((session) => refreshErrorBySessionId.get(session.id))
      .find((value) => typeof value === "string");
  const isQuotaSnapshotStale = (
    account: ReturnType<typeof getAccountGroups>["groups"][number],
    refreshErrorMessage?: string,
  ) => {
    if (!refreshErrorMessage) {
      return false;
    }
    const updatedAt = account.representative.quota?.updatedAt;
    if (typeof updatedAt !== "number") {
      return true;
    }
    return Date.now() - updatedAt > STALE_QUOTA_AFTER_REFRESH_ERROR_MS;
  };
  const getDisplayQuotaPercentage = (
    account: ReturnType<typeof getAccountGroups>["groups"][number],
  ) => {
    const refreshErrorMessage = getAccountRefreshError(account);
    if (isQuotaSnapshotStale(account, refreshErrorMessage)) {
      return undefined;
    }
    return getQuotaPercentage(account.representative);
  };

  const accounts = getVisibleLocalImportAccountGroups();
  reconcileSelectedAccountKeys(accounts);
  const activitySummary = buildAccountActivitySummary(accounts);
  const healthyQuotaCount = accounts.filter(
    (account) => (getDisplayQuotaPercentage(account) ?? 0) > 50,
  ).length;
  const warningQuotaCount = accounts.filter((account) => {
    const percentage = getDisplayQuotaPercentage(account);
    return (
      typeof percentage === "number" && percentage > 20 && percentage <= 50
    );
  }).length;
  const lowQuotaCount = accounts.filter((account) => {
    const percentage = getDisplayQuotaPercentage(account);
    return typeof percentage === "number" && percentage <= 20;
  }).length;

  cancelAccountRenderFrame();

  const buildAccountCardMarkup = (
    account: ReturnType<typeof getAccountGroups>["groups"][number],
  ): string => {
    const title = getSessionTitle(account.representative);
    const avatarTone = getAvatarToneIndex(account.representative.id);
    const refreshErrorMessage = getAccountRefreshError(account);
    const quotaIsStale = isQuotaSnapshotStale(account, refreshErrorMessage);
    const quotaPercentage = quotaIsStale
      ? undefined
      : getQuotaPercentage(account.representative);
    const quotaScope = formatQuotaWindowLabel(account.representative);
    const quotaToneClass = getQuotaToneClass(quotaPercentage).replace(
      "quota-",
      "",
    );
    const activity = account.representative.activity;
    const requestCount = activity?.requestCount ?? 0;
    const recentCallLabel = formatRecentCall(activity?.lastRequestAt);
    const clientTagBadges = renderClientTagBadges(activity?.byClientTag ?? []);
    const recentClientTagBadges = renderRecentClientTagBadges(
      activity?.recentByClientTag5m ?? [],
      activity?.recentRequestCount5m ?? 0,
    );
    const isLive =
      typeof activity?.lastRequestAt === "number" &&
      Date.now() - activity.lastRequestAt <= 90_000;
    const isPinned = isPinnedAccountSession(account.representative.id);
    const selected = selectedAccountKeys.has(account.key);
    const refreshMode =
      account.representative.credentialRefreshMode ??
      (account.representative.sourceKind === "local-import"
        ? "external-readonly"
        : undefined);
    const sourceBadge =
      account.representative.sourceKind === "local-import"
        ? account.representative.sourceLabel ?? "本地账号副本"
        : account.representative.sourceLabel ?? "OpenClaw 授权源";
    const ownershipBadge =
      refreshMode === "managed"
        ? "本项目可刷新"
        : "外部只读";
    const quotaUpdatedAt = account.representative.quota?.updatedAt
      ? `${quotaIsStale ? "上次成功同步于" : "同步于"} ${new Date(account.representative.quota.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "尚未同步";
    return `
      <div class="figma-table-row account-item account-assets-table-row${account.isActive ? " active" : ""}${isLive ? " live" : ""}${isPinned ? " pinned" : ""}${isPinned && isLive ? " pinned-live" : ""}" role="row" data-account-key="${escapeHtml(account.key)}" data-selected="${selected ? "true" : "false"}">
        <div class="figma-table-cell account-assets-main-cell">
          <div class="acc-header">
            <div class="acc-title-group">
              <label
                class="account-card-select"
                data-account-select-control="true"
                title="选择此账号用于批量操作"
              >
                <input
                  type="checkbox"
                  data-field="account-card-selector"
                  data-account-key="${escapeHtml(account.key)}"
                  aria-label="选择账号 ${escapeHtml(title)}"
                  ${selected ? "checked" : ""}
                />
              </label>
              <div class="acc-avatar" data-avatar-tone="${avatarTone}">${escapeHtml(title.charAt(0).toUpperCase())}</div>
              <div class="acc-info">
                <h4>${escapeHtml(title)}</h4>
                <span>${escapeHtml(account.representative.accountId ?? account.representative.profileId ?? "无 ID")}</span>
              </div>
            </div>
          </div>
          <div class="acc-status-group">
            <span class="badge neutral">${escapeHtml(sourceBadge)}</span>
            <span class="badge ${refreshMode === "managed" ? "active" : "warning"}">${escapeHtml(ownershipBadge)}</span>
            ${isPinned && isLive ? `<span class="badge featured">优先账号</span>` : ""}
            ${isPinned ? `<span class="badge neutral">已置顶</span>` : ""}
            ${isLive ? `<span class="badge active">活跃调用</span>` : ""}
            ${refreshErrorMessage ? `<span class="badge incomplete">${quotaIsStale ? "额度已过期" : "额度同步失败"}</span>` : ""}
            <span class="badge ${account.representative.status}">${statusLabel(account.representative.status)}</span>
          </div>
        </div>
        <div class="figma-table-cell account-assets-ownership-cell">
          <div class="account-row-meta">
            <small>来源</small>
            <strong>${escapeHtml(sourceBadge)}</strong>
            <span>${escapeHtml(account.representative.sourcePath)}</span>
          </div>
          <div class="account-row-meta">
            <small>刷新所有权</small>
            <strong>${escapeHtml(ownershipBadge)}</strong>
            <span>${refreshMode === "managed" ? "凭据刷新由本项目托管" : "外部只读，不主动刷新 refresh token"}</span>
          </div>
          <div class="account-row-meta account-row-split">
            <span>套餐: ${escapeHtml(account.representative.planType ?? "待同步")}</span>
            <span>到期: ${escapeHtml(formatDate(account.representative.expiresAt))}</span>
          </div>
        </div>
        <div class="figma-table-cell account-assets-usage-cell">
          <div class="account-row-meta account-row-split">
            <span>${isLive ? "活跃调用" : "最近调用"}: ${escapeHtml(recentCallLabel)}</span>
            <span>请求数: ${requestCount}</span>
          </div>
          <div class="account-row-meta account-row-split">
            <span>近1小时: ${activity?.recentRequestCount1h ?? 0}</span>
            <span>近24小时: ${activity?.recentRequestCount24h ?? 0}</span>
          </div>
          <div class="account-row-source">
            <span>来源分布</span>
            <span class="client-tag-list">${clientTagBadges}</span>
          </div>
          <div class="account-row-source">
            <span>近 5 分钟</span>
            <span class="client-tag-list">${recentClientTagBadges}</span>
          </div>
          <div class="account-row-quota">
            <div class="account-row-split">
              <span>${quotaScope}</span>
              <strong>${quotaPercentage !== undefined ? `${quotaPercentage}%` : "待接入"}</strong>
            </div>
            <div class="acc-quota-bar">
              <div class="acc-quota-fill ${quotaToneClass}" style="width: ${quotaPercentage ?? 0}%;"></div>
            </div>
          </div>
          <div class="account-row-meta account-row-split">
            <span>重置: ${escapeHtml(formatCountdown(account.representative.quota?.resetAt))}</span>
            <span>${escapeHtml(quotaUpdatedAt)}</span>
          </div>
          ${refreshErrorMessage ? `<div class="account-row-refresh-error">${quotaIsStale ? "最近同步失败，旧额度已不再作为实时值展示。" : `最近同步失败：${escapeHtml(refreshErrorMessage)}`}</div>` : ""}
        </div>
        <div class="figma-table-cell account-assets-actions-cell">
          <div class="acc-actions">
            <button
              class="icon-btn"
              data-icon-only="true"
              data-action="activate"
              data-tone="${account.isActive ? "active" : "activate"}"
              data-tooltip="${account.isActive ? "当前活动账号" : "设为活动账号"}"
              data-session-id="${escapeHtml(account.representative.id)}"
              title="${account.isActive ? "当前活动账号" : "设为活动账号"}"
              aria-label="${account.isActive ? "当前活动账号" : "设为活动账号"}"
              type="button"
            >
              ${renderActionIcon(account.isActive ? "active" : "activate")}
            </button>
            <button
              class="icon-btn"
              data-icon-only="true"
              data-action="toggle-pin-session"
              data-tone="${isPinned ? "pin-active" : "pin"}"
              data-tooltip="${isPinned ? "取消置顶" : "置顶账号"}"
              data-session-id="${escapeHtml(account.representative.id)}"
              title="${isPinned ? "取消置顶" : "置顶账号"}"
              aria-label="${isPinned ? "取消置顶" : "置顶账号"}"
              type="button"
            >
              ${renderActionIcon(isPinned ? "unpin" : "pin")}
            </button>
            <button
              class="icon-btn"
              data-icon-only="true"
              data-action="refresh-session-usage"
              data-tone="refresh"
              data-tooltip="刷新额度"
              data-session-id="${escapeHtml(account.representative.id)}"
              title="刷新额度"
              aria-label="刷新额度"
              type="button"
            >
              ${renderActionIcon("refresh")}
            </button>
            <button
              class="icon-btn"
              data-icon-only="true"
              data-action="delete-codex-account"
              data-tone="delete"
              data-tooltip="删除本地副本"
              data-session-id="${escapeHtml(account.representative.id)}"
              title="删除本地副本"
              aria-label="删除本地副本"
              type="button"
            >
              ${renderActionIcon("delete")}
            </button>
          </div>
        </div>
      </div>
    `;
  };

  const topHeader = document.getElementById("accounts-top-header");
  if (topHeader) {
    topHeader.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px;">
        <div>
          <h3 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 600;">桌面端 Codex 账号</h3>
          <p style="margin: 0; font-size: 14px; color: var(--text-secondary);">这里展示的是本应用自己管理并可直接切换的 Codex 账号。</p>
        </div>
        <span class="badge neutral">${accounts.length} 个账号</span>
      </div>
      <div id="account-usage-ranking-panel">${buildAccountUsageRankingMarkup()}</div>
      <div class="card routing-observe-panel" style="margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px; flex-wrap: wrap;">
          <div>
            <strong style="font-size: 16px;">账号资产摘要</strong>
            <div style="font-size: 14px; color: var(--text-secondary);">从额度状态与来源窗口两个维度观察当前本地账号资产面板。</div>
          </div>
          <span class="badge neutral">资产视角</span>
        </div>
        <div class="routing-observe-grid" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
          <div class="routing-observe-kpi">
            <small>额度充足</small>
            <strong>${healthyQuotaCount} 个</strong>
          </div>
          <div class="routing-observe-kpi">
            <small>额度关注</small>
            <strong>${warningQuotaCount} 个</strong>
          </div>
          <div class="routing-observe-kpi">
            <small>额度紧张</small>
            <strong>${lowQuotaCount} 个</strong>
          </div>
          <div class="routing-observe-kpi">
            <small>近 1 小时最忙账号</small>
            <strong>${escapeHtml(
              activitySummary.topAccount1h
                ? `${activitySummary.topAccount1h.title} (${activitySummary.topAccount1h.requestCount})`
                : "暂无",
            )}</strong>
          </div>
        </div>
        <div class="source-window-grid" style="margin-top: 12px;">
          <div class="source-window-item">
            <strong>近 5 分钟来源</strong>
            <div class="client-tag-list">${renderWindowClientTagBadges(
              activitySummary.byClientTag5m,
              activitySummary.totalRequestCount5m,
              "最近 5 分钟暂无来源分布",
            )}</div>
          </div>
          <div class="source-window-item">
            <strong>近 1 小时来源</strong>
            <div class="client-tag-list">${renderWindowClientTagBadges(
              activitySummary.byClientTag1h,
              activitySummary.totalRequestCount1h,
              "最近 1 小时暂无来源分布",
            )}</div>
          </div>
          <div class="source-window-item">
            <strong>近 24 小时来源</strong>
            <div class="client-tag-list">${renderWindowClientTagBadges(
              activitySummary.byClientTag24h,
              activitySummary.totalRequestCount24h,
              "最近 24 小时暂无来源分布",
            )}</div>
          </div>
        </div>
      </div>
      <div class="settings-note compact" style="margin-bottom: 16px;">
        <strong>账号卡片说明</strong>
        <p>置顶账号固定显示在最前且不参与排序；“活跃调用”表示最近 90 秒内有请求命中；来源分布现已支持累计、近 5 分钟、近 1 小时与近 24 小时的窗口观察。</p>
      </div>
      `;
  }
  if (accounts.length === 0) {
    selectedAccountKeys.clear();
    container.innerHTML =
      "<div class='empty-state'>当前还没有导入任何桌面端 Codex 账号。可通过“添加账号”或“导入配置”补充。</div>";
    updateAccountToolbarState();
    return;
  }

  container.innerHTML = `
    ${buildAccountBulkToolbarMarkup(accounts)}
    <div class="figma-table account-assets-table" data-accounts-grid role="table" aria-label="账号资产列表">
      <div class="figma-table-head account-assets-table-head" role="row">
        <span>账号</span>
        <span>刷新所有权 / 来源</span>
        <span>调用与额度</span>
        <span>操作</span>
      </div>
    </div>
  `;
  const grid = container.querySelector<HTMLElement>("[data-accounts-grid]");
  if (!grid) {
    updateAccountToolbarState();
    return;
  }

  const batchToken = accountRenderToken;
  let cursor = 0;
  const batchSize = 10;

  const appendNextBatch = () => {
    if (batchToken !== accountRenderToken) {
      return;
    }
    const nextHtml = accounts
      .slice(cursor, cursor + batchSize)
      .map((account) => buildAccountCardMarkup(account))
      .join("");
    if (nextHtml) {
      const fragment = document.createRange().createContextualFragment(nextHtml);
      grid.appendChild(fragment);
    }
    cursor += batchSize;
    if (cursor < accounts.length) {
      accountRenderFrame = window.requestAnimationFrame(appendNextBatch);
      return;
    }
    accountRenderFrame = undefined;
  };

  appendNextBatch();

  updateAccountToolbarState();
}

function renderProviderRegistry(): void {
  const container = document.getElementById("provider-registry");
  if (!container) {
    return;
  }

  const providers = state.providers;
  if (!providers?.data.length) {
    container.innerHTML =
      "<div class='empty-card'>当前没有已注册 provider</div>";
    return;
  }

  const rows = providers.data
    .map((provider) => {
      const isDefault = provider.models.some(
        (model) => model.alias === state.health?.defaultModel,
      );
      const modelRows = provider.models
        .map(
          (model) => `
        <div class="model-line provider-registry-model-line">
          <div class="provider-registry-model-name">
            <strong>${escapeHtml(model.alias)}</strong>
            <span>${escapeHtml(model.providerModelId)}</span>
          </div>
          <span class="badge ${model.alias === state.health?.defaultModel ? "active" : "neutral"}">${model.alias === state.health?.defaultModel ? "默认" : "可用"}</span>
        </div>
      `,
        )
        .join("");

      return `
      <div class="figma-table-row provider-registry-row${isDefault ? " active" : ""}">
        <div class="figma-table-cell provider-registry-main-cell">
          <strong>${escapeHtml(provider.label)}</strong>
          <span>${escapeHtml(provider.id)}</span>
          <span class="badge neutral">${provider.usesSessions ? "会话型" : "固定配置"}</span>
        </div>
        <div class="figma-table-cell provider-registry-config-cell">
          <span>配置来源: ${escapeHtml(provider.configuration?.configuredVia ?? "未声明")}</span>
          <span>${provider.usesSessions ? `活动会话: ${escapeHtml(provider.activeSessionId ?? "未选择")}` : "无需活动会话"}</span>
        </div>
        <div class="figma-table-cell provider-registry-models-cell">
          <div class="provider-registry-model-list">${modelRows}</div>
        </div>
      </div>
    `;
    })
    .join("");

  container.innerHTML = `
    <div class="figma-table provider-registry-table">
      <div class="figma-table-head provider-registry-table-head">
        <span>Provider</span>
        <span>配置</span>
        <span>暴露模型</span>
      </div>
      ${rows}
    </div>
  `;
}

function getLanAccessBaseUrl(): string {
  const configuredPort = normalizeGatewayPort(state.systemSettings?.gatewayPort);
  return (
    state.health?.desktopNetwork?.lanBaseUrl?.trim() ||
    `http://<本机局域网IP>:${configuredPort}/v1`
  );
}

function buildLanAccessTemplateText(): string {
  const baseUrl = getLanAccessBaseUrl();
  return [
    "Local AI Gateway LAN 接入模板",
    "",
    `base_url: ${baseUrl}`,
    "api_key: <分发给该成员的一次性 API Key 明文>",
    "",
    "cc_switch / Codex / 支持自定义 Provider 的 Agent 工具：",
    "- Provider 类型：OpenAI-compatible 或 Custom OpenAI",
    `- Base URL：${baseUrl}`,
    "- API Key：粘贴该成员的专属 API Key",
    "- Model：使用本项目已暴露的模型别名",
    "",
    "cURL 验证：",
    `curl ${baseUrl}/models \\`,
    "  -H \"Authorization: Bearer <成员 API Key>\"",
  ].join("\n");
}

function renderLanAccessTemplate(): void {
  const container = document.getElementById("lan-access-template");
  if (!container) {
    return;
  }

  const security = state.securitySettings ?? state.health?.inferenceAuth;
  const lanEnabled = Boolean(security?.lanAccess?.enabled);
  const hasApiKey = Boolean(security?.hasApiKey);
  const baseUrl = getLanAccessBaseUrl();
  const status = lanEnabled
    ? hasApiKey
      ? "可分发模板"
      : "缺少 API Key"
    : "未启用";
  const detail = lanEnabled
    ? "将下面模板发给可信成员；真实 API Key 请从“访问与密钥”的成员 Key 创建或轮换结果中单独分发。"
    : "启用 LAN 共享并配置 API Key 后，这里会生成可分发给成员的接入模板。";

  container.innerHTML = `
    <div class="diagnostic-card detail-drawer-panel lan-access-template-card">
      <div class="diagnostic-card-header">
        <div>
          <strong>LAN 成员接入模板</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
        <span class="badge ${lanEnabled && hasApiKey ? "active" : "neutral"}">${escapeHtml(status)}</span>
      </div>
      <div class="diagnostic-fact-grid">
        <div class="diagnostic-fact"><span>Base URL</span><strong>${escapeHtml(baseUrl)}</strong></div>
        <div class="diagnostic-fact"><span>适用工具</span><strong>cc_switch / Codex / 自定义 Provider</strong></div>
      </div>
      <pre class="template-preview">${escapeHtml(buildLanAccessTemplateText())}</pre>
      <div class="usage-alert-actions">
        <button class="btn secondary mini" data-action="copy-lan-access-template">复制 LAN 模板</button>
      </div>
    </div>
  `;
}

function renderDiagnostics(): void {
  const serviceContainer = document.getElementById("service-diagnostics");
  const container = document.getElementById("provider-diagnostics");
  if (!container || !serviceContainer) {
    return;
  }

  renderStartupChecklist();
  renderAppDataStatus();
  renderLanAccessTemplate();

  const runtimeDiagnostics = state.runtimeDiagnostics;
  if (!runtimeDiagnostics.length) {
    serviceContainer.innerHTML =
      "<div class='empty-card'>当前没有额外的运行状态提示</div>";
  } else {
    serviceContainer.innerHTML = "";
    for (const item of runtimeDiagnostics) {
      const card = document.createElement("div");
      card.className = "diagnostic-card detail-drawer-panel service-diagnostic-card";
      const suggestion = item.suggestion
        ? `<div class="diagnostic-suggestion"><strong>建议处理</strong>${escapeHtml(item.suggestion)}</div>`
        : "";
      card.innerHTML = `
        <div class="diagnostic-card-header">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.message)}</span>
          </div>
          <span class="badge ${diagnosticBadgeClass(item.severity)}">${diagnosticSeverityLabel(item.severity)}</span>
        </div>
        ${suggestion}
      `;
      serviceContainer.appendChild(card);
    }
  }

  const diagnostics = state.health?.providerConfigurations ?? [];
  if (!diagnostics.length) {
    container.innerHTML =
      "<div class='empty-card'>暂无 provider 诊断信息</div>";
    return;
  }

  container.innerHTML = "";
  for (const item of diagnostics) {
    const card = document.createElement("div");
    card.className = "diagnostic-card detail-drawer-panel provider-diagnostic-card";
    const missing = item.missingEnvKeys?.length
      ? `<div class="diagnostic-suggestion warning"><strong>缺失配置项</strong>${escapeHtml(item.missingEnvKeys.join(", "))}</div>`
      : "";
    const notes = item.notes?.length
      ? `<div class="diagnostic-note-list">${item.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>`
      : "";

    card.innerHTML = `
      <div class="diagnostic-card-header">
        <div>
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.id)}</span>
        </div>
        <span class="badge ${item.status}">${statusTone(item.status)}</span>
      </div>
      <div class="diagnostic-fact-grid">
        <div class="diagnostic-fact"><span>注册状态</span><strong>${item.registered ? "已注册" : "未注册"}</strong></div>
        <div class="diagnostic-fact"><span>配置来源</span><strong>${escapeHtml(item.configuredVia)}</strong></div>
        <div class="diagnostic-fact"><span>鉴权方式</span><strong>${escapeHtml(item.authMode)}</strong></div>
        <div class="diagnostic-fact"><span>Base URL</span><strong>${escapeHtml(item.baseUrl ?? "未设置")}</strong></div>
      </div>
      ${missing}
      ${notes}
    `;
    container.appendChild(card);
  }
}

function renderAppDataStatus(): void {
  const container = document.getElementById("app-data-status");
  if (!container) {
    return;
  }

  const status = state.appDataStatus;
  if (!status) {
    container.innerHTML = "<div class='form-hint'>正在加载本地数据概况…</div>";
    return;
  }

  container.innerHTML = `
    <div class="routing-rule-guide app-data-status-card">
      <span>当前本地持久化数据：${escapeHtml(String(status.fileCount))} 个文件，约 ${escapeHtml(formatBytes(status.totalBytes))}。</span>
      <span>应用数据目录：${escapeHtml(status.rootDir)}</span>
      <span>备份目录：${escapeHtml(status.backupDir)}</span>
      <span>开发环境与安装版默认共用同一应用数据目录；仅删除应用程序文件不会清空这里的数据。</span>
      ${
        status.latestBackup
          ? `<span>最近安全备份：${escapeHtml(status.latestBackup.fileName)} · ${escapeHtml(
              formatDate(status.latestBackup.createdAt),
            )} · ${escapeHtml(formatBytes(status.latestBackup.sizeBytes))}</span>`
          : "<span>当前还没有历史安全备份文件。</span>"
      }
    </div>
  `;
}

function renderStartupChecklist(): void {
  const container = document.getElementById("startup-checklist");
  if (!container) {
    return;
  }

  const health = state.health;
  const sessions = state.sessions;
  if (!health || !sessions) {
    container.innerHTML =
      "<div class='empty-card'>正在加载首次启动与升级检查信息…</div>";
    return;
  }

  const activeSession = sessions.data.find(
    (session) => session.id === sessions.activeSessionId,
  );
  const totalRequestCount = sessions.data.reduce(
    (sum, session) => sum + (session.activity?.requestCount ?? 0),
    0,
  );
  const routingHitCount = health.routingObservability?.totalMatched ?? 0;
  const localAccountCount = getAccountGroups().localImport;
  const hasRecentErrors =
    (state.health?.recentErrors?.length ?? 0) > 0 ||
    (state.lastUsageRefresh?.errors?.length ?? 0) > 0;
  const baseUrl = health.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1";
  const model =
    health.openclaw?.model ?? health.defaultModel ?? "codex-default";

  const firstStartChecks: StartupCheckItem[] = [
    {
      title: "本地网关状态",
      description: health.ok
        ? `当前服务已就绪，入口为 ${baseUrl}`
        : "当前服务未完全就绪，请先处理顶部或诊断页中的异常提示。",
      badgeTone: health.ok ? "active" : "disabled",
      badgeLabel: health.ok ? "已就绪" : "需处理",
    },
    {
      title: "活动账号",
      description: activeSession
        ? `当前活动账号为 ${getSessionTitle(activeSession)}，默认模型为 ${model}`
        : "还没有选中活动账号。导入账号后，请在账号页将一个可用账号设为活动账号。",
      badgeTone: activeSession ? "active" : "incomplete",
      badgeLabel: activeSession ? "已设置" : "未设置",
    },
    {
      title: "真实第三方流量",
      description:
        totalRequestCount > 0
          ? `当前已记录 ${totalRequestCount} 次真实请求，路由命中 ${routingHitCount} 次。`
          : "当前尚未观测到任何真实第三方请求，建议先用接入模板完成一次联调。",
      badgeTone: totalRequestCount > 0 ? "active" : "neutral",
      badgeLabel: totalRequestCount > 0 ? "已验证" : "待联调",
    },
    {
      title: "已导入桌面端账号",
      description:
        localAccountCount > 0
          ? `当前已导入 ${localAccountCount} 个桌面端 Codex 账号，可继续做固定账号或灵活切号配置。`
          : "当前尚未导入桌面端账号。可通过 OAuth、JSON 或扫描本地授权快速补齐。",
      badgeTone: localAccountCount > 0 ? "active" : "incomplete",
      badgeLabel: localAccountCount > 0 ? "已导入" : "待导入",
    },
  ];

  const upgradeChecks: StartupCheckItem[] = [
    {
      title: "当前版本与运行方式",
      description: `当前网关版本为 v${health.version}，控制模式为 ${health.managed ? "桌面托管" : "外部服务"}。`,
      badgeTone: "neutral",
      badgeLabel: "运行信息",
    },
    {
      title: "升级后建议动作",
      description:
        "版本更新后，建议先查看一次“运行诊断与日志”，确认没有新的接入鉴权、端口或授权异常。",
      badgeTone: hasRecentErrors ? "incomplete" : "active",
      badgeLabel: hasRecentErrors ? "建议检查" : "正常",
    },
    {
      title: "源码版发布前预检",
      description:
        "如果你是从源码运行或准备打包，建议执行 `npm run preflight:release`，一次性校验构建、测试、网关 smoke 与桌面目录包。",
      badgeTone: "neutral",
      badgeLabel: "推荐",
    },
    {
      title: "端口与接入模板",
      description:
        "如果升级后修改了网关端口，请同步更新第三方客户端中的 baseUrl；总览页的接入模板会自动跟随当前端口和鉴权模式。",
      badgeTone: "neutral",
      badgeLabel: "避免遗漏",
    },
  ];

  const renderItem = (item: StartupCheckItem): string => `
    <div class="startup-check-item">
      <div class="startup-check-item-top">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="badge ${item.badgeTone}">${escapeHtml(item.badgeLabel)}</span>
      </div>
      <p>${escapeHtml(item.description)}</p>
    </div>
  `;

  container.innerHTML = `
    <div class="startup-check-card">
      <div class="startup-check-head">
        <div>
          <h3>首次启动检查</h3>
          <p>用于确认本地网关、活动账号与第三方联调是否已经形成最小可用闭环。</p>
        </div>
        <span class="badge ${health.ok && activeSession ? "active" : "incomplete"}">${health.ok && activeSession ? "基础闭环已形成" : "仍需检查"}</span>
      </div>
      <div class="startup-check-list">
        ${firstStartChecks.map(renderItem).join("")}
      </div>
    </div>
    <div class="startup-check-card">
      <div class="startup-check-head">
        <div>
          <h3>升级与发布前建议</h3>
          <p>用于版本更新、重新打包或迁移环境后，快速确认哪些动作最值得优先做。</p>
        </div>
        <span class="badge neutral">维护清单</span>
      </div>
      <div class="startup-check-list">
        ${upgradeChecks.map(renderItem).join("")}
      </div>
    </div>
  `;
}

function buildIntegrationSnippets(
  health: DashboardHealth,
): Record<IntegrationTemplateKey, string> {
  const baseUrl = health.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1";
  const model = health.openclaw?.model ?? "codex-default";
  const provider = health.openclaw?.provider ?? "openai";
  const requiresApiKey =
    (state.securitySettings?.enabled ?? health.inferenceAuth?.enabled) &&
    (state.securitySettings?.hasApiKey ?? health.inferenceAuth?.hasApiKey);

  const openclaw = [
    `provider=${provider}`,
    `baseUrl=${baseUrl}`,
    `model=${model}`,
    "clientTag=openclaw",
    ...(requiresApiKey ? ["apiKey=<你的 Local AI Gateway API Key>"] : []),
  ].join("\n");

  const hermes = [
    "model:",
    "  provider: custom",
    `  base_url: ${baseUrl}`,
    `  default: ${model}`,
    "custom_providers:",
    `- name: ${model}`,
    `  base_url: ${baseUrl}`,
    `  model: ${model}`,
    ...(requiresApiKey ? ["  api_key: <你的 Local AI Gateway API Key>"] : []),
  ].join("\n");

  const curlHeaders = [
    `-H "Content-Type: application/json"`,
    `-H "x-client-tag: hermes"`,
    ...(requiresApiKey
      ? [`-H "Authorization: Bearer <你的 Local AI Gateway API Key>"`]
      : []),
  ];
  const curl = [
    `curl ${baseUrl}/chat/completions \\`,
    ...curlHeaders.map((header) => `  ${header} \\`),
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"ping"}]}'`,
  ].join("\n");

  return {
    openclaw,
    hermes,
    curl,
  };
}

function renderGuide(): void {
  const container = document.getElementById("guide-cards");
  if (!container) {
    return;
  }

  const health = state.health;
  if (!health) {
    return;
  }

  const openAI = getProviderConfiguration("openai-compatible");
  const ollama = getProviderConfiguration("ollama");
  const snippets = buildIntegrationSnippets(health);
  const snippetRows: Array<{
    key: IntegrationTemplateKey;
    title: string;
    subtitle: string;
  }> = [
    {
      key: "openclaw",
      title: "OpenClaw 模板",
      subtitle: "适用于 OpenClaw provider 配置文件",
    },
    {
      key: "hermes",
      title: "Hermes 模板",
      subtitle: "适用于 Hermes 自定义 provider / custom provider 配置",
    },
    {
      key: "curl",
      title: "通用 cURL 模板",
      subtitle: "用于快速联通验证与故障排查",
    },
  ];

  container.innerHTML = `
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">定位说明</h3>
      <p style="margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">这是本地 AI Gateway 的桌面控制台，不是聊天窗口。当前主路径优先服务 OpenClaw 与 Hermes，负责本地服务管理、Provider 配置、桌面端 Codex 账号管理，以及本机可复用授权的导入与复用。</p>
    </div>
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">第三方接入模板</h3>
      <p style="margin: 0 0 10px 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">先在“Provider 配置”完成模型入口设定，必要时再到“策略路由 / 号池调度”补充分流规则，然后把 OpenClaw 或 Hermes 指向本地网关。每个模板都支持一键复制。</p>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        ${snippetRows
          .map((row) => {
            const snippet =
              row.key === "openclaw"
                ? snippets.openclaw
                : row.key === "hermes"
                  ? snippets.hermes
                  : snippets.curl;
            return `
              <section style="border: 1px solid var(--border-light); border-radius: 10px; padding: 10px; background: var(--bg-surface);">
                <div style="display: flex; justify-content: space-between; gap: 8px; align-items: flex-start;">
                  <div style="display: flex; flex-direction: column; gap: 2px;">
                    <strong style="font-size: 14px;">${escapeHtml(row.title)}</strong>
                    <span style="font-size: 14px; color: var(--text-secondary);">${escapeHtml(row.subtitle)}</span>
                  </div>
                  <button class="btn secondary" data-action="copy-template" data-template-key="${row.key}" title="复制 ${escapeHtml(row.title)}">复制</button>
                </div>
                <pre style="margin: 8px 0 0 0; padding: 10px; background: #fff; border-radius: 8px; font-size: 14px; border: 1px solid var(--border-light); overflow-x: auto;">${escapeHtml(snippet)}</pre>
              </section>
            `;
          })
          .join("")}
      </div>
    </div>
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">OpenAI-Compatible</h3>
      <p style="margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">${escapeHtml(
        openAI?.status === "active"
          ? "已启用，可以直接通过模型别名访问。"
          : openAI?.status === "incomplete"
            ? `配置还不完整：${openAI.missingEnvKeys?.join(", ") ?? "缺少关键字段"}`
            : "尚未启用。请在配置页填写 Base URL、API Key 和模型名。",
      )}</p>
    </div>
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">本地 Ollama</h3>
      <p style="margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">${escapeHtml(
        ollama?.status === "active"
          ? "已启用，可以将它的模型别名设为默认模型。"
          : ollama?.status === "incomplete"
            ? `配置还不完整：${ollama.missingEnvKeys?.join(", ") ?? "缺少关键字段"}`
            : "尚未启用。请在配置页填写本地 Ollama 地址和模型名。",
      )}</p>
    </div>
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">错误码速查</h3>
      <div style="display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--text-secondary);">
        <span><strong>401</strong>：未携带 API Key（鉴权模式为 API Key 时）</span>
        <span><strong>403</strong>：API Key 错误</span>
        <span><strong>503</strong>：网关已启用 API Key 鉴权，但尚未配置有效密钥</span>
      </div>
    </div>
  `;
}

function renderErrors(): void {
  const container = document.getElementById("recent-errors");
  if (!container) {
    return;
  }

  const refreshErrors = state.lastUsageRefresh?.errors ?? [];
  const errors = state.health?.recentErrors ?? [];
  if (!errors.length && !refreshErrors.length) {
    container.innerHTML = "<div class='empty-card'>最近没有新的错误记录</div>";
    return;
  }

  container.innerHTML = "";
  for (const item of refreshErrors.slice(0, 6)) {
    const card = document.createElement("div");
    card.className = "diagnostic-card detail-drawer-panel recent-error-card";
    card.innerHTML = `
      <div class="diagnostic-card-header">
        <div>
          <strong>额度刷新失败</strong>
          <span>${escapeHtml(item.sessionId)}</span>
        </div>
        <span class="badge incomplete">需处理</span>
      </div>
      <div class="diagnostic-suggestion">
        <strong>原因</strong>
        ${escapeHtml(item.message)}
      </div>
    `;
    container.appendChild(card);
  }

  for (const item of errors.slice(0, 6)) {
    const card = document.createElement("div");
    card.className = "diagnostic-card detail-drawer-panel recent-error-card";
    card.innerHTML = `
      <div class="diagnostic-card-header">
        <div>
          <strong>${escapeHtml(item.level.toUpperCase())}</strong>
          <span>${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN"))}</span>
        </div>
        <span class="badge ${item.level === "error" ? "disabled" : "neutral"}">${item.level === "error" ? "错误" : "日志"}</span>
      </div>
      <div class="diagnostic-suggestion">
        <strong>内容</strong>
        ${escapeHtml(item.message)}
      </div>
    `;
    container.appendChild(card);
  }
}

function applySettingsToForm(): void {
  const settings = state.settings ?? {};
  const codex = settings.codex ?? {};
  const openAI = settings.openAICompatible ?? {};
  const ollama = settings.ollama ?? {};
  const defaultSelect = document.getElementById(
    "default-model-alias",
  ) as HTMLSelectElement | null;
  const codexSelect = document.getElementById(
    "codex-upstream-model",
  ) as HTMLSelectElement | null;
  const codexExposeContainer = document.getElementById(
    "codex-exposed-models",
  ) as HTMLElement | null;

  if (codexSelect) {
    codexSelect.replaceChildren();
    for (const modelId of SUPPORTED_CODEX_UPSTREAM_MODELS) {
      const node = document.createElement("option");
      node.value = modelId;
      node.textContent = formatCodexUpstreamModelLabel(modelId);
      codexSelect.appendChild(node);
    }
    codexSelect.value = codex.upstreamModel ?? "gpt-5.4";
  }

  if (codexExposeContainer) {
    const selectedModels =
      codex.exposedModels === undefined
        ? [...SUPPORTED_CODEX_UPSTREAM_MODELS]
        : codex.exposedModels;
    codexExposeContainer.innerHTML = SUPPORTED_CODEX_UPSTREAM_MODELS.map(
      (modelId) => {
        const alias = getCodexAliasPreset(modelId);
        const checked = selectedModels.includes(modelId) ? "checked" : "";
        return `
          <label class="chip-check">
            <input type="checkbox" data-codex-exposed-model value="${escapeHtml(modelId)}" ${checked} />
            <span>${escapeHtml(alias)} → ${escapeHtml(formatCodexUpstreamModelLabel(modelId))}</span>
          </label>
        `;
      },
    ).join("");
  }

  if (defaultSelect) {
    const codexExposedAliases = (
      codex.exposedModels === undefined
        ? [...SUPPORTED_CODEX_UPSTREAM_MODELS]
        : codex.exposedModels
    )
      .map((modelId) => getCodexAliasPreset(modelId))
      .filter((alias) => alias !== "codex-custom");
    defaultSelect.replaceChildren();
    const aliasSet = new Set<string>([
      "codex-default",
      ...codexExposedAliases,
      ...(state.providers?.data.flatMap((provider) =>
        provider.models.map((model) => model.alias),
      ) ?? []),
      ...(openAI.alias ? [openAI.alias] : []),
      ...(ollama.alias ? [ollama.alias] : []),
      ...(settings.defaultModelAlias ? [settings.defaultModelAlias] : []),
    ]);
    const options = [
      { value: "", label: "自动选择默认模型" },
      ...Array.from(aliasSet).map((alias) => ({ value: alias, label: alias })),
    ];

    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      defaultSelect.appendChild(node);
    }
    defaultSelect.value = settings.defaultModelAlias ?? "";
  }

  (document.getElementById(
    "openai-enabled",
  ) as HTMLInputElement | null)!.checked = Boolean(openAI.enabled);
  (document.getElementById("openai-label") as HTMLInputElement | null)!.value =
    openAI.label ?? "OpenAI-Compatible";
  (document.getElementById(
    "openai-base-url",
  ) as HTMLInputElement | null)!.value = openAI.baseUrl ?? "";
  (document.getElementById(
    "openai-api-key",
  ) as HTMLInputElement | null)!.value = openAI.apiKey ?? "";
  (document.getElementById("openai-model") as HTMLInputElement | null)!.value =
    openAI.model ?? "";
  (document.getElementById("openai-alias") as HTMLInputElement | null)!.value =
    openAI.alias ?? "openai-compatible-default";
  (document.getElementById(
    "openai-display-name",
  ) as HTMLInputElement | null)!.value = openAI.displayName ?? "";

  (document.getElementById(
    "ollama-enabled",
  ) as HTMLInputElement | null)!.checked = Boolean(ollama.enabled);
  (document.getElementById("ollama-label") as HTMLInputElement | null)!.value =
    ollama.label ?? "Ollama";
  (document.getElementById(
    "ollama-base-url",
  ) as HTMLInputElement | null)!.value =
    ollama.baseUrl ?? "http://127.0.0.1:11434";
  (document.getElementById("ollama-model") as HTMLInputElement | null)!.value =
    ollama.model ?? "";
  (document.getElementById("ollama-alias") as HTMLInputElement | null)!.value =
    ollama.alias ?? "ollama-default";
  (document.getElementById(
    "ollama-display-name",
  ) as HTMLInputElement | null)!.value = ollama.displayName ?? "";
}

function createRoutingRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createPoolId(): string {
  return `pool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getRoutingRulesContainer(): HTMLElement | null {
  return document.getElementById("routing-rules-list");
}

function getPoolsContainer(): HTMLElement | null {
  return document.getElementById("pool-list");
}

function reconcileSelectedPoolIds(pools: PoolDefinition[]): void {
  const normalized = normalizePoolSelection(pools, selectedPoolIds);
  selectedPoolIds.clear();
  for (const poolId of normalized) {
    selectedPoolIds.add(poolId);
  }
}

function cleanupDeletedPoolState(poolIds: Iterable<string>): void {
  for (const poolId of poolIds) {
    cancelPoolMemberFieldFrame(poolId);
    poolMemberPanelState.delete(poolId);
    selectedPoolIds.delete(poolId);
  }
}

function syncAllPoolDraftsFromRows(): void {
  for (const row of Array.from(
    document.querySelectorAll<HTMLElement>("[data-pool-row]"),
  )) {
    syncPoolDraftFromRow(row);
  }
}

function buildPoolBulkToolbarMarkup(pools: PoolDefinition[]): string {
  const selectedCount = selectedPoolIds.size;
  const allSelected = pools.length > 0 && selectedCount === pools.length;
  const hasSelection = selectedCount > 0;
  return `
    <div class="pool-bulk-toolbar">
      <div class="pool-bulk-toolbar-main">
        <label class="pool-bulk-select" data-pool-select-control="true">
          <input
            type="checkbox"
            data-field="pool-bulk-select-all"
            aria-label="选择全部号池"
            ${allSelected ? "checked" : ""}
          />
          <span>选择全部号池</span>
        </label>
        <span class="badge neutral">已选 ${escapeHtml(String(selectedCount))} / 共 ${escapeHtml(String(pools.length))}</span>
        <span class="pool-bulk-hint">批量删除只影响当前编辑态，保存号池配置后正式生效。</span>
      </div>
      <div class="pool-bulk-actions">
        <button
          type="button"
          class="btn ghost mini"
          data-action="pool-clear-selection"
          ${hasSelection ? "" : "disabled"}
        >清空选择</button>
        <button
          type="button"
          class="btn danger-ghost mini"
          data-action="pool-delete-selected"
          ${hasSelection ? "" : "disabled"}
        >删除选中号池</button>
      </div>
    </div>
  `;
}

function resolveRoutingDispatchMode(rule: RoutingRule): RoutingDispatchMode {
  const explicit = rule.target?.dispatchMode;
  if (
    explicit === "active-session" ||
    explicit === "fixed-session" ||
    explicit === "dynamic-pool"
  ) {
    return explicit;
  }
  if (rule.target?.poolId?.trim()) {
    return "dynamic-pool";
  }
  if (rule.target?.sessionId?.trim()) {
    return "fixed-session";
  }
  return "active-session";
}

function buildPoolOptions(selectedPoolId?: string): string {
  const pools = state.poolSettings?.pools ?? [];
  const rows = [
    `<option value="">请选择号池</option>`,
    ...pools.map(
      (pool) =>
        `<option value="${escapeHtml(pool.id)}" ${pool.id === selectedPoolId ? "selected" : ""}>${escapeHtml(pool.name || pool.id)}</option>`,
    ),
  ];
  if (selectedPoolId && !pools.some((pool) => pool.id === selectedPoolId)) {
    rows.push(
      `<option value="${escapeHtml(selectedPoolId)}" selected>${escapeHtml(selectedPoolId)}（当前未找到）</option>`,
    );
  }
  return rows.join("");
}

function buildPoolMemberCandidates(): PoolMemberCandidateView[] {
  const sessions = (state.sessions?.data ?? []).filter(
    (session) => session.sourceKind === "local-import",
  );
  const groups = buildCodexAccountGroups(
    sessions,
    state.sessions?.activeSessionId,
  ).groups.filter((group) => group.sourceKind === "local-import");

  return groups.map((group) => {
    const representative = group.representative;
    const selector =
      representative.accountId?.trim() ||
      representative.profileId?.trim() ||
      representative.id;
    const quotaPercentage = getQuotaPercentage(representative);
    const statusLabel =
      representative.status === "available"
        ? "可用"
        : representative.status === "expired"
          ? "已过期"
          : "无效";
    const statusToneClass =
      representative.status === "available"
        ? "success"
        : representative.status === "expired"
          ? "warning"
          : "danger";

    return {
      selector,
      title: getSessionTitle(representative),
      subtitle:
        representative.email ||
        representative.accountId ||
        representative.profileId ||
        representative.id,
      quotaPercentage,
      quotaLabel:
        typeof quotaPercentage === "number" ? `${quotaPercentage}%` : "待同步",
      quotaToneClass: getQuotaToneClass(quotaPercentage),
      resetAt: representative.quota?.resetAt,
      resetLabel: formatCountdown(representative.quota?.resetAt),
      statusLabel,
      statusToneClass,
      matchers: Array.from(
        new Set(
          [
            selector,
            representative.id,
            representative.profileId,
            representative.accountId,
          ].filter((item): item is string => Boolean(item && item.trim())),
        ),
      ),
    };
  });
}

function getPoolPanelState(poolId: string): PoolMemberPanelState {
  const existing = poolMemberPanelState.get(poolId);
  if (existing) {
    return existing;
  }
  const next: PoolMemberPanelState = {
    search: "",
    sortKey: "quota",
    sortDirection: "desc",
    collapsed: false,
    cardCollapsed: false,
  };
  poolMemberPanelState.set(poolId, next);
  return next;
}

function setPoolPanelState(
  poolId: string,
  patch: Partial<PoolMemberPanelState>,
): void {
  const current = getPoolPanelState(poolId);
  poolMemberPanelState.set(poolId, {
    ...current,
    ...patch,
  });
}

function comparePoolMemberCandidates(
  left: PoolMemberCandidateView,
  right: PoolMemberCandidateView,
  sortKey: PoolMemberSortKey,
  direction: PoolMemberSortDirection,
): number {
  const multiplier = direction === "asc" ? 1 : -1;

  if (sortKey === "name") {
    return left.title.localeCompare(right.title, "zh-CN") * multiplier;
  }

  if (sortKey === "resetAt") {
    const leftValue = left.resetAt ?? Number.MAX_SAFE_INTEGER;
    const rightValue = right.resetAt ?? Number.MAX_SAFE_INTEGER;
    if (leftValue !== rightValue) {
      return (leftValue - rightValue) * multiplier;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  }

  const leftQuota = left.quotaPercentage ?? -1;
  const rightQuota = right.quotaPercentage ?? -1;
  if (leftQuota !== rightQuota) {
    return (leftQuota - rightQuota) * multiplier;
  }
  return left.title.localeCompare(right.title, "zh-CN");
}

function matchesPoolCandidateSearch(
  candidate: PoolMemberCandidateView,
  search: string,
): boolean {
  if (!search) {
    return true;
  }
  const normalized = search.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    candidate.title,
    candidate.subtitle,
    candidate.selector,
    ...candidate.matchers,
  ].some((value) => value.toLowerCase().includes(normalized));
}

function getPoolRuntime(poolId: string): PoolRuntimeSummary | undefined {
  return state.health?.poolObservability?.find(
    (pool) => pool.poolId === poolId,
  );
}

function getPoolRuntimeMember(
  pool: PoolDefinition,
  candidate: PoolMemberCandidateView,
): PoolRuntimeMember | undefined {
  return getPoolRuntime(pool.id)?.members.find(
    (member) =>
      candidate.matchers.includes(member.selector) ||
      (member.sessionId
        ? candidate.matchers.includes(member.sessionId)
        : false),
  );
}

function getPoolRuntimeMemberTone(
  member: PoolRuntimeMember | undefined,
): string {
  if (!member) {
    return "neutral";
  }
  if (member.selected && member.eligible) {
    return "active";
  }
  if (member.status === "available" || member.status === "expired") {
    return member.eligible ? "success" : "warning";
  }
  if (member.status === "cooldown" || member.status === "quota-low") {
    return "warning";
  }
  if (
    member.status === "invalid" ||
    member.status === "missing" ||
    member.status === "disabled"
  ) {
    return "danger";
  }
  return "neutral";
}

function formatPoolFailureClassLabel(
  failureClass?: PoolRuntimeMember["lastFailureClass"],
): string {
  if (failureClass === "auth_invalid") {
    return "鉴权失效";
  }
  if (failureClass === "quota_exhausted") {
    return "额度耗尽";
  }
  if (failureClass === "rate_limited") {
    return "速率限制";
  }
  if (failureClass === "network_retryable") {
    return "网络重试";
  }
  if (failureClass === "upstream_retryable") {
    return "上游重试";
  }
  if (failureClass === "non_retryable") {
    return "不可重试";
  }
  return "暂无";
}

function formatPoolEventTypeLabel(eventType: "selected" | "failover"): string {
  return eventType === "failover" ? "自动切号" : "首次选中";
}

function findSessionSummaryByIdentifier(
  identifier?: string,
): DashboardSessions["data"][number] | undefined {
  const normalized = identifier?.trim();
  if (!normalized) {
    return undefined;
  }
  return (state.sessions?.data ?? []).find(
    (session) =>
      session.id === normalized ||
      session.profileId === normalized ||
      session.accountId === normalized,
  );
}

function formatSessionReadableLabel(identifier?: string): {
  label: string;
  detail?: string;
  raw: string;
} {
  const raw = identifier?.trim() || "unknown";
  const session = findSessionSummaryByIdentifier(identifier);
  if (!session) {
    return {
      label: raw,
      raw,
    };
  }
  const label =
    getSessionTitle(session) ||
    session.email ||
    session.displayName ||
    session.accountId ||
    session.profileId ||
    session.id;
  const detailCandidates = [
    session.email,
    session.displayName,
    session.accountId,
    session.profileId,
    session.id,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const detail = detailCandidates.find((value) => value !== label);
  return {
    label,
    detail,
    raw,
  };
}

function formatPoolEventSessionLabel(event: {
  eventType: "selected" | "failover";
  selectedSessionId?: string;
  fromSessionId?: string;
  toSessionId?: string;
}): { title: string; detail?: string; raw: string } {
  if (event.eventType === "failover") {
    const from = formatSessionReadableLabel(event.fromSessionId);
    const to = formatSessionReadableLabel(
      event.toSessionId ?? event.selectedSessionId,
    );
    const detailParts = [from.detail, to.detail].filter(
      (value): value is string => Boolean(value),
    );
    return {
      title: `${from.label} -> ${to.label}`,
      detail: detailParts.length > 0 ? detailParts.join(" -> ") : undefined,
      raw: `${from.raw} -> ${to.raw}`,
    };
  }
  const selected = formatSessionReadableLabel(event.selectedSessionId);
  return {
    title: selected.label,
    detail: selected.detail,
    raw: selected.raw,
  };
}

function buildPoolEventMarkup(poolId: string): string {
  const events = getPoolRuntime(poolId)?.recentEvents ?? [];
  if (!events.length) {
    return `
      <div class="pool-event-empty">
        暂无最近调度事件。等该号池真正命中第三方请求后，这里会显示“为什么选中某个账号”以及“什么时候自动切号”。
      </div>
    `;
  }

  return `
    <div class="pool-event-list">
      ${events
        .map((event) => {
          const tone = event.eventType === "failover" ? "warning" : "active";
          const sessionLabel = formatPoolEventSessionLabel(event);
          const subtitleParts = [
            event.clientTag ? `来源 ${event.clientTag}` : undefined,
            event.requestedModelAlias
              ? `模型 ${event.requestedModelAlias}`
              : undefined,
            event.failureClass
              ? `原因 ${formatPoolFailureClassLabel(event.failureClass)}`
              : undefined,
          ].filter(Boolean);
          return `
            <div class="pool-event-item">
              <div class="pool-event-head">
                <span class="badge ${tone}">${escapeHtml(formatPoolEventTypeLabel(event.eventType))}</span>
                <strong title="${escapeHtml(sessionLabel.raw)}">${escapeHtml(sessionLabel.title)}</strong>
                <span class="pool-event-time">${escapeHtml(formatRecentCall(event.timestamp))}</span>
              </div>
              <div class="pool-event-subtitle">${escapeHtml(
                [
                  sessionLabel.detail
                    ? `账号 ${sessionLabel.detail}`
                    : undefined,
                  ...subtitleParts,
                ]
                  .filter(Boolean)
                  .join(" · ") || "暂无附加上下文",
              )}</div>
              ${
                event.reason
                  ? `<div class="pool-event-reason">${escapeHtml(event.reason)}</div>`
                  : ""
              }
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function buildPoolMemberRuntimeMarkup(
  member: PoolRuntimeMember | undefined,
): string {
  if (!member) {
    return "";
  }

  const shouldRender =
    member.selected ||
    Boolean(
      member.note ||
      member.cooldownUntil ||
      member.lastSelectedAt ||
      member.lastSuccessAt ||
      member.lastFailureAt ||
      member.consecutiveFailures,
    );
  if (!shouldRender) {
    return "";
  }

  const tags: string[] = [];
  if (member.selected) {
    tags.push('<span class="badge active">当前首选</span>');
  }
  if (member.cooldownUntil && member.cooldownUntil > Date.now()) {
    tags.push(
      `<span class="badge warning" title="${escapeHtml(formatDate(member.cooldownUntil))}">冷却至 ${escapeHtml(formatCountdown(member.cooldownUntil))}</span>`,
    );
  }
  if (member.lastFailureClass) {
    tags.push(
      `<span class="badge danger">最近失败：${escapeHtml(formatPoolFailureClassLabel(member.lastFailureClass))}</span>`,
    );
  }

  const facts = [
    {
      label: "最近选中",
      value: formatRecentCall(member.lastSelectedAt),
    },
    {
      label: "最近成功",
      value: formatRecentCall(member.lastSuccessAt),
    },
    {
      label: "最近失败",
      value: formatRecentCall(member.lastFailureAt),
    },
    {
      label: "连续失败",
      value: `${member.consecutiveFailures} 次`,
    },
  ];

  return `
    <div class="pool-member-runtime">
      ${tags.length ? `<div class="pool-member-runtime-tags">${tags.join("")}</div>` : ""}
      <div class="pool-member-runtime-grid">
        ${facts
          .map(
            (fact) => `
              <div class="pool-member-runtime-item">
                <span>${escapeHtml(fact.label)}</span>
                <strong title="${escapeHtml(fact.value)}">${escapeHtml(fact.value)}</strong>
              </div>
            `,
          )
          .join("")}
      </div>
      ${
        member.note && (member.selected || member.eligible)
          ? `<div class="form-hint">${escapeHtml(member.note)}</div>`
          : ""
      }
    </div>
  `;
}

function renderUtilityIcon(type: "copy" | "eye" | "eye-off"): string {
  if (type === "copy") {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M5 2.25A1.75 1.75 0 0 0 3.25 4v6c0 .966.784 1.75 1.75 1.75h.25V12A2.75 2.75 0 0 0 8 14.75h4A2.75 2.75 0 0 0 14.75 12V6A2.75 2.75 0 0 0 12 3.25h-.25V4c0 .966-.784 1.75-1.75 1.75H5.25V4A.25.25 0 0 1 5.5 3.75h4.75a.75.75 0 0 0 0-1.5H5Zm3 2.5h4c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H8c-.69 0-1.25-.56-1.25-1.25V6c0-.69.56-1.25 1.25-1.25Z" fill="currentColor"/>
      </svg>
    `;
  }
  if (type === "eye") {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 3c3.528 0 6.205 2.352 7.352 4.324a1.33 1.33 0 0 1 0 1.352C14.205 10.648 11.528 13 8 13s-6.205-2.352-7.352-4.324a1.33 1.33 0 0 1 0-1.352C1.795 5.352 4.472 3 8 3Zm0 1.5c-2.84 0-5.034 1.86-6.044 3.5 1.01 1.64 3.204 3.5 6.044 3.5s5.034-1.86 6.044-3.5C13.034 6.36 10.84 4.5 8 4.5Zm0 1.25A2.25 2.25 0 1 1 5.75 8 2.25 2.25 0 0 1 8 5.75Zm0 1.5A.75.75 0 1 0 8.75 8 .75.75 0 0 0 8 7.25Z" fill="currentColor"/>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.53 1.47a.75.75 0 0 0-1.06 1.06l10 10a.75.75 0 1 0 1.06-1.06l-1.35-1.35c1.74-.58 3.05-1.86 3.97-3.46a1.33 1.33 0 0 0 0-1.352C14.005 3.398 11.328 1.046 7.8 1.046c-1.27 0-2.436.305-3.465.826L2.53 1.47Zm2.88 2.88A2.25 2.25 0 0 1 8.75 7.69l-3.34-3.34ZM8 3.5c2.84 0 5.034 1.86 6.044 3.5-.763 1.239-2.22 2.556-4.151 3.181l-1.32-1.32a2.25 2.25 0 0 1-2.934-2.934L4.463 4.75A6.684 6.684 0 0 1 8 3.5Zm-6.044 3.5c.49.797 1.25 1.628 2.272 2.285l-1.08 1.08C2.155 9.692 1.35 8.889.648 7.676a1.33 1.33 0 0 1 0-1.352c.37-.637.802-1.254 1.292-1.825l1.09 1.09A9.867 9.867 0 0 0 1.956 7Z" fill="currentColor"/>
    </svg>
  `;
}

function formatPoolSelectionStrategyLabel(
  strategy?: PoolDefinition["selectionStrategy"],
): string {
  if (strategy === "priority") {
    return "成员顺序";
  }
  if (strategy === "quota-desc") {
    return "剩余额度";
  }
  if (strategy === "least-recently-used") {
    return "最近最少使用";
  }
  return "综合策略";
}

function getPoolSelectedMemberDisplay(poolRuntime: PoolRuntimeSummary): {
  label: string;
  detail?: string;
} {
  const selectedMember = poolRuntime.members.find((member) => member.selected);
  if (selectedMember?.sessionTitle || selectedMember?.label) {
    return {
      label:
        selectedMember.sessionTitle ||
        selectedMember.label ||
        selectedMember.selector,
      detail:
        selectedMember.sessionSubtitle ||
        selectedMember.sessionId ||
        selectedMember.selector,
    };
  }

  const formatted = formatSessionReadableLabel(
    poolRuntime.selectedSessionId ?? poolRuntime.selectedSelector,
  );
  return {
    label: formatted.label,
    detail: formatted.detail ?? formatted.raw,
  };
}

function summarizePoolSkippedMembers(
  poolRuntime: PoolRuntimeSummary,
): Array<{ status: string; label: string; count: number; tone: string }> {
  const counts = new Map<string, number>();
  for (const member of poolRuntime.members) {
    if (member.selected || member.eligible) {
      continue;
    }
    counts.set(member.status, (counts.get(member.status) ?? 0) + 1);
  }

  const definitions: Array<{
    status: PoolRuntimeMember["status"];
    label: string;
    tone: string;
  }> = [
    { status: "quota-low", label: "低于阈值", tone: "warning" },
    { status: "cooldown", label: "冷却中", tone: "warning" },
    { status: "expired", label: "已过期", tone: "neutral" },
    { status: "invalid", label: "鉴权失效", tone: "danger" },
    { status: "missing", label: "未映射", tone: "neutral" },
    { status: "disabled", label: "已停用", tone: "neutral" },
    { status: "unknown-quota", label: "额度未知", tone: "neutral" },
    { status: "available", label: "暂未参与", tone: "neutral" },
  ];

  return definitions
    .map((definition) => ({
      ...definition,
      count: counts.get(definition.status) ?? 0,
    }))
    .filter((item) => item.count > 0);
}

function describePoolMemberDecision(input: {
  pool: PoolDefinition;
  candidate: PoolMemberCandidateView;
  member?: PoolRuntimeMember;
}):
  | {
      tone: "neutral" | "info" | "success" | "warning";
      title: string;
      body: string;
    }
  | undefined {
  const runtime = getPoolRuntime(input.pool.id);
  const member = input.member;
  if (!runtime || !member) {
    return undefined;
  }

  if (member.selected) {
    return {
      tone: "success",
      title: "本轮已选中",
      body:
        runtime.selectionReason ||
        "当前请求会优先使用该账号；如本次请求失败，系统才会考虑切到下一个候选。",
    };
  }

  if (!member.eligible) {
    return {
      tone:
        member.status === "cooldown" || member.status === "quota-low"
          ? "warning"
          : "neutral",
      title: `当前已跳过：${member.statusLabel}`,
      body:
        member.note || "当前该成员不满足本轮调度条件，因此不会参与新请求选择。",
    };
  }

  const selectedMember = runtime.members.find((item) => item.selected);
  const selectedTitle =
    selectedMember?.sessionTitle ||
    selectedMember?.label ||
    selectedMember?.selector;
  if (selectedMember && selectedMember.selector !== member.selector) {
    const strategyLabel = formatPoolSelectionStrategyLabel(
      runtime.selectionStrategy,
    );
    let body = `当前号池按${strategyLabel}优先选择了 ${selectedTitle ?? "其他成员"}，该账号仍保持可选，会在后续请求或失败回退时参与调度。`;
    if (
      runtime.selectionStrategy === "quota-desc" &&
      typeof member.quotaPercentage === "number"
    ) {
      body = `当前号池按剩余额度优先选择了 ${selectedTitle ?? "其他成员"}；该账号当前剩余额度为 ${member.quotaPercentage}% ，仍会在后续请求中参与调度。`;
    } else if (
      runtime.selectionStrategy === "least-recently-used" &&
      member.lastSelectedAt
    ) {
      body = `当前号池按最近最少使用优先选择了 ${selectedTitle ?? "其他成员"}；该账号最近在 ${formatRecentCall(member.lastSelectedAt)} 被使用过，因此暂未成为首选。`;
    }
    return {
      tone: "info",
      title: "当前未轮到",
      body,
    };
  }

  return {
    tone: "neutral",
    title: "当前可选",
    body: "该账号满足当前号池条件，但最近还没有形成新的调度决策。",
  };
}

function isPoolCandidateSelected(
  pool: PoolDefinition,
  candidate: PoolMemberCandidateView,
): boolean {
  return (pool.members ?? []).some((member) =>
    candidate.matchers.includes(member.selector.trim()),
  );
}

function buildPoolMemberSelectorMarkup(pool: PoolDefinition): string {
  const panelState = getPoolPanelState(pool.id);
  const candidates = buildPoolMemberCandidates();
  const poolRuntime = getPoolRuntime(pool.id);
  if (candidates.length === 0) {
    return "<div class='empty-state'>当前没有可选的桌面端账号。请先在“账号资产”页导入至少一个桌面端 Codex 账号。</div>";
  }

  const filteredCandidates = [...candidates]
    .filter((candidate) =>
      matchesPoolCandidateSearch(candidate, panelState.search),
    )
    .sort((left, right) =>
      comparePoolMemberCandidates(
        left,
        right,
        panelState.sortKey,
        panelState.sortDirection,
      ),
    );
  const selectedCount = candidates.filter((candidate) =>
    isPoolCandidateSelected(pool, candidate),
  ).length;
  const selectedVisibleCount = filteredCandidates.filter((candidate) =>
    isPoolCandidateSelected(pool, candidate),
  ).length;
  const sortLabel =
    panelState.sortKey === "name"
      ? "按名称"
      : panelState.sortKey === "resetAt"
        ? "按重置时间"
        : "按剩余额度";
  const directionLabel = panelState.sortDirection === "asc" ? "升序" : "降序";
  const unresolvedMembers = getPoolUnresolvedMembers(pool, candidates);
  const runtimeSummary = poolRuntime
    ? (() => {
        const selectedDisplay = getPoolSelectedMemberDisplay(poolRuntime);
        const skippedMembers = summarizePoolSkippedMembers(poolRuntime);
        const recentFailoverCount = (poolRuntime.recentEvents ?? []).filter(
          (event) => event.eventType === "failover",
        ).length;
        const runtimeExplanation = skippedMembers.length
          ? `本轮已跳过 ${skippedMembers.map((item) => `${item.label} ${item.count} 个`).join("、")}。`
          : "当前所有成员都处于可参与调度的状态。";
        const skipBadgesMarkup = skippedMembers.length
          ? skippedMembers
              .map(
                (item) =>
                  `<span class="badge ${item.tone}">${escapeHtml(item.label)} ${escapeHtml(String(item.count))}</span>`,
              )
              .join("")
          : '<span class="badge success">暂无被跳过成员</span>';
        return `
      <div class="pool-runtime-summary">
        <div class="pool-runtime-kpi">
          <span>可选成员</span>
          <strong class="${poolRuntime.eligibleMemberCount > 0 ? "success" : "warning"}">${escapeHtml(String(poolRuntime.eligibleMemberCount))} / ${escapeHtml(String(poolRuntime.memberCount))}</strong>
        </div>
        <div class="pool-runtime-kpi">
          <span>冷却中</span>
          <strong class="${poolRuntime.coolingMemberCount > 0 ? "warning" : ""}">${escapeHtml(String(poolRuntime.coolingMemberCount))}</strong>
        </div>
        <div class="pool-runtime-kpi">
          <span>当前首选</span>
          <strong title="${escapeHtml(selectedDisplay.detail ?? selectedDisplay.label)}">${escapeHtml(selectedDisplay.label)}</strong>
        </div>
        <div class="pool-runtime-kpi">
          <span>最近选中</span>
          <strong>${escapeHtml(formatRecentCall(poolRuntime.lastSelectedAt))}</strong>
        </div>
        <div class="pool-runtime-kpi">
          <span>最近异常</span>
          <strong class="${poolRuntime.lastFailureAt ? "warning" : ""}">${escapeHtml(formatRecentCall(poolRuntime.lastFailureAt))}</strong>
        </div>
      </div>
      <div class="pool-runtime-explanation">
        <strong>当前调度摘要</strong>
        <span>当前号池优先选择 ${escapeHtml(selectedDisplay.label)}。${escapeHtml(runtimeExplanation)}</span>
        <div class="pool-runtime-badges">
          ${skipBadgesMarkup}
          <span class="badge neutral">最近切号 ${escapeHtml(String(recentFailoverCount))} 次</span>
        </div>
      </div>
      <div class="routing-rule-guide" style="margin-top: 0;">
        <span>当前调度策略：${escapeHtml(poolRuntime.selectionReason ?? "尚未形成有效选择结果。")}</span>
        ${
          poolRuntime.warnings.length
            ? poolRuntime.warnings
                .map((warning) => `<span>${escapeHtml(warning)}</span>`)
                .join("")
            : `<span>运行时观测已加载，可直接查看成员冷却、最近失败和最近命中情况。</span>`
        }
      </div>
      <div class="pool-runtime-actions">
        <button
          type="button"
          class="btn secondary mini"
          data-action="open-pool-events"
          data-pool-id="${escapeHtml(pool.id)}"
        >查看最近调度事件</button>
        <span class="badge neutral">最近事件 ${escapeHtml(String(poolRuntime.recentEvents?.length ?? 0))} 条</span>
      </div>
    `;
      })()
    : `<div class="form-hint" style="margin-bottom: 12px;">当前尚未拿到该号池的运行时观测。通常在网关健康信息刷新后会自动出现。</div>`;

  return `
    <div class="pool-member-table-shell">
    ${runtimeSummary}
    <div class="pool-member-toolbar">
      <div class="toolbar-group">
        <input
          class="input-field search-input"
          data-pool-ui="search"
          type="search"
          placeholder="搜索名称、邮箱、账号标识..."
          value="${escapeHtml(panelState.search)}"
        />
        <select class="input-field" data-pool-ui="sort-key" style="width: auto;">
          <option value="quota" ${panelState.sortKey === "quota" ? "selected" : ""}>按剩余额度</option>
          <option value="resetAt" ${panelState.sortKey === "resetAt" ? "selected" : ""}>按重置时间</option>
          <option value="name" ${panelState.sortKey === "name" ? "selected" : ""}>按名称</option>
        </select>
        <button
          type="button"
          class="btn secondary mini"
          data-action="pool-toggle-sort"
          data-pool-id="${escapeHtml(pool.id)}"
          title="切换当前排序升降序"
        >${escapeHtml(directionLabel)}</button>
        <button
          type="button"
          class="btn secondary mini"
          data-action="pool-select-all"
          data-pool-id="${escapeHtml(pool.id)}"
          title="全选当前筛选结果"
        >全选</button>
        <button
          type="button"
          class="btn secondary mini"
          data-action="pool-invert-selection"
          data-pool-id="${escapeHtml(pool.id)}"
          title="反选当前筛选结果"
        >反选</button>
      </div>
      <div class="toolbar-group">
        <span class="badge neutral">已选 ${escapeHtml(String(selectedCount))} / 总 ${escapeHtml(String(candidates.length))}</span>
        <span class="badge neutral">当前筛选 ${escapeHtml(String(filteredCandidates.length))} 项</span>
        <span class="badge neutral">${escapeHtml(sortLabel)} · ${escapeHtml(directionLabel)}</span>
        <button
          type="button"
          class="btn ghost mini"
          data-action="pool-toggle-collapse"
          data-pool-id="${escapeHtml(pool.id)}"
          title="${panelState.collapsed ? "展开池成员面板" : "收起池成员面板"}"
        >${panelState.collapsed ? "展开面板" : "收起面板"}</button>
      </div>
    </div>
    ${
      unresolvedMembers.length
        ? `<div class="form-hint" style="margin-bottom: 12px;">当前仍有 ${escapeHtml(String(unresolvedMembers.length))} 个高级成员标识未映射到上方账号卡片，可在“额外成员标识”里继续维护。</div>`
        : ""
    }
    ${
      panelState.collapsed
        ? `<div class="form-hint">池成员面板已收起。当前筛选结果中已选 ${escapeHtml(String(selectedVisibleCount))} 项。</div>`
        : ""
    }
    <div ${panelState.collapsed ? "hidden" : ""}>
      ${
        filteredCandidates.length === 0
          ? `<div class="empty-state">当前筛选条件下没有匹配的桌面端账号。可清空搜索词、调整排序，或先在“账号资产”页导入更多账号。</div>`
          : `<div class="pool-member-grid">
      ${filteredCandidates
        .map((candidate) => {
          const selected = isPoolCandidateSelected(pool, candidate);
          const runtimeMember = getPoolRuntimeMember(pool, candidate);
          const decisionHint = describePoolMemberDecision({
            pool,
            candidate,
            member: runtimeMember,
          });
          const effectiveStatusTone = runtimeMember
            ? getPoolRuntimeMemberTone(runtimeMember)
            : candidate.statusToneClass;
          const effectiveStatusLabel =
            runtimeMember?.statusLabel ?? candidate.statusLabel;
          const quotaFillClass =
            candidate.quotaToneClass === "quota-low"
              ? "low"
              : candidate.quotaToneClass === "quota-medium"
                ? "medium"
                : "";
          const quotaNumberClass =
            candidate.quotaToneClass === "quota-low"
              ? "pool-quota-text low"
              : candidate.quotaToneClass === "quota-medium"
                ? "pool-quota-text medium"
                : candidate.quotaToneClass === "quota-high"
                  ? "pool-quota-text high"
                  : "pool-quota-text";
          const runtimeStatus = runtimeMember?.status ?? "unknown";
          const isDeemphasized = Boolean(
            runtimeMember &&
            !runtimeMember.selected &&
            (!runtimeMember.eligible ||
              runtimeStatus === "quota-low" ||
              runtimeStatus === "invalid" ||
              runtimeStatus === "missing" ||
              runtimeStatus === "disabled" ||
              runtimeStatus === "expired" ||
              runtimeStatus === "unknown-quota"),
          );
          return `
            <label class="pool-member-option" data-selected="${selected ? "true" : "false"}" data-eligible="${runtimeMember?.eligible === false ? "false" : "true"}" data-runtime-status="${escapeHtml(runtimeStatus)}" data-deemphasized="${isDeemphasized ? "true" : "false"}">
              <div class="pool-member-option-head">
                <div class="pool-member-option-title">
                  <input
                    type="checkbox"
                    data-field="pool-member-selector"
                    data-selector="${escapeHtml(candidate.selector)}"
                    data-label="${escapeHtml(candidate.title)}"
                    value="${escapeHtml(candidate.selector)}"
                    ${selected ? "checked" : ""}
                  />
                  <strong title="${escapeHtml(candidate.title)}"><span class="truncate-text">${escapeHtml(candidate.title)}</span></strong>
                </div>
                <span class="badge ${effectiveStatusTone}" title="${escapeHtml(effectiveStatusLabel)}">${escapeHtml(effectiveStatusLabel)}</span>
              </div>
              <div class="pool-member-option-subtitle" title="${escapeHtml(candidate.subtitle)}"><span class="truncate-text">${escapeHtml(candidate.subtitle)}</span></div>
              <div class="pool-member-option-meta">
                <span class="badge neutral" title="${escapeHtml(candidate.selector)}"><span class="truncate-text">${escapeHtml(candidate.selector)}</span></span>
                <span class="badge ${candidate.quotaToneClass === "quota-high" ? "success" : candidate.quotaToneClass === "quota-medium" ? "warning" : candidate.quotaToneClass === "quota-low" ? "danger" : "neutral"}" title="${escapeHtml(candidate.resetLabel)}">${escapeHtml(candidate.resetLabel)}</span>
              </div>
              <div class="pool-member-quota-row">
                <span>剩余额度</span>
                <strong class="${quotaNumberClass}" title="${escapeHtml(candidate.quotaLabel)}">${escapeHtml(candidate.quotaLabel)}</strong>
              </div>
              <div class="acc-quota-bar">
                <div class="acc-quota-fill ${quotaFillClass}" style="width: ${escapeHtml(String(Math.max(0, Math.min(100, candidate.quotaPercentage ?? 0))))}%"></div>
              </div>
              ${
                decisionHint
                  ? `
                    <div class="pool-member-decision ${decisionHint.tone}">
                      <strong>${escapeHtml(decisionHint.title)}</strong>
                      <span title="${escapeHtml(decisionHint.body)}">${escapeHtml(decisionHint.body)}</span>
                    </div>
                  `
                  : ""
              }
              ${buildPoolMemberRuntimeMarkup(runtimeMember)}
            </label>
          `;
        })
        .join("")}
    </div>`
      }
    </div>
    </div>
  `;
}

function getPoolUnresolvedMembers(
  pool: PoolDefinition,
  candidates: PoolMemberCandidateView[],
): string[] {
  const knownSelectors = new Set(
    candidates.flatMap((candidate) => candidate.matchers),
  );
  return (pool.members ?? [])
    .map((member) => member.selector.trim())
    .filter((selector) => selector.length > 0 && !knownSelectors.has(selector));
}

function syncRoutingRuleDispatchModeUI(row: HTMLElement): void {
  const dispatchMode =
    row.querySelector<HTMLSelectElement>('[data-field="dispatch-mode"]')
      ?.value ?? "active-session";
  for (const field of Array.from(
    row.querySelectorAll<HTMLElement>("[data-dispatch-visibility]"),
  )) {
    const expected = field.dataset.dispatchVisibility;
    field.hidden = expected !== dispatchMode;
  }
}

function syncAllRoutingRuleDispatchModeUI(): void {
  for (const row of Array.from(
    document.querySelectorAll<HTMLElement>("[data-routing-rule-row]"),
  )) {
    syncRoutingRuleDispatchModeUI(row);
  }
}

function renderRoutingRules(): void {
  const container = getRoutingRulesContainer();
  if (!container) {
    return;
  }

  const rules = state.routingSettings?.rules ?? [];
  if (rules.length === 0) {
    container.innerHTML =
      "<div class='empty-state'>当前还没有路由规则。你可以新增规则用于按客户端或模型做策略预演。</div>";
    return;
  }

  container.innerHTML = rules
    .map((rule, index) => {
      const dispatchMode = resolveRoutingDispatchMode(rule);
      const hash = rule.id
        .split("")
        .reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const bgColors = ["#f8f9fa", "#f5f5f5", "#f1f3f5", "#fafafa", "#fcfcfc"];
      const bgColor = bgColors[hash % bgColors.length];

      return `
      <div class="routing-rule-card collapsed" data-enabled="${rule.enabled === false ? "false" : "true"}" data-routing-rule-row data-rule-id="${escapeHtml(rule.id)}" style="background-color: ${bgColor};">
        <div class="routing-rule-top" data-action="toggle-routing-rule">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div class="acc-avatar" style="width: 32px; height: 32px; font-size: 16px; background: rgba(0,0,0,0.05); color: var(--text-primary); border: 1px solid var(--border-light);">${index + 1}</div>
            <div>
              <strong style="font-size: 18px;">${escapeHtml(rule.name || "未命名规则")}</strong>
              <span style="font-size: 14px; color: var(--text-secondary);">优先级: ${typeof rule.priority === "number" ? rule.priority : 100}</span>
            </div>
          </div>
          <div class="routing-rule-meta" style="align-items: center;">
            <span class="badge ${rule.enabled === false ? "neutral" : "active"}">${rule.enabled === false ? "未启用" : "已启用"}</span>
            <div class="routing-rule-collapse-icon" style="font-size: 20px; color: var(--text-tertiary); transition: transform 0.2s; margin-left: 8px; transform: rotate(-90deg);">▾</div>
          </div>
        </div>
        <div class="routing-rule-body">
          <div class="routing-rule-grid">
            <div class="form-field">
              <label>规则名称</label>
              <input class="input-field" data-field="name" value="${escapeHtml(rule.name ?? "")}" />
            </div>
            <div class="form-field">
              <label>优先级（越小越优先）</label>
              <input class="input-field" data-field="priority" type="number" step="1" value="${typeof rule.priority === "number" ? rule.priority : 100}" />
            </div>
            <div class="form-field">
              <label>按客户端标签匹配</label>
              <input class="input-field" data-field="when-client-tag" placeholder="例如 localraghub" value="${escapeHtml(rule.when?.clientTag ?? "")}" />
            </div>
            <div class="form-field">
              <label>按请求模型别名匹配</label>
              <input class="input-field" data-field="when-requested-model" placeholder="例如 codex-default" value="${escapeHtml(rule.when?.requestedModelAlias ?? "")}" />
            </div>
            <div class="form-field">
              <label>目标模型别名</label>
              <input class="input-field" data-field="target-model-alias" placeholder="例如 openai-compatible-default" value="${escapeHtml(rule.target?.modelAlias ?? "")}" />
            </div>
            <div class="form-field">
              <label>目标账号模式</label>
              <select class="input-field" data-field="dispatch-mode">
                <option value="active-session" ${dispatchMode === "active-session" ? "selected" : ""}>沿用当前活动账号</option>
                <option value="fixed-session" ${dispatchMode === "fixed-session" ? "selected" : ""}>固定账号</option>
                <option value="dynamic-pool" ${dispatchMode === "dynamic-pool" ? "selected" : ""}>号池调度</option>
              </select>
            </div>
            <div class="form-field" data-dispatch-visibility="fixed-session" ${dispatchMode === "fixed-session" ? "" : "hidden"}>
              <label>目标会话 / 账号标识（可选）</label>
              <input class="input-field" data-field="target-session-id" placeholder="可填 sessionId、profileId 或 accountId" value="${escapeHtml(rule.target?.sessionId ?? "")}" />
            </div>
            <div class="form-field" data-dispatch-visibility="dynamic-pool" ${dispatchMode === "dynamic-pool" ? "" : "hidden"}>
              <label>目标号池（可选）</label>
              <select class="input-field" data-field="target-pool-id">
                ${buildPoolOptions(rule.target?.poolId)}
              </select>
            </div>
          </div>
          <div class="routing-rule-guide">
            <span>至少填写 1 个匹配条件，并至少填写 1 个目标字段。</span>
            <span>选择“沿用当前活动账号”时，命中规则后仍由账号页当前活动账号决定最终额度来源。</span>
            <span>选择“固定账号”时，命中规则后会固定走指定账号，适合给某个客户端预留专用额度。</span>
            <span>选择“号池调度”时，请先在“号池调度”页配置池成员与阈值；命中后网关会按池策略自动挑选账号。</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--border-strong);">
            <label class="switch-label" style="font-size: 14px;">
              <input type="checkbox" data-field="enabled" ${rule.enabled === false ? "" : "checked"} />
              启用规则
            </label>
            <div style="display: flex; gap: 8px;">
              <button class="btn ghost danger-ghost mini" data-action="routing-remove-rule" data-rule-id="${escapeHtml(rule.id)}">删除规则</button>
              <button class="btn primary mini" data-action="save-routing-settings">保存独立配置</button>
            </div>
          </div>
        </div>
      </div>
    `;
    })
    .join("");
  syncAllRoutingRuleDispatchModeUI();
}

function applyRoutingSettingsToForm(): void {
  const settings = state.routingSettings ?? {};
  const enabledInput = document.getElementById(
    "routing-enabled",
  ) as HTMLInputElement | null;
  if (enabledInput) {
    enabledInput.checked = Boolean(settings.enabled);
  }
  renderRoutingRules();
}

function renderPoolCards(): void {
  const container = getPoolsContainer();
  if (!container) {
    return;
  }

  const pools = state.poolSettings?.pools ?? [];
  reconcileSelectedPoolIds(pools);
  if (pools.length === 0) {
    selectedPoolIds.clear();
    container.innerHTML =
      "<div class='empty-state'>当前还没有号池。你可以新增一个号池，把多个桌面端 Codex 账号纳入自动调度。</div>";
    return;
  }

  container.innerHTML = [
    buildPoolBulkToolbarMarkup(pools),
    ...pools
    .map((pool, index) => {
      const poolVisibility = normalizePoolVisibility(pool.visibility);
      const poolVisibilityLabel = formatPoolVisibilityLabel(poolVisibility);
      const panelState = getPoolPanelState(pool.id);
      const candidates = buildPoolMemberCandidates();
      const unresolvedMembers = getPoolUnresolvedMembers(pool, candidates).join(
        "\n",
      );
      const selected = selectedPoolIds.has(pool.id);
      return `
        <div class="routing-rule-card pool-config-card detail-drawer-panel ${panelState.cardCollapsed ? "collapsed" : ""}" data-pool-row data-pool-id="${escapeHtml(pool.id)}" data-enabled="${pool.enabled === false ? "false" : "true"}" data-selected="${selected ? "true" : "false"}">
          <div class="card-header pool-card-header routing-rule-top pool-card-top" data-action="toggle-pool-card" data-pool-id="${escapeHtml(pool.id)}">
            <div class="pool-card-title-wrap">
              <label
                class="pool-card-select"
                data-pool-select-control="true"
                title="选择此号池用于批量操作"
              >
                <input
                  type="checkbox"
                  data-field="pool-card-selector"
                  data-pool-id="${escapeHtml(pool.id)}"
                  aria-label="选择号池 ${escapeHtml(pool.name || pool.id)}"
                  ${selected ? "checked" : ""}
                />
              </label>
              <div class="pool-card-index-avatar">${index + 1}</div>
              <div class="pool-card-title-text">
                <strong>${escapeHtml(pool.name || "未命名号池")}</strong>
                <span>首版只纳入桌面端导入账号；通过列表顺序确定默认优先级，必要时再结合额度与最近使用情况自动挑号。</span>
              </div>
            </div>
            <div class="routing-rule-meta pool-card-actions">
              <span class="badge neutral">${escapeHtml(pool.id)}</span>
              <span class="badge neutral">${poolVisibilityLabel}</span>
              <span class="badge ${pool.enabled === false ? "neutral" : "active"}">${pool.enabled === false ? "未启用" : "已启用"}</span>
              <button
                type="button"
                class="btn primary mini"
                data-action="save-pool-card"
                data-pool-id="${escapeHtml(pool.id)}"
              >保存此卡片</button>
              <button
                type="button"
                class="btn ghost danger-ghost mini"
                data-action="pool-remove"
                data-pool-id="${escapeHtml(pool.id)}"
              >删除号池</button>
              <div class="routing-rule-collapse-icon">▾</div>
            </div>
          </div>
          <div class="routing-rule-body">
          <div class="routing-rule-grid pool-config-form-grid">
            <div class="form-field">
              <label>号池名称</label>
              <input class="input-field" data-field="pool-name" value="${escapeHtml(pool.name ?? "")}" />
            </div>
            <div class="form-field">
              <label>选择策略</label>
              <select class="input-field" data-field="pool-strategy">
                <option value="hybrid" ${pool.selectionStrategy === "hybrid" || !pool.selectionStrategy ? "selected" : ""}>混合策略（推荐）</option>
                <option value="quota-desc" ${pool.selectionStrategy === "quota-desc" ? "selected" : ""}>按剩余额度优先</option>
                <option value="least-recently-used" ${pool.selectionStrategy === "least-recently-used" ? "selected" : ""}>按最近最少使用</option>
                <option value="priority" ${pool.selectionStrategy === "priority" ? "selected" : ""}>按成员顺序优先</option>
              </select>
            </div>
            <div class="form-field">
              <label>可见性</label>
              <select class="input-field" data-field="pool-visibility">
                <option value="private" ${poolVisibility === "private" ? "selected" : ""}>私有（管理员自用）</option>
                <option value="shared-lan" ${poolVisibility === "shared-lan" ? "selected" : ""}>局域网共享</option>
                <option value="public-ready" ${poolVisibility === "public-ready" ? "selected" : ""}>外网预留（暂不开放）</option>
              </select>
            </div>
            <div class="form-field" style="grid-column: 1 / -1;">
              <label>说明（可选）</label>
              <input class="input-field" data-field="pool-description" placeholder="例如：给 OpenClaw 长任务预留的自动切号池" value="${escapeHtml(pool.description ?? "")}" />
            </div>
            <div class="form-field" data-pool-members-field="true" style="grid-column: 1 / -1;">
              <label>池成员（推荐直接勾选桌面端账号）</label>
              ${buildPoolMemberSelectorMarkup(pool)}
              <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
            </div>
            <div class="form-field" style="grid-column: 1 / -1;">
              <label>额外成员标识（高级，可选）</label>
              <textarea class="input-field" data-field="pool-members-extra" rows="3" placeholder="仅当某个账号暂时未出现在上方列表里时，再手动填写额外的 sessionId / profileId / accountId，每行一个。">${escapeHtml(unresolvedMembers)}</textarea>
            </div>
            <div class="form-field">
              <label>最低剩余额度阈值（%）</label>
              <input class="input-field" data-field="pool-min-percentage" type="number" min="0" max="100" step="1" value="${typeof pool.minRemainingPercentage === "number" ? pool.minRemainingPercentage : 15}" />
            </div>
            <div class="form-field">
              <label>常规冷却（秒）</label>
              <input class="input-field" data-field="pool-cooldown-seconds" type="number" min="10" max="86400" step="10" value="${typeof pool.cooldownSeconds === "number" ? pool.cooldownSeconds : 300}" />
            </div>
            <div class="form-field">
              <label>额度耗尽冷却（秒）</label>
              <input class="input-field" data-field="pool-quota-cooldown-seconds" type="number" min="30" max="86400" step="30" value="${typeof pool.quotaExhaustedCooldownSeconds === "number" ? pool.quotaExhaustedCooldownSeconds : 7200}" />
            </div>
            <div class="form-field">
              <label>单次请求最多尝试账号数</label>
              <input class="input-field" data-field="pool-max-retry-candidates" type="number" min="1" max="5" step="1" value="${typeof pool.maxRetryCandidates === "number" ? pool.maxRetryCandidates : 2}" />
            </div>
          </div>
          <div class="routing-rule-guide">
            <span>第一版动态号池只纳入桌面端导入账号，不直接把原始本地可复用授权作为正式池成员。</span>
            <span>动态号池是“请求级自动选账号”，不是把多个账号做成真正的额度池化；单次请求仍只会使用一个账号。</span>
            <span>额度阈值用于“新请求是否可选”，不是精确 token 预算；当某账号低于阈值或进入冷却，会自动跳过。</span>
            <span>请求级自动切号不会改写全局活动账号；每次请求只会在命中的号池内独立选择实际使用账号。</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px;">
            <div style="display: flex; gap: 16px; flex-wrap: wrap;">
              <label class="switch-label" style="font-size: 14px;">
                <input type="checkbox" data-field="pool-enabled" ${pool.enabled === false ? "" : "checked"} />
                启用号池
              </label>
              <label class="switch-label" style="font-size: 14px;">
                <input type="checkbox" data-field="pool-allow-unknown" ${pool.allowUnknownQuota === false ? "" : "checked"} />
                允许未知额度账号参与
              </label>
              <label class="switch-label" style="font-size: 14px;">
                <input type="checkbox" data-field="pool-fallback-active" ${pool.fallbackToActiveSession === false ? "" : "checked"} />
                无候选时回退活动账号
              </label>
            </div>
            <button class="btn primary mini" data-action="save-pool-card" data-pool-id="${escapeHtml(pool.id)}">保存此卡片</button>
          </div>
          </div>
        </div>
      `;
    }),
  ].join("");
}

function applyPoolSettingsToForm(): void {
  const enabledInput = document.getElementById(
    "pool-enabled",
  ) as HTMLInputElement | null;
  if (enabledInput) {
    enabledInput.checked = Boolean(state.poolSettings?.enabled);
  }
  renderPoolCards();
}

function collectPoolDefinitionFromRow(row: HTMLElement): PoolDefinition {
  const id = row.dataset.poolId || createPoolId();
  const name =
    row
      .querySelector<HTMLInputElement>('[data-field="pool-name"]')
      ?.value.trim() || id;
  const description =
    row
      .querySelector<HTMLInputElement>('[data-field="pool-description"]')
      ?.value.trim() || undefined;
  const selectionStrategy = row.querySelector<HTMLSelectElement>(
    '[data-field="pool-strategy"]',
  )?.value as PoolDefinition["selectionStrategy"] | undefined;
  const visibility = row.querySelector<HTMLSelectElement>(
    '[data-field="pool-visibility"]',
  )?.value as PoolDefinition["visibility"] | undefined;
  const minRemainingPercentage = Number(
    row.querySelector<HTMLInputElement>('[data-field="pool-min-percentage"]')
      ?.value ?? "15",
  );
  const cooldownSeconds = Number(
    row.querySelector<HTMLInputElement>('[data-field="pool-cooldown-seconds"]')
      ?.value ?? "300",
  );
  const quotaExhaustedCooldownSeconds = Number(
    row.querySelector<HTMLInputElement>(
      '[data-field="pool-quota-cooldown-seconds"]',
    )?.value ?? "7200",
  );
  const maxRetryCandidates = Number(
    row.querySelector<HTMLInputElement>(
      '[data-field="pool-max-retry-candidates"]',
    )?.value ?? "2",
  );
  const selectedMembers = Array.from(
    row.querySelectorAll<HTMLInputElement>(
      '[data-field="pool-member-selector"]:checked',
    ),
  ).map((input, index) => ({
    selector: (input.dataset.selector ?? input.value).trim(),
    label: input.dataset.label?.trim() || undefined,
    priority: index * 10,
    enabled: true,
  }));
  const extraMembersRaw =
    row.querySelector<HTMLTextAreaElement>('[data-field="pool-members-extra"]')
      ?.value ?? "";
  const extraMembers = extraMembersRaw
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((selector, index) => ({
      selector,
      priority: (selectedMembers.length + index) * 10,
      enabled: true,
    }));
  const membersCombined = [...selectedMembers, ...extraMembers].filter(
    (member, index, list) =>
      list.findIndex((item) => item.selector === member.selector) === index,
  );

  return {
    id,
    name,
    description,
    enabled:
      row.querySelector<HTMLInputElement>('[data-field="pool-enabled"]')
        ?.checked ?? true,
    selectionStrategy,
    visibility:
      visibility === "shared-lan" || visibility === "public-ready"
        ? visibility
        : "private",
    minRemainingPercentage: Number.isFinite(minRemainingPercentage)
      ? Math.max(0, Math.min(100, Math.round(minRemainingPercentage)))
      : 15,
    allowUnknownQuota:
      row.querySelector<HTMLInputElement>('[data-field="pool-allow-unknown"]')
        ?.checked ?? true,
    cooldownSeconds: Number.isFinite(cooldownSeconds)
      ? Math.max(10, Math.min(86_400, Math.round(cooldownSeconds)))
      : 300,
    quotaExhaustedCooldownSeconds: Number.isFinite(
      quotaExhaustedCooldownSeconds,
    )
      ? Math.max(
          30,
          Math.min(86_400, Math.round(quotaExhaustedCooldownSeconds)),
        )
      : 7_200,
    maxRetryCandidates: Number.isFinite(maxRetryCandidates)
      ? Math.max(1, Math.min(5, Math.round(maxRetryCandidates)))
      : 2,
    fallbackToActiveSession:
      row.querySelector<HTMLInputElement>('[data-field="pool-fallback-active"]')
        ?.checked ?? true,
    members: membersCombined,
  } satisfies PoolDefinition;
}

function syncPoolDraftFromRow(row: HTMLElement): void {
  const nextPool = collectPoolDefinitionFromRow(row);
  const settings = state.poolSettings ?? {};
  const pools = settings.pools ?? [];
  const existingIndex = pools.findIndex((pool) => pool.id === nextPool.id);
  const nextPools = [...pools];
  if (existingIndex >= 0) {
    nextPools.splice(existingIndex, 1, nextPool);
  } else {
    nextPools.push(nextPool);
  }
  state.poolSettings = {
    ...settings,
    pools: nextPools,
  };
}

function getPoolMembersFieldContainer(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('[data-pool-members-field="true"]');
}

function renderPoolMembersField(
  row: HTMLElement,
  options?: { preserveSearchFocus?: boolean },
): void {
  const poolId = row.dataset.poolId || createPoolId();
  const pool =
    state.poolSettings?.pools?.find((item) => item.id === poolId) ??
    collectPoolDefinitionFromRow(row);
  const membersContainer = getPoolMembersFieldContainer(row);
  if (!membersContainer) {
    renderPoolCards();
    return;
  }
  const activeSearch = row.querySelector(
    '[data-pool-ui="search"]',
  ) as HTMLInputElement | null;
  const selectionStart = activeSearch?.selectionStart ?? null;
  const selectionEnd = activeSearch?.selectionEnd ?? null;
  membersContainer.innerHTML = `
    <label>池成员（推荐直接勾选桌面端账号）</label>
    ${buildPoolMemberSelectorMarkup(pool)}
    <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
  `;
  if (options?.preserveSearchFocus) {
    const newInput = row.querySelector('[data-pool-ui="search"]') as HTMLInputElement | null;
    if (newInput) {
      newInput.focus();
      const start = selectionStart ?? newInput.value.length;
      const end = selectionEnd ?? newInput.value.length;
      newInput.setSelectionRange(start, end);
    }
  }
}

function schedulePoolMembersFieldRender(
  row: HTMLElement,
  options?: { preserveSearchFocus?: boolean },
): void {
  const poolId = row.dataset.poolId || createPoolId();
  cancelPoolMemberFieldFrame(poolId);
  const frame = window.requestAnimationFrame(() => {
    poolMemberFieldFrames.delete(poolId);
    renderPoolMembersField(row, options);
  });
  poolMemberFieldFrames.set(poolId, frame);
}

function collectRoutingSettingsFromForm(): RoutingSettings {
  const enabled =
    (document.getElementById("routing-enabled") as HTMLInputElement | null)
      ?.checked ?? false;
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>("[data-routing-rule-row]"),
  );
  const rules: RoutingRule[] = rows
    .map((row) => {
      const id = row.dataset.ruleId || createRoutingRuleId();
      const name =
        (
          row.querySelector<HTMLInputElement>('[data-field="name"]')?.value ??
          ""
        ).trim() || "未命名规则";
      const priorityValue = Number(
        row.querySelector<HTMLInputElement>('[data-field="priority"]')?.value ??
          "100",
      );
      const enabledValue =
        row.querySelector<HTMLInputElement>('[data-field="enabled"]')
          ?.checked ?? true;
      const clientTag =
        row
          .querySelector<HTMLInputElement>('[data-field="when-client-tag"]')
          ?.value.trim() || undefined;
      const requestedModelAlias =
        row
          .querySelector<HTMLInputElement>(
            '[data-field="when-requested-model"]',
          )
          ?.value.trim() || undefined;
      const modelAlias =
        row
          .querySelector<HTMLInputElement>('[data-field="target-model-alias"]')
          ?.value.trim() || undefined;
      const dispatchMode = row.querySelector<HTMLSelectElement>(
        '[data-field="dispatch-mode"]',
      )?.value as RoutingDispatchMode | undefined;
      const sessionId =
        row
          .querySelector<HTMLInputElement>('[data-field="target-session-id"]')
          ?.value.trim() || undefined;
      const poolId =
        row
          .querySelector<HTMLSelectElement>('[data-field="target-pool-id"]')
          ?.value.trim() || undefined;

      return {
        id,
        name,
        enabled: enabledValue,
        priority: Number.isFinite(priorityValue)
          ? Math.max(-10_000, Math.min(10_000, Math.round(priorityValue)))
          : 100,
        when: {
          clientTag,
          requestedModelAlias,
        },
        target: {
          dispatchMode,
          modelAlias,
          sessionId: dispatchMode === "fixed-session" ? sessionId : undefined,
          poolId: dispatchMode === "dynamic-pool" ? poolId : undefined,
        },
      } satisfies RoutingRule;
    })
    .filter(
      (rule) =>
        Boolean(rule.when?.clientTag || rule.when?.requestedModelAlias) &&
        Boolean(
          rule.target?.modelAlias ||
          rule.target?.sessionId ||
          rule.target?.poolId,
        ),
    );

  return {
    enabled,
    rules,
  };
}

async function savePoolSettings(): Promise<void> {
  const api = getGatewayApi();
  const payload = collectPoolSettingsFromForm();
  const response = await api.savePoolSettings(payload);
  state.poolSettings = response.data;
  applyPoolSettingsToForm();
  applyRoutingSettingsToForm();
}

async function saveSinglePoolSettings(poolId: string): Promise<string> {
  const row = document.querySelector<HTMLElement>(
    `[data-pool-row][data-pool-id="${poolId}"]`,
  );
  if (!row) {
    throw new Error("未找到目标号池卡片。");
  }

  syncPoolDraftFromRow(row);
  const settings = state.poolSettings ?? {};
  const enabled =
    (document.getElementById("pool-enabled") as HTMLInputElement | null)
      ?.checked ?? Boolean(settings.enabled);
  const pools = (settings.pools ?? []).filter(
    (pool) => pool.name.trim().length > 0 && (pool.members?.length ?? 0) > 0,
  );
  if (!pools.some((pool) => pool.id === poolId)) {
    throw new Error("目标号池缺少有效成员或名称，无法保存。");
  }

  const response = await getGatewayApi().savePoolSettings({
    enabled,
    pools,
  });
  state.poolSettings = response.data;
  applyPoolSettingsToForm();
  applyRoutingSettingsToForm();
  const savedPool = response.data.pools?.find((pool) => pool.id === poolId);
  return savedPool?.name?.trim() || poolId;
}

function collectPoolSettingsFromForm(): PoolSettings {
  const enabled =
    (document.getElementById("pool-enabled") as HTMLInputElement | null)
      ?.checked ?? false;
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>("[data-pool-row]"),
  );
  const pools: PoolDefinition[] = rows
    .map((row) => collectPoolDefinitionFromRow(row))
    .filter(
      (pool) => pool.name.trim().length > 0 && (pool.members?.length ?? 0) > 0,
    );

  return {
    enabled,
    pools,
  };
}

function renderRoutingPreviewResult(
  payload: RoutingPreviewResponse["data"],
): void {
  const node = document.getElementById("routing-preview-result");
  if (!node) {
    return;
  }
  const tone = payload.warnings?.length
    ? "warning"
    : payload.reason === "rule_matched"
      ? "success"
      : "neutral";
  const headline =
    payload.reason === "rule_matched"
      ? "已命中策略规则"
      : payload.reason === "routing_disabled"
        ? "策略路由当前未启用"
        : "未命中任何策略规则";
  const description =
    payload.reason === "rule_matched"
      ? "当前输入条件会按下方结果进入对应模型和账号。"
      : payload.reason === "routing_disabled"
        ? "当前系统会直接沿用默认模型与当前活动账号。"
        : "当前请求会直接沿用默认模型与当前活动账号。";
  const warnings = payload.warnings?.length
    ? `<div class="routing-preview-warning"><strong>命中告警</strong><span>${escapeHtml(payload.warnings.join("；"))}</span></div>`
    : "";
  const matched = payload.matchedRuleName
    ? `${payload.matchedRuleName} (${payload.matchedRuleId ?? "unknown"})`
    : "未命中";
  const poolFact = payload.resolvedPoolId
    ? `
        <div class="routing-preview-fact">
          <label>命中号池</label>
          <span>${escapeHtml(payload.resolvedPoolId)}</span>
        </div>
      `
    : "";
  const selectionFact = payload.selectionReason
    ? `
        <div class="routing-preview-fact">
          <label>选择原因</label>
          <span>${escapeHtml(payload.selectionReason)}</span>
        </div>
      `
    : "";
  const candidateFact =
    typeof payload.candidateCount === "number"
      ? `
        <div class="routing-preview-fact">
          <label>可用候选数</label>
          <span>${escapeHtml(String(payload.candidateCount))}</span>
        </div>
      `
      : "";
  const accessDecision = payload.accessDecision
    ? `
        <div class="routing-preview-access-decision ${payload.accessDecision.status}">
          <div>
            <strong>${payload.accessDecision.status === "allowed" ? "访问策略允许" : "访问策略拒绝"}</strong>
            <span>${escapeHtml(
              payload.accessDecision.status === "allowed"
                ? "该访问成员按当前模型、路由和号池配置可继续请求。"
                : payload.accessDecision.message ??
                    payload.accessDecision.reason,
            )}</span>
          </div>
          <div class="routing-preview-facts compact">
            <div class="routing-preview-fact">
              <label>访问成员</label>
              <span>${escapeHtml(
                payload.accessDecision.consumerName ??
                  payload.accessDecision.consumerId,
              )}</span>
            </div>
            <div class="routing-preview-fact">
              <label>成员类型</label>
              <span>${escapeHtml(payload.accessDecision.consumerType ?? "unknown")}</span>
            </div>
            <div class="routing-preview-fact">
              <label>策略原因</label>
              <span>${escapeHtml(payload.accessDecision.errorType ?? payload.accessDecision.reason)}</span>
            </div>
            <div class="routing-preview-fact">
              <label>判定模型</label>
              <span>${escapeHtml(payload.accessDecision.modelAlias ?? payload.resolvedModelAlias)}</span>
            </div>
            <div class="routing-preview-fact">
              <label>判定号池</label>
              <span>${escapeHtml(payload.accessDecision.poolId ?? payload.resolvedPoolId ?? "未命中号池")}</span>
            </div>
            <div class="routing-preview-fact">
              <label>号池可见性</label>
              <span>${escapeHtml(
                payload.accessDecision.poolVisibility
                  ? formatPoolVisibilityLabel(payload.accessDecision.poolVisibility)
                  : "无",
              )}</span>
            </div>
          </div>
        </div>
      `
    : "";
  const rejectedCandidates = payload.rejectedCandidates?.length
    ? `
        <div class="routing-preview-warning">
          <strong>被跳过的候选账号</strong>
          <span>${payload.rejectedCandidates
            .map((item) => {
              const label =
                item.label || item.selector || item.sessionId || "unknown";
              return `${escapeHtml(label)}：${escapeHtml(item.reason)}`;
            })
            .join("；")}</span>
        </div>
      `
    : "";
  node.innerHTML = `
    <div class="routing-preview-result-card ${tone}">
      <div class="routing-preview-result-head">
        <div>
          <strong>${escapeHtml(headline)}</strong>
          <p>${escapeHtml(description)}</p>
        </div>
        <span class="badge ${payload.enabled ? "active" : "neutral"}">${payload.enabled ? "已启用" : "未启用"}</span>
      </div>
      <div class="routing-preview-facts">
        <div class="routing-preview-fact">
          <label>命中规则</label>
          <span>${escapeHtml(matched)}</span>
        </div>
        <div class="routing-preview-fact">
          <label>解析模型</label>
          <span>${escapeHtml(payload.resolvedModelAlias)}</span>
        </div>
        <div class="routing-preview-fact">
          <label>解析会话</label>
          <span>${escapeHtml(payload.resolvedSessionId ?? "沿用当前活动会话")}</span>
        </div>
        ${poolFact}
        ${selectionFact}
        ${candidateFact}
      </div>
      ${warnings}
      ${accessDecision}
      ${rejectedCandidates}
    </div>
  `;
}

function renderRoutingPreviewConsumerOptions(): void {
  const select = document.getElementById(
    "routing-preview-access-consumer",
  ) as HTMLSelectElement | null;
  if (!select) {
    return;
  }

  const currentValue = select.value;
  const consumers = state.securitySettings?.accessControl?.consumers ?? [];
  select.innerHTML = [
    `<option value="">不指定访问成员</option>`,
    ...consumers.map(
      (consumer) =>
        `<option value="${escapeHtml(consumer.id)}">${escapeHtml(
          `${consumer.name} · ${consumer.clientTag} · ${consumer.type}`,
        )}</option>`,
    ),
  ].join("");

  if (currentValue && consumers.some((consumer) => consumer.id === currentValue)) {
    select.value = currentValue;
  }
}

function resetRoutingPreviewResult(): void {
  const node = document.getElementById("routing-preview-result");
  if (!node) {
    return;
  }
  node.innerHTML =
    "<div class='routing-preview-result-card neutral'><span style='font-size: 14px; color: var(--text-secondary);'>填写条件后点击“预演路由结果”查看命中情况。</span></div>";
}

function renderSecurityClientMappings(
  mappings: SecurityClientMapping[],
): void {
  const listNode = document.getElementById("gateway-auth-client-mappings");
  if (!listNode) {
    return;
  }
  if (mappings.length === 0) {
    listNode.innerHTML = `
      <div class="form-hint">当前暂无客户端映射。可新增独立 API Key，将来源稳定标记为 hermes / openclaw 等。</div>
    `;
    return;
  }

  listNode.innerHTML = mappings
    .map(
      (mapping, index) => `
      <div class="routing-rule-card" data-security-mapping-row="${index}" style="margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <strong style="font-size: 14px;">客户端映射 #${index + 1}</strong>
          <button class="btn danger-ghost mini" type="button" data-remove-security-mapping="${index}">删除</button>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label>名称</label>
            <input class="input-field" data-security-mapping-name="${index}" value="${escapeHtml(mapping.name)}" placeholder="例如 Hermes" />
          </div>
          <div class="form-field">
            <label>客户端标签</label>
            <input class="input-field" data-security-mapping-client-tag="${index}" value="${escapeHtml(mapping.clientTag)}" placeholder="例如 hermes" />
          </div>
          <div class="form-field full">
            <label>客户端 API Key</label>
            <div class="secret-field-stack">
              <div class="secret-inline-row">
                <div class="secret-input-shell">
                  <input
                    id="security-mapping-api-key-${index}"
                    class="input-field"
                    data-secret-input="security-mapping-api-key-${index}"
                    type="password"
                    data-security-mapping-api-key="${index}"
                    value="${escapeHtml(mapping.draftApiKey ?? "")}"
                    placeholder="${mapping.hasApiKey ? "已保存；如需更新请输入新值" : "请输入该客户端专属密钥"}"
                  />
                  <div class="secret-inline-actions">
                    <button
                      class="icon-btn"
                      data-tone="visibility"
                      type="button"
                      data-secret-visibility-toggle="#security-mapping-api-key-${index}"
                      title="显示或隐藏密钥"
                      aria-label="显示或隐藏密钥"
                    ></button>
                    <button
                      class="icon-btn"
                      data-tone="copy"
                      type="button"
                      data-secret-copy-target="#security-mapping-api-key-${index}"
                      title="复制密钥"
                      aria-label="复制密钥"
                    ></button>
                  </div>
                </div>
                <button class="btn primary mini secret-generate-btn" type="button" data-generate-security-mapping-api-key="${index}">生成专属密钥</button>
              </div>
            </div>
            <div class="form-hint">安全原因不会回显已有密钥。留空表示保留已有密钥不变。</div>
          </div>
          <div class="form-field" style="flex-direction: row; align-items: center; gap: 8px;">
            <input type="checkbox" data-security-mapping-enabled="${index}" ${mapping.enabled ? "checked" : ""} />
            <label style="margin: 0;">启用该映射</label>
          </div>
          <div class="form-field" style="flex-direction: row; align-items: center; gap: 8px;">
            <input type="checkbox" data-security-mapping-allow-header="${index}" ${mapping.allowHeaderOverride ? "checked" : ""} />
            <label style="margin: 0;">允许 header 覆盖标签</label>
          </div>
        </div>
      </div>
    `,
    )
    .join("");
  syncSecretFieldActionState(listNode);
}

function updateSecretVisibilityButton(
  button: HTMLButtonElement,
  input: HTMLInputElement,
): void {
  const visible = input.type === "text";
  button.innerHTML = renderUtilityIcon(visible ? "eye-off" : "eye");
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.title = visible ? "隐藏密钥" : "显示密钥";
  button.setAttribute("aria-label", visible ? "隐藏密钥" : "显示密钥");
  button.disabled = input.value.trim().length === 0;
}

function updateSecretCopyButton(
  button: HTMLButtonElement,
  input: HTMLInputElement,
): void {
  button.innerHTML = renderUtilityIcon("copy");
  button.title = "复制密钥";
  button.setAttribute("aria-label", "复制密钥");
  button.disabled = input.value.trim().length === 0;
}

function syncSecretFieldActionState(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLButtonElement>("[data-secret-visibility-toggle]")
    .forEach((button) => {
      const selector = button.dataset.secretVisibilityToggle;
      if (!selector) {
        return;
      }
      const input = document.querySelector(selector) as HTMLInputElement | null;
      if (!input) {
        return;
      }
      updateSecretVisibilityButton(button, input);
    });

  root
    .querySelectorAll<HTMLButtonElement>("[data-secret-copy-target]")
    .forEach((button) => {
      const selector = button.dataset.secretCopyTarget;
      if (!selector) {
        return;
      }
      const input = document.querySelector(selector) as HTMLInputElement | null;
      if (!input) {
        return;
      }
      updateSecretCopyButton(button, input);
    });
}

function syncSecurityMappingDraftsFromDom(): void {
  if (!state.securitySettings) {
    return;
  }
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>("[data-security-mapping-row]"),
  );
  if (rows.length === 0) {
    return;
  }
  const nextMappings = rows
    .map((row, rowIndex) => {
      const current = state.securitySettings?.clientMappings[rowIndex];
      const nameNode = row.querySelector(
        `[data-security-mapping-name="${rowIndex}"]`,
      ) as HTMLInputElement | null;
      const clientTagNode = row.querySelector(
        `[data-security-mapping-client-tag="${rowIndex}"]`,
      ) as HTMLInputElement | null;
      const apiKeyNode = row.querySelector(
        `[data-security-mapping-api-key="${rowIndex}"]`,
      ) as HTMLInputElement | null;
      const enabledNode = row.querySelector(
        `[data-security-mapping-enabled="${rowIndex}"]`,
      ) as HTMLInputElement | null;
      const allowHeaderNode = row.querySelector(
        `[data-security-mapping-allow-header="${rowIndex}"]`,
      ) as HTMLInputElement | null;

      return {
        name: nameNode?.value.trim() || current?.name || `client-${rowIndex + 1}`,
        clientTag:
          clientTagNode?.value.trim() || current?.clientTag || `client-${rowIndex + 1}`,
        enabled: enabledNode?.checked ?? current?.enabled ?? true,
        allowHeaderOverride:
          allowHeaderNode?.checked ?? current?.allowHeaderOverride ?? false,
        hasApiKey:
          Boolean(apiKeyNode?.value.trim()) || current?.hasApiKey || false,
        draftApiKey: apiKeyNode?.value.trim() || undefined,
      } satisfies SecurityClientMapping;
    })
    .filter((item) => item.name.trim().length > 0);

  state.securitySettings.clientMappings = nextMappings;
  state.securitySettings.mappingCount = nextMappings.length;
  state.securitySettings.enabledMappingCount = nextMappings.filter(
    (item) => item.enabled,
  ).length;
}

function applySecuritySettingsToForm(): void {
  const settings = state.securitySettings;
  const modeNode = document.getElementById(
    "gateway-auth-mode",
  ) as HTMLSelectElement | null;
  const statusNode = document.getElementById(
    "gateway-auth-status",
  ) as HTMLElement | null;
  const keyNode = document.getElementById(
    "gateway-auth-api-key",
  ) as HTMLInputElement | null;
  const resolveByApiKeyNode = document.getElementById(
    "gateway-auth-resolve-client-tag-by-api-key",
  ) as HTMLInputElement | null;
  const lanAccessNode = document.getElementById(
    "gateway-lan-access-enabled",
  ) as HTMLInputElement | null;
  const lanAccessStatusNode = document.getElementById(
    "gateway-lan-access-status",
  ) as HTMLElement | null;

  const mode = settings?.mode === "api-key" ? "api-key" : "none";
  const lanEnabled = Boolean(settings?.lanAccess?.enabled);
  if (modeNode) {
    modeNode.value = mode;
  }
  if (statusNode) {
    if (mode === "api-key") {
      statusNode.textContent = settings?.hasApiKey
        ? "当前已启用 API Key 鉴权，外部请求需携带有效密钥。"
        : "当前已启用 API Key 鉴权，但尚未保存有效密钥。";
    } else {
      statusNode.textContent = "当前未启用推理接口鉴权，适合本机单用户场景。";
    }
  }
  if (keyNode) {
    keyNode.value = "";
    keyNode.placeholder = settings?.hasApiKey
      ? "如需更新密钥，请在此输入新值"
      : "请输入新的 API Key";
  }
  if (resolveByApiKeyNode) {
    resolveByApiKeyNode.checked = Boolean(settings?.resolveClientTagByApiKey);
  }
  if (lanAccessNode) {
    lanAccessNode.checked = lanEnabled;
  }
  if (lanAccessStatusNode) {
    if (lanEnabled) {
      lanAccessStatusNode.textContent =
        "局域网共享已开启。保存变更后会重启网关，使推理面监听局域网地址；管理面仍只允许本机访问。";
    } else {
      lanAccessStatusNode.textContent =
        "LAN 共享必须启用 API Key 鉴权，并配置默认 API Key 或客户端密钥映射。";
    }
  }
  renderSecurityClientMappings(settings?.clientMappings ?? []);
  renderRoutingPreviewConsumerOptions();
  syncSecretFieldActionState();
}

function applySystemSettingsToForm(): void {
  const settings = state.systemSettings ?? {};
  const launchAtLogin = document.getElementById(
    "launch-at-login",
  ) as HTMLInputElement | null;
  const autoRefreshInterval = document.getElementById(
    "auto-refresh-interval",
  ) as HTMLSelectElement | null;
  const autoRefreshHint = document.getElementById(
    "auto-refresh-hint",
  ) as HTMLElement | null;
  const gatewayPortInput = document.getElementById(
    "gateway-port",
  ) as HTMLInputElement | null;
  const gatewayPortHint = document.getElementById(
    "gateway-port-hint",
  ) as HTMLElement | null;

  if (launchAtLogin) {
    launchAtLogin.checked = Boolean(settings.launchAtLogin);
  }

  if (autoRefreshInterval) {
    autoRefreshInterval.value = String(
      normalizeAutoRefreshIntervalSeconds(settings.autoRefreshIntervalSeconds),
    );
  }

  if (autoRefreshHint) {
    autoRefreshHint.textContent = `当前将每 ${formatAutoRefreshInterval(settings.autoRefreshIntervalSeconds)} 自动刷新一次账号额度与状态。`;
  }

  const gatewayPort = normalizeGatewayPort(settings.gatewayPort);
  if (gatewayPortInput) {
    gatewayPortInput.value = String(gatewayPort);
  }

  if (gatewayPortHint) {
    gatewayPortHint.textContent = `当前网关入口：http://127.0.0.1:${gatewayPort}/v1`;
  }
}

function buildHealthFallback(): DashboardHealth {
  const gatewayPort = normalizeGatewayPort(state.systemSettings?.gatewayPort);
  return {
    ok: false,
    managed: false,
    version: "0.1.0",
    defaultModel: "codex-default",
    openclaw: {
      baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
      provider: "openai",
      model: "codex-default",
    },
    recentErrors: [],
    providerConfigurations: [],
    poolObservability: [],
  };
}

function buildEmptyProviders(): DashboardProviders {
  return {
    data: [],
  };
}

function buildEmptySessions(): DashboardSessions {
  return {
    activeSessionId: undefined,
    data: [],
  };
}

function updateRuntimeDiagnostics(
  loadFailures: RuntimeDiagnosticLoadFailure[],
): void {
  const security = state.securitySettings ?? state.health?.inferenceAuth;
  const accessControl = state.securitySettings?.accessControl;
  const enabledLanConsumerIds = new Set(
    (accessControl?.consumers ?? [])
      .filter((consumer) => consumer.type === "lan-member" && consumer.status === "enabled")
      .map((consumer) => consumer.id),
  );
  const enabledLanAccessKeyCount = (accessControl?.keys ?? []).filter(
    (key) =>
      key.status === "enabled" &&
      key.hasKey &&
      enabledLanConsumerIds.has(key.consumerId),
  ).length;
  const sharedLanPoolCount = (state.poolSettings?.pools ?? []).filter(
    (pool) => pool.enabled !== false && normalizePoolVisibility(pool.visibility) === "shared-lan",
  ).length;
  const publicReadyPoolCount = (state.poolSettings?.pools ?? []).filter(
    (pool) => pool.enabled !== false && normalizePoolVisibility(pool.visibility) === "public-ready",
  ).length;
  state.runtimeDiagnostics = buildRuntimeDiagnostics({
    gatewayOk: state.health?.ok,
    activeSessionId: state.sessions?.activeSessionId,
    sessions: state.sessions?.data ?? [],
    loadFailures,
    routingEnabled: state.routingSettings?.enabled,
    routingMatchedTotal: state.health?.routingObservability?.totalMatched,
    inferenceAuthEnabled: security?.enabled,
    inferenceAuthHasApiKey: security?.hasApiKey,
    lanAccessEnabled: Boolean(security?.lanAccess?.enabled),
    lanBaseUrl: state.health?.desktopNetwork?.lanBaseUrl,
    gatewayHost: state.health?.host,
    gatewayPort: state.health?.port,
    localNetworkAddressCount:
      state.health?.desktopNetwork?.localNetworkAddresses?.length,
    sharedLanPoolCount,
    enabledLanConsumerCount: enabledLanConsumerIds.size,
    enabledLanAccessKeyCount,
    publicReadyPoolCount,
    recentErrors: state.health?.recentErrors ?? [],
  });
}

function configureAutoRefreshTimer(): void {
  clearAutoRefreshTimer();

  const seconds = normalizeAutoRefreshIntervalSeconds(
    state.systemSettings?.autoRefreshIntervalSeconds,
  );
  autoRefreshTimer = window.setInterval(() => {
    void triggerBackgroundLiveUsageRefresh("auto");
  }, seconds * 1_000);
}

function configureSessionActivityTimer(): void {
  clearSessionActivityTimer();
  sessionActivityTimer = window.setInterval(() => {
    void syncSessionActivitySilently();
  }, 15_000);
}

function collectSettingsFromForm(): ProviderSettings {
  return {
    defaultModelAlias:
      (
        document.getElementById(
          "default-model-alias",
        ) as HTMLSelectElement | null
      )?.value || undefined,
    codex: {
      upstreamModel:
        (
          document.getElementById(
            "codex-upstream-model",
          ) as HTMLSelectElement | null
        )?.value || undefined,
      exposedModels: Array.from(
        document.querySelectorAll<HTMLInputElement>(
          "[data-codex-exposed-model]:checked",
        ),
      )
        .map((node) => node.value.trim())
        .filter((value) => value.length > 0),
    },
    openAICompatible: {
      enabled:
        (document.getElementById("openai-enabled") as HTMLInputElement | null)
          ?.checked ?? false,
      label:
        (
          document.getElementById("openai-label") as HTMLInputElement | null
        )?.value.trim() || undefined,
      baseUrl:
        (
          document.getElementById("openai-base-url") as HTMLInputElement | null
        )?.value.trim() || undefined,
      apiKey:
        (
          document.getElementById("openai-api-key") as HTMLInputElement | null
        )?.value.trim() || undefined,
      model:
        (
          document.getElementById("openai-model") as HTMLInputElement | null
        )?.value.trim() || undefined,
      alias:
        (
          document.getElementById("openai-alias") as HTMLInputElement | null
        )?.value.trim() || undefined,
      displayName:
        (
          document.getElementById(
            "openai-display-name",
          ) as HTMLInputElement | null
        )?.value.trim() || undefined,
    },
    ollama: {
      enabled:
        (document.getElementById("ollama-enabled") as HTMLInputElement | null)
          ?.checked ?? false,
      label:
        (
          document.getElementById("ollama-label") as HTMLInputElement | null
        )?.value.trim() || undefined,
      baseUrl:
        (
          document.getElementById("ollama-base-url") as HTMLInputElement | null
        )?.value.trim() || undefined,
      model:
        (
          document.getElementById("ollama-model") as HTMLInputElement | null
        )?.value.trim() || undefined,
      alias:
        (
          document.getElementById("ollama-alias") as HTMLInputElement | null
        )?.value.trim() || undefined,
      displayName:
        (
          document.getElementById(
            "ollama-display-name",
          ) as HTMLInputElement | null
        )?.value.trim() || undefined,
    },
  };
}

async function saveSettingsAndRestart(): Promise<void> {
  const api = getGatewayApi();
  const payload = collectSettingsFromForm();
  setBanner("正在保存 Provider 配置并重启服务...", "info");
  await api.saveProviderSettings(payload);
  await api.restartGateway();
  setBanner("配置已保存，服务已重启。", "success");
  await refresh();
}

async function saveSystemSettings(): Promise<void> {
  const api = getGatewayApi();
  const payload: SystemSettings = {
    launchAtLogin:
      (document.getElementById("launch-at-login") as HTMLInputElement | null)
        ?.checked ?? false,
    autoRefreshIntervalSeconds: normalizeAutoRefreshIntervalSeconds(
      Number(
        (
          document.getElementById(
            "auto-refresh-interval",
          ) as HTMLSelectElement | null
        )?.value ?? "120",
      ),
    ),
    gatewayPort: normalizeGatewayPort(
      Number(
        (document.getElementById("gateway-port") as HTMLInputElement | null)
          ?.value ?? "8787",
      ),
    ),
    pinnedSessionId: state.systemSettings?.pinnedSessionId,
  };

  const response = await api.saveSystemSettings(payload);
  state.systemSettings = response.data;
  applySystemSettingsToForm();
  configureAutoRefreshTimer();
}

async function togglePinnedSession(sessionId: string): Promise<void> {
  const api = getGatewayApi();
  const nextPinnedSessionId = isPinnedAccountSession(sessionId)
    ? undefined
    : sessionId;
  const response = await api.saveSystemSettings({
    pinnedSessionId: nextPinnedSessionId,
  });
  state.systemSettings = response.data;
  renderCodexAccounts();
  setBanner(
    nextPinnedSessionId
      ? "账号已置顶，后续排序将固定显示在最前。"
      : "已取消账号置顶。",
    "success",
  );
}

async function saveSecuritySettings(): Promise<void> {
  const api = getGatewayApi();
  const mode =
    (document.getElementById("gateway-auth-mode") as HTMLSelectElement | null)
      ?.value === "api-key"
      ? "api-key"
      : "none";
  const apiKey =
    (
      document.getElementById("gateway-auth-api-key") as HTMLInputElement | null
    )?.value.trim() || undefined;
  const resolveClientTagByApiKey =
    (
      document.getElementById(
        "gateway-auth-resolve-client-tag-by-api-key",
      ) as HTMLInputElement | null
    )?.checked ?? false;
  const lanAccessEnabled =
    (
      document.getElementById(
        "gateway-lan-access-enabled",
      ) as HTMLInputElement | null
    )?.checked ?? false;

  const mappingRows = Array.from(
    document.querySelectorAll<HTMLElement>("[data-security-mapping-row]"),
  );
  const clientMappings = mappingRows
    .map((row) => {
      const index = Number(row.dataset.securityMappingRow ?? "-1");
      if (index < 0) {
        return undefined;
      }
      const name = (
        document.querySelector(
          `[data-security-mapping-name="${index}"]`,
        ) as HTMLInputElement | null
      )?.value.trim();
      const clientTag = (
        document.querySelector(
          `[data-security-mapping-client-tag="${index}"]`,
        ) as HTMLInputElement | null
      )?.value.trim();
      const mappingApiKey = (
        document.querySelector(
          `[data-security-mapping-api-key="${index}"]`,
        ) as HTMLInputElement | null
      )?.value.trim();
      const enabled =
        (
          document.querySelector(
            `[data-security-mapping-enabled="${index}"]`,
          ) as HTMLInputElement | null
        )?.checked ?? true;
      const allowHeaderOverride =
        (
          document.querySelector(
            `[data-security-mapping-allow-header="${index}"]`,
          ) as HTMLInputElement | null
        )?.checked ?? false;
      if (!name || !clientTag) {
        return undefined;
      }
      return {
        name,
        clientTag,
        apiKey: mappingApiKey || "",
        enabled,
        allowHeaderOverride,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const payload: SecuritySettingsInput = {
    mode,
    apiKey,
    resolveClientTagByApiKey,
    clientMappings,
    accessControl: state.securitySettings?.accessControl,
    lanAccess: {
      enabled: lanAccessEnabled,
    },
  };
  const previousLanEnabled = Boolean(state.securitySettings?.lanAccess?.enabled);
  const response = await api.saveSecuritySettings(payload);
  state.securitySettings = response.data;
  applySecuritySettingsToForm();
  if (previousLanEnabled !== Boolean(response.data.lanAccess?.enabled)) {
    setBanner("局域网共享配置已保存，正在重启网关使监听地址生效...", "info");
    await api.restartGateway();
    await refresh();
  }
}

async function exportAppData(): Promise<void> {
  const api = getGatewayApi();
  const result = await api.exportAppData();
  if (result.canceled) {
    setBanner("已取消应用数据导出。", "info");
    return;
  }

  try {
    state.appDataStatus = (await api.getAppDataStatus()).data;
    renderAppDataStatus();
  } catch {
    // 导出成功不依赖状态刷新，失败时保留成功提示即可。
  }

  setBanner(
    `应用数据已导出到 ${result.selectedPath ?? "目标位置"}：${result.fileCount ?? 0} 个文件，${formatBytes(result.totalBytes)}。`,
    "success",
  );
}

async function importAppData(): Promise<void> {
  const api = getGatewayApi();
  const preview = await api.previewImportAppData();
  if (preview.canceled || !preview.data) {
    setBanner("已取消应用数据导入。", "info");
    return;
  }

  const confirmed = await requestConfirmation({
    title: "确认导入应用数据",
    message: `将导入备份 ${preview.data.fileName}（导出时间 ${formatDate(
      preview.data.exportedAt ? Date.parse(preview.data.exportedAt) : undefined,
    )}，应用版本 ${preview.data.appVersion ?? "unknown"}，${preview.data.fileCount} 个文件，约 ${formatBytes(
      preview.data.totalBytes,
    )}）。导入会覆盖当前本机的配置、账号、统计和日志等持久化数据，并先自动创建一份安全备份。是否继续？`,
    confirmLabel: "确认导入",
    tone: "danger",
  });
  if (!confirmed) {
    setBanner("已取消应用数据导入。", "info");
    return;
  }

  const result = await api.importAppData(preview.data.selectedPath);
  if (result.canceled) {
    setBanner("已取消应用数据导入。", "info");
    return;
  }

  try {
    await refresh();
  } catch {
    // 若当前不是托管 gateway，导入后可能需要人工重启，本次保留导入成功提示即可。
  }

  try {
    state.appDataStatus = (await api.getAppDataStatus()).data;
    renderAppDataStatus();
  } catch {
    // 恢复后若状态暂不可读取，不影响主流程。
  }

  if (result.requiresManualRestart) {
    setBanner(
      `应用数据已导入，恢复 ${result.restoredFiles ?? 0} 个文件；当前非托管网关需手动重启后才能完全生效。本机安全备份：${result.safetyBackupPath ?? "已创建"}。`,
      "success",
    );
    return;
  }

  setBanner(
    `应用数据已导入，恢复 ${result.restoredFiles ?? 0} 个文件，${formatBytes(result.restoredBytes)}；本机安全备份：${result.safetyBackupPath ?? "已创建"}。`,
    "success",
  );
}

async function saveRoutingSettings(): Promise<void> {
  const api = getGatewayApi();
  const payload = collectRoutingSettingsFromForm();
  const response = await api.saveRoutingSettings(payload);
  state.routingSettings = response.data;
  applyRoutingSettingsToForm();
}

async function previewRoutingSettings(): Promise<void> {
  const api = getGatewayApi();
  const payload: RoutingPreviewInput = {
    accessConsumerId:
      (
        document.getElementById(
          "routing-preview-access-consumer",
        ) as HTMLSelectElement | null
      )?.value.trim() || undefined,
    clientTag:
      (
        document.getElementById(
          "routing-preview-client-tag",
        ) as HTMLInputElement | null
      )?.value.trim() || undefined,
    requestedModelAlias:
      (
        document.getElementById(
          "routing-preview-requested-model",
        ) as HTMLInputElement | null
      )?.value.trim() || undefined,
    currentModelAlias:
      (
        document.getElementById(
          "routing-preview-current-model",
        ) as HTMLInputElement | null
      )?.value.trim() || undefined,
    currentSessionId:
      (
        document.getElementById(
          "routing-preview-current-session",
        ) as HTMLInputElement | null
      )?.value.trim() || undefined,
  };

  const response = await api.previewRouting(payload);
  renderRoutingPreviewResult(response.data);
}

function openAccountModal(tab = "import"): void {
  const modal = document.getElementById("account-modal");
  if (!modal) {
    return;
  }
  modal.hidden = false;
  setAccountTab(tab);
}

function closeAccountModal(): void {
  const modal = document.getElementById("account-modal");
  if (modal) {
    modal.hidden = true;
  }
  setOAuthStatus(
    "浏览器授权已准备就绪。点击下方按钮后将自动打开授权页面。",
    "info",
  );
}

function openPoolEventsModal(poolId: string): void {
  state.activePoolEventsModalId = poolId;
  renderPoolEventsModal();
  const modal = document.getElementById("pool-events-modal");
  if (modal) {
    modal.hidden = false;
  }
}

function closePoolEventsModal(): void {
  state.activePoolEventsModalId = undefined;
  const modal = document.getElementById("pool-events-modal");
  if (modal) {
    modal.hidden = true;
  }
}

function renderPoolEventsModal(): void {
  const modal = document.getElementById("pool-events-modal");
  const titleNode = document.getElementById("pool-events-modal-title");
  const bodyNode = document.getElementById("pool-events-modal-body");
  if (!modal || !titleNode || !bodyNode) {
    return;
  }

  const poolId = state.activePoolEventsModalId;
  if (!poolId) {
    modal.hidden = true;
    return;
  }

  const pool =
    state.poolSettings?.pools?.find((item) => item.id === poolId) ??
    state.health?.poolObservability?.find((item) => item.poolId === poolId);
  const poolTitle =
    (pool && "name" in pool ? pool.name : undefined) ||
    (pool && "poolName" in pool ? pool.poolName : undefined) ||
    poolId;
  titleNode.textContent = `${poolTitle} · 最近调度事件`;
  bodyNode.innerHTML = `
    <div class="pool-event-panel">
      <div class="pool-event-panel-head">
        <strong>最近调度事件</strong>
        <span>用于解释为什么这次选中了某个账号、为什么会从 A 切到 B，以及最近是哪类失败触发了自动切号。</span>
      </div>
      ${buildPoolEventMarkup(poolId)}
    </div>
  `;
}

function openUsageDetailsModal(): void {
  state.usageDetailsModalOpen = true;
  renderUsageDetailsModal();
  const modal = document.getElementById("usage-details-modal");
  if (modal) {
    modal.hidden = false;
  }
}

function closeUsageDetailsModal(): void {
  state.usageDetailsModalOpen = false;
  const modal = document.getElementById("usage-details-modal");
  if (modal) {
    modal.hidden = true;
  }
}

function renderUsageDetailsModal(): void {
  const modal = document.getElementById("usage-details-modal");
  const titleNode = document.getElementById("usage-details-modal-title");
  const bodyNode = document.getElementById("usage-details-modal-body");
  if (!modal || !titleNode || !bodyNode) {
    return;
  }

  const summary = getActiveUsageWindowSummary();
  if (!state.usageDetailsModalOpen || !summary) {
    modal.hidden = true;
    return;
  }

  titleNode.textContent = `Token 用量明细 · ${usageWindowLabel(state.usageObserveWindow)} · ${usageClientFilterLabel(state.usageClientFilter)}`;
  const accessConsumersById = new Map(
    (state.securitySettings?.accessControl?.consumers ?? []).map((consumer) => [
      consumer.id,
      consumer,
    ]),
  );
  const accessKeysById = new Map(
    (state.securitySettings?.accessControl?.keys ?? []).map((key) => [
      key.id,
      key,
    ]),
  );
  const poolsById = new Map(
    (state.poolSettings?.pools ?? []).map((pool) => [pool.id, pool]),
  );

  const renderUsageDetailItems = (
    rows: Array<{
      title: string;
      subtitle?: string;
      usage: UsageCounters;
    }>,
    emptyLabel: string,
  ) =>
    rows.length > 0
      ? rows
          .map(
            (row) => `
              <div class="usage-details-item">
                <div class="usage-details-item-head">
                  <div style="display: grid; gap: 2px;">
                    <strong>${escapeHtml(row.title)}</strong>
                    ${row.subtitle ? `<small>${escapeHtml(row.subtitle)}</small>` : ""}
                  </div>
                  <span class="badge neutral">${escapeHtml(formatCompactCount(row.usage.totalTokens))} Token</span>
                </div>
                <span>请求 ${escapeHtml(formatCompactCount(row.usage.requestCount))} · 成功率 ${escapeHtml(formatUsageSuccessRate(row.usage))} · 平均延迟 ${escapeHtml(formatUsageLatency(row.usage))}</span>
                <span>输入 ${escapeHtml(formatCompactCount(row.usage.inputTokens))} / 输出 ${escapeHtml(formatCompactCount(row.usage.outputTokens))} / 缓存 ${escapeHtml(formatCompactCount(row.usage.cachedTokens))} / 思考 ${escapeHtml(formatCompactCount(row.usage.reasoningTokens))}</span>
              </div>
            `,
          )
          .join("")
      : `<div class="empty-card">${escapeHtml(emptyLabel)}</div>`;

  bodyNode.innerHTML = `
    <div class="usage-details-grid">
      <div class="usage-details-section">
        <h4>账号排行</h4>
        <div class="usage-details-list">
          ${renderUsageDetailItems(
            summary.accounts.map((row) => ({
              title: row.email ?? row.accountId,
              subtitle: row.email && row.email !== row.accountId ? row.accountId : undefined,
              usage: row.usage,
            })),
            "当前窗口暂无账号维度的 Token 用量记录。",
          )}
        </div>
      </div>
      <div class="usage-details-section">
        <h4>客户端排行</h4>
        <div class="usage-details-list">
          ${renderUsageDetailItems(
            summary.clients.map((row) => ({
              title: normalizeUsageClientTagLabel(row.clientTag),
              usage: row.usage,
            })),
            "当前窗口暂无客户端维度的 Token 用量记录。",
          )}
        </div>
      </div>
      <div class="usage-details-section">
        <h4>访问成员排行</h4>
        <div class="usage-details-list">
          ${renderUsageDetailItems(
            summary.consumers.map((row) => {
              const consumer = accessConsumersById.get(row.consumerId);
              return {
                title:
                  consumer?.name ||
                  row.clientTag ||
                  consumer?.clientTag ||
                  row.consumerId,
                subtitle: [
                  consumer?.type,
                  row.clientTag ? `clientTag: ${row.clientTag}` : undefined,
                  row.accessKeyId ? `key: ${row.accessKeyId}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
                usage: row.usage,
              };
            }),
            "当前窗口暂无访问成员维度的 Token 用量记录。",
          )}
        </div>
      </div>
      <div class="usage-details-section">
        <h4>Access Key 排行</h4>
        <div class="usage-details-list">
          ${renderUsageDetailItems(
            summary.accessKeys.map((row) => {
              const key = accessKeysById.get(row.accessKeyId);
              const consumer = row.consumerId
                ? accessConsumersById.get(row.consumerId)
                : undefined;
              return {
                title: key?.name || row.accessKeyId,
                subtitle: [
                  consumer?.name || row.clientTag,
                  key ? `${key.keyPrefix}...${key.keySuffix}` : undefined,
                  key?.status ? formatAccessStatusLabel(key.status) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
                usage: row.usage,
              };
            }),
            "当前窗口暂无 Access Key 维度的 Token 用量记录。",
          )}
        </div>
      </div>
      <div class="usage-details-section">
        <h4>号池排行</h4>
        <div class="usage-details-list">
          ${renderUsageDetailItems(
            (summary.pools ?? []).map((row) => {
              const pool = poolsById.get(row.poolId);
              return {
                title: pool?.name || row.poolId,
                subtitle: [
                  row.clientTag ? `clientTag: ${row.clientTag}` : undefined,
                  pool?.visibility ? formatPoolVisibilityLabel(pool.visibility) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
                usage: row.usage,
              };
            }),
            "当前窗口暂无号池维度的 Token 用量记录。",
          )}
        </div>
      </div>
      <div class="usage-details-section">
        <h4>模型排行</h4>
        <div class="usage-details-list">
          ${renderUsageDetailItems(
            summary.models.map((row) => ({
              title: row.modelAlias,
              usage: row.usage,
            })),
            "当前窗口暂无模型维度的 Token 用量记录。",
          )}
        </div>
      </div>
    </div>
  `;
}

function setAccountTab(tab: string): void {
  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>("[data-account-tab]"),
  )) {
    node.dataset.active = node.dataset.accountTab === tab ? "true" : "false";
  }

  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>("[data-account-panel]"),
  )) {
    node.hidden = node.dataset.accountPanel !== tab;
  }
}

function bindNavigation(): void {
  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>("[data-nav-target]"),
  )) {
    node.addEventListener("click", () => {
      const target = node.dataset.navTarget;
      if (!target) {
        return;
      }
      setActiveView(target as DashboardView);
    });
  }

  const viewStack = document.querySelector<HTMLElement>(".view-stack");
  viewStack?.addEventListener(
    "scroll",
    () => {
      markViewStackScrolling();
    },
    { passive: true },
  );
}

async function copySnippetWithFeedback(): Promise<void> {
  await getGatewayApi().copyOpenClawSnippet();
  setBanner("接入片段已复制。", "success");
}

async function copyTextWithFallback(text: string): Promise<void> {
  const api = getGatewayApi();
  if (typeof api.copyText === "function") {
    try {
      await api.copyText(text);
      return;
    } catch (error) {
      const message = String(error);
      if (!message.includes("No handler registered")) {
        throw error;
      }
    }
  }

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("当前环境不支持复制，请手动复制。");
  }
}

async function copyTemplateWithFeedback(
  key: IntegrationTemplateKey,
): Promise<void> {
  const health = state.health;
  if (!health) {
    throw new Error("控制台尚未完成初始化，请稍后重试。");
  }
  const snippets = buildIntegrationSnippets(health);
  const labels: Record<IntegrationTemplateKey, string> = {
    openclaw: "OpenClaw 模板",
    hermes: "Hermes 模板",
    curl: "通用 cURL 模板",
  };
  await copyTextWithFallback(snippets[key]);
  setBanner(`${labels[key]}已复制。`, "success");
}

function setOAuthStatus(
  message: string,
  tone: "info" | "success" | "error" = "info",
): void {
  const node = document.getElementById("oauth-status");
  if (!node) {
    return;
  }
  node.textContent = message;
  node.setAttribute("data-tone", tone);
}

function closeConfirmModal(confirmed: boolean): void {
  const overlay = document.getElementById("confirm-modal");
  if (overlay) {
    overlay.hidden = true;
  }
  const resolver = pendingConfirmResolver;
  pendingConfirmResolver = undefined;
  resolver?.(confirmed);
}

async function requestConfirmation(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: "danger" | "primary";
}): Promise<boolean> {
  const overlay = document.getElementById("confirm-modal");
  const titleNode = document.getElementById("confirm-modal-title");
  const messageNode = document.getElementById("confirm-modal-message");
  const confirmButton = document.getElementById(
    "confirm-modal-confirm",
  ) as HTMLButtonElement | null;
  const cancelButton = document.getElementById(
    "confirm-modal-cancel",
  ) as HTMLButtonElement | null;

  if (
    !overlay ||
    !titleNode ||
    !messageNode ||
    !confirmButton ||
    !cancelButton
  ) {
    return window.confirm(options.message);
  }

  if (pendingConfirmResolver) {
    closeConfirmModal(false);
  }

  titleNode.textContent = options.title;
  messageNode.textContent = options.message;
  confirmButton.textContent = options.confirmLabel ?? "确认继续";
  confirmButton.classList.toggle("primary", options.tone !== "danger");
  confirmButton.classList.toggle("danger", options.tone === "danger");
  confirmButton.classList.toggle("ghost", false);
  confirmButton.classList.toggle("danger-ghost", false);
  overlay.hidden = false;

  return await new Promise<boolean>((resolve) => {
    pendingConfirmResolver = resolve;
    cancelButton.focus();
  });
}

function summarizeRefreshBanner(
  summary: SessionUsageRefreshResponse | undefined,
  options: {
    successMessage: string;
    emptyMessage: string;
    unsupportedMessage: string;
    failedOnlyMessage: string;
  },
): { tone: "info" | "success" | "error"; message: string } {
  if (!summary) {
    return {
      tone: "info",
      message: options.unsupportedMessage,
    };
  }
  if (summary.refreshed === 0 && summary.failed === 0) {
    return {
      tone: "info",
      message: options.emptyMessage,
    };
  }
  if (summary.refreshed > 0) {
    return {
      tone: "success",
      message: options.successMessage.replace(
        "{count}",
        String(summary.refreshed),
      ),
    };
  }

  const failureMessages = summary.errors
    .map((error) => String(error.message ?? "").toLowerCase())
    .filter((message) => message.length > 0);
  const hasNetworkFailure = failureMessages.some(
    (message) =>
      message.includes("fetch failed") ||
      message.includes("timeout") ||
      message.includes("connect"),
  );
  const hasOAuthRejected = failureMessages.some(
    (message) =>
      message.includes("unsupported_country_region_territory") ||
      message.includes("request_forbidden") ||
      message.includes("oauth"),
  );

  if (hasOAuthRejected) {
    return {
      tone: "error",
      message:
        "状态已刷新，但当前账号授权刷新被上游拒绝。请切换可用账号或重新授权后再试。",
    };
  }
  if (hasNetworkFailure) {
    return {
      tone: "error",
      message:
        "状态已刷新，但当前网络无法访问额度接口，未能同步到最新额度。",
    };
  }
  return {
    tone: "error",
    message: options.failedOnlyMessage,
  };
}

function setOAuthBusyState(inFlight: boolean): void {
  state.oauthInFlight = inFlight;
  const startButton = document.getElementById(
    "start-codex-oauth",
  ) as HTMLButtonElement | null;
  const submitButton = document.getElementById(
    "submit-codex-oauth-input",
  ) as HTMLButtonElement | null;
  const cancelButton = document.getElementById(
    "cancel-codex-oauth",
  ) as HTMLButtonElement | null;
  const input = document.getElementById(
    "oauth-manual-input",
  ) as HTMLInputElement | null;

  if (startButton) {
    startButton.disabled = inFlight;
    startButton.textContent = inFlight
      ? "等待授权完成..."
      : "在浏览器中开始授权";
  }
  if (submitButton) {
    submitButton.disabled = !inFlight;
  }
  if (cancelButton) {
    cancelButton.disabled = !inFlight;
  }
  if (input) {
    input.disabled = !inFlight;
  }
}

async function startCodexOAuthFlow(): Promise<void> {
  if (state.oauthInFlight) {
    return;
  }

  setOAuthBusyState(true);
  setOAuthStatus(
    "已打开浏览器授权页面。若未自动完成，请把回调地址粘贴到下方输入框。",
    "info",
  );
  setBanner("正在等待 Codex OAuth 授权完成...", "info");

  try {
    const result = await getGatewayApi().loginCodexOAuth();
    await refresh();
    closeAccountModal();
    setBanner(
      `Codex 账号已导入：${result.data.accountId ?? result.data.profileId}`,
      "success",
    );
  } catch (error) {
    setOAuthStatus(`授权失败：${String(error)}`, "error");
    setBanner(`Codex 授权失败：${String(error)}`, "error");
  } finally {
    setOAuthBusyState(false);
  }
}

async function submitCodexOAuthInput(): Promise<void> {
  const input =
    (
      document.getElementById("oauth-manual-input") as HTMLInputElement | null
    )?.value.trim() ?? "";
  await getGatewayApi().submitCodexOAuthInput(input);
  setOAuthStatus("已提交手动回调地址，正在继续完成授权...", "info");
}

async function cancelCodexOAuthFlow(): Promise<void> {
  await getGatewayApi().cancelCodexOAuth();
  setOAuthBusyState(false);
  setOAuthStatus("已取消当前 Codex 授权流程。", "info");
}

async function importCodexJson(): Promise<void> {
  const result = await getGatewayApi().importCodexJson();
  if (result.canceled) {
    setBanner("已取消 JSON 导入。", "info");
    return;
  }

  await refresh();
  closeAccountModal();
  setBanner(
    `已导入 ${result.imported ?? 0} 个 Codex 账号，更新 ${result.updated ?? 0} 个账号。`,
    "success",
  );
}

async function importAccountConfig(): Promise<void> {
  const result = await getGatewayApi().importAccountConfig();
  if (result.canceled) {
    setBanner("已取消账号配置导入。", "info");
    return;
  }

  await refresh();
  setActiveView("accounts");
  setBanner(
    `账号配置已导入：新增 ${result.imported ?? 0} 个，更新 ${result.updated ?? 0} 个。`,
    "success",
  );
}

function appendSecurityClientMappingDraft(): void {
  const current = state.securitySettings ?? {
    mode: "none" as const,
    enabled: false,
    hasApiKey: false,
    resolveClientTagByApiKey: false,
    mappingCount: 0,
    enabledMappingCount: 0,
    clientMappings: [],
    lanAccess: {
      enabled: false,
    },
    accessControl: {
      consumers: [],
      keys: [],
      policies: [],
    },
  };
  syncSecurityMappingDraftsFromDom();
  const nextIndex = current.clientMappings.length + 1;
  current.clientMappings = [
    ...current.clientMappings,
    {
      name: `client-${nextIndex}`,
      clientTag: `client-${nextIndex}`,
      enabled: true,
      allowHeaderOverride: false,
      hasApiKey: false,
    },
  ];
  current.mappingCount = current.clientMappings.length;
  current.enabledMappingCount = current.clientMappings.filter((item) => item.enabled)
    .length;
  state.securitySettings = current;
  renderSecurityClientMappings(current.clientMappings);
  syncSecretFieldActionState();
}

function generateApiKey(prefix: string): string {
  const normalizedPrefix = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "client";
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(40);
  globalThis.crypto.getRandomValues(bytes);
  let body = "";
  for (let i = 0; i < 36; i += 1) {
    body += alphabet[bytes[i] % alphabet.length];
  }
  return `lagw_${normalizedPrefix}_${body}`;
}

function normalizeAccessSlug(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function createAccessEntityId(prefix: string, seed: string): string {
  return `${prefix}-${normalizeAccessSlug(seed, "member")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function cloneAccessControlForSave(
  accessControl: SecurityAccessControl,
): SecurityAccessControlInput {
  return {
    consumers: accessControl.consumers.map((consumer) => ({ ...consumer })),
    keys: accessControl.keys.map((key) => ({ ...key })),
    policies: accessControl.policies.map((policy) => ({
      ...policy,
      allowedModelAliases: [...(policy.allowedModelAliases ?? [])],
      allowedPoolIds: [...(policy.allowedPoolIds ?? [])],
    })),
  };
}

function getSecurityClientMappingInputs(
  settings: SecuritySettings,
): SecurityClientMappingInput[] {
  syncSecurityMappingDraftsFromDom();
  return settings.clientMappings.map((mapping) => ({
    name: mapping.name,
    clientTag: mapping.clientTag,
    apiKey: mapping.draftApiKey ?? "",
    enabled: mapping.enabled,
    allowHeaderOverride: mapping.allowHeaderOverride,
  }));
}

async function saveAccessControlSettings(
  accessControl: SecurityAccessControlInput,
): Promise<SecuritySettings> {
  const api = getGatewayApi();
  const current = getSecuritySettingsWithDefaults();
  const response = await api.saveSecuritySettings({
    mode: "api-key",
    resolveClientTagByApiKey: true,
    clientMappings: getSecurityClientMappingInputs(current),
    lanAccess: current.lanAccess,
    accessControl,
  });
  state.securitySettings = response.data;
  if (
    state.selectedAccessConsumerId &&
    !response.data.accessControl.consumers.some(
      (item) => item.id === state.selectedAccessConsumerId,
    )
  ) {
    state.selectedAccessConsumerId = undefined;
  }
  renderAccessAndKeys();
  renderSecurityClientMappings(state.securitySettings.clientMappings);
  return response.data;
}

function getAccessKeyExpiryInput(keyId: string): HTMLInputElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-access-key-expiry]"),
  ).find((input) => input.dataset.accessKeyExpiry === keyId);
}

function showRotatedAccessKey(apiKey: string): void {
  const result = document.getElementById("access-rotated-key-result");
  const input = document.getElementById(
    "access-rotated-one-time-key",
  ) as HTMLInputElement | null;
  if (input) {
    input.value = apiKey;
  }
  if (result) {
    result.hidden = false;
  }
}

function openAccessMemberModal(): void {
  const modal = document.getElementById("access-create-member-modal");
  if (!modal) {
    return;
  }
  modal.hidden = false;
  const keyResult = document.getElementById("access-member-key-result");
  if (keyResult) {
    keyResult.hidden = true;
  }
  const keyNode = document.getElementById(
    "access-member-one-time-key",
  ) as HTMLInputElement | null;
  if (keyNode) {
    keyNode.value = "";
  }
  (document.getElementById("access-member-name") as HTMLInputElement | null)?.focus();
}

function closeAccessMemberModal(): void {
  const modal = document.getElementById("access-create-member-modal");
  if (modal) {
    modal.hidden = true;
  }
}

function getSecuritySettingsWithDefaults(): SecuritySettings {
  return state.securitySettings ?? {
    mode: "none",
    enabled: false,
    hasApiKey: false,
    resolveClientTagByApiKey: false,
    mappingCount: 0,
    enabledMappingCount: 0,
    clientMappings: [],
    lanAccess: {
      enabled: false,
    },
    accessControl: {
      consumers: [],
      keys: [],
      policies: [],
    },
  };
}

async function createAccessMember(): Promise<void> {
  const api = getGatewayApi();
  const name =
    (document.getElementById("access-member-name") as HTMLInputElement | null)
      ?.value.trim() ?? "";
  const rawClientTag =
    (document.getElementById("access-member-client-tag") as HTMLInputElement | null)
      ?.value.trim() ?? "";
  const note =
    (document.getElementById("access-member-note") as HTMLInputElement | null)
      ?.value.trim() || undefined;
  if (!name) {
    setBanner("请先填写成员名称。", "error");
    return;
  }
  const clientTag = normalizeAccessSlug(rawClientTag || name, "member");
  const current = getSecuritySettingsWithDefaults();
  const consumerId = createAccessEntityId("consumer", clientTag);
  const keyId = createAccessEntityId("key", clientTag);
  const now = new Date().toISOString();
  const apiKey = generateApiKey(clientTag);
  const nextAccessControl: SecurityAccessControlInput = {
    consumers: [
      ...current.accessControl.consumers,
      {
        id: consumerId,
        name,
        type: "lan-member",
        status: "enabled",
        clientTag,
        note,
        tags: ["lan"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    keys: [
      ...current.accessControl.keys,
      {
        id: keyId,
        consumerId,
        name: `${name} 默认 Key`,
        keyPrefix: apiKey.slice(0, 8),
        keySuffix: apiKey.slice(-4),
        status: "enabled",
        createdAt: now,
        hasKey: true,
        apiKey,
      },
    ],
    policies: [
      ...current.accessControl.policies,
      {
        consumerId,
        allowedModelAliases: [],
        allowedPoolIds: [],
      },
    ],
  };

  const response = await api.saveSecuritySettings({
    mode: "api-key",
    resolveClientTagByApiKey: true,
    clientMappings: getSecurityClientMappingInputs(current),
    lanAccess: current.lanAccess,
    accessControl: nextAccessControl,
  });
  state.securitySettings = response.data;
  state.selectedAccessConsumerId = consumerId;
  renderAccessAndKeys();
  renderSecurityClientMappings(state.securitySettings.clientMappings);
  const keyNode = document.getElementById(
    "access-member-one-time-key",
  ) as HTMLInputElement | null;
  const keyResult = document.getElementById("access-member-key-result");
  if (keyNode) {
    keyNode.value = apiKey;
  }
  if (keyResult) {
    keyResult.hidden = false;
  }
  setBanner("访问成员已创建。请立即复制一次性 API Key。", "success");
}

async function toggleAccessKeyStatus(keyId: string): Promise<void> {
  const current = getSecuritySettingsWithDefaults();
  const nextAccessControl = cloneAccessControlForSave(current.accessControl);
  const key = nextAccessControl.keys.find((item) => item.id === keyId);
  if (!key) {
    setBanner("未找到目标访问 Key。", "error");
    return;
  }
  key.status = key.status === "paused" ? "enabled" : "paused";
  await saveAccessControlSettings(nextAccessControl);
  setBanner(
    key.status === "enabled" ? "访问 Key 已启用。" : "访问 Key 已暂停。",
    "success",
  );
}

async function saveAccessKeyExpiry(keyId: string): Promise<void> {
  const input = getAccessKeyExpiryInput(keyId);
  if (!input) {
    setBanner("未找到目标 Key 的到期时间输入框。", "error");
    return;
  }
  const expiresAt = parseAccessDateTimeLocalValue(input.value);
  const current = getSecuritySettingsWithDefaults();
  const nextAccessControl = cloneAccessControlForSave(current.accessControl);
  const key = nextAccessControl.keys.find((item) => item.id === keyId);
  if (!key) {
    setBanner("未找到目标访问 Key。", "error");
    return;
  }
  key.expiresAt = expiresAt;
  if (expiresAt && Date.parse(expiresAt) > Date.now() && key.status === "expired") {
    key.status = "enabled";
  }
  await saveAccessControlSettings(nextAccessControl);
  setBanner(expiresAt ? "访问 Key 到期时间已保存。" : "访问 Key 到期时间已清空。", "success");
}

async function saveAccessPolicySettings(consumerId: string): Promise<void> {
  const current = getSecuritySettingsWithDefaults();
  const nextAccessControl = cloneAccessControlForSave(current.accessControl);
  const consumer = nextAccessControl.consumers.find(
    (item) => item.id === consumerId,
  );
  if (!consumer) {
    setBanner("未找到目标访问成员。", "error");
    return;
  }
  const selectedPoolIds = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      "[data-access-policy-pool]:checked",
    ),
  )
    .map((input) => input.dataset.accessPolicyPool?.trim())
    .filter((poolId): poolId is string => Boolean(poolId));
  const existingPolicy = nextAccessControl.policies.find(
    (item) => item.consumerId === consumerId,
  );
  if (existingPolicy) {
    existingPolicy.allowedPoolIds = selectedPoolIds;
  } else {
    nextAccessControl.policies.push({
      consumerId,
      allowedModelAliases: [],
      allowedPoolIds: selectedPoolIds,
    });
  }

  const policy = nextAccessControl.policies.find(
    (item) => item.consumerId === consumerId,
  );
  if (!policy) {
    setBanner("未找到目标访问策略。", "error");
    return;
  }

  const dailyTokenLimit = parseAccessPositiveIntegerInput(
    `[data-access-policy-daily-token-limit="${consumerId}"]`,
    "日 Token 限额",
  );
  const requestsPerMinute = parseAccessPositiveIntegerInput(
    `[data-access-policy-requests-per-minute="${consumerId}"]`,
    "每分钟请求数",
  );
  const maxConcurrentRequests = parseAccessPositiveIntegerInput(
    `[data-access-policy-max-concurrent="${consumerId}"]`,
    "最大并发请求数",
  );
  policy.allowedModelAliases = parseAccessModelAliasesInput(
    `[data-access-policy-model-aliases="${consumerId}"]`,
  );

  const quota = { ...(policy.quota ?? {}) };
  if (typeof dailyTokenLimit === "number") {
    quota.dailyTokenLimit = dailyTokenLimit;
  } else {
    delete quota.dailyTokenLimit;
  }
  policy.quota = Object.keys(quota).length > 0 ? quota : undefined;

  const limits = { ...(policy.limits ?? {}) };
  if (typeof requestsPerMinute === "number") {
    limits.requestsPerMinute = requestsPerMinute;
  } else {
    delete limits.requestsPerMinute;
  }
  if (typeof maxConcurrentRequests === "number") {
    limits.maxConcurrentRequests = maxConcurrentRequests;
  } else {
    delete limits.maxConcurrentRequests;
  }
  policy.limits = Object.keys(limits).length > 0 ? limits : undefined;

  await saveAccessControlSettings(nextAccessControl);
  setBanner("访问成员策略已保存。", "success");
}

async function saveAccessPolicyPools(consumerId: string): Promise<void> {
  await saveAccessPolicySettings(consumerId);
}

async function rotateAccessKey(keyId: string): Promise<void> {
  const confirmed = await requestConfirmation({
    title: "确认轮换 Key",
    message:
      "轮换后旧 API Key 会立即失效，需要把新 Key 重新分发给对应成员。是否继续？",
    confirmLabel: "轮换 Key",
    tone: "danger",
  });
  if (!confirmed) {
    return;
  }

  const current = getSecuritySettingsWithDefaults();
  const nextAccessControl = cloneAccessControlForSave(current.accessControl);
  const key = nextAccessControl.keys.find((item) => item.id === keyId);
  if (!key) {
    setBanner("未找到目标访问 Key。", "error");
    return;
  }
  const consumer = nextAccessControl.consumers.find(
    (item) => item.id === key.consumerId,
  );
  const apiKey = generateApiKey(consumer?.clientTag || consumer?.name || "member");
  key.apiKey = apiKey;
  key.keyPrefix = apiKey.slice(0, 8);
  key.keySuffix = apiKey.slice(-4);
  key.status = "enabled";
  key.rotatedAt = new Date().toISOString();

  await saveAccessControlSettings(nextAccessControl);
  showRotatedAccessKey(apiKey);
  setBanner("访问 Key 已轮换。请立即复制一次性 API Key。", "success");
}

function removeSecurityClientMappingDraft(index: number): void {
  if (!state.securitySettings) {
    return;
  }
  syncSecurityMappingDraftsFromDom();
  state.securitySettings.clientMappings = state.securitySettings.clientMappings.filter(
    (_item, itemIndex) => itemIndex !== index,
  );
  state.securitySettings.mappingCount = state.securitySettings.clientMappings.length;
  state.securitySettings.enabledMappingCount = state.securitySettings.clientMappings
    .filter((item) => item.enabled).length;
  renderSecurityClientMappings(state.securitySettings.clientMappings);
  syncSecretFieldActionState();
}

function bindActions(): void {
  document.getElementById("refresh")?.addEventListener("click", async () => {
    const button = document.getElementById(
      "refresh",
    ) as HTMLButtonElement | null;
    try {
      setButtonLoading(button, true, "刷新中");
      setBanner("正在刷新状态与 Codex 实时额度...", "info");
      const summary = await refreshWithLiveUsage();
      const banner = summarizeRefreshBanner(summary, {
        successMessage: "状态已刷新，{count} 个账号额度已更新。",
        emptyMessage: "状态已刷新。当前没有可刷新的桌面端账号。",
        unsupportedMessage: "状态已刷新。当前桌面主进程尚未启用实时额度刷新。",
        failedOnlyMessage: "状态已刷新，但当前没有账号成功同步到最新额度。",
      });
      setBanner(banner.message, banner.tone);
    } catch (error) {
      setBanner(`刷新失败：${String(error)}`, "error");
    } finally {
      setButtonLoading(button, false);
    }
  });

  document.getElementById("restart")?.addEventListener("click", async () => {
    try {
      setBanner("正在重启本地服务...", "info");
      await getGatewayApi().restartGateway();
      await refresh();
      setBanner("服务已重启。", "success");
    } catch (error) {
      setBanner(`重启失败：${String(error)}`, "error");
    }
  });

  document
    .getElementById("copy-snippet")
    ?.addEventListener("click", async () => {
      try {
        await copySnippetWithFeedback();
      } catch (error) {
        setBanner(`复制失败：${String(error)}`, "error");
      }
    });

  document
    .getElementById("copy-snippet-toolbar")
    ?.addEventListener("click", async () => {
      try {
        await copySnippetWithFeedback();
      } catch (error) {
        setBanner(`复制失败：${String(error)}`, "error");
      }
    });

  document
    .getElementById("access-create-member-button")
    ?.addEventListener("click", () => {
      openAccessMemberModal();
    });

  document
    .getElementById("close-access-member-modal")
    ?.addEventListener("click", () => {
      closeAccessMemberModal();
    });

  document
    .getElementById("create-access-member-submit")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "create-access-member-submit",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "创建中");
        await createAccessMember();
      } catch (error) {
        setBanner(`创建访问成员失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("copy-access-member-key")
    ?.addEventListener("click", async () => {
      const value =
        (
          document.getElementById(
            "access-member-one-time-key",
          ) as HTMLInputElement | null
        )?.value.trim() ?? "";
      if (!value) {
        setBanner("当前没有可复制的一次性 API Key。", "info");
        return;
      }
      try {
        await copyTextWithFallback(value);
        setBanner("一次性 API Key 已复制。", "success");
      } catch (error) {
        setBanner(`复制一次性 API Key 失败：${String(error)}`, "error");
      }
    });

  document.getElementById("open-logs")?.addEventListener("click", async () => {
    try {
      await getGatewayApi().openLogs();
      setBanner("已尝试打开日志目录。", "success");
    } catch (error) {
      setBanner(`打开日志目录失败：${String(error)}`, "error");
    }
  });

  document
    .getElementById("save-provider-settings")
    ?.addEventListener("click", async () => {
      try {
        await saveSettingsAndRestart();
      } catch (error) {
        setBanner(`保存配置失败：${String(error)}`, "error");
      }
    });

  document
    .getElementById("save-routing-settings")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "save-routing-settings",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "保存中");
        setBanner("正在保存路由策略配置...", "info");
        await saveRoutingSettings();
        setBanner("路由策略配置已保存。启用后将参与实时推理路由。", "success");
      } catch (error) {
        setBanner(`保存路由策略失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("save-pool-settings")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "save-pool-settings",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "保存中");
        setBanner("正在保存号池调度配置...", "info");
        await savePoolSettings();
        setBanner(
          "号池调度配置已保存。命中号池的请求将按调度策略自动挑选账号。",
          "success",
        );
      } catch (error) {
        setBanner(`保存号池配置失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("add-security-client-mapping")
    ?.addEventListener("click", () => {
      appendSecurityClientMappingDraft();
    });

  document
    .getElementById("gateway-auth-client-mappings")
    ?.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const trigger = target.closest<HTMLElement>("[data-remove-security-mapping]");
      if (!trigger) {
        return;
      }
      const index = Number(trigger.dataset.removeSecurityMapping ?? "-1");
      if (index < 0) {
        return;
      }
      const confirmed = await requestConfirmation({
        title: "确认删除客户端映射",
        message:
          "删除后该客户端映射会立即从当前编辑态中移除；保存鉴权配置后才会正式生效。是否继续？",
        confirmLabel: "删除映射",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      removeSecurityClientMappingDraft(index);
    });

  document
    .getElementById("generate-gateway-auth-api-key")
    ?.addEventListener("click", () => {
      const keyNode = document.getElementById(
        "gateway-auth-api-key",
      ) as HTMLInputElement | null;
      if (!keyNode) {
        return;
      }
      keyNode.value = generateApiKey("default");
      syncSecretFieldActionState();
      setBanner("已生成新的 Gateway API Key。请记得保存并同步到客户端。", "success");
    });

  document
    .getElementById("gateway-auth-client-mappings")
    ?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const trigger = target.closest<HTMLElement>(
        "[data-generate-security-mapping-api-key]",
      );
      if (!trigger) {
        return;
      }
      const index = Number(
        trigger.dataset.generateSecurityMappingApiKey ?? "-1",
      );
      if (index < 0) {
        return;
      }
      const nameNode = document.querySelector(
        `[data-security-mapping-name="${index}"]`,
      ) as HTMLInputElement | null;
      const apiKeyNode = document.querySelector(
        `[data-security-mapping-api-key="${index}"]`,
      ) as HTMLInputElement | null;
      if (!apiKeyNode) {
        return;
      }
      const prefix = nameNode?.value?.trim() || `client-${index + 1}`;
      apiKeyNode.value = generateApiKey(prefix);
      syncSecretFieldActionState();
      setBanner(
        `已为映射 #${index + 1} 生成专属密钥。请记得保存并同步到对应客户端。`,
        "success",
      );
    });

  document.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const memberSelectTrigger = target.closest<HTMLElement>(
      "[data-access-member-select]",
    );
    if (memberSelectTrigger) {
      state.selectedAccessConsumerId =
        memberSelectTrigger.dataset.accessMemberSelect;
      renderAccessConsumerList(
        state.securitySettings?.clientMappings ?? [],
        state.securitySettings?.accessControl,
      );
      renderAccessMemberDrawer(state.securitySettings?.accessControl);
      return;
    }

    const keyToggleTrigger = target.closest<HTMLButtonElement>(
      "[data-access-key-toggle]",
    );
    if (keyToggleTrigger?.dataset.accessKeyToggle) {
      try {
        setButtonLoading(keyToggleTrigger, true, "保存中");
        await toggleAccessKeyStatus(keyToggleTrigger.dataset.accessKeyToggle);
      } catch (error) {
        setBanner(`更新访问 Key 状态失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(keyToggleTrigger, false);
      }
      return;
    }

    const keyExpiryTrigger = target.closest<HTMLButtonElement>(
      "[data-access-key-save-expiry]",
    );
    if (keyExpiryTrigger?.dataset.accessKeySaveExpiry) {
      try {
        setButtonLoading(keyExpiryTrigger, true, "保存中");
        await saveAccessKeyExpiry(keyExpiryTrigger.dataset.accessKeySaveExpiry);
      } catch (error) {
        setBanner(`保存访问 Key 到期时间失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(keyExpiryTrigger, false);
      }
      return;
    }

    const poolPolicyTrigger = target.closest<HTMLButtonElement>(
      "[data-access-policy-save-pools]",
    );
    if (poolPolicyTrigger?.dataset.accessPolicySavePools) {
      try {
        setButtonLoading(poolPolicyTrigger, true, "保存中");
        await saveAccessPolicyPools(
          poolPolicyTrigger.dataset.accessPolicySavePools,
        );
      } catch (error) {
        setBanner(`保存访问成员号池授权失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(poolPolicyTrigger, false);
      }
      return;
    }

    const keyRotateTrigger = target.closest<HTMLButtonElement>(
      "[data-access-key-rotate]",
    );
    if (keyRotateTrigger?.dataset.accessKeyRotate) {
      try {
        setButtonLoading(keyRotateTrigger, true, "轮换中");
        await rotateAccessKey(keyRotateTrigger.dataset.accessKeyRotate);
      } catch (error) {
        setBanner(`轮换访问 Key 失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(keyRotateTrigger, false);
      }
      return;
    }

    const rotatedCopyTrigger = target.closest<HTMLButtonElement>(
      "#copy-access-rotated-key",
    );
    if (rotatedCopyTrigger) {
      const value =
        (
          document.getElementById(
            "access-rotated-one-time-key",
          ) as HTMLInputElement | null
        )?.value.trim() ?? "";
      if (!value) {
        setBanner("当前没有可复制的轮换 API Key。", "info");
        return;
      }
      try {
        await copyTextWithFallback(value);
        setBanner("轮换 API Key 已复制。", "success");
      } catch (error) {
        setBanner(`复制轮换 API Key 失败：${String(error)}`, "error");
      }
      return;
    }

    const toggleTrigger = target.closest<HTMLElement>(
      "[data-secret-visibility-toggle]",
    );
    if (toggleTrigger) {
      const selector = toggleTrigger.dataset.secretVisibilityToggle;
      const input = selector
        ? (document.querySelector(selector) as HTMLInputElement | null)
        : null;
      if (input) {
        input.type = input.type === "password" ? "text" : "password";
        syncSecretFieldActionState();
      }
      return;
    }

    const copyTrigger = target.closest<HTMLElement>("[data-secret-copy-target]");
    if (copyTrigger) {
      const selector = copyTrigger.dataset.secretCopyTarget;
      const input = selector
        ? (document.querySelector(selector) as HTMLInputElement | null)
        : null;
      const value = input?.value.trim() ?? "";
      if (!value) {
        setBanner("当前密钥输入框为空，暂无可复制内容。", "info");
        return;
      }
      try {
        await copyTextWithFallback(value);
        setBanner("密钥已复制。", "success");
      } catch (error) {
        setBanner(`复制密钥失败：${String(error)}`, "error");
      }
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    if (
      target.matches("[data-secret-input]") ||
      target.matches("[data-security-mapping-name]")
    ) {
      syncSecretFieldActionState();
    }
  });

  document.getElementById("add-pool")?.addEventListener("click", () => {
    const settings = state.poolSettings ?? {};
    const pools = settings.pools ?? [];
    state.poolSettings = {
      ...settings,
      enabled: settings.enabled ?? true,
      pools: [
        ...pools,
        {
          id: createPoolId(),
          name: `号池-${pools.length + 1}`,
          enabled: true,
          visibility: "private",
          selectionStrategy: "hybrid",
          minRemainingPercentage: 15,
          cooldownSeconds: 300,
          quotaExhaustedCooldownSeconds: 7200,
          maxRetryCandidates: 2,
          allowUnknownQuota: true,
          fallbackToActiveSession: true,
          members: [],
        },
      ],
    };
    applyPoolSettingsToForm();
  });

  document.getElementById("add-routing-rule")?.addEventListener("click", () => {
    const settings = state.routingSettings ?? {};
    const rules = settings.rules ?? [];
    state.routingSettings = {
      ...settings,
      rules: [
        ...rules,
        {
          id: createRoutingRuleId(),
          name: `规则-${rules.length + 1}`,
          enabled: true,
          priority: 100 + rules.length,
          when: {},
          target: {},
        },
      ],
    };
    applyRoutingSettingsToForm();
  });

  document
    .getElementById("preview-routing-settings")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "preview-routing-settings",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "预演中");
        await previewRoutingSettings();
        setBanner("路由预演完成。", "success");
      } catch (error) {
        setBanner(`路由预演失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("save-system-settings")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "save-system-settings",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "保存中");
        setBanner("正在保存系统配置...", "info");
        await saveSystemSettings();
        setBanner("系统配置已保存。", "success");
      } catch (error) {
        setBanner(`保存系统配置失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("export-app-data")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "export-app-data",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "导出中");
        setBanner("正在导出应用数据备份...", "info");
        await exportAppData();
      } catch (error) {
        setBanner(`导出应用数据失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("import-app-data")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "import-app-data",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "导入中");
        setBanner("正在导入应用数据备份...", "info");
        await importAppData();
      } catch (error) {
        setBanner(`导入应用数据失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("open-backups-folder")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "open-backups-folder",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "打开中");
        await getGatewayApi().openBackupsFolder();
      } catch (error) {
        setBanner(`打开备份目录失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("save-security-settings")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "save-security-settings",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "保存中");
        setBanner("正在保存客户端接入鉴权配置...", "info");
        await saveSecuritySettings();
        setBanner("客户端接入鉴权配置已保存。", "success");
      } catch (error) {
        setBanner(`保存鉴权配置失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("open-account-modal")
    ?.addEventListener("click", () => {
      openAccountModal("oauth");
    });

  document
    .getElementById("import-account-config")
    ?.addEventListener("click", async () => {
      try {
        await importAccountConfig();
      } catch (error) {
        setBanner(`账号配置导入失败：${String(error)}`, "error");
      }
    });

  document
    .getElementById("refresh-accounts")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "refresh-accounts",
      ) as HTMLButtonElement | null;
      try {
        setButtonLoading(button, true, "刷新中");
        setBanner("正在刷新全部账号的额度与状态...", "info");
        const summary = await refreshWithLiveUsage();
        const banner = summarizeRefreshBanner(summary, {
          successMessage: "账号状态已刷新，{count} 个账号已更新。",
          emptyMessage: "账号状态已刷新。当前没有可刷新的桌面端账号。",
          unsupportedMessage: "账号状态已刷新。",
          failedOnlyMessage:
            "账号状态已刷新，但当前没有账号成功同步到最新额度。",
        });
        setBanner(banner.message, banner.tone);
      } catch (error) {
        setBanner(`账号刷新失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button, false);
      }
    });

  document
    .getElementById("account-search")
    ?.addEventListener("input", (event) => {
      state.accountSearch = (event.target as HTMLInputElement).value;
      renderCodexAccounts();
    });

  document.addEventListener("input", (event) => {
    const target = event.target as HTMLElement | null;
    if (
      target instanceof HTMLInputElement &&
      target.matches('[data-pool-ui="search"]')
    ) {
      const row = target.closest<HTMLElement>("[data-pool-row]");
      if (!row) {
        return;
      }
      setPoolPanelState(row.dataset.poolId || createPoolId(), {
        search: target.value,
      });
      schedulePoolMembersFieldRender(row, { preserveSearchFocus: true });
      return;
    }

    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      const row = target.closest<HTMLElement>("[data-pool-row]");
      if (row && target.dataset.poolUi !== "search") {
        syncPoolDraftFromRow(row);
      }
    }
  });

  document
    .getElementById("account-sort-key")
    ?.addEventListener("change", (event) => {
      state.accountSortKey = (event.target as HTMLSelectElement)
        .value as AccountSortKey;
      renderCodexAccounts();
    });

  document
    .getElementById("account-sort-direction")
    ?.addEventListener("click", () => {
      state.accountSortDirection =
        state.accountSortDirection === "asc" ? "desc" : "asc";
      renderCodexAccounts();
    });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    if (
      target instanceof HTMLSelectElement &&
      target.id === "usage-client-filter"
    ) {
      const value = target.value;
      state.usageClientFilter =
        value === "openclaw" ||
        value === "hermes" ||
        value === "other"
          ? value
          : "all";
      void refreshUsageSummaryOnly().catch((error) => {
        setBanner(`刷新 Token 用量统计失败：${normalizeErrorMessage(error)}`, "error");
      });
      return;
    }

    if (
      target instanceof HTMLSelectElement &&
      target.id === "routing-preview-access-consumer"
    ) {
      const consumer = state.securitySettings?.accessControl?.consumers.find(
        (item) => item.id === target.value,
      );
      const clientTagInput = document.getElementById(
        "routing-preview-client-tag",
      ) as HTMLInputElement | null;
      if (consumer && clientTagInput && !clientTagInput.value.trim()) {
        clientTagInput.value = consumer.clientTag;
      }
      return;
    }

    if (
      target instanceof HTMLSelectElement &&
      target.matches('[data-field="dispatch-mode"]')
    ) {
      const row = target.closest<HTMLElement>("[data-routing-rule-row]");
      if (row) {
        syncRoutingRuleDispatchModeUI(row);
      }
    }

    if (
      target instanceof HTMLSelectElement &&
      target.matches('[data-pool-ui="sort-key"]')
    ) {
      const row = target.closest<HTMLElement>("[data-pool-row]");
      if (row) {
        setPoolPanelState(row.dataset.poolId || createPoolId(), {
          sortKey: target.value as PoolMemberSortKey,
        });
        schedulePoolMembersFieldRender(row);
      }
    }

    if (
      target instanceof HTMLInputElement &&
      target.matches('[data-field="account-bulk-select-all"]')
    ) {
      selectedAccountKeys.clear();
      if (target.checked) {
        for (const account of getVisibleLocalImportAccountGroups()) {
          selectedAccountKeys.add(account.key);
        }
      }
      renderCodexAccounts();
      return;
    }

    if (
      target instanceof HTMLInputElement &&
      target.matches('[data-field="account-card-selector"]')
    ) {
      const accountKey = target.dataset.accountKey;
      if (accountKey) {
        if (target.checked) {
          selectedAccountKeys.add(accountKey);
        } else {
          selectedAccountKeys.delete(accountKey);
        }
      }
      renderCodexAccounts();
      return;
    }

    if (
      target instanceof HTMLInputElement &&
      target.matches('[data-field="pool-bulk-select-all"]')
    ) {
      selectedPoolIds.clear();
      if (target.checked) {
        for (const pool of state.poolSettings?.pools ?? []) {
          selectedPoolIds.add(pool.id);
        }
      }
      renderPoolCards();
      return;
    }

    if (
      target instanceof HTMLInputElement &&
      target.matches('[data-field="pool-card-selector"]')
    ) {
      const poolId = target.dataset.poolId;
      if (poolId) {
        if (target.checked) {
          selectedPoolIds.add(poolId);
        } else {
          selectedPoolIds.delete(poolId);
        }
      }
      renderPoolCards();
      return;
    }

    if (
      target instanceof HTMLInputElement &&
      target.matches('[data-field="pool-member-selector"]')
    ) {
      const option = target.closest<HTMLElement>(".pool-member-option");
      if (option) {
        option.dataset.selected = target.checked ? "true" : "false";
      }
      const row = target.closest<HTMLElement>("[data-pool-row]");
      if (row) {
        syncPoolDraftFromRow(row);
        schedulePoolMembersFieldRender(row);
      }
    }

    if (
      target instanceof HTMLInputElement &&
      target.closest<HTMLElement>("[data-pool-row]")
    ) {
      const row = target.closest<HTMLElement>("[data-pool-row]");
      if (row && target.dataset.poolUi !== "search") {
        syncPoolDraftFromRow(row);
      }
    }
  });

  document
    .getElementById("routing-observe-client-filter")
    ?.addEventListener("change", (event) => {
      state.routingClientFilter =
        (event.target as HTMLSelectElement).value.trim() || "all";
      renderRoutingObservability();
      renderTopSummary();
    });

  document
    .getElementById("routing-observe-window")
    ?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      state.routingObserveWindow =
        value === "1h" || value === "24h" ? value : "5m";
      renderRoutingObservability();
      renderTopSummary();
    });

  document
    .getElementById("close-account-modal")
    ?.addEventListener("click", () => {
      closeAccountModal();
    });

  document
    .getElementById("import-local-accounts")
    ?.addEventListener("click", async () => {
      try {
        await refresh();
        closeAccountModal();
        setBanner("已重新扫描本地可复用授权。", "success");
      } catch (error) {
        setBanner(`重新扫描失败：${String(error)}`, "error");
      }
    });

  document
    .getElementById("start-codex-oauth")
    ?.addEventListener("click", async () => {
      await startCodexOAuthFlow();
    });

  document
    .getElementById("submit-codex-oauth-input")
    ?.addEventListener("click", async () => {
      try {
        await submitCodexOAuthInput();
      } catch (error) {
        setOAuthStatus(`提交失败：${String(error)}`, "error");
      }
    });

  document
    .getElementById("cancel-codex-oauth")
    ?.addEventListener("click", async () => {
      await cancelCodexOAuthFlow();
    });

  document
    .getElementById("import-codex-json")
    ?.addEventListener("click", async () => {
      try {
        await importCodexJson();
      } catch (error) {
        setBanner(`JSON 导入失败：${String(error)}`, "error");
      }
    });

  for (const node of Array.from(
    document.querySelectorAll<HTMLElement>("[data-account-tab]"),
  )) {
    node.addEventListener("click", () => {
      setAccountTab(node.dataset.accountTab ?? "import");
    });
  }

  document
    .getElementById("account-modal")
    ?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closeAccountModal();
      }
    });

  document
    .getElementById("pool-events-modal")
    ?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closePoolEventsModal();
      }
    });

  document
    .getElementById("usage-details-modal")
    ?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closeUsageDetailsModal();
      }
    });

  document
    .getElementById("close-pool-events-modal")
    ?.addEventListener("click", () => {
      closePoolEventsModal();
    });

  document
    .getElementById("close-usage-details-modal")
    ?.addEventListener("click", () => {
      closeUsageDetailsModal();
    });

  document
    .getElementById("confirm-modal")
    ?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closeConfirmModal(false);
      }
    });

  document
    .getElementById("confirm-modal-cancel")
    ?.addEventListener("click", () => {
      closeConfirmModal(false);
    });

  document
    .getElementById("confirm-modal-cancel-top")
    ?.addEventListener("click", () => {
      closeConfirmModal(false);
    });

  document
    .getElementById("confirm-modal-confirm")
    ?.addEventListener("click", () => {
      closeConfirmModal(true);
    });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const confirmModal = document.getElementById("confirm-modal");
      if (confirmModal && !confirmModal.hidden) {
        closeConfirmModal(false);
        return;
      }
      const poolEventsModal = document.getElementById("pool-events-modal");
      if (poolEventsModal && !poolEventsModal.hidden) {
        closePoolEventsModal();
        return;
      }
      const usageDetailsModal = document.getElementById("usage-details-modal");
      if (usageDetailsModal && !usageDetailsModal.hidden) {
        closeUsageDetailsModal();
        return;
      }
      closeAccountModal();
    }
  });

  window.addEventListener("beforeunload", () => {
    clearAutoRefreshTimer();
    clearSessionActivityTimer();
    clearViewStackScrollIdleTimer();
    cancelVisibleRefreshFrame();
    cancelAccountRenderFrame();
    for (const poolId of poolMemberFieldFrames.keys()) {
      cancelPoolMemberFieldFrame(poolId);
    }
  });

  document.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-account-select-control]")) {
      return;
    }
    if (target?.closest("[data-pool-select-control]")) {
      return;
    }
    const button = target?.closest<HTMLElement>("[data-action]");
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    if (action === "usage-window" && button.dataset.usageWindow) {
      const nextWindow = button.dataset.usageWindow;
      const normalizedWindow: UsageObserveWindow =
        nextWindow === "history" ||
        nextWindow === "weekly" ||
        nextWindow === "monthly"
          ? nextWindow
          : "daily";
      if (state.usageObserveWindow === normalizedWindow) {
        return;
      }
      state.usageObserveWindow = normalizedWindow;
      renderUsagePanelsForWindowChange();
      return;
    }

    if (action === "open-usage-details") {
      openUsageDetailsModal();
      return;
    }

    if (action === "reset-telemetry") {
      await resetTelemetryWithFeedback(button as HTMLButtonElement);
      return;
    }

    if (action === "ack-access-alert" && button.dataset.alertId) {
      const alertId = Number.parseInt(button.dataset.alertId, 10);
      if (!Number.isFinite(alertId) || alertId <= 0) {
        setBanner("告警事件 ID 无效，无法确认。", "error");
        return;
      }
      try {
        setButtonLoading(button as HTMLButtonElement, true, "确认中");
        await getGatewayApi().acknowledgeAccessAlert(alertId);
        await refreshUsageSummaryOnly();
        setBanner("告警事件已确认。", "success");
      } catch (error) {
        setBanner(`确认告警失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button as HTMLButtonElement, false);
      }
      return;
    }

    if (action === "ack-all-access-alerts") {
      try {
        setButtonLoading(button as HTMLButtonElement, true, "确认中");
        const result = await getGatewayApi().acknowledgeAllAccessAlerts();
        await refreshUsageSummaryOnly();
        setBanner(
          result.data.updatedCount > 0
            ? `已确认 ${formatCompactCount(result.data.updatedCount)} 条告警事件。`
            : "当前没有未确认告警事件。",
          "success",
        );
      } catch (error) {
        setBanner(`批量确认告警失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button as HTMLButtonElement, false);
      }
      return;
    }

    if (action === "clear-acknowledged-access-alerts") {
      try {
        setButtonLoading(button as HTMLButtonElement, true, "清理中");
        const result = await getGatewayApi().clearAcknowledgedAccessAlerts();
        await refreshUsageSummaryOnly();
        setBanner(
          result.data.deletedCount > 0
            ? `已清理 ${formatCompactCount(result.data.deletedCount)} 条已确认告警事件。`
            : "当前没有已确认告警事件可清理。",
          "success",
        );
      } catch (error) {
        setBanner(`清理已确认告警失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button as HTMLButtonElement, false);
      }
      return;
    }

    if (action === "toggle-routing-rule") {
      const card = button.closest(".routing-rule-card");
      if (card) {
        card.classList.toggle("collapsed");
      }
      return;
    }

    if (action === "toggle-pool-card" && button.dataset.poolId) {
      const card = button.closest(".routing-rule-card");
      if (card) {
        card.classList.toggle("collapsed");
        setPoolPanelState(button.dataset.poolId, {
          cardCollapsed: card.classList.contains("collapsed"),
        });
      }
      return;
    }

    if (action === "save-routing-settings") {
      try {
        setButtonLoading(button as HTMLButtonElement, true, "保存中");
        setBanner("正在保存路由策略配置...", "info");
        await saveRoutingSettings();
        setBanner("路由策略配置已保存。启用后将参与实时推理路由。", "success");
      } catch (error) {
        setBanner(`保存路由策略失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button as HTMLButtonElement, false);
      }
      return;
    }

    if (action === "save-pool-settings") {
      try {
        setButtonLoading(button as HTMLButtonElement, true, "保存中");
        setBanner("正在保存动态号池配置...", "info");
        await savePoolSettings();
        setBanner("动态号池配置已保存。启用后将自动调度组内额度。", "success");
      } catch (error) {
        setBanner(`保存号池失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button as HTMLButtonElement, false);
      }
      return;
    }

    if (action === "save-pool-card" && button.dataset.poolId) {
      try {
        setButtonLoading(button as HTMLButtonElement, true, "保存中");
        setBanner("正在保存当前号池配置...", "info");
        const savedName = await saveSinglePoolSettings(button.dataset.poolId);
        setBanner(`号池「${savedName}」配置已保存。`, "success");
      } catch (error) {
        setBanner(`保存号池配置失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(button as HTMLButtonElement, false);
      }
      return;
    }

    if (action === "open-pool-events" && button.dataset.poolId) {
      openPoolEventsModal(button.dataset.poolId);
      return;
    }

    if (action === "activate" && button.dataset.sessionId) {
      try {
        setBanner(`正在切换到 ${button.dataset.sessionId} ...`, "info");
        await getGatewayApi().setActiveSession(button.dataset.sessionId);
        await refreshWithLiveUsage(button.dataset.sessionId);
        setBanner("活动账号已切换。", "success");
      } catch (error) {
        setBanner(`切换失败：${String(error)}`, "error");
      }
    }

    if (action === "refresh-session-usage" && button.dataset.sessionId) {
      const refreshButton = button as HTMLButtonElement;
      try {
        setButtonLoading(refreshButton, true, "刷新中");
        setBanner(`正在刷新 ${button.dataset.sessionId} 的额度信息...`, "info");
        const summary = await refreshWithLiveUsage(button.dataset.sessionId);
        const banner = summarizeRefreshBanner(summary, {
          successMessage: "账号状态已刷新。",
          emptyMessage: "账号状态已刷新。当前会话暂无可更新额度。",
          unsupportedMessage: "账号状态已刷新。",
          failedOnlyMessage: "账号状态刷新失败，请稍后重试。",
        });
        setBanner(banner.message, banner.tone);
      } catch (error) {
        setBanner(`账号刷新失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(refreshButton, false);
      }
    }

    if (action === "toggle-pin-session" && button.dataset.sessionId) {
      const pinButton = button as HTMLButtonElement;
      try {
        setButtonLoading(
          pinButton,
          true,
          isPinnedAccountSession(button.dataset.sessionId)
            ? "取消中"
            : "置顶中",
        );
        await togglePinnedSession(button.dataset.sessionId);
      } catch (error) {
        setBanner(`置顶操作失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(pinButton, false);
      }
    }

    if (action === "copy-snippet") {
      try {
        await copySnippetWithFeedback();
      } catch (error) {
        setBanner(`复制失败：${String(error)}`, "error");
      }
    }

    if (action === "copy-template" && button.dataset.templateKey) {
      const templateKey = button.dataset.templateKey as IntegrationTemplateKey;
      try {
        await copyTemplateWithFeedback(templateKey);
      } catch (error) {
        setBanner(`模板复制失败：${String(error)}`, "error");
      }
    }

    if (action === "copy-lan-access-template") {
      try {
        await copyTextWithFallback(buildLanAccessTemplateText());
        setBanner("LAN 成员接入模板已复制。", "success");
      } catch (error) {
        setBanner(`复制 LAN 模板失败：${String(error)}`, "error");
      }
    }

    if (action === "account-clear-selection") {
      selectedAccountKeys.clear();
      renderCodexAccounts();
      setBanner("已清空账号批量选择。", "info");
      return;
    }

    if (action === "account-delete-selected") {
      const accounts = getVisibleLocalImportAccountGroups();
      const targets = collectAccountDeletionTargets(accounts, selectedAccountKeys);
      const selectedAccounts = accounts.filter((account) =>
        selectedAccountKeys.has(account.key),
      );
      if (targets.length === 0) {
        selectedAccountKeys.clear();
        renderCodexAccounts();
        setBanner("当前没有可删除的已选本地账号。", "info");
        return;
      }

      const accountNames = selectedAccounts
        .slice(0, 5)
        .map((account) => getSessionTitle(account.representative))
        .join("、");
      const suffix =
        selectedAccounts.length > 5
          ? ` 等 ${selectedAccounts.length} 个账号`
          : "";
      const confirmed = await requestConfirmation({
        title: "确认批量删除账号",
        message: `即将删除 local-ai-gateway 本地维护的 ${selectedAccounts.length} 个账号：${accountNames}${suffix}。这会从本项目的本地账号配置中移除对应凭据，并同步清理号池中的账号引用；不会删除或改写 Cockpit 原始配置。是否继续？`,
        confirmLabel: "批量删除",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }

      const deleteButton = button as HTMLButtonElement;
      const errors: string[] = [];
      let removedSessionCount = 0;
      let removedPoolMemberCount = 0;
      const affectedPoolIds = new Set<string>();

      try {
        setButtonLoading(deleteButton, true, "删除中");
        setBanner(
          `正在删除 ${selectedAccounts.length} 个本地账号并清理号池引用...`,
          "info",
        );
        for (const target of targets) {
          try {
            const result = await getGatewayApi().deleteCodexAccount(
              target.sessionId,
            );
            if (result.data.removed) {
              removedSessionCount += 1;
            }
            const poolCleanup = result.data.poolCleanup;
            removedPoolMemberCount += poolCleanup?.removedMemberCount ?? 0;
            for (const poolId of poolCleanup?.affectedPoolIds ?? []) {
              affectedPoolIds.add(poolId);
            }
          } catch (error) {
            errors.push(
              `${target.sessionId}: ${normalizeErrorMessage(error)}`,
            );
          }
        }
        selectedAccountKeys.clear();
        await refresh();
        if (errors.length > 0) {
          setBanner(
            `已删除 ${removedSessionCount} 个本地账号会话，但 ${errors.length} 个删除失败：${errors[0]}`,
            "error",
          );
          return;
        }
        setBanner(
          `已删除 ${selectedAccounts.length} 个本地账号，清理 ${removedPoolMemberCount} 个号池成员引用${affectedPoolIds.size ? `，影响 ${affectedPoolIds.size} 个号池` : ""}。`,
          "success",
        );
      } finally {
        setButtonLoading(deleteButton, false);
      }
      return;
    }

    if (action === "delete-codex-account" && button.dataset.sessionId) {
      try {
        const confirmed = await requestConfirmation({
          title: "确认删除账号",
          message:
            "删除后将从 local-ai-gateway 本地账号配置中移除该 Codex 账号，并同步清理号池中的账号引用；不会删除或改写 Cockpit 原始配置。是否继续？",
          confirmLabel: "删除账号",
          tone: "danger",
        });
        if (!confirmed) {
          return;
        }
        setBanner(
          `正在删除桌面端 Codex 账号 ${button.dataset.sessionId} ...`,
          "info",
        );
        const result = await getGatewayApi().deleteCodexAccount(
          button.dataset.sessionId,
        );
        await refresh();
        setBanner(
          result.data.removed
            ? `桌面端 Codex 账号已删除，已清理 ${result.data.poolCleanup?.removedMemberCount ?? 0} 个号池成员引用。`
            : "目标账号不存在，已刷新列表。",
          "success",
        );
      } catch (error) {
        setBanner(`删除失败：${String(error)}`, "error");
      }
    }

    if (action === "routing-remove-rule" && button.dataset.ruleId) {
      const confirmed = await requestConfirmation({
        title: "确认删除路由规则",
        message:
          "删除后该策略规则将立即从当前编辑态中移除；保存路由策略后会正式生效。是否继续？",
        confirmLabel: "删除规则",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      const settings = state.routingSettings ?? {};
      const rules = (settings.rules ?? []).filter(
        (rule) => rule.id !== button.dataset.ruleId,
      );
      state.routingSettings = {
        ...settings,
        rules,
      };
      applyRoutingSettingsToForm();
      resetRoutingPreviewResult();
    }

    if (action === "pool-clear-selection") {
      selectedPoolIds.clear();
      renderPoolCards();
      setBanner("已清空号池批量选择。", "info");
      return;
    }

    if (action === "pool-delete-selected") {
      syncAllPoolDraftsFromRows();
      const settings = state.poolSettings ?? {};
      const result = deleteSelectedPools(settings.pools ?? [], selectedPoolIds);
      if (result.deletedPools.length === 0) {
        selectedPoolIds.clear();
        renderPoolCards();
        setBanner("当前没有可删除的已选号池。", "info");
        return;
      }

      const deletedNames = result.deletedPools
        .slice(0, 5)
        .map((pool) => pool.name || pool.id)
        .join("、");
      const suffix =
        result.deletedPools.length > 5
          ? ` 等 ${result.deletedPools.length} 个号池`
          : "";
      const confirmed = await requestConfirmation({
        title: "确认批量删除号池",
        message: `即将从当前编辑态删除 ${result.deletedPools.length} 个号池：${deletedNames}${suffix}。保存号池配置后会正式生效；若仍有路由规则引用这些号池，请同步检查策略路由配置。是否继续？`,
        confirmLabel: "批量删除",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }

      cleanupDeletedPoolState(result.deletedPools.map((pool) => pool.id));
      state.poolSettings = {
        ...settings,
        pools: result.remainingPools,
      };
      applyPoolSettingsToForm();
      applyRoutingSettingsToForm();
      resetRoutingPreviewResult();
      setBanner(
        `已从当前编辑态删除 ${result.deletedPools.length} 个号池；保存号池配置后正式生效。`,
        "success",
      );
      return;
    }

    if (action === "pool-remove" && button.dataset.poolId) {
      const confirmed = await requestConfirmation({
        title: "确认删除号池",
        message:
          "删除后该号池会立即从当前编辑态中移除；保存号池配置后会正式生效。若仍有路由规则引用该号池，请同步检查策略路由配置。",
        confirmLabel: "删除号池",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      const settings = state.poolSettings ?? {};
      const pools = (settings.pools ?? []).filter(
        (pool) => pool.id !== button.dataset.poolId,
      );
      state.poolSettings = {
        ...settings,
        pools,
      };
      cleanupDeletedPoolState([button.dataset.poolId]);
      applyPoolSettingsToForm();
      applyRoutingSettingsToForm();
      resetRoutingPreviewResult();
      setBanner("已从当前编辑态删除号池；保存号池配置后正式生效。", "success");
    }

    if (action === "pool-toggle-collapse" && button.dataset.poolId) {
      const row = button.closest<HTMLElement>("[data-pool-row]");
      const panelState = getPoolPanelState(button.dataset.poolId);
      setPoolPanelState(button.dataset.poolId, {
        collapsed: !panelState.collapsed,
      });
      if (row) {
        schedulePoolMembersFieldRender(row);
        return;
      }
      renderPoolCards();
    }

    if (action === "pool-toggle-sort" && button.dataset.poolId) {
      const row = button.closest<HTMLElement>("[data-pool-row]");
      const panelState = getPoolPanelState(button.dataset.poolId);
      setPoolPanelState(button.dataset.poolId, {
        sortDirection: panelState.sortDirection === "asc" ? "desc" : "asc",
      });
      if (row) {
        schedulePoolMembersFieldRender(row);
        return;
      }
      renderPoolCards();
    }

    if (
      (action === "pool-select-all" || action === "pool-invert-selection") &&
      button.dataset.poolId
    ) {
      const row = button.closest<HTMLElement>("[data-pool-row]");
      if (!row) {
        return;
      }
      const checkboxes = Array.from(
        row.querySelectorAll<HTMLInputElement>(
          '[data-field="pool-member-selector"]',
        ),
      );
      for (const checkbox of checkboxes) {
        checkbox.checked =
          action === "pool-select-all" ? true : !checkbox.checked;
        const option = checkbox.closest<HTMLElement>(".pool-member-option");
        if (option) {
          option.dataset.selected = checkbox.checked ? "true" : "false";
        }
      }
      syncPoolDraftFromRow(row);
      schedulePoolMembersFieldRender(row);
      return;
      renderPoolCards();
    }
  });
}

async function refresh(): Promise<void> {
  const api = getGatewayApi();
  const [
    healthResult,
    providersResult,
    usageSummaryResult,
    accessAlertsResult,
    sessionsResult,
    settingsResult,
    routingSettingsResult,
    poolSettingsResult,
    securitySettingsResult,
    systemSettingsResult,
    appDataStatusResult,
  ] = await Promise.allSettled([
    api.getHealth(),
    api.getProviders(),
    api.getUsageSummary(state.usageClientFilter),
    api.getAccessAlerts(),
    api.getSessions(),
    api.getProviderSettings(),
    api.getRoutingSettings(),
    api.getPoolSettings(),
    api.getSecuritySettings(),
    api.getSystemSettings(),
    api.getAppDataStatus(),
  ]);
  const loadFailures: RuntimeDiagnosticLoadFailure[] = [];

  if (systemSettingsResult.status === "fulfilled") {
    state.systemSettings = systemSettingsResult.value.data;
  } else {
    loadFailures.push({
      scope: "system-settings",
      message: normalizeErrorMessage(systemSettingsResult.reason),
    });
    state.systemSettings = {
      launchAtLogin: false,
      autoRefreshIntervalSeconds: 120,
      gatewayPort: 8787,
    };
  }

  if (healthResult.status === "fulfilled") {
    state.health = healthResult.value;
  } else {
    loadFailures.push({
      scope: "health",
      message: normalizeErrorMessage(healthResult.reason),
    });
    state.health = buildHealthFallback();
  }

  if (usageSummaryResult.status === "fulfilled") {
    state.usageSummary = usageSummaryResult.value.data;
  } else {
    loadFailures.push({
      scope: "usage-summary",
      message: normalizeErrorMessage(usageSummaryResult.reason),
    });
    state.usageSummary = state.health?.usageObservability;
  }

  if (accessAlertsResult.status === "fulfilled") {
    state.accessAlerts = accessAlertsResult.value.data.events;
  } else {
    loadFailures.push({
      scope: "access-alerts",
      message: normalizeErrorMessage(accessAlertsResult.reason),
    });
    state.accessAlerts = [];
  }

  if (providersResult.status === "fulfilled") {
    state.providers = providersResult.value;
  } else {
    loadFailures.push({
      scope: "providers",
      message: normalizeErrorMessage(providersResult.reason),
    });
    state.providers = buildEmptyProviders();
  }

  if (sessionsResult.status === "fulfilled") {
    state.sessions = sessionsResult.value;
  } else {
    loadFailures.push({
      scope: "sessions",
      message: normalizeErrorMessage(sessionsResult.reason),
    });
    state.sessions = buildEmptySessions();
  }

  if (settingsResult.status === "fulfilled") {
    state.settings = settingsResult.value.data;
  } else {
    loadFailures.push({
      scope: "provider-settings",
      message: normalizeErrorMessage(settingsResult.reason),
    });
    state.settings = {};
  }

  if (routingSettingsResult.status === "fulfilled") {
    state.routingSettings = routingSettingsResult.value.data;
  } else {
    loadFailures.push({
      scope: "routing-settings",
      message: normalizeErrorMessage(routingSettingsResult.reason),
    });
    state.routingSettings = {
      enabled: false,
      rules: [],
    };
  }

  if (poolSettingsResult.status === "fulfilled") {
    state.poolSettings = poolSettingsResult.value.data;
  } else {
    loadFailures.push({
      scope: "pool-settings",
      message: normalizeErrorMessage(poolSettingsResult.reason),
    });
    state.poolSettings = {
      enabled: false,
      pools: [],
    };
  }

  if (securitySettingsResult.status === "fulfilled") {
    state.securitySettings = securitySettingsResult.value.data;
  } else {
    loadFailures.push({
      scope: "security-settings",
      message: normalizeErrorMessage(securitySettingsResult.reason),
    });
    state.securitySettings = {
      mode: "none",
      enabled: false,
      hasApiKey: false,
      resolveClientTagByApiKey: false,
      mappingCount: 0,
      enabledMappingCount: 0,
      clientMappings: [],
      lanAccess: {
        enabled: false,
      },
      accessControl: {
        consumers: [],
        keys: [],
        policies: [],
      },
    };
  }

  if (appDataStatusResult.status === "fulfilled") {
    state.appDataStatus = appDataStatusResult.value.data;
  } else {
    loadFailures.push({
      scope: "app-data-status",
      message: normalizeErrorMessage(appDataStatusResult.reason),
    });
    state.appDataStatus = undefined;
  }

  updateRuntimeDiagnostics(loadFailures);

  renderActiveViewContent();
  applyActiveViewFormState();
  renderPoolEventsModal();
  renderUsageDetailsModal();
  configureAutoRefreshTimer();
  configureSessionActivityTimer();
  setOAuthBusyState(Boolean(state.oauthInFlight));
}

async function refreshHealthAndSessionsOnly(): Promise<void> {
  const api = getGatewayApi();
  const shouldFetchUsage =
    state.activeView === "overview" ||
    state.activeView === "accounts" ||
    state.activeView === "usage" ||
    Boolean(state.usageDetailsModalOpen);
  const shouldFetchSessions =
    state.activeView === "overview" ||
    state.activeView === "accounts" ||
    state.activeView === "pools";

  const [
    healthResult,
    usageSummaryResult,
    accessAlertsResult,
    sessionsResult,
  ] = await Promise.allSettled([
    api.getHealth(),
    shouldFetchUsage
      ? api.getUsageSummary(state.usageClientFilter)
      : Promise.resolve(
          state.usageSummary ? { data: state.usageSummary } : undefined,
        ),
    shouldFetchUsage
      ? api.getAccessAlerts()
      : Promise.resolve(
          state.accessAlerts ? { data: { events: state.accessAlerts } } : undefined,
        ),
    shouldFetchSessions
      ? api.getSessions()
      : Promise.resolve(state.sessions),
  ]);

  if (
    healthResult.status !== "fulfilled" &&
    usageSummaryResult.status !== "fulfilled" &&
    accessAlertsResult.status !== "fulfilled" &&
    sessionsResult.status !== "fulfilled"
  ) {
    throw (
      healthResult.reason ??
      usageSummaryResult.reason ??
      accessAlertsResult.reason ??
      sessionsResult.reason ??
      new Error("无法刷新桌面端运行态数据。")
    );
  }

  if (healthResult.status === "fulfilled") {
    state.health = healthResult.value;
  }
  if (
    usageSummaryResult.status === "fulfilled" &&
    usageSummaryResult.value &&
    "data" in usageSummaryResult.value
  ) {
    state.usageSummary = usageSummaryResult.value.data;
  } else if (healthResult.status === "fulfilled") {
    state.usageSummary = healthResult.value.usageObservability;
  }
  if (
    accessAlertsResult.status === "fulfilled" &&
    accessAlertsResult.value &&
    "data" in accessAlertsResult.value
  ) {
    state.accessAlerts = accessAlertsResult.value.data.events;
  }
  if (sessionsResult.status === "fulfilled" && sessionsResult.value) {
    state.sessions = sessionsResult.value;
  }
  updateRuntimeDiagnostics([]);
  scheduleVisibleRefresh();
  renderPoolEventsModal();
  renderUsageDetailsModal();
}

async function refreshUsageSummaryOnly(): Promise<void> {
  const api = getGatewayApi();
  const [response, alerts] = await Promise.all([
    api.getUsageSummary(state.usageClientFilter),
    api.getAccessAlerts(),
  ]);
  state.usageSummary = response.data;
  state.accessAlerts = alerts.data.events;
  scheduleVisibleRefresh();
}

async function refreshWithLiveUsage(
  sessionId?: string,
): Promise<SessionUsageRefreshResponse | undefined> {
  const api = getGatewayApi();
  if (typeof api.refreshSessionUsage !== "function") {
    state.lastUsageRefresh = undefined;
    await refresh();
    return undefined;
  }

  let summary: SessionUsageRefreshResponse | undefined;
  try {
    summary = await api.refreshSessionUsage(sessionId);
  } catch (error) {
    if (!isMissingRefreshUsageHandler(error)) {
      throw error;
    }
  }

  state.lastUsageRefresh = summary;
  await refreshHealthAndSessionsOnly();
  return summary;
}

async function triggerBackgroundLiveUsageRefresh(
  source: "init" | "auto",
): Promise<SessionUsageRefreshResponse | undefined> {
  if (state.backgroundRefreshInFlight) {
    return undefined;
  }

  state.backgroundRefreshInFlight = true;
  try {
    const summary = await refreshWithLiveUsage();
    if (source === "init") {
      const banner = summarizeRefreshBanner(summary, {
        successMessage: "控制台已就绪。实时额度已完成后台同步。",
        emptyMessage: "控制台已就绪。当前没有可刷新的桌面端账号。",
        unsupportedMessage:
          "控制台已就绪。当前桌面主进程尚未启用实时额度刷新。",
        failedOnlyMessage: "控制台已就绪，但后台额度暂未同步成功。",
      });
      setBanner(banner.message, banner.tone);
    } else if (summary) {
      if (summary.refreshed > 0) {
        setBanner("自动刷新完成。", "success");
      } else if (summary.failed > 0) {
        setBanner(
          "自动刷新已结束，但当前没有账号成功同步到最新额度。",
          "error",
        );
      }
    }
    return summary;
  } catch (error) {
    if (source === "init") {
      setBanner(`控制台已就绪，但后台额度同步失败：${String(error)}`, "error");
    } else {
      setBanner(`自动刷新失败：${String(error)}`, "error");
    }
    return undefined;
  } finally {
    state.backgroundRefreshInFlight = false;
  }
}

async function resetTelemetryWithFeedback(
  button?: HTMLButtonElement | null,
): Promise<void> {
  try {
    const confirmed = await requestConfirmation({
      title: "确认清空统计",
      message:
        "将清空路由命中、Token 用量与账号调用统计，但不会影响账号、配置和授权。是否继续？",
      confirmLabel: "确认清空",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    const api = getGatewayApi();
    if (typeof api.resetTelemetry !== "function") {
      throw new Error(
        "当前桌面主进程版本暂不支持清空统计，请重启桌面端后重试。",
      );
    }
    setButtonLoading(button ?? null, true, "清理中");
    setBanner("正在清空统计数据...", "info");
    try {
      await api.resetTelemetry();
    } catch (error) {
      const message = String(error);
      if (
        message.includes("gateway:reset-telemetry") &&
        message.includes("No handler registered")
      ) {
        throw new Error(
          "当前桌面主进程仍是旧版本，尚未注册“清空统计”能力。请完全退出桌面端后重新启动。",
        );
      }
      throw error;
    }
    await refresh();
    setBanner("统计数据已清空。", "success");
  } catch (error) {
    setBanner(`清空统计失败：${String(error)}`, "error");
  } finally {
    setButtonLoading(button ?? null, false);
  }
}

async function syncSessionActivitySilently(): Promise<void> {
  if (state.sessionPulseInFlight || state.backgroundRefreshInFlight) {
    return;
  }
  const millisSinceLastScroll = state.lastViewStackScrollAt
    ? Date.now() - state.lastViewStackScrollAt
    : Number.POSITIVE_INFINITY;
  if (state.isViewStackScrolling || millisSinceLastScroll < 1200) {
    return;
  }
  state.sessionPulseInFlight = true;
  try {
    await refreshHealthAndSessionsOnly();
  } catch {
    // 静默轮询不弹错误，避免打扰正常交互
  } finally {
    state.sessionPulseInFlight = false;
  }
}

void (async () => {
  try {
    state.activeView = loadPersistedView();
    bindNavigation();
    setActiveView(state.activeView);
    initCollapsibleSettingsGroups();
    bindActions();
    setOAuthStatus(
      "浏览器授权已准备就绪。点击下方按钮后将自动打开授权页面。",
      "info",
    );
    setOAuthBusyState(false);
    setBanner("正在加载 Local AI Gateway 控制台...", "info");
    await refresh();
    const primaryDiagnostic = getPrimaryRuntimeDiagnostic();
    if (primaryDiagnostic?.severity === "error") {
      setBanner(
        `控制台已加载，但存在异常：${primaryDiagnostic.title}`,
        "error",
      );
    } else if (primaryDiagnostic?.severity === "warning") {
      setBanner(`控制台已加载，请关注：${primaryDiagnostic.title}`, "info");
    } else {
      setBanner("控制台已就绪，正在后台同步实时额度...", "info");
    }
    void triggerBackgroundLiveUsageRefresh("init");
  } catch (error) {
    setBanner(`初始化失败：${String(error)}`, "error");
  }
})();

export {};
