import { buildCodexAccountGroups } from "./account-groups.js";
import {
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

const SUPPORTED_CODEX_UPSTREAM_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
] as const;

const ACTIVE_VIEW_STORAGE_KEY = "local-ai-gateway.desktop.active-view";

declare global {
  interface Window {
    localAIGateway?: {
      getHealth: () => Promise<DashboardHealth>;
      getProviders: () => Promise<DashboardProviders>;
      getProviderSettings: () => Promise<ProviderSettingsResponse>;
      saveProviderSettings: (
        payload: ProviderSettings,
      ) => Promise<{ ok: boolean; requiresRestart: boolean }>;
      getSystemSettings: () => Promise<SystemSettingsResponse>;
      saveSystemSettings: (
        payload: SystemSettings,
      ) => Promise<SystemSettingsResponse>;
      getSessions: () => Promise<DashboardSessions>;
      setActiveSession: (sessionId: string) => Promise<any>;
      refreshSessionUsage: (
        sessionId?: string,
      ) => Promise<SessionUsageRefreshResponse>;
      deleteCodexAccount: (sessionId: string) => Promise<{
        ok: boolean;
        data: { removed: boolean; profileId: string; filePath: string };
      }>;
      restartGateway: () => Promise<any>;
      copyOpenClawSnippet: () => Promise<any>;
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
};

type SystemSettingsResponse = {
  ok: boolean;
  data: SystemSettings;
};

type DashboardView = "overview" | "accounts" | "providers" | "diagnostics";
const state: {
  health?: DashboardHealth;
  providers?: DashboardProviders;
  sessions?: DashboardSessions;
  settings?: ProviderSettings;
  systemSettings?: SystemSettings;
  oauthInFlight?: boolean;
  lastUsageRefresh?: SessionUsageRefreshResponse;
  activeView: DashboardView;
  accountSearch: string;
  accountSortKey: AccountSortKey;
  accountSortDirection: AccountSortDirection;
  backgroundRefreshInFlight?: boolean;
  sessionPulseInFlight?: boolean;
  runtimeDiagnostics: RuntimeDiagnostic[];
} = {
  activeView: "overview",
  accountSearch: "",
  accountSortKey: "quota",
  accountSortDirection: "desc",
  runtimeDiagnostics: [],
};

let autoRefreshTimer: number | undefined;
let sessionActivityTimer: number | undefined;

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

function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
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
      saved === "diagnostics"
    ) {
      return saved;
    }
  } catch {
    // ignore
  }
  return "overview";
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
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent ?? "";
    }
    button.dataset.loading = "true";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = loadingText ?? `${button.dataset.originalText}...`;
    return;
  }

  button.disabled = false;
  button.removeAttribute("aria-busy");
  delete button.dataset.loading;
  if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
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

function getPrimaryRuntimeDiagnostic():
  | RuntimeDiagnostic
  | undefined {
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

function getAccountGroups() {
  return buildCodexAccountGroups(
    state.sessions?.data ?? [],
    state.sessions?.activeSessionId,
  );
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
    "top-summary-session",
    activeSession ? getSessionTitle(activeSession) : "未选择活动会话",
  );
  setText(
    "top-summary-providers",
    `${providers.data.length} 个 Provider / ${groups.total} 个授权对象`,
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
}

function renderCodexAccounts(): void {
  const container = document.getElementById("codex-accounts");
  if (!container) {
    return;
  }
  const refreshErrorBySessionId = new Map(
    (state.lastUsageRefresh?.errors ?? []).map((item) => [item.sessionId, item.message]),
  );

  const accountGroups = getAccountGroups();
  const accounts = sortAccountGroups(
    accountGroups.groups.filter((group) => group.sourceKind === "local-import"),
    {
      search: state.accountSearch,
      sortKey: state.accountSortKey,
      sortDirection: state.accountSortDirection,
    },
  );

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
          const isLive =
            typeof activity?.lastRequestAt === "number" &&
            Date.now() - activity.lastRequestAt <= 90_000;
          const refreshErrorMessage = account.sessions
            .map((session) => refreshErrorBySessionId.get(session.id))
            .find((value) => typeof value === "string");
          const quotaUpdatedAt = account.representative.quota?.updatedAt
            ? `同步于 ${new Date(account.representative.quota.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
            : "尚未同步";
          return `
        <div class="account-item${account.isActive ? " active" : ""}${isLive ? " live" : ""}">
          <div class="acc-header">
            <div class="acc-title-group">
              <div class="acc-avatar" data-avatar-tone="${avatarTone}">${escapeHtml(title.charAt(0).toUpperCase())}</div>
              <div class="acc-info">
                <h4>${escapeHtml(title)}</h4>
                <span>${escapeHtml(account.representative.accountId ?? account.representative.profileId ?? "无 ID")}</span>
              </div>
            </div>
            <div class="acc-status-group">
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
          <div style="margin-top: 4px;">
            <div style="display: flex; justify-content: space-between; font-size: 12px;">
              <span style="color: var(--text-secondary);">${quotaScope}</span>
              <span style="font-weight: 500;">${quotaPercentage !== undefined ? `${quotaPercentage}%` : "待接入"}</span>
            </div>
            <div class="acc-quota-bar">
              <div class="acc-quota-fill ${quotaToneClass}" style="width: ${quotaPercentage ?? 0}%;"></div>
            </div>
            <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 6px; display: flex; justify-content: space-between;">
              <span>重置: ${escapeHtml(formatCountdown(account.representative.quota?.resetAt))}</span>
              <span>${escapeHtml(quotaUpdatedAt)}</span>
            </div>
          </div>
          ${refreshErrorMessage ? `<div style="font-size: 12px; color: var(--warning); background: var(--warning-bg); border-radius: 6px; padding: 6px 8px;">最近同步失败：${escapeHtml(refreshErrorMessage)}</div>` : ""}
          <div class="acc-actions">
            <button class="btn ${account.isActive ? "primary" : "secondary"} mini" data-action="activate" data-session-id="${escapeHtml(account.representative.id)}">
              ${account.isActive ? "当前活动" : "设为活动"}
            </button>
            <button class="btn secondary mini" data-action="refresh-session-usage" data-session-id="${escapeHtml(account.representative.id)}">刷新</button>
            <button class="btn ghost danger-ghost mini" data-action="delete-codex-account" data-session-id="${escapeHtml(account.representative.id)}">删除</button>
            <button class="btn ghost mini" style="margin-left: auto;" data-action="copy-snippet" title="复制接入片段">复制片段</button>
          </div>
        </div>
      `;
        })()}
      `,
          )
          .join("")
    : "<div class='empty-state'>当前还没有导入任何桌面端 Codex 账号。可通过“添加账号”或“导入配置”补充。</div>";

  section.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px;">
        <div>
          <h3 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 600;">桌面端 Codex 账号</h3>
          <p style="margin: 0; font-size: 14px; color: var(--text-secondary);">这里展示的是本应用自己管理并可直接切换的 Codex 账号。</p>
        </div>
        <span class="badge neutral">${accounts.length} 个账号</span>
      </div>
      <div class="grid-layout grid-3">${cards}</div>
    `;
  container.appendChild(section);

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
            <span style="color: var(--text-tertiary); font-size: 11px;">${escapeHtml(model.providerModelId)}</span>
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
      ? `<div style="margin-top: 12px; padding: 8px; background: var(--warning-bg); border-radius: 6px; font-size: 14px; color: var(--warning);"><strong style="display: block; margin-bottom: 2px;">缺失配置项</strong>${escapeHtml(item.missingEnvKeys.join(", "))}</div>`
      : "";
    const notes = item.notes?.length
      ? `<div style="margin-top: 12px; display: flex; flex-direction: column; gap: 4px;">${item.notes.map((note) => `<span style="font-size: 14px; color: var(--text-secondary); background: var(--bg-surface); padding: 4px 8px; border-radius: 4px;">${escapeHtml(note)}</span>`).join("")}</div>`
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
  const snippet = [
    `provider=${health.openclaw?.provider ?? "openai"}`,
    `baseUrl=${health.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1"}`,
    `model=${health.openclaw?.model ?? "codex-default"}`,
  ].join("\n");

  container.innerHTML = `
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">定位说明</h3>
      <p style="margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">这是本地 AI Gateway 的桌面控制台，不是聊天窗口。它负责本地服务管理、Provider 配置、桌面端 Codex 账号管理，以及本机可复用授权的导入与复用。</p>
    </div>
    <div class="card">
      <h3 style="margin: 0 0 8px 0; font-size: 15px;">如何接入</h3>
      <p style="margin: 0 0 8px 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6;">先在配置页完成 provider 设定并重启服务，然后将客户端指向下方本地地址：</p>
      <pre style="margin: 0; padding: 12px; background: var(--bg-surface); border-radius: 8px; font-size: 14px; border: 1px solid var(--border-light); overflow-x: auto;">${escapeHtml(snippet)}</pre>
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

  if (codexSelect) {
    codexSelect.replaceChildren();
    for (const modelId of SUPPORTED_CODEX_UPSTREAM_MODELS) {
      const node = document.createElement("option");
      node.value = modelId;
      node.textContent = modelId;
      codexSelect.appendChild(node);
    }
    codexSelect.value = codex.upstreamModel ?? "gpt-5.4";
  }

  if (defaultSelect) {
    defaultSelect.replaceChildren();
    const aliasSet = new Set<string>([
      "codex-default",
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
    defaultModel: "codex-default",
    openclaw: {
      baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
      provider: "openai",
      model: "codex-default",
    },
    recentErrors: [],
    providerConfigurations: [],
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
        (
          document.getElementById("gateway-port") as HTMLInputElement | null
        )?.value ?? "8787",
      ),
    ),
  };

  const response = await api.saveSystemSettings(payload);
  state.systemSettings = response.data;
  applySystemSettingsToForm();
  configureAutoRefreshTimer();
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
      if (!summary) {
        setBanner("状态已刷新。当前桌面主进程尚未启用实时额度刷新。", "info");
      } else if (summary.refreshed === 0 && summary.failed === 0) {
        setBanner("状态已刷新。当前没有可刷新的桌面端账号。", "info");
      } else if (summary.failed > 0) {
        setBanner(
          `状态已刷新，${summary.refreshed} 个账号额度已更新，${summary.failed} 项额度同步失败（账号仍可能可用）。`,
          "error",
        );
      } else {
        setBanner(
          `状态已刷新，${summary.refreshed} 个账号额度已更新。`,
          "success",
        );
      }
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
        if (!summary) {
          setBanner("账号状态已刷新。", "success");
        } else if (summary.refreshed === 0 && summary.failed === 0) {
          setBanner("账号状态已刷新。当前没有可刷新的桌面端账号。", "info");
        } else if (summary.failed > 0) {
          setBanner(
            `账号状态已刷新，${summary.refreshed} 个账号更新成功，${summary.failed} 项额度同步失败（账号仍可能可用）。`,
            "error",
          );
        } else {
          setBanner(
            `账号状态已刷新，${summary.refreshed} 个账号已更新。`,
            "success",
          );
        }
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
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
        if (!summary) {
          setBanner("账号状态已刷新。", "success");
        } else if (summary.refreshed === 0 && summary.failed === 0) {
          setBanner("账号状态已刷新。当前会话暂无可更新额度。", "info");
        } else if (summary.failed > 0) {
          setBanner(
            `账号状态已刷新，但仍有 ${summary.failed} 项失败。`,
            "error",
          );
        } else {
          setBanner("账号状态已刷新。", "success");
        }
      } catch (error) {
        setBanner(`账号刷新失败：${String(error)}`, "error");
      } finally {
        setButtonLoading(refreshButton, false);
      }
    }

    if (action === "copy-snippet") {
      try {
        await copySnippetWithFeedback();
      } catch (error) {
        setBanner(`复制失败：${String(error)}`, "error");
      }
    }

    if (action === "delete-codex-account" && button.dataset.sessionId) {
      try {
        const confirmed = window.confirm(
          "删除后将从桌面端本地账号存储中移除该 Codex 账号。是否继续？",
        );
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
  });
}

async function refresh(): Promise<void> {
  const api = getGatewayApi();
  const [
    healthResult,
    providersResult,
    sessionsResult,
    settingsResult,
    systemSettingsResult,
  ] = await Promise.allSettled([
    api.getHealth(),
    api.getProviders(),
    api.getSessions(),
    api.getProviderSettings(),
    api.getSystemSettings(),
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

  updateRuntimeDiagnostics(loadFailures);

  renderOverview();
  renderTopSummary();
  renderCodexAccounts();
  renderProviderRegistry();
  renderDiagnostics();
  renderErrors();
  renderGuide();
  applySettingsToForm();
  applySystemSettingsToForm();
  configureAutoRefreshTimer();
  configureSessionActivityTimer();
  setOAuthBusyState(Boolean(state.oauthInFlight));
}

async function refreshSessionsOnly(): Promise<void> {
  const api = getGatewayApi();
  state.sessions = await api.getSessions();
  updateRuntimeDiagnostics([]);
  renderOverview();
  renderTopSummary();
  renderCodexAccounts();
  renderDiagnostics();
  renderErrors();
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
  await refreshSessionsOnly();
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
      if (!summary) {
        setBanner("控制台已就绪。当前桌面主进程尚未启用实时额度刷新。", "info");
      } else if (summary.refreshed === 0 && summary.failed === 0) {
        setBanner("控制台已就绪。当前没有可刷新的桌面端账号。", "info");
      } else if (summary.failed > 0) {
        setBanner(
          `控制台已就绪，但实时额度同步有 ${summary.failed} 项失败（不代表账号不可用）。`,
          "error",
        );
      } else {
        setBanner("控制台已就绪。实时额度已完成后台同步。", "success");
      }
    } else if (summary?.failed) {
      setBanner(
        `自动刷新完成，但有 ${summary.failed} 项额度同步失败。`,
        "error",
      );
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
    await refreshSessionsOnly();
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
      setBanner(`控制台已加载，但存在异常：${primaryDiagnostic.title}`, "error");
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
