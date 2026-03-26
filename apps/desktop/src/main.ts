import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";

import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell } from "electron";
import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import { ImportedCodexAccountStore, OpenClawSessionSource } from "@local-ai-gateway/openclaw-session";

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  type SessionActivitySnapshot,
  type SessionUsageRefreshSummary,
  resolveGatewayPaths,
  toIsoNow,
  type DesktopSystemSettings,
  type GatewayStoredConfig,
} from "@local-ai-gateway/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gatewayEntrypoint = join(__dirname, "../../gateway/dist/cli.js");
const preloadPath = join(__dirname, "../static/preload.cjs");
const indexHtmlPath = join(__dirname, "../static/index.html");
const gatewayPaths = resolveGatewayPaths();
const importedCodexAccountStore = new ImportedCodexAccountStore(gatewayPaths.codexProfilesPath);
const desktopSessionSource = new OpenClawSessionSource(undefined, gatewayPaths.codexProfilesPath);

type PendingCodexOAuthFlow = {
  resolveManualInput: (value: string) => void;
  rejectManualInput: (error: Error) => void;
};

let pendingCodexOAuthFlow: PendingCodexOAuthFlow | undefined;
let codexOAuthInProgress = false;

class GatewayProcessManager {
  private child?: ChildProcess;
  private managed = false;
  private ensuring?: Promise<{ managed: boolean }>;

  async ensureRunning(): Promise<{ managed: boolean }> {
    if (this.ensuring) {
      return this.ensuring;
    }

    const port = getConfiguredGatewayPort();
    if (await this.isHealthy(port)) {
      return { managed: this.managed };
    }

    this.ensuring = (async () => {
      if (!existsSync(gatewayEntrypoint)) {
        throw new Error("Gateway build output was not found. Run `npm run build` first.");
      }

      this.startManagedGateway();
      await this.waitForHealthy(port);
      return { managed: this.managed };
    })();

    try {
      return await this.ensuring;
    } finally {
      this.ensuring = undefined;
    }
  }

  async restartManaged(): Promise<void> {
    const port = getConfiguredGatewayPort();
    if (!this.child) {
      this.startManagedGateway();
      await this.waitForHealthy(port);
      return;
    }

    this.child.kill("SIGTERM");
    this.startManagedGateway();
    await this.waitForHealthy(port);
  }

  async stopManaged(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.child.kill("SIGTERM");
    this.child = undefined;
    this.managed = false;
  }

  isManaged(): boolean {
    return this.managed;
  }

  private startManagedGateway(): void {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = undefined;
    }

    const port = getConfiguredGatewayPort();
    const child = spawn("node", [gatewayEntrypoint], {
      cwd: join(__dirname, "../../.."),
      env: {
        ...process.env,
        LOCAL_AI_GATEWAY_PORT: String(port),
      },
      stdio: "ignore",
    });
    child.unref();
    child.on("exit", (code) => {
      if (this.child?.pid === child.pid) {
        this.child = undefined;
      }

      if (code === 75) {
        this.startManagedGateway();
      }
    });
    this.child = child;
    this.managed = true;
  }

  private async waitForHealthy(port: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.isHealthy(port)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (await this.isPortOccupied(port)) {
      throw new Error(
        `本地端口 ${port} 已被其他进程占用，网关无法启动。请在系统配置中更换网关端口或释放该端口后重试。`,
      );
    }

    throw new Error("Gateway did not become healthy within 15 seconds.");
  }

  private async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await fetch(`${buildGatewayBaseUrl(port)}/healthz`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async isPortOccupied(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let done = false;

      const finish = (value: boolean) => {
        if (done) {
          return;
        }
        done = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(600);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, DEFAULT_HOST);
    });
  }
}

const gatewayManager = new GatewayProcessManager();

function normalizeAutoRefreshIntervalSeconds(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 120;
  }
  return Math.max(30, Math.min(1_800, Math.round(value)));
}

function normalizeGatewayPort(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PORT;
  }

  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 65_535) {
    return DEFAULT_PORT;
  }

  return rounded;
}

function buildGatewayBaseUrl(port: number): string {
  return `http://${DEFAULT_HOST}:${port}`;
}

function readGatewayConfig(): Partial<GatewayStoredConfig> {
  if (!existsSync(gatewayPaths.configPath)) {
    return {};
  }

  return JSON.parse(readFileSync(gatewayPaths.configPath, "utf8")) as Partial<GatewayStoredConfig>;
}

function writeGatewayConfig(patch: Partial<GatewayStoredConfig>): Partial<GatewayStoredConfig> {
  const current = readGatewayConfig();
  const next = {
    ...current,
    ...patch,
    updatedAt: toIsoNow(),
  };
  writeFileSync(gatewayPaths.configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function getStoredDesktopSystemSettings(): DesktopSystemSettings {
  const settings = readGatewayConfig().desktopSettings ?? {};
  return {
    launchAtLogin: Boolean(settings.launchAtLogin),
    autoRefreshIntervalSeconds: normalizeAutoRefreshIntervalSeconds(settings.autoRefreshIntervalSeconds),
    gatewayPort: normalizeGatewayPort(settings.gatewayPort),
  };
}

function getConfiguredGatewayPort(): number {
  return normalizeGatewayPort(getStoredDesktopSystemSettings().gatewayPort);
}

function applyLoginItemSetting(launchAtLogin: boolean): void {
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: launchAtLogin,
    });
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: launchAtLogin,
    path: process.execPath,
    args: [app.getAppPath()],
  });
}

function getDesktopSystemSettings(): DesktopSystemSettings {
  const stored = getStoredDesktopSystemSettings();
  const loginItemSettings = app.isPackaged
    ? app.getLoginItemSettings()
    : app.getLoginItemSettings({
        path: process.execPath,
        args: [app.getAppPath()],
      });
  return {
    ...stored,
    launchAtLogin: loginItemSettings.openAtLogin,
    gatewayPort: normalizeGatewayPort(stored.gatewayPort),
  };
}

function readAdminToken(): string {
  const config = readGatewayConfig();
  return config.adminToken ?? "";
}

async function callAdmin(path: string, init?: RequestInit): Promise<unknown> {
  const token = readAdminToken();
  const baseUrl = buildGatewayBaseUrl(getConfiguredGatewayPort());
  if (!token) {
    throw new Error("Admin token is not available yet. Start the gateway first.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload?.error === "object" && payload.error && "message" in payload.error
        ? String(payload.error.message)
        : `Admin request failed (${response.status}) @ ${baseUrl}${path}`;
    throw new Error(message);
  }

  return payload;
}

async function buildOpenClawSnippet(): Promise<string> {
  const payload = (await callAdmin("/admin/health")) as {
    openclaw?: {
      baseUrl?: string;
      provider?: string;
      model?: string;
    };
  };

  const baseUrl = buildGatewayBaseUrl(getConfiguredGatewayPort());
  return [
    `baseUrl=${payload.openclaw?.baseUrl ?? `${baseUrl}/v1`}`,
    `provider=${payload.openclaw?.provider ?? "openai"}`,
    `model=${payload.openclaw?.model ?? "codex-default"}`,
  ].join("\n");
}

async function createWindow(): Promise<void> {
  await gatewayManager.ensureRunning();

  const window = new BrowserWindow({
    width: 980,
    height: 760,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await window.loadFile(indexHtmlPath);
}

function waitForManualCodexOAuthInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    pendingCodexOAuthFlow = {
      resolveManualInput: resolve,
      rejectManualInput: (error: Error) => reject(error),
    };
  });
}

async function withElectronFetch<T>(task: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === "string" || input instanceof URL) {
      return net.fetch(input.toString(), init);
    }
    return net.fetch(input, init);
  }) as typeof fetch;

  try {
    return await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

ipcMain.handle("gateway:get-health", async () => {
  const running = await gatewayManager.ensureRunning();
  const payload = (await callAdmin("/admin/health")) as Record<string, unknown>;
  return {
    managed: running.managed,
    ...payload,
  };
});

ipcMain.handle("gateway:get-providers", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/providers");
});

ipcMain.handle("gateway:get-provider-settings", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/config/providers");
});

ipcMain.handle("gateway:save-provider-settings", async (_event, payload: unknown) => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/config/providers", {
    method: "PUT",
    body: JSON.stringify(payload ?? {}),
  });
});

ipcMain.handle("gateway:get-sessions", async () => {
  await gatewayManager.ensureRunning();
  const payload = (await callAdmin("/admin/sessions")) as {
    activeSessionId?: string;
    data?: Array<{
      id?: string;
      activity?: SessionActivitySnapshot;
    }>;
  };
  const activityBySessionId = new Map<string, SessionActivitySnapshot | undefined>();
  for (const item of payload.data ?? []) {
    if (typeof item?.id === "string") {
      activityBySessionId.set(item.id, item.activity);
    }
  }

  const mergedSessions = desktopSessionSource.listSessions().map((session) => ({
    ...session,
    activity: activityBySessionId.get(session.id) ?? session.activity,
  }));

  return {
    activeSessionId: payload.activeSessionId,
    data: mergedSessions,
  };
});

ipcMain.handle("gateway:set-active-session", async (_event, sessionId: string) => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/sessions/active", {
    method: "PUT",
    body: JSON.stringify({ sessionId }),
  });
});

async function refreshDesktopManagedUsage(
  sessionId?: string,
): Promise<SessionUsageRefreshSummary> {
  const sessions = desktopSessionSource
    .listSessions()
    .filter(
      (session) =>
        session.status !== "invalid" && session.sourceKind === "local-import",
    );

  if (sessionId) {
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) {
      throw new Error(
        `会话 ${sessionId} 不是桌面端账号或当前不可用。请先导入为桌面端账号后再刷新。`,
      );
    }
    return desktopSessionSource.refreshUsage(target.id);
  }

  if (sessions.length === 0) {
    return {
      ok: true,
      refreshed: 0,
      failed: 0,
      data: [],
      errors: [],
    };
  }

  const representativeIds = new Map<string, string>();
  for (const session of sessions) {
    const key = session.accountId ?? session.id;
    if (!representativeIds.has(key)) {
      representativeIds.set(key, session.id);
    }
  }

  const partialResults = await Promise.all(
    Array.from(representativeIds.values()).map((id) =>
      desktopSessionSource.refreshUsage(id),
    ),
  );

  const data: SessionUsageRefreshSummary["data"] = [];
  const errors: SessionUsageRefreshSummary["errors"] = [];
  for (const result of partialResults) {
    data.push(...result.data);
    errors.push(...result.errors);
  }

  return {
    ok: errors.length === 0,
    refreshed: data.length,
    failed: errors.length,
    data,
    errors,
  };
}

ipcMain.handle("gateway:refresh-session-usage", async (_event, sessionId?: string) => {
  return refreshDesktopManagedUsage(sessionId);
});

ipcMain.handle("gateway:delete-codex-account", async (_event, sessionId: string) => {
  const removed = desktopSessionSource.deleteImportedSession(sessionId);

  await gatewayManager.ensureRunning();
  const sessionPayload = (await callAdmin("/admin/sessions")) as {
    activeSessionId?: string;
  };

  if (sessionPayload.activeSessionId === sessionId) {
    const replacement = desktopSessionSource
      .listSessions()
      .find((session) => session.status === "available");

    if (replacement) {
      await callAdmin("/admin/sessions/active", {
        method: "PUT",
        body: JSON.stringify({ sessionId: replacement.id }),
      });
    }
  }

  return {
    ok: true,
    data: removed,
  };
});

ipcMain.handle("gateway:restart", async () => {
  await gatewayManager.ensureRunning();

  if (gatewayManager.isManaged()) {
    await gatewayManager.restartManaged();
    return { ok: true, restarted: true, managed: true };
  }

  return callAdmin("/admin/service/restart", {
    method: "POST",
  });
});

ipcMain.handle("gateway:copy-openclaw-snippet", async () => {
  await gatewayManager.ensureRunning();
  clipboard.writeText(await buildOpenClawSnippet());
  return { ok: true };
});

ipcMain.handle("gateway:open-logs", async () => {
  return shell.openPath(gatewayPaths.logsDir);
});

ipcMain.handle("gateway:login-codex-oauth", async () => {
  if (codexOAuthInProgress) {
    throw new Error("已有 Codex 授权流程正在进行中。");
  }

  codexOAuthInProgress = true;
  try {
    const credentials = await withElectronFetch(() =>
      loginOpenAICodex({
        originator: "local-ai-gateway",
        onAuth: ({ url }) => {
          void shell.openExternal(url);
        },
        onPrompt: async () => {
          throw new Error("未收到授权回调。请在弹窗中粘贴完整回调地址后继续。");
        },
        onManualCodeInput: () => waitForManualCodexOAuthInput(),
        onProgress: () => {
          // 预留给后续更细的 UI 状态提示
        },
      }),
    ).catch((error: unknown) => {
      const message = toErrorMessage(error);
      if (message.includes("fetch failed")) {
        throw new Error(
          "浏览器回调已经成功，但桌面端在向 OpenAI 交换 OAuth 令牌时网络请求失败。当前版本已改用 Electron 网络栈；如果仍失败，请检查系统代理、VPN 或防火墙是否允许桌面应用访问 auth.openai.com。",
        );
      }
      throw error;
    });

    const saved = importedCodexAccountStore.upsertOAuthCredentials(credentials, {
      label:
        typeof credentials.accountId === "string" && credentials.accountId.length > 0
          ? `Codex ${credentials.accountId}`
          : "Codex 导入账号",
    });

    return {
      ok: true,
      data: {
        sessionId: `local-import:${saved.profileId}`,
        profileId: saved.profileId,
        accountId: saved.profile.accountId,
        filePath: saved.filePath,
      },
    };
  } finally {
    codexOAuthInProgress = false;
    pendingCodexOAuthFlow = undefined;
  }
});

ipcMain.handle("gateway:submit-codex-oauth-input", async (_event, input: string) => {
  if (!pendingCodexOAuthFlow) {
    throw new Error("当前没有进行中的 Codex 授权流程。");
  }

  const value = input.trim();
  if (!value) {
    throw new Error("请先粘贴完整回调地址或授权码。");
  }

  pendingCodexOAuthFlow.resolveManualInput(value);
  pendingCodexOAuthFlow = undefined;
  return { ok: true };
});

ipcMain.handle("gateway:cancel-codex-oauth", async () => {
  if (pendingCodexOAuthFlow) {
    pendingCodexOAuthFlow.rejectManualInput(new Error("用户已取消 Codex 授权流程。"));
    pendingCodexOAuthFlow = undefined;
  }
  return { ok: true };
});

ipcMain.handle("gateway:import-codex-json", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择 Codex 认证 JSON 文件",
    properties: ["openFile"],
    filters: [
      { name: "JSON 文件", extensions: ["json"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      canceled: true,
    };
  }

  const selectedPath = result.filePaths[0];
  const parsed = JSON.parse(readFileSync(selectedPath, "utf8")) as unknown;
  const imported = importedCodexAccountStore.importAccountConfigObject(parsed);
  if (imported.imported === 0 && imported.updated === 0) {
    throw new Error("所选文件中未发现可用的 openai-codex OAuth 凭据。");
  }

  return {
    ok: true,
    selectedPath,
    ...imported,
  };
});

ipcMain.handle("gateway:import-account-config", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择账号配置文件",
    properties: ["openFile"],
    filters: [
      { name: "JSON 文件", extensions: ["json"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      canceled: true,
    };
  }

  const selectedPath = result.filePaths[0];
  const parsed = JSON.parse(readFileSync(selectedPath, "utf8")) as unknown;
  const imported = importedCodexAccountStore.importAccountConfigObject(parsed);
  if (imported.imported === 0 && imported.updated === 0) {
    throw new Error("所选文件中未发现可用的 openai-codex OAuth 凭据。");
  }

  return {
    ok: true,
    selectedPath,
    ...imported,
  };
});

ipcMain.handle("gateway:import-openclaw-session", async (_event, sessionId: string) => {
  const imported = desktopSessionSource.copySessionToImportedStore(sessionId);
  return {
    ok: true,
    data: {
      sessionId: `local-import:${imported.profileId}`,
      profileId: imported.profileId,
      accountId: imported.profile.accountId,
      filePath: imported.filePath,
    },
  };
});

ipcMain.handle("gateway:get-system-settings", async () => {
  return {
    ok: true,
    data: getDesktopSystemSettings(),
  };
});

ipcMain.handle("gateway:save-system-settings", async (_event, payload: DesktopSystemSettings) => {
  const previous = getStoredDesktopSystemSettings();
  const next: DesktopSystemSettings = {
    launchAtLogin: Boolean(payload?.launchAtLogin),
    autoRefreshIntervalSeconds: normalizeAutoRefreshIntervalSeconds(payload?.autoRefreshIntervalSeconds),
    gatewayPort: normalizeGatewayPort(payload?.gatewayPort),
  };
  writeGatewayConfig({
    desktopSettings: next,
  });
  applyLoginItemSetting(next.launchAtLogin ?? false);

  if ((previous.gatewayPort ?? DEFAULT_PORT) !== (next.gatewayPort ?? DEFAULT_PORT)) {
    if (gatewayManager.isManaged()) {
      await gatewayManager.restartManaged();
    }
  }

  return {
    ok: true,
    data: getDesktopSystemSettings(),
  };
});

app.whenReady().then(() => {
  applyLoginItemSetting(getStoredDesktopSystemSettings().launchAtLogin ?? false);
  void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void gatewayManager.stopManaged().finally(() => app.quit());
  }
});
