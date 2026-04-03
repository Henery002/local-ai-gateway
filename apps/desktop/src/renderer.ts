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

const ACTIVE_VIEW_STORAGE_KEY = "local-ai-gateway.desktop.active-view";
const COLLAPSED_GROUPS_STORAGE_KEY =
  "local-ai-gateway.desktop.collapsed-groups";
const EXPANDED_GROUPS_STORAGE_KEY = "local-ai-gateway.desktop.expanded-groups";

declare global {
  interface Window {
    localAIGateway?: {
      getHealth: () => Promise<DashboardHealth>;
      getProviders: () => Promise<DashboardProviders>;
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
        data: { removed: boolean; profileId: string; filePath: string };
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

type DashboardHealth = {
  ok: boolean;
  managed: boolean;
  version: string;
  defaultModel?: string;
  openclaw?: { baseUrl?: string; provider?: string; model?: string };
  recentErrors?: Array<{ level: string; message: string; createdAt: string }>;
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
  };
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
  };
};

type PoolDefinition = {
  id: string;
  name: string;
  enabled?: boolean;
  description?: string;
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

type SecuritySettingsInput = {
  mode?: "none" | "api-key";
  apiKey?: string;
};

type SecuritySettings = {
  mode: "none" | "api-key";
  enabled: boolean;
  hasApiKey: boolean;
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
  | "accounts"
  | "providers"
  | "routing"
  | "pools"
  | "diagnostics";
type IntegrationTemplateKey = "openclaw" | "localraghub" | "curl";
type RoutingObserveWindow = "5m" | "1h" | "24h";
const state: {
  health?: DashboardHealth;
  providers?: DashboardProviders;
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
  runtimeDiagnostics: RuntimeDiagnostic[];
  routingClientFilter: string;
  routingObserveWindow: RoutingObserveWindow;
  activePoolEventsModalId?: string;
} = {
  activeView: "overview",
  accountSearch: "",
  accountSortKey: "quota",
  accountSortDirection: "desc",
  runtimeDiagnostics: [],
  routingClientFilter: "all",
  routingObserveWindow: "5m",
};

let autoRefreshTimer: number | undefined;
let sessionActivityTimer: number | undefined;
const poolMemberPanelState = new Map<string, PoolMemberPanelState>();
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
      saved === "accounts" ||
      saved === "providers" ||
      saved === "routing" ||
      saved === "pools" ||
      saved === "diagnostics"
    ) {
      return saved;
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
    document.querySelectorAll<HTMLElement>(".settings-group"),
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
  const providers = state.providers;
  const sessions = state.sessions;
  if (!health || !providers || !sessions) {
    return;
  }

  const groups = getAccountGroups();
  const activeSession = sessions.data.find(
    (session) => session.id === sessions.activeSessionId,
  );
  const primaryDiagnostic = getPrimaryRuntimeDiagnostic();
  const routing = health.routingObservability;

  setText(
    "top-summary-status",
    primaryDiagnostic?.severity === "error"
      ? primaryDiagnostic.title
      : primaryDiagnostic?.severity === "warning"
        ? primaryDiagnostic.title
        : health.ok
          ? "服务运行中"
          : "服务异常",
  );
  setText(
    "top-summary-route",
    health.openclaw?.model ?? health.defaultModel ?? "codex-default",
  );
  setText(
    "top-summary-routing-hit",
    routing
      ? `${routingWindowLabel(state.routingObserveWindow).replace("命中", "")} ${getRoutingWindowCount(routing, state.routingObserveWindow)} 次 / 累计 ${routing.totalMatched} 次`
      : "暂无命中",
  );
  setText(
    "top-summary-session",
    activeSession ? getSessionTitle(activeSession) : "未选择活动会话",
  );
  setText(
    "top-summary-providers",
    `${providers.data.length} 个 Provider / ${groups.total} 个授权对象`,
  );
  setText(
    "top-summary-auth",
    (state.securitySettings?.enabled ?? health.inferenceAuth?.enabled)
      ? (state.securitySettings?.hasApiKey ?? health.inferenceAuth?.hasApiKey)
        ? "API Key 鉴权"
        : "鉴权缺少密钥"
      : "无鉴权",
  );
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
  setText("default-model", health.defaultModel ?? "codex-default");
  setText(
    "openclaw-base-url",
    health.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1",
  );
  const sourceCounts = getAccountGroups();
  setText("local-account-count", String(sourceCounts.localImport));
  setText("openclaw-source-count", String(sourceCounts.openclaw));
  setText("provider-count", String(providers.data.length));
  setText(
    "default-selection",
    health.defaultSelection?.reason ?? "使用默认规则",
  );
  setText(
    "snippet-model",
    health.openclaw?.model ?? health.defaultModel ?? "codex-default",
  );
  renderAccountActivityOverview();
  renderRoutingObservability();
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

  const accountGroups = getAccountGroups();
  const accounts = sortAccountGroups(
    accountGroups.groups.filter((group) => group.sourceKind === "local-import"),
    {
      search: state.accountSearch,
      sortKey: state.accountSortKey,
      sortDirection: state.accountSortDirection,
      pinnedSessionId: state.systemSettings?.pinnedSessionId,
    },
  );
  const activitySummary = buildAccountActivitySummary(accounts);
  const healthyQuotaCount = accounts.filter(
    (account) => (account.representative.quota?.percentage ?? 0) > 50,
  ).length;
  const warningQuotaCount = accounts.filter((account) => {
    const percentage = account.representative.quota?.percentage;
    return (
      typeof percentage === "number" && percentage > 20 && percentage <= 50
    );
  }).length;
  const lowQuotaCount = accounts.filter((account) => {
    const percentage = account.representative.quota?.percentage;
    return typeof percentage === "number" && percentage <= 20;
  }).length;

  container.innerHTML = "";
  const section = document.createElement("section");
  section.style.marginBottom = "32px";
  const cards = accounts.length
    ? accounts
        .map(
          (account) => `
        ${(() => {
          const title = getSessionTitle(account.representative);
          const avatarTone = getAvatarToneIndex(account.representative.id);
          const quotaPercentage = getQuotaPercentage(account.representative);
          const quotaScope = formatQuotaWindowLabel(account.representative);
          const quotaToneClass = getQuotaToneClass(quotaPercentage).replace(
            "quota-",
            "",
          );
          const activity = account.representative.activity;
          const requestCount = activity?.requestCount ?? 0;
          const recentCallLabel = formatRecentCall(activity?.lastRequestAt);
          const clientTagBadges = renderClientTagBadges(
            activity?.byClientTag ?? [],
          );
          const recentClientTagBadges = renderRecentClientTagBadges(
            activity?.recentByClientTag5m ?? [],
            activity?.recentRequestCount5m ?? 0,
          );
          const isLive =
            typeof activity?.lastRequestAt === "number" &&
            Date.now() - activity.lastRequestAt <= 90_000;
          const isPinned = isPinnedAccountSession(account.representative.id);
          const refreshErrorMessage = account.sessions
            .map((session) => refreshErrorBySessionId.get(session.id))
            .find((value) => typeof value === "string");
          const quotaUpdatedAt = account.representative.quota?.updatedAt
            ? `同步于 ${new Date(account.representative.quota.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
            : "尚未同步";
          return `
        <div class="account-item${account.isActive ? " active" : ""}${isLive ? " live" : ""}${isPinned ? " pinned" : ""}${isPinned && isLive ? " pinned-live" : ""}">
          <div class="acc-header">
            <div class="acc-title-group">
              <div class="acc-avatar" data-avatar-tone="${avatarTone}">${escapeHtml(title.charAt(0).toUpperCase())}</div>
              <div class="acc-info">
                <h4>${escapeHtml(title)}</h4>
                <span>${escapeHtml(account.representative.accountId ?? account.representative.profileId ?? "无 ID")}</span>
              </div>
            </div>
            <div class="acc-status-group">
              ${isPinned && isLive ? `<span class="badge featured">优先账号</span>` : ""}
              ${isPinned ? `<span class="badge neutral">已置顶</span>` : ""}
              ${isLive ? `<span class="badge active">活跃调用</span>` : ""}
              ${refreshErrorMessage ? `<span class="badge incomplete">额度同步失败</span>` : ""}
              <span class="badge ${account.representative.status}">${statusLabel(account.representative.status)}</span>
            </div>
          </div>
          <div class="acc-meta">
            <span>套餐: ${escapeHtml(account.representative.planType ?? "待同步")}</span>
            <span>到期: ${escapeHtml(formatDate(account.representative.expiresAt))}</span>
          </div>
          <div class="acc-meta">
            <span>${isLive ? "活跃调用" : "最近调用"}: ${escapeHtml(recentCallLabel)}</span>
            <span>请求数: ${requestCount}</span>
          </div>
          <div class="acc-meta" style="align-items: center;">
            <span>来源分布:</span>
            <span class="client-tag-list">${clientTagBadges}</span>
          </div>
          <div class="acc-meta" style="align-items: center;">
            <span>近5分钟:</span>
            <span class="client-tag-list">${recentClientTagBadges}</span>
          </div>
          <div class="acc-meta">
            <span>近1小时请求: ${activity?.recentRequestCount1h ?? 0}</span>
            <span>近24小时: ${activity?.recentRequestCount24h ?? 0}</span>
          </div>
          <div style="margin-top: 4px;">
            <div style="display: flex; justify-content: space-between; font-size: 14px;">
              <span style="color: var(--text-secondary);">${quotaScope}</span>
              <span style="font-weight: 500;">${quotaPercentage !== undefined ? `${quotaPercentage}%` : "待接入"}</span>
            </div>
            <div class="acc-quota-bar">
              <div class="acc-quota-fill ${quotaToneClass}" style="width: ${quotaPercentage ?? 0}%;"></div>
            </div>
            <div style="font-size: 14px; color: var(--text-tertiary); margin-top: 6px; display: flex; justify-content: space-between;">
              <span>重置: ${escapeHtml(formatCountdown(account.representative.quota?.resetAt))}</span>
              <span>${escapeHtml(quotaUpdatedAt)}</span>
            </div>
          </div>
          ${refreshErrorMessage ? `<div style="font-size: 14px; color: var(--warning); background: var(--warning-bg); border-radius: 8px; padding: 8px 10px;">最近同步失败：${escapeHtml(refreshErrorMessage)}</div>` : ""}
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
              data-tooltip="删除账号"
              data-session-id="${escapeHtml(account.representative.id)}"
              title="删除账号"
              aria-label="删除账号"
              style="margin-left: auto;"
              type="button"
            >
              ${renderActionIcon("delete")}
            </button>
          </div>
        </div>
      `;
        })()}
      `,
        )
        .join("")
    : "<div class='empty-state'>当前还没有导入任何桌面端 Codex 账号。可通过“添加账号”或“导入配置”补充。</div>";

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
  container.innerHTML = `<div class="grid-layout accounts-grid">${cards}</div>`;

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

  container.innerHTML = "";
  for (const provider of providers.data) {
    const isDefault = provider.models.some(
      (model) => model.alias === state.health?.defaultModel,
    );
    const card = document.createElement("div");
    card.className = `provider-item${isDefault ? " active" : ""}`;
    const modelRows = provider.models
      .map(
        (model) => `
        <div class="model-line">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <strong style="font-weight: 600; color: var(--text-primary);">${escapeHtml(model.alias)}</strong>
            <span style="color: var(--text-tertiary); font-size: 13px;">${escapeHtml(model.providerModelId)}</span>
          </div>
          <span class="badge ${model.alias === state.health?.defaultModel ? "active" : "neutral"}">${model.alias === state.health?.defaultModel ? "默认" : "可用"}</span>
        </div>
      `,
      )
      .join("");

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <strong style="font-size: 15px; font-weight: 600;">${escapeHtml(provider.label)}</strong>
          <span style="font-size: 14px; color: var(--text-tertiary);">${escapeHtml(provider.id)}</span>
        </div>
        <span class="badge neutral">${provider.usesSessions ? "会话型" : "固定配置"}</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--text-secondary); margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed var(--border-light);">
        <span>配置来源: ${escapeHtml(provider.configuration?.configuredVia ?? "未声明")}</span>
        <span>${provider.usesSessions ? `活动会话: ${escapeHtml(provider.activeSessionId ?? "未选择")}` : "无需活动会话"}</span>
      </div>
      <div class="provider-models">${modelRows}</div>
    `;
    container.appendChild(card);
  }
}

function renderDiagnostics(): void {
  const serviceContainer = document.getElementById("service-diagnostics");
  const container = document.getElementById("provider-diagnostics");
  if (!container || !serviceContainer) {
    return;
  }

  renderStartupChecklist();
  renderAppDataStatus();

  const runtimeDiagnostics = state.runtimeDiagnostics;
  if (!runtimeDiagnostics.length) {
    serviceContainer.innerHTML =
      "<div class='empty-card'>当前没有额外的运行状态提示</div>";
  } else {
    serviceContainer.innerHTML = "";
    for (const item of runtimeDiagnostics) {
      const card = document.createElement("div");
      card.className = "card";
      const suggestion = item.suggestion
        ? `<div style="font-size: 14px; color: var(--text-secondary); background: var(--bg-surface); padding: 8px; border-radius: 6px; margin-top: 8px;"><strong style="display: block; margin-bottom: 2px; color: var(--text-primary);">建议处理</strong>${escapeHtml(item.suggestion)}</div>`
        : "";
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <strong style="font-size: 15px; font-weight: 600;">${escapeHtml(item.title)}</strong>
            <span style="font-size: 14px; color: var(--text-secondary);">${escapeHtml(item.message)}</span>
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
    card.className = "card";
    const missing = item.missingEnvKeys?.length
      ? `<div style="margin-top: 12px; padding: 10px 12px; background: var(--warning-bg); border-radius: var(--radius-sm); border: 1px solid var(--warning-border); font-size: 13px; color: var(--warning);"><strong style="display: block; margin-bottom: 4px;">缺失配置项</strong>${escapeHtml(item.missingEnvKeys.join(", "))}</div>`
      : "";
    const notes = item.notes?.length
      ? `<div style="margin-top: 12px; display: flex; flex-direction: column; gap: 4px;">${item.notes.map((note) => `<span style="font-size: 13px; color: var(--text-secondary); background: var(--bg-surface); border: 1px solid var(--border-light); padding: 6px 10px; border-radius: var(--radius-sm);">${escapeHtml(note)}</span>`).join("")}</div>`
      : "";

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <strong style="font-size: 15px; font-weight: 600;">${escapeHtml(item.label)}</strong>
          <span style="font-size: 14px; color: var(--text-tertiary);">${escapeHtml(item.id)}</span>
        </div>
        <span class="badge ${item.status}">${statusTone(item.status)}</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 14px;">
        <div style="display: flex; flex-direction: column;"><span style="color: var(--text-secondary); margin-bottom: 2px;">注册状态</span><strong style="font-weight: 500;">${item.registered ? "已注册" : "未注册"}</strong></div>
        <div style="display: flex; flex-direction: column;"><span style="color: var(--text-secondary); margin-bottom: 2px;">配置来源</span><strong style="font-weight: 500;">${escapeHtml(item.configuredVia)}</strong></div>
        <div style="display: flex; flex-direction: column;"><span style="color: var(--text-secondary); margin-bottom: 2px;">鉴权方式</span><strong style="font-weight: 500;">${escapeHtml(item.authMode)}</strong></div>
        <div style="display: flex; flex-direction: column;"><span style="color: var(--text-secondary); margin-bottom: 2px;">Base URL</span><strong style="font-weight: 500;">${escapeHtml(item.baseUrl ?? "未设置")}</strong></div>
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
    <div class="routing-rule-guide" style="margin-top: 10px;">
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
    "clientTag=<你的客户端标识>",
    ...(requiresApiKey ? ["apiKey=<你的 Local AI Gateway API Key>"] : []),
  ].join("\n");

  const localraghub = [
    "provider=openai-compatible",
    `baseUrl=${baseUrl}`,
    `model=${model}`,
    "clientTag=localraghub",
    ...(requiresApiKey ? ["apiKey=<你的 Local AI Gateway API Key>"] : []),
  ].join("\n");

  const curlHeaders = [
    `-H "Content-Type: application/json"`,
    `-H "x-client-tag: localraghub"`,
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
    localraghub,
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
      key: "localraghub",
      title: "localRagHub 模板",
      subtitle: "适用于支持 OpenAI-compatible 的 RAG 客户端",
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
      <p style="margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">这是本地 AI Gateway 的桌面控制台，不是聊天窗口。它负责本地服务管理、Provider 配置、桌面端 Codex 账号管理，以及本机可复用授权的导入与复用。</p>
    </div>
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">第三方接入模板</h3>
      <p style="margin: 0 0 10px 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">先在“Provider 配置”完成模型入口设定，必要时再到“策略路由 / 号池调度”补充分流规则，然后把客户端指向本地网关。每个模板都支持一键复制。</p>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        ${snippetRows
          .map((row) => {
            const snippet =
              row.key === "openclaw"
                ? snippets.openclaw
                : row.key === "localraghub"
                  ? snippets.localraghub
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
    card.className = "card";
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <strong style="font-size: 15px; font-weight: 600;">额度刷新失败</strong>
          <span style="font-size: 14px; color: var(--text-tertiary);">${escapeHtml(item.sessionId)}</span>
        </div>
        <span class="badge incomplete">需处理</span>
      </div>
      <div style="font-size: 14px; color: var(--text-secondary); background: var(--bg-surface); padding: 8px; border-radius: 6px; margin-top: 8px;">
        <strong style="display: block; margin-bottom: 2px; color: var(--text-primary);">原因</strong>
        ${escapeHtml(item.message)}
      </div>
    `;
    container.appendChild(card);
  }

  for (const item of errors.slice(0, 6)) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <strong style="font-size: 15px; font-weight: 600;">${escapeHtml(item.level.toUpperCase())}</strong>
          <span style="font-size: 14px; color: var(--text-tertiary);">${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN"))}</span>
        </div>
        <span class="badge ${item.level === "error" ? "disabled" : "neutral"}">${item.level === "error" ? "错误" : "日志"}</span>
      </div>
      <div style="font-size: 14px; color: var(--text-secondary); background: var(--bg-surface); padding: 8px; border-radius: 6px; margin-top: 8px;">
        <strong style="display: block; margin-bottom: 2px; color: var(--text-primary);">内容</strong>
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
  if (pools.length === 0) {
    container.innerHTML =
      "<div class='empty-state'>当前还没有号池。你可以新增一个号池，把多个桌面端 Codex 账号纳入自动调度。</div>";
    return;
  }

  container.innerHTML = pools
    .map((pool, index) => {
      const panelState = getPoolPanelState(pool.id);
      const candidates = buildPoolMemberCandidates();
      const unresolvedMembers = getPoolUnresolvedMembers(pool, candidates).join(
        "\n",
      );
      return `
        <div class="routing-rule-card pool-config-card ${panelState.cardCollapsed ? "collapsed" : ""}" data-pool-row data-pool-id="${escapeHtml(pool.id)}" data-enabled="${pool.enabled === false ? "false" : "true"}">
          <div class="routing-rule-top pool-card-top" data-action="toggle-pool-card" data-pool-id="${escapeHtml(pool.id)}">
            <div class="pool-card-title-wrap">
              <div class="pool-card-index-avatar">${index + 1}</div>
              <div class="pool-card-title-text">
                <strong>${escapeHtml(pool.name || "未命名号池")}</strong>
                <span>首版只纳入桌面端导入账号；通过列表顺序确定默认优先级，必要时再结合额度与最近使用情况自动挑号。</span>
              </div>
            </div>
            <div class="routing-rule-meta">
              <span class="badge neutral">${escapeHtml(pool.id)}</span>
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
          <div class="routing-rule-grid">
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
            <div class="form-field" style="grid-column: 1 / -1;">
              <label>说明（可选）</label>
              <input class="input-field" data-field="pool-description" placeholder="例如：给 OpenClaw 长任务预留的自动切号池" value="${escapeHtml(pool.description ?? "")}" />
            </div>
            <div class="form-field" style="grid-column: 1 / -1;">
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
    })
    .join("");
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
      ${rejectedCandidates}
    </div>
  `;
}

function resetRoutingPreviewResult(): void {
  const node = document.getElementById("routing-preview-result");
  if (!node) {
    return;
  }
  node.innerHTML =
    "<div class='routing-preview-result-card neutral'><span style='font-size: 14px; color: var(--text-secondary);'>填写条件后点击“预演路由结果”查看命中情况。</span></div>";
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

  const mode = settings?.mode === "api-key" ? "api-key" : "none";
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
  state.runtimeDiagnostics = buildRuntimeDiagnostics({
    gatewayOk: state.health?.ok,
    activeSessionId: state.sessions?.activeSessionId,
    sessions: state.sessions?.data ?? [],
    loadFailures,
    routingEnabled: state.routingSettings?.enabled,
    routingMatchedTotal: state.health?.routingObservability?.totalMatched,
    inferenceAuthEnabled:
      state.securitySettings?.enabled ?? state.health?.inferenceAuth?.enabled,
    inferenceAuthHasApiKey:
      state.securitySettings?.hasApiKey ??
      state.health?.inferenceAuth?.hasApiKey,
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

  const payload: SecuritySettingsInput = {
    mode,
    apiKey,
  };
  const response = await api.saveSecuritySettings(payload);
  state.securitySettings = response.data;
  applySecuritySettingsToForm();
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
    localraghub: "localRagHub 模板",
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
      syncPoolDraftFromRow(row);
      setPoolPanelState(row.dataset.poolId || createPoolId(), {
        search: target.value,
      });
      // 只更新该号池内的成员列表区域，避免重绘整个卡片导致失焦
      const memberSelectorMarkup = buildPoolMemberSelectorMarkup(
        state.poolSettings?.pools?.find((p) => p.id === row.dataset.poolId) ||
          collectPoolDefinitionFromRow(row),
      );
      const membersContainer = row.querySelector(".form-field:nth-child(4)"); // 也就是"池成员"所在的div
      if (membersContainer) {
        membersContainer.innerHTML = `
          <label>池成员（推荐直接勾选桌面端账号）</label>
          ${memberSelectorMarkup}
          <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
        `;
        const newInput = row.querySelector(
          '[data-pool-ui="search"]',
        ) as HTMLInputElement;
        if (newInput) {
          newInput.focus();
          newInput.setSelectionRange(
            newInput.value.length,
            newInput.value.length,
          );
        }
      } else {
        renderPoolCards();
      }
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
        syncPoolDraftFromRow(row);
        setPoolPanelState(row.dataset.poolId || createPoolId(), {
          sortKey: target.value as PoolMemberSortKey,
        });

        const memberSelectorMarkup = buildPoolMemberSelectorMarkup(
          state.poolSettings?.pools?.find((p) => p.id === row.dataset.poolId) ||
            collectPoolDefinitionFromRow(row),
        );
        const membersContainer = row.querySelector(".form-field:nth-child(4)");
        if (membersContainer) {
          membersContainer.innerHTML = `
            <label>池成员（推荐直接勾选桌面端账号）</label>
            ${memberSelectorMarkup}
            <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
          `;
        } else {
          renderPoolCards();
        }
      }
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

        const memberSelectorMarkup = buildPoolMemberSelectorMarkup(
          state.poolSettings?.pools?.find((p) => p.id === row.dataset.poolId) ||
            collectPoolDefinitionFromRow(row),
        );
        const membersContainer = row.querySelector(".form-field:nth-child(4)");
        if (membersContainer) {
          membersContainer.innerHTML = `
            <label>池成员（推荐直接勾选桌面端账号）</label>
            ${memberSelectorMarkup}
            <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
          `;
        } else {
          renderPoolCards();
        }
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
    .getElementById("reset-telemetry")
    ?.addEventListener("click", async () => {
      const button = document.getElementById(
        "reset-telemetry",
      ) as HTMLButtonElement | null;
      try {
        const confirmed = await requestConfirmation({
          title: "确认清空统计",
          message:
            "将清空路由命中与账号调用统计，但不会影响账号、配置和授权。是否继续？",
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
        setButtonLoading(button, true, "清理中");
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
        setButtonLoading(button, false);
      }
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
    .getElementById("close-pool-events-modal")
    ?.addEventListener("click", () => {
      closePoolEventsModal();
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
      closeAccountModal();
    }
  });

  window.addEventListener("beforeunload", () => {
    clearAutoRefreshTimer();
    clearSessionActivityTimer();
  });

  document.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>("[data-action]");
    if (!button) {
      return;
    }

    const action = button.dataset.action;
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

    if (action === "delete-codex-account" && button.dataset.sessionId) {
      try {
        const confirmed = await requestConfirmation({
          title: "确认删除账号",
          message:
            "删除后将从桌面端本地账号存储中移除该 Codex 账号。是否继续？",
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
            ? "桌面端 Codex 账号已删除。"
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
      applyPoolSettingsToForm();
      applyRoutingSettingsToForm();
      resetRoutingPreviewResult();
    }

    if (action === "pool-toggle-collapse" && button.dataset.poolId) {
      const row = button.closest<HTMLElement>("[data-pool-row]");
      if (row) {
        syncPoolDraftFromRow(row);
      }
      const panelState = getPoolPanelState(button.dataset.poolId);
      setPoolPanelState(button.dataset.poolId, {
        collapsed: !panelState.collapsed,
      });
      if (row) {
        const memberSelectorMarkup = buildPoolMemberSelectorMarkup(
          state.poolSettings?.pools?.find((p) => p.id === row.dataset.poolId) ||
            collectPoolDefinitionFromRow(row),
        );
        const membersContainer = row.querySelector(".form-field:nth-child(4)");
        if (membersContainer) {
          membersContainer.innerHTML = `
            <label>池成员（推荐直接勾选桌面端账号）</label>
            ${memberSelectorMarkup}
            <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
          `;
          return;
        }
      }
      renderPoolCards();
    }

    if (action === "pool-toggle-sort" && button.dataset.poolId) {
      const row = button.closest<HTMLElement>("[data-pool-row]");
      if (row) {
        syncPoolDraftFromRow(row);
      }
      const panelState = getPoolPanelState(button.dataset.poolId);
      setPoolPanelState(button.dataset.poolId, {
        sortDirection: panelState.sortDirection === "asc" ? "desc" : "asc",
      });
      if (row) {
        const memberSelectorMarkup = buildPoolMemberSelectorMarkup(
          state.poolSettings?.pools?.find((p) => p.id === row.dataset.poolId) ||
            collectPoolDefinitionFromRow(row),
        );
        const membersContainer = row.querySelector(".form-field:nth-child(4)");
        if (membersContainer) {
          membersContainer.innerHTML = `
            <label>池成员（推荐直接勾选桌面端账号）</label>
            ${memberSelectorMarkup}
            <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
          `;
          return;
        }
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

      const memberSelectorMarkup = buildPoolMemberSelectorMarkup(
        state.poolSettings?.pools?.find((p) => p.id === row.dataset.poolId) ||
          collectPoolDefinitionFromRow(row),
      );
      const membersContainer = row.querySelector(".form-field:nth-child(4)");
      if (membersContainer) {
        membersContainer.innerHTML = `
          <label>池成员（推荐直接勾选桌面端账号）</label>
          ${memberSelectorMarkup}
          <div class="form-hint">支持搜索、排序、全选、反选与面板收起；优先使用上方可视账号列表勾选池成员。如果同一账号存在多个底层会话，网关会优先解析到当前更合适的本地会话。</div>
        `;
        return;
      }
      renderPoolCards();
    }
  });
}

async function refresh(): Promise<void> {
  const api = getGatewayApi();
  const [
    healthResult,
    providersResult,
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

  renderOverview();
  renderTopSummary();
  renderCodexAccounts();
  renderProviderRegistry();
  renderDiagnostics();
  renderErrors();
  renderGuide();
  renderPoolEventsModal();
  applySettingsToForm();
  applyRoutingSettingsToForm();
  applyPoolSettingsToForm();
  resetRoutingPreviewResult();
  applySecuritySettingsToForm();
  applySystemSettingsToForm();
  configureAutoRefreshTimer();
  configureSessionActivityTimer();
  setOAuthBusyState(Boolean(state.oauthInFlight));
}

async function refreshHealthAndSessionsOnly(): Promise<void> {
  const api = getGatewayApi();
  const [healthResult, sessionsResult] = await Promise.allSettled([
    api.getHealth(),
    api.getSessions(),
  ]);

  if (
    healthResult.status !== "fulfilled" &&
    sessionsResult.status !== "fulfilled"
  ) {
    throw (
      healthResult.reason ??
      sessionsResult.reason ??
      new Error("无法刷新桌面端运行态数据。")
    );
  }

  if (healthResult.status === "fulfilled") {
    state.health = healthResult.value;
  }
  if (sessionsResult.status === "fulfilled") {
    state.sessions = sessionsResult.value;
  }
  updateRuntimeDiagnostics([]);
  renderOverview();
  renderTopSummary();
  renderCodexAccounts();
  renderDiagnostics();
  renderErrors();
  renderPoolCards();
  renderPoolEventsModal();
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

async function syncSessionActivitySilently(): Promise<void> {
  if (state.sessionPulseInFlight || state.backgroundRefreshInFlight) {
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
