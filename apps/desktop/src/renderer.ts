import { buildCodexAccountGroups } from "./account-groups.js";

const SUPPORTED_CODEX_UPSTREAM_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
] as const;

declare global {
  interface Window {
    localAIGateway?: {
      getHealth: () => Promise<DashboardHealth>;
      getProviders: () => Promise<DashboardProviders>;
      getProviderSettings: () => Promise<ProviderSettingsResponse>;
      saveProviderSettings: (payload: ProviderSettings) => Promise<{ ok: boolean; requiresRestart: boolean }>;
      getSessions: () => Promise<DashboardSessions>;
      setActiveSession: (sessionId: string) => Promise<any>;
      refreshSessionUsage: (sessionId?: string) => Promise<SessionUsageRefreshResponse>;
      deleteCodexAccount: (sessionId: string) => Promise<{ ok: boolean; data: { removed: boolean; profileId: string; filePath: string } }>;
      restartGateway: () => Promise<any>;
      copyOpenClawSnippet: () => Promise<any>;
      openLogs: () => Promise<any>;
      loginCodexOAuth: () => Promise<{
        ok: boolean;
        data: { sessionId: string; profileId: string; accountId?: string; filePath: string };
      }>;
      submitCodexOAuthInput: (input: string) => Promise<{ ok: boolean }>;
      cancelCodexOAuth: () => Promise<{ ok: boolean }>;
      importCodexJson: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        imported?: number;
        profileIds?: string[];
        selectedPath?: string;
      }>;
      importOpenClawSession: (sessionId: string) => Promise<{
        ok: boolean;
        data: { sessionId: string; profileId: string; accountId?: string; filePath: string };
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

const state: {
  health?: DashboardHealth;
  providers?: DashboardProviders;
  sessions?: DashboardSessions;
  settings?: ProviderSettings;
  oauthInFlight?: boolean;
  lastUsageRefresh?: SessionUsageRefreshResponse;
} = {};

function getGatewayApi() {
  const api = window.localAIGateway;
  if (!api) {
    throw new Error("Electron preload 未成功注入，桌面桥接不可用。请重启桌面端。");
  }
  return api;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function setText(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
}

function setBanner(message: string, tone: "info" | "success" | "error" = "info"): void {
  const node = document.getElementById("status-banner");
  if (!node) {
    return;
  }
  node.textContent = message;
  node.setAttribute("data-tone", tone);
}

function setButtonLoading(button: HTMLButtonElement | null, loading: boolean, loadingText?: string): void {
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

function getSessionTitle(session: DashboardSessions["data"][number]): string {
  return session.email ?? session.displayName ?? session.accountId ?? session.profileId;
}

function getSessionSubtitle(session: DashboardSessions["data"][number]): string {
  return session.id;
}

function getQuotaPercentage(session: DashboardSessions["data"][number]): number | undefined {
  const value = session.quota?.percentage;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

function formatQuotaWindowLabel(session: DashboardSessions["data"][number]): string {
  const quota = session.quota;
  if (!quota) {
    return "剩余额度";
  }

  if (typeof quota.windowMinutes === "number") {
    if (quota.windowMinutes >= 60 * 24 * 6) {
      return "剩余额度（7天）";
    }
    if (quota.windowMinutes >= 60) {
      return `剩余额度（${Math.round(quota.windowMinutes / 60)}小时）`;
    }
    return `剩余额度（${quota.windowMinutes}分钟）`;
  }

  return quota.scope === "weekly" ? "剩余额度（周）" : "剩余额度（小时）";
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

function isMissingRefreshUsageHandler(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("gateway:refresh-session-usage") &&
    (message.includes("No handler registered") || message.includes("Admin request failed (404)"))
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
  return buildCodexAccountGroups(state.sessions?.data ?? [], state.sessions?.activeSessionId);
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
  setText("openclaw-base-url", health.openclaw?.baseUrl ?? "http://127.0.0.1:8787/v1");
  const sourceCounts = getAccountGroups();
  setText("local-account-count", String(sourceCounts.localImport));
  setText("openclaw-source-count", String(sourceCounts.openclaw));
  setText("provider-count", String(providers.data.length));
  setText("default-selection", health.defaultSelection?.reason ?? "使用默认规则");
  setText("snippet-model", health.openclaw?.model ?? health.defaultModel ?? "codex-default");
}

function renderCodexAccounts(): void {
  const container = document.getElementById("codex-accounts");
  if (!container) {
    return;
  }

  const accountGroups = getAccountGroups();
  const groups = [
    {
      key: "local-import",
      title: "桌面端 Codex 账号",
      description: "这里展示的是本应用自己管理的 Codex 账号。通过 OAuth 或 JSON 成功导入后，才会出现在这里。",
      kindLabel: "个账号",
      emptyText: "当前还没有导入任何桌面端 Codex 账号。",
      accounts: accountGroups.groups.filter((group) => group.sourceKind === "local-import"),
    },
    {
      key: "openclaw",
      title: "OpenClaw 可复用授权会话",
      description: "这里展示的是 OpenClaw 已登录的本地 Codex OAuth 授权。它们可直接作为网关授权来源，也可以一键导入为桌面端账号。",
      kindLabel: "个授权",
      emptyText: "当前没有从 OpenClaw 检测到可复用的 Codex 授权会话。",
      accounts: accountGroups.groups.filter((group) => group.sourceKind === "openclaw"),
    },
  ];

  container.innerHTML = "";
  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "source-group";
    const cards = group.accounts.length
      ? group.accounts
          .map((account) => `
        ${(() => {
          const title = getSessionTitle(account.representative);
          const subtitle = getSessionSubtitle(account.representative);
          const quotaPercentage = getQuotaPercentage(account.representative);
          const quotaScope = formatQuotaWindowLabel(account.representative);
          const quotaUpdatedAt = account.representative.quota?.updatedAt
            ? `实时快照：${formatDate(account.representative.quota?.updatedAt)}`
            : "";
          return `
        <article class="account-card${account.isActive ? " active" : ""}">
          <div class="account-head">
            <div>
              <strong>${escapeHtml(title)}</strong>
              <small>${escapeHtml(subtitle)}</small>
            </div>
            <span class="pill ${account.representative.status}">${statusLabel(account.representative.status)}</span>
          </div>
          <div class="account-meta">
            <span>套餐类型：${escapeHtml(account.representative.planType ?? "待同步")}</span>
            <span>OAuth 过期：${escapeHtml(formatDate(account.representative.expiresAt))}</span>
            ${quotaUpdatedAt ? `<span>${escapeHtml(quotaUpdatedAt)}</span>` : ""}
          </div>
          <div class="account-usage">
            <div>
              <small>${quotaScope}</small>
              <strong>${escapeHtml(quotaPercentage !== undefined ? `${quotaPercentage}%` : "待接入")}</strong>
              ${
                quotaPercentage !== undefined
                  ? `<div class="quota-meter"><span style="width: ${quotaPercentage}%;"></span></div>`
                  : ""
              }
            </div>
            <div>
              <small>重置时间</small>
              <strong>${escapeHtml(formatCountdown(account.representative.quota?.resetAt))}</strong>
              <small class="subtle-date">${escapeHtml(formatDate(account.representative.quota?.resetAt))}</small>
            </div>
          </div>
          <div class="account-actions">
            <button class="secondary mini" data-action="activate" data-session-id="${escapeHtml(account.representative.id)}">
              ${account.isActive ? "当前活动" : "设为活动"}
            </button>
            <button class="ghost mini" data-action="refresh-session-usage" data-session-id="${escapeHtml(account.representative.id)}">刷新</button>
            ${
              account.sourceKind === "openclaw"
                ? `<button class="ghost mini" data-action="import-openclaw-session" data-session-id="${escapeHtml(account.representative.id)}">导入为桌面端账号</button>`
                : `<button class="ghost mini danger" data-action="delete-codex-account" data-session-id="${escapeHtml(account.representative.id)}">删除</button>`
            }
            <button class="ghost mini" data-action="copy-snippet">复制接入片段</button>
          </div>
        </article>
      `;
        })()}
      `)
          .join("")
      : `<div class="empty-card">${escapeHtml(group.emptyText)}</div>`;

    section.innerHTML = `
      <div class="source-group-head">
        <div>
          <h3>${escapeHtml(group.title)}</h3>
          <p>${escapeHtml(group.description)}</p>
        </div>
        <span class="pill neutral">${group.accounts.length} ${group.kindLabel}</span>
      </div>
      <div class="account-subgrid">${cards}</div>
    `;
    container.appendChild(section);
  }
}

function renderProviderRegistry(): void {
  const container = document.getElementById("provider-registry");
  if (!container) {
    return;
  }

  const providers = state.providers;
  if (!providers?.data.length) {
    container.innerHTML = "<div class='empty-card'>当前没有已注册 provider</div>";
    return;
  }

  container.innerHTML = "";
  for (const provider of providers.data) {
    const isDefault = provider.models.some((model) => model.alias === state.health?.defaultModel);
    const card = document.createElement("article");
    card.className = `provider-card-2${isDefault ? " active" : ""}`;
    const modelRows = provider.models
      .map((model) => `
        <div class="model-row">
          <strong>${escapeHtml(model.alias)}</strong>
          <span>${model.alias === state.health?.defaultModel ? "默认" : "可用"}</span>
          <small>${escapeHtml(model.providerModelId)}</small>
        </div>
      `)
      .join("");

    card.innerHTML = `
      <div class="provider-card-head">
        <div>
          <strong>${escapeHtml(provider.label)}</strong>
          <small>${escapeHtml(provider.id)}</small>
        </div>
        <span class="pill neutral">${provider.usesSessions ? "会话型" : "固定配置"}</span>
      </div>
      <div class="provider-card-meta">
        <span>配置来源：${escapeHtml(provider.configuration?.configuredVia ?? "未声明")}</span>
        <span>${provider.usesSessions ? `活动会话：${escapeHtml(provider.activeSessionId ?? "未选择")}` : "无需活动会话"}</span>
      </div>
      <div class="model-list">${modelRows}</div>
    `;
    container.appendChild(card);
  }
}

function renderDiagnostics(): void {
  const container = document.getElementById("provider-diagnostics");
  if (!container) {
    return;
  }

  const diagnostics = state.health?.providerConfigurations ?? [];
  if (!diagnostics.length) {
    container.innerHTML = "<div class='empty-card'>暂无 provider 诊断信息</div>";
    return;
  }

  container.innerHTML = "";
  for (const item of diagnostics) {
    const card = document.createElement("article");
    card.className = `diagnostic-card status-${item.status}`;
    const missing = item.missingEnvKeys?.length
      ? `<div class="diagnostic-inline"><small>缺失项</small><strong>${escapeHtml(item.missingEnvKeys.join(", "))}</strong></div>`
      : "";
    const notes = item.notes?.length
      ? `<div class="diagnostic-notes">${item.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>`
      : "";

    card.innerHTML = `
      <div class="provider-card-head">
        <div>
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.id)}</small>
        </div>
        <span class="pill ${item.status}">${statusTone(item.status)}</span>
      </div>
      <div class="diagnostic-grid">
        <div><small>注册状态</small><strong>${item.registered ? "已注册" : "未注册"}</strong></div>
        <div><small>来源</small><strong>${escapeHtml(item.configuredVia)}</strong></div>
        <div><small>鉴权方式</small><strong>${escapeHtml(item.authMode)}</strong></div>
        <div><small>Base URL</small><strong>${escapeHtml(item.baseUrl ?? "未设置")}</strong></div>
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
    <article class="guide-card">
      <h3>这是个什么应用</h3>
      <p>这是本地 AI Gateway 的桌面控制台，不是聊天窗口。它负责本地服务管理、Provider 配置、桌面端 Codex 账号管理，以及 OpenClaw 本地授权的复用与导入。</p>
    </article>
    <article class="guide-card">
      <h3>如何使用</h3>
      <p>先在本页完成 provider 配置，再重启本地服务，然后把 OpenClaw 指向下方片段中的本地地址即可。</p>
      <pre>${escapeHtml(snippet)}</pre>
    </article>
    <article class="guide-card">
      <h3>OpenAI-compatible</h3>
      <p>${escapeHtml(
        openAI?.status === "active"
          ? "已启用，可以直接通过模型别名访问。"
          : openAI?.status === "incomplete"
            ? `配置还不完整：${openAI.missingEnvKeys?.join(", ") ?? "缺少关键字段"}`
            : "尚未启用。请在下方表单填写 Base URL、API Key 和模型名。",
      )}</p>
    </article>
    <article class="guide-card">
      <h3>Ollama</h3>
      <p>${escapeHtml(
        ollama?.status === "active"
          ? "已启用，可以将它的模型别名设为默认模型。"
          : ollama?.status === "incomplete"
            ? `配置还不完整：${ollama.missingEnvKeys?.join(", ") ?? "缺少关键字段"}`
            : "尚未启用。请在下方表单填写本地 Ollama 地址和模型名。",
      )}</p>
    </article>
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
    const card = document.createElement("article");
    card.className = "diagnostic-card";
    card.innerHTML = `
      <div class="provider-card-head">
        <div>
          <strong>额度刷新失败</strong>
          <small>${escapeHtml(item.sessionId)}</small>
        </div>
        <span class="pill incomplete">需处理</span>
      </div>
      <div class="diagnostic-inline">
        <small>原因</small>
        <strong>${escapeHtml(item.message)}</strong>
      </div>
    `;
    container.appendChild(card);
  }

  for (const item of errors.slice(0, 6)) {
    const card = document.createElement("article");
    card.className = "diagnostic-card";
    card.innerHTML = `
      <div class="provider-card-head">
        <div>
          <strong>${escapeHtml(item.level.toUpperCase())}</strong>
          <small>${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN"))}</small>
        </div>
        <span class="pill ${item.level === "error" ? "disabled" : "neutral"}">${item.level === "error" ? "错误" : "日志"}</span>
      </div>
      <div class="diagnostic-inline">
        <small>内容</small>
        <strong>${escapeHtml(item.message)}</strong>
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
  const defaultSelect = document.getElementById("default-model-alias") as HTMLSelectElement | null;
  const codexSelect = document.getElementById("codex-upstream-model") as HTMLSelectElement | null;

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
      ...(state.providers?.data.flatMap((provider) => provider.models.map((model) => model.alias)) ?? []),
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

  (document.getElementById("openai-enabled") as HTMLInputElement | null)!.checked = Boolean(openAI.enabled);
  (document.getElementById("openai-label") as HTMLInputElement | null)!.value = openAI.label ?? "OpenAI-Compatible";
  (document.getElementById("openai-base-url") as HTMLInputElement | null)!.value = openAI.baseUrl ?? "";
  (document.getElementById("openai-api-key") as HTMLInputElement | null)!.value = openAI.apiKey ?? "";
  (document.getElementById("openai-model") as HTMLInputElement | null)!.value = openAI.model ?? "";
  (document.getElementById("openai-alias") as HTMLInputElement | null)!.value = openAI.alias ?? "openai-compatible-default";
  (document.getElementById("openai-display-name") as HTMLInputElement | null)!.value = openAI.displayName ?? "";

  (document.getElementById("ollama-enabled") as HTMLInputElement | null)!.checked = Boolean(ollama.enabled);
  (document.getElementById("ollama-label") as HTMLInputElement | null)!.value = ollama.label ?? "Ollama";
  (document.getElementById("ollama-base-url") as HTMLInputElement | null)!.value = ollama.baseUrl ?? "http://127.0.0.1:11434";
  (document.getElementById("ollama-model") as HTMLInputElement | null)!.value = ollama.model ?? "";
  (document.getElementById("ollama-alias") as HTMLInputElement | null)!.value = ollama.alias ?? "ollama-default";
  (document.getElementById("ollama-display-name") as HTMLInputElement | null)!.value = ollama.displayName ?? "";
}

function collectSettingsFromForm(): ProviderSettings {
  return {
    defaultModelAlias: (document.getElementById("default-model-alias") as HTMLSelectElement | null)?.value || undefined,
    codex: {
      upstreamModel: (document.getElementById("codex-upstream-model") as HTMLSelectElement | null)?.value || undefined,
    },
    openAICompatible: {
      enabled: (document.getElementById("openai-enabled") as HTMLInputElement | null)?.checked ?? false,
      label: (document.getElementById("openai-label") as HTMLInputElement | null)?.value.trim() || undefined,
      baseUrl: (document.getElementById("openai-base-url") as HTMLInputElement | null)?.value.trim() || undefined,
      apiKey: (document.getElementById("openai-api-key") as HTMLInputElement | null)?.value.trim() || undefined,
      model: (document.getElementById("openai-model") as HTMLInputElement | null)?.value.trim() || undefined,
      alias: (document.getElementById("openai-alias") as HTMLInputElement | null)?.value.trim() || undefined,
      displayName: (document.getElementById("openai-display-name") as HTMLInputElement | null)?.value.trim() || undefined,
    },
    ollama: {
      enabled: (document.getElementById("ollama-enabled") as HTMLInputElement | null)?.checked ?? false,
      label: (document.getElementById("ollama-label") as HTMLInputElement | null)?.value.trim() || undefined,
      baseUrl: (document.getElementById("ollama-base-url") as HTMLInputElement | null)?.value.trim() || undefined,
      model: (document.getElementById("ollama-model") as HTMLInputElement | null)?.value.trim() || undefined,
      alias: (document.getElementById("ollama-alias") as HTMLInputElement | null)?.value.trim() || undefined,
      displayName: (document.getElementById("ollama-display-name") as HTMLInputElement | null)?.value.trim() || undefined,
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
  setOAuthStatus("浏览器授权已准备就绪。点击下方按钮后将自动打开授权页面。", "info");
}

function setAccountTab(tab: string): void {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-account-tab]"))) {
    node.dataset.active = node.dataset.accountTab === tab ? "true" : "false";
  }

  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-account-panel]"))) {
    node.hidden = node.dataset.accountPanel !== tab;
  }
}

function bindNavigation(): void {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-nav-target]"))) {
    node.addEventListener("click", () => {
      const target = node.dataset.navTarget;
      if (!target) {
        return;
      }
      document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

async function copySnippetWithFeedback(): Promise<void> {
  await getGatewayApi().copyOpenClawSnippet();
  setBanner("OpenClaw 接入片段已复制。", "success");
}

function setOAuthStatus(message: string, tone: "info" | "success" | "error" = "info"): void {
  const node = document.getElementById("oauth-status");
  if (!node) {
    return;
  }
  node.textContent = message;
  node.setAttribute("data-tone", tone);
}

function setOAuthBusyState(inFlight: boolean): void {
  state.oauthInFlight = inFlight;
  const startButton = document.getElementById("start-codex-oauth") as HTMLButtonElement | null;
  const submitButton = document.getElementById("submit-codex-oauth-input") as HTMLButtonElement | null;
  const cancelButton = document.getElementById("cancel-codex-oauth") as HTMLButtonElement | null;
  const input = document.getElementById("oauth-manual-input") as HTMLInputElement | null;

  if (startButton) {
    startButton.disabled = inFlight;
    startButton.textContent = inFlight ? "等待授权完成..." : "在浏览器中开始授权";
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
  setOAuthStatus("已打开浏览器授权页面。若未自动完成，请把回调地址粘贴到下方输入框。", "info");
  setBanner("正在等待 Codex OAuth 授权完成...", "info");

  try {
    const result = await getGatewayApi().loginCodexOAuth();
    await refresh();
    closeAccountModal();
    setBanner(`Codex 账号已导入：${result.data.accountId ?? result.data.profileId}`, "success");
  } catch (error) {
    setOAuthStatus(`授权失败：${String(error)}`, "error");
    setBanner(`Codex 授权失败：${String(error)}`, "error");
  } finally {
    setOAuthBusyState(false);
  }
}

async function submitCodexOAuthInput(): Promise<void> {
  const input = (document.getElementById("oauth-manual-input") as HTMLInputElement | null)?.value.trim() ?? "";
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
  setBanner(`已导入 ${result.imported ?? 0} 个 Codex 账号。`, "success");
}

function bindActions(): void {
  document.getElementById("refresh")?.addEventListener("click", async () => {
    const button = document.getElementById("refresh") as HTMLButtonElement | null;
    try {
      setButtonLoading(button, true, "刷新中");
      setBanner("正在刷新状态与 Codex 实时额度...", "info");
      const summary = await refreshWithLiveUsage();
      if (!summary) {
        setBanner("状态已刷新。当前桌面主进程尚未启用实时额度刷新。", "info");
      } else if (summary.failed > 0) {
        setBanner(
          `状态已刷新，${summary.refreshed} 个账号额度已更新，${summary.failed} 项刷新失败。`,
          "error",
        );
      } else {
        setBanner(`状态已刷新，${summary.refreshed} 个账号额度已更新。`, "success");
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

  document.getElementById("copy-snippet")?.addEventListener("click", async () => {
    try {
      await copySnippetWithFeedback();
    } catch (error) {
      setBanner(`复制失败：${String(error)}`, "error");
    }
  });

  document.getElementById("copy-snippet-toolbar")?.addEventListener("click", async () => {
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

  document.getElementById("save-provider-settings")?.addEventListener("click", async () => {
    try {
      await saveSettingsAndRestart();
    } catch (error) {
      setBanner(`保存配置失败：${String(error)}`, "error");
    }
  });

  document.getElementById("open-account-modal")?.addEventListener("click", () => {
    openAccountModal("oauth");
  });

  document.getElementById("close-account-modal")?.addEventListener("click", () => {
    closeAccountModal();
  });

  document.getElementById("import-local-accounts")?.addEventListener("click", async () => {
    try {
      await refresh();
      closeAccountModal();
      setBanner("已重新扫描本地 OpenClaw 授权。", "success");
    } catch (error) {
      setBanner(`重新扫描失败：${String(error)}`, "error");
    }
  });

  document.getElementById("start-codex-oauth")?.addEventListener("click", async () => {
    await startCodexOAuthFlow();
  });

  document.getElementById("submit-codex-oauth-input")?.addEventListener("click", async () => {
    try {
      await submitCodexOAuthInput();
    } catch (error) {
      setOAuthStatus(`提交失败：${String(error)}`, "error");
    }
  });

  document.getElementById("cancel-codex-oauth")?.addEventListener("click", async () => {
    await cancelCodexOAuthFlow();
  });

  document.getElementById("import-codex-json")?.addEventListener("click", async () => {
    try {
      await importCodexJson();
    } catch (error) {
      setBanner(`JSON 导入失败：${String(error)}`, "error");
    }
  });

  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-account-tab]"))) {
    node.addEventListener("click", () => {
      setAccountTab(node.dataset.accountTab ?? "import");
    });
  }

  document.getElementById("account-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeAccountModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAccountModal();
    }
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
        } else if (summary.failed > 0) {
          setBanner(`账号状态已刷新，但仍有 ${summary.failed} 项失败。`, "error");
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

    if (action === "import-openclaw-session" && button.dataset.sessionId) {
      try {
        setBanner(`正在从 ${button.dataset.sessionId} 导入桌面端账号...`, "info");
        const result = await getGatewayApi().importOpenClawSession(button.dataset.sessionId);
        await refresh();
        setBanner(`已导入桌面端 Codex 账号：${result.data.accountId ?? result.data.profileId}`, "success");
      } catch (error) {
        setBanner(`导入失败：${String(error)}`, "error");
      }
    }

    if (action === "delete-codex-account" && button.dataset.sessionId) {
      try {
        const confirmed = window.confirm("删除后将从桌面端本地账号存储中移除该 Codex 账号。是否继续？");
        if (!confirmed) {
          return;
        }
        setBanner(`正在删除桌面端 Codex 账号 ${button.dataset.sessionId} ...`, "info");
        const result = await getGatewayApi().deleteCodexAccount(button.dataset.sessionId);
        await refresh();
        setBanner(result.data.removed ? "桌面端 Codex 账号已删除。" : "目标账号不存在，已刷新列表。", "success");
      } catch (error) {
        setBanner(`删除失败：${String(error)}`, "error");
      }
    }
  });
}

async function refresh(): Promise<void> {
  const api = getGatewayApi();
  const [health, providers, sessions, settingsResponse] = await Promise.all([
    api.getHealth(),
    api.getProviders(),
    api.getSessions(),
    api.getProviderSettings(),
  ]);

  state.health = health;
  state.providers = providers;
  state.sessions = sessions;
  state.settings = settingsResponse.data;

  renderOverview();
  renderCodexAccounts();
  renderProviderRegistry();
  renderDiagnostics();
  renderErrors();
  renderGuide();
  applySettingsToForm();
  setOAuthBusyState(Boolean(state.oauthInFlight));
}

async function refreshWithLiveUsage(sessionId?: string): Promise<SessionUsageRefreshResponse | undefined> {
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
  await refresh();
  return summary;
}

void (async () => {
  try {
    bindNavigation();
    bindActions();
    setOAuthStatus("浏览器授权已准备就绪。点击下方按钮后将自动打开授权页面。", "info");
    setOAuthBusyState(false);
    setBanner("正在加载 Local AI Gateway 控制台...", "info");
    const summary = await refreshWithLiveUsage();
    if (!summary) {
      setBanner("控制台已就绪。当前桌面主进程尚未启用实时额度刷新。", "info");
    } else if (summary.failed > 0) {
      setBanner(`控制台已就绪，但实时额度刷新有 ${summary.failed} 项失败。`, "error");
    } else {
      setBanner("控制台已就绪。", "success");
    }
  } catch (error) {
    setBanner(`初始化失败：${String(error)}`, "error");
  }
})();

export {};
