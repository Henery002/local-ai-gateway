import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  net,
  shell,
} from "electron";
import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import { ImportedCodexAccountStore, OpenClawSessionSource } from "@local-ai-gateway/openclaw-session";
import {
  pruneDeletedAccountPoolMembers,
  type AccountDeletionTarget,
} from "./account-bulk-actions.js";

import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type GatewayInferenceObservability,
  type GatewayPoolObservability,
  type GatewayRoutingHitEvent,
  type GatewayInferenceAuthPublicSettings,
  type GatewayInferenceAuthSettings,
  type GatewayRoutingPreviewInput,
  type GatewayRoutingSettings,
  type GatewaySessionPoolDefinition,
  type GatewaySessionPoolSettings,
  type SessionActivitySnapshot,
  type SessionSummary,
  type SessionUsageRefreshSummary,
  resolveGatewayPaths,
  toIsoNow,
  type DesktopSystemSettings,
  type GatewayStoredConfig,
} from "@local-ai-gateway/shared";
import {
  createAppDataBackupBundle,
  createBackupFileName,
  getBackupBundleSizeBytes,
  getAppDataSnapshotSummary,
  parseAppDataBackupBundle,
  pruneStoredBackups,
  restoreAppDataBackupBundle,
  writeAppDataBackupBundle,
} from "./backup-utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const appContentRoot = app.isPackaged ? join(process.resourcesPath, "app.asar") : join(__dirname, "../../..");
const gatewayEntrypoint = app.isPackaged
  ? join(appContentRoot, "apps/gateway/dist/cli.js")
  : join(__dirname, "../../gateway/dist/cli.js");
const gatewayServerEntrypoint = app.isPackaged
  ? join(appContentRoot, "apps/gateway/dist/server.js")
  : join(__dirname, "../../gateway/dist/server.js");
const preloadPath = join(__dirname, "../static/preload.cjs");
const indexHtmlPath = join(__dirname, "../static/index.html");
const iconAssetDir = join(__dirname, "../assets/icons/generated");
const appIconPath = join(iconAssetDir, "app-icon.png");
const gatewayPaths = resolveGatewayPaths();
const desktopMainLogPath = join(gatewayPaths.logsDir, "desktop-main.log");
const BetterSqlite3 = require("better-sqlite3") as new (path: string) => {
  pragma: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
  };
  close: () => void;
};
const importedCodexAccountStore = new ImportedCodexAccountStore(gatewayPaths.codexProfilesPath);
const desktopSessionSource = new OpenClawSessionSource(undefined, gatewayPaths.codexProfilesPath);
const DESKTOP_UI_ZOOM_LEVEL = -1;
const BACKUP_STORE_MAX_FILES = 20;
const BACKUP_STORE_RETAIN_DAYS = 30;
const ACTIVE_TRAY_FRAME_COUNT = 12;
const ACTIVE_TRAY_FRAME_INTERVAL_MS = 180;
const TRAY_REFRESH_INTERVAL_MS = 1_200;
const TRAY_ACTIVE_WINDOW_MS = 3_000;
const TRAY_RECENT_FINISH_GRACE_MS = 1_200;
const TRAY_USAGE_REFRESH_MIN_INTERVAL_MS = 30_000;
const IGNORABLE_STDIO_ERROR_CODES = new Set(["EIO", "EPIPE", "ENXIO"]);

type TrayVisualState = "idle" | "active" | "error";
type TraySnapshot = {
  state: TrayVisualState;
  label: string;
  detail: string;
  clientLabel?: string;
  modelAlias?: string;
  activePoolName?: string;
  activePoolThreshold?: number;
  activeSessionLabel?: string;
  activeSessionQuotaPercentage?: number;
  activeSessionResetAt?: number;
  inFlightCount?: number;
  recentlyFinished?: boolean;
  usage30mTotalTokens?: number;
  usage30mRequestCount?: number;
  usage30mTopClientLabel?: string;
  lastActivityAt?: number;
};

type TrayStickyContext = {
  sessionId?: string;
  sessionLabel?: string;
  clientLabel?: string;
  modelAlias?: string;
  poolId?: string;
  poolName?: string;
  poolThreshold?: number;
  quotaPercentage?: number;
  resetAt?: number;
};

type PendingCodexOAuthFlow = {
  resolveManualInput: (value: string) => void;
  rejectManualInput: (error: Error) => void;
};

type HostedGatewayHandle = {
  close: (signal?: string) => Promise<void>;
};

let pendingCodexOAuthFlow: PendingCodexOAuthFlow | undefined;
let codexOAuthInProgress = false;
let mainWindow: BrowserWindow | undefined;
let statusTray: Tray | undefined;
let trayRefreshTimer: ReturnType<typeof setInterval> | undefined;
let trayAnimationTimer: ReturnType<typeof setInterval> | undefined;
let trayUsageRefreshTimer: ReturnType<typeof setInterval> | undefined;
let trayAnimationFrame = 0;
let trayVisualState: TrayVisualState = "idle";
let trayUsageRefreshInFlight: Promise<void> | undefined;
let lastTrayUsageRefreshAt = 0;
let trayMenuIsOpen = false;
let trayStickyContext: TrayStickyContext = {};
let allowAppQuit = false;
let hasShownMainProcessFatalDialog = false;

function appendDesktopMainLog(level: string, args: unknown[]): void {
  try {
    mkdirSync(gatewayPaths.logsDir, { recursive: true });
    const rendered = args
      .map((arg) => {
        if (typeof arg === "string") {
          return arg;
        }
        if (arg instanceof Error) {
          return arg.stack ?? arg.message;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
    appendFileSync(desktopMainLogPath, `[${toIsoNow()}] [${level}] ${rendered}\n`, "utf8");
  } catch {
    // ignore logging failures
  }
}

function isIgnorableStdioError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (maybeCode && IGNORABLE_STDIO_ERROR_CODES.has(maybeCode)) {
    return true;
  }

  const maybeMessage =
    "message" in error && typeof error.message === "string" ? error.message : "";
  return (
    maybeMessage.includes("write EIO") ||
    maybeMessage.includes("write EPIPE") ||
    maybeMessage.includes("ENXIO")
  );
}

function installStdioFaultGuards(): void {
  const mark = "__localAIGatewaySafeConsoleInstalled";
  if ((globalThis as Record<string, unknown>)[mark]) {
    return;
  }
  (globalThis as Record<string, unknown>)[mark] = true;

  const wrapConsoleMethod = <T extends (...args: unknown[]) => void>(method: T, level: string): T =>
    ((...args: unknown[]) => {
      if (app.isPackaged) {
        appendDesktopMainLog(level, args);
        return;
      }
      try {
        method(...args);
      } catch (error) {
        if (!isIgnorableStdioError(error)) {
          throw error;
        }
      }
    }) as T;

  console.log = wrapConsoleMethod(console.log.bind(console), "info");
  console.info = wrapConsoleMethod(console.info.bind(console), "info");
  console.warn = wrapConsoleMethod(console.warn.bind(console), "warn");
  console.error = wrapConsoleMethod(console.error.bind(console), "error");
  console.debug = wrapConsoleMethod(console.debug.bind(console), "debug");

  const wrapStreamWrite = (stream?: NodeJS.WriteStream) => {
    if (!stream) {
      return;
    }

    const guardedStream = stream as NodeJS.WriteStream & {
      __localAIGatewaySafeWriteInstalled?: boolean;
    };
    if (guardedStream.__localAIGatewaySafeWriteInstalled) {
      return;
    }
    guardedStream.__localAIGatewaySafeWriteInstalled = true;

    const originalWrite = guardedStream.write.bind(guardedStream);
    guardedStream.write = ((...args: Parameters<typeof originalWrite>) => {
      const callbackIndex =
        typeof args[args.length - 1] === "function" ? args.length - 1 : -1;
      const originalCallback =
        callbackIndex >= 0
          ? (args[callbackIndex] as ((error?: Error | null) => void))
          : undefined;

      if (callbackIndex >= 0 && originalCallback) {
        args[callbackIndex] = ((error?: Error | null) => {
          if (error && isIgnorableStdioError(error)) {
            return originalCallback(undefined);
          }
          return originalCallback(error);
        }) as Parameters<typeof originalWrite>[number];
      }

      try {
        return originalWrite(...args);
      } catch (error) {
        if (!isIgnorableStdioError(error)) {
          throw error;
        }
        if (originalCallback) {
          originalCallback(undefined);
        }
        return false;
      }
    }) as typeof guardedStream.write;
  };

  wrapStreamWrite(process.stdout);
  wrapStreamWrite(process.stderr);

  const swallowIgnorableStreamError = (error: Error) => {
    if (!isIgnorableStdioError(error)) {
      throw error;
    }
  };

  process.stdout?.on("error", swallowIgnorableStreamError);
  process.stderr?.on("error", swallowIgnorableStreamError);
}

installStdioFaultGuards();

function handleCapturedMainProcessError(error: unknown): void {
  if (isIgnorableStdioError(error)) {
    return;
  }

  const message = toErrorMessage(error);
  try {
    console.error("[desktop] 主进程未捕获异常:", message);
  } catch {
    // ignore logging failures
  }

  if (!hasShownMainProcessFatalDialog) {
    hasShownMainProcessFatalDialog = true;
    dialog.showErrorBox(
      "Local AI Gateway 主进程异常",
      `桌面主进程出现未捕获异常。\n\n原因：${message}\n\n如果问题持续出现，请重新安装最新构建或把该报错反馈给开发记录。`,
    );
  }
}

process.setUncaughtExceptionCaptureCallback(handleCapturedMainProcessError);

process.on("unhandledRejection", (reason) => {
  if (isIgnorableStdioError(reason)) {
    return;
  }

  try {
    console.error("[desktop] 主进程未处理 Promise 拒绝:", toErrorMessage(reason));
  } catch {
    // ignore logging failures
  }
});

class GatewayProcessManager {
  private child?: ChildProcess;
  private hostedGateway?: HostedGatewayHandle;
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
      if (!existsSync(app.isPackaged ? gatewayServerEntrypoint : gatewayEntrypoint)) {
        throw new Error("Gateway build output was not found. Run `npm run build` first.");
      }

      await this.startManagedGateway();
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
    if (!this.child && !this.hostedGateway) {
      await this.startManagedGateway();
      await this.waitForHealthy(port);
      return;
    }

    await this.stopManaged();
    await this.startManagedGateway();
    await this.waitForHealthy(port);
  }

  async stopManaged(): Promise<void> {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = undefined;
    }
    if (this.hostedGateway) {
      await this.hostedGateway.close("SIGTERM");
      this.hostedGateway = undefined;
    }
    this.managed = false;
  }

  isManaged(): boolean {
    return this.managed;
  }

  async recoverMissingPoolEndpoint(): Promise<boolean> {
    const port = getConfiguredGatewayPort();
    if (this.child) {
      await this.restartManaged();
      return true;
    }

    const pid = this.findListeningProcessId(port);
    if (!pid) {
      return false;
    }

    const command = this.readProcessCommand(pid);
    if (!this.looksLikeLocalGatewayCommand(command)) {
      return false;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await this.isPortOccupied(port))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    await this.startManagedGateway();
    await this.waitForHealthy(port);
    return true;
  }

  private async startManagedGateway(): Promise<void> {
    const port = getConfiguredGatewayPort();
    if (app.isPackaged) {
      if (this.hostedGateway) {
        await this.hostedGateway.close("restart");
        this.hostedGateway = undefined;
      }

      const { startGatewayServer } = await import(pathToFileURL(gatewayServerEntrypoint).href) as {
        startGatewayServer: (options?: {
          env?: NodeJS.ProcessEnv;
          host?: string;
          port?: number;
        }) => Promise<HostedGatewayHandle>;
      };
      this.hostedGateway = await startGatewayServer({
        env: process.env,
        port,
      });
      this.child = undefined;
      this.managed = true;
      return;
    }

    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = undefined;
    }

    const child = spawn("node", [gatewayEntrypoint], {
      cwd: appContentRoot,
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
        void this.startManagedGateway();
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

  private findListeningProcessId(port: number): number | undefined {
    try {
      const output = execFileSync(
        "lsof",
        ["-ti", `tcp:${port}`, "-sTCP:LISTEN"],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .find(Boolean);
      if (!output) {
        return undefined;
      }
      const pid = Number(output);
      return Number.isFinite(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private readProcessCommand(pid: number): string {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  }

  private looksLikeLocalGatewayCommand(command: string): boolean {
    if (!command) {
      return false;
    }
    return (
      command.includes(gatewayEntrypoint) ||
      (command.includes("apps/gateway/dist/cli.js") &&
        command.includes("local-ai-gateway"))
    );
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
    pinnedSessionId:
      typeof settings.pinnedSessionId === "string" &&
      settings.pinnedSessionId.trim().length > 0
        ? settings.pinnedSessionId.trim()
        : undefined,
  };
}

function getConfiguredGatewayPort(): number {
  return normalizeGatewayPort(getStoredDesktopSystemSettings().gatewayPort);
}

function canApplyLoginItemSetting(): boolean {
  return app.isPackaged;
}

function applyLoginItemSetting(launchAtLogin: boolean): void {
  if (!canApplyLoginItemSetting()) {
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: launchAtLogin,
      openAsHidden: true,
    });
  } catch (error) {
    console.warn(
      `[desktop] 无法更新开机自启动状态：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getDesktopSystemSettings(): DesktopSystemSettings {
  const stored = getStoredDesktopSystemSettings();
  return {
    ...stored,
    launchAtLogin: canApplyLoginItemSetting()
      ? app.getLoginItemSettings().openAtLogin
      : Boolean(stored.launchAtLogin),
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

  const headers = new Headers(init?.headers ?? undefined);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  } else if (headers.get("Content-Type")?.toLowerCase() === "application/json") {
    headers.delete("Content-Type");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
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

function isPoolEndpointMissing(error: unknown): boolean {
  const message = toErrorMessage(error);
  return message.includes("/admin/config/pools") && message.includes("404");
}

async function callAdminWithPoolCompatibility(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  try {
    return await callAdmin(path, init);
  } catch (error) {
    if (!isPoolEndpointMissing(error)) {
      throw error;
    }

    const recovered = await gatewayManager.recoverMissingPoolEndpoint();
    if (!recovered) {
      throw new Error(
        "当前运行中的本地网关缺少号池配置接口，且桌面端未能自动接管旧进程。请先点击“重启服务”，或完全退出旧网关后再重试。",
      );
    }

    return callAdmin(path, init);
  }
}

async function prunePoolsForDeletedAccounts(
  targets: readonly AccountDeletionTarget[],
): Promise<{ removedMemberCount: number; affectedPoolIds: string[] }> {
  if (targets.length === 0) {
    return {
      removedMemberCount: 0,
      affectedPoolIds: [],
    };
  }

  const poolPayload = (await callAdminWithPoolCompatibility("/admin/config/pools")) as {
    data?: GatewaySessionPoolSettings;
  };
  const currentSettings = poolPayload.data ?? {};
  const pruned = pruneDeletedAccountPoolMembers(currentSettings, targets);
  if (pruned.removedMemberCount === 0) {
    return {
      removedMemberCount: 0,
      affectedPoolIds: [],
    };
  }

  await callAdminWithPoolCompatibility("/admin/config/pools", {
    method: "PUT",
    body: JSON.stringify(pruned.settings),
  });
  return {
    removedMemberCount: pruned.removedMemberCount,
    affectedPoolIds: pruned.affectedPoolIds,
  };
}

async function buildOpenClawSnippet(): Promise<string> {
  const payload = (await callAdmin("/admin/health")) as {
    openclaw?: {
      baseUrl?: string;
      provider?: string;
      model?: string;
    };
    inferenceAuth?: GatewayInferenceAuthPublicSettings;
  };

  const baseUrl = buildGatewayBaseUrl(getConfiguredGatewayPort());
  const lines = [
    `baseUrl=${payload.openclaw?.baseUrl ?? `${baseUrl}/v1`}`,
    `provider=${payload.openclaw?.provider ?? "openai"}`,
    `model=${payload.openclaw?.model ?? "codex-default"}`,
  ];
  if (payload.inferenceAuth?.enabled) {
    lines.push("apiKey=<你的 Local AI Gateway API Key>");
  }
  return lines.join("\n");
}

function getTrayAppearance(): "dark" | "light" {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function formatClientTagLabel(clientTag?: string): string | undefined {
  if (!clientTag) {
    return undefined;
  }
  if (clientTag === "openclaw") {
    return "OpenClaw";
  }
  if (clientTag === "localraghub") {
    return "localRagHub";
  }
  if (clientTag === "unknown") {
    return "未标记";
  }
  return clientTag;
}

function formatSessionLabel(session?: SessionSummary): string | undefined {
  if (!session) {
    return undefined;
  }
  return (
    session.displayName?.trim() ||
    session.email?.trim() ||
    session.accountId?.trim() ||
    session.profileId?.trim() ||
    session.id
  );
}

function formatRelativeDuration(targetAt?: number): string | undefined {
  if (!targetAt || !Number.isFinite(targetAt)) {
    return undefined;
  }
  const diff = Math.max(0, targetAt - Date.now());
  if (diff === 0) {
    return "即将到期";
  }
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}天${hours > 0 ? ` ${hours}小时` : ""}`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes > 0 ? ` ${minutes}分钟` : ""}`;
  }
  return `${Math.max(1, minutes)}分钟`;
}

function formatRelativePast(timestamp?: number): string | undefined {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return undefined;
  }
  const diff = Math.max(0, Date.now() - timestamp);
  const totalSeconds = Math.floor(diff / 1000);
  if (totalSeconds < 5) {
    return "刚刚";
  }
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒前`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} 分钟前`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours} 小时前`;
  }
  return `${Math.floor(totalHours / 24)} 天前`;
}

function formatCompactNumber(value?: number): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(Math.round(value));
}

function buildQuotaBar(percentage?: number): string | undefined {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    return undefined;
  }
  const normalized = Math.max(0, Math.min(100, percentage));
  const filled = Math.max(0, Math.min(10, Math.round(normalized / 10)));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function getQuotaTonePrefix(percentage?: number): string {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    return "⚪";
  }
  if (percentage >= 60) {
    return "🟢";
  }
  if (percentage >= 25) {
    return "🟡";
  }
  return "🔴";
}

function formatQuotaLine(percentage?: number): string | undefined {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
    return undefined;
  }
  const quotaBar = buildQuotaBar(percentage);
  return `${getQuotaTonePrefix(percentage)} ${percentage}%${quotaBar ? `  ${quotaBar}` : ""}`;
}

function formatClientTagBadgeLabel(clientTag?: string): string | undefined {
  const label = formatClientTagLabel(clientTag);
  if (!label) {
    return undefined;
  }
  return `◉ ${label}`;
}

function getTrayUsageSummary30m() {
  const sinceTimestamp = Date.now() - 30 * 60_000;
  const database = new BetterSqlite3(gatewayPaths.dbPath);
  database.pragma("journal_mode = WAL");
  try {
    const totalsRow = database
      .prepare(
        `
          SELECT
            COUNT(1) AS request_count,
            SUM(
              CASE
                WHEN COALESCE(total_tokens, 0) > 0 THEN total_tokens
                ELSE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
              END
            ) AS total_tokens
          FROM inference_usage_events
          WHERE timestamp >= ?
        `,
      )
      .get(sinceTimestamp);
    const topClientRow = database
      .prepare(
        `
          SELECT
            COALESCE(NULLIF(client_tag, ''), 'unknown') AS client_tag,
            SUM(
              CASE
                WHEN COALESCE(total_tokens, 0) > 0 THEN total_tokens
                ELSE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
              END
            ) AS total_tokens
          FROM inference_usage_events
          WHERE timestamp >= ?
          GROUP BY client_tag
          ORDER BY total_tokens DESC
          LIMIT 1
        `,
      )
      .get(sinceTimestamp);

    return {
      totalTokens:
        typeof totalsRow?.total_tokens === "number"
          ? totalsRow.total_tokens
          : 0,
      requestCount:
        typeof totalsRow?.request_count === "number"
          ? totalsRow.request_count
          : 0,
      topClientTag:
        typeof topClientRow?.client_tag === "string"
          ? topClientRow.client_tag
          : undefined,
    };
  } finally {
    database.close();
  }
}

function resolveCurrentPool(
  poolObservability: GatewayPoolObservability[],
  currentPoolId?: string,
  activeSessionId?: string,
  latestRouting?: GatewayRoutingHitEvent,
): GatewayPoolObservability | undefined {
  if (currentPoolId) {
    const exact = poolObservability.find((pool) => pool.poolId === currentPoolId);
    if (exact) {
      return exact;
    }
  }

  const latestPoolEvent = poolObservability
    .flatMap((pool) =>
      (pool.recentEvents ?? []).map((event) => ({
        pool,
        event,
      })),
    )
    .sort((left, right) => right.event.timestamp - left.event.timestamp)[0];

  if (
    latestPoolEvent &&
    Date.now() - latestPoolEvent.event.timestamp <= TRAY_ACTIVE_WINDOW_MS * 4
  ) {
    return latestPoolEvent.pool;
  }

  if (latestRouting?.resolvedSessionId) {
    const matched = poolObservability.find(
      (pool) => pool.selectedSessionId === latestRouting.resolvedSessionId,
    );
    if (matched) {
      return matched;
    }
  }

  if (activeSessionId) {
    return poolObservability.find((pool) => pool.selectedSessionId === activeSessionId);
  }
  return undefined;
}

function getTrayIconBaseName(state: TrayVisualState, frame = 0): string {
  const appearance = getTrayAppearance();
  if (state === "active") {
    return `tray-active-${appearance}-${frame % ACTIVE_TRAY_FRAME_COUNT}`;
  }
  return `tray-${state}-${appearance}`;
}

function loadTrayIcon(state: TrayVisualState, frame = 0) {
  const iconPath = join(iconAssetDir, `${getTrayIconBaseName(state, frame)}.png`);
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return undefined;
  }
  const resized = image.resize({ width: 18, height: 18, quality: "best" });
  resized.setTemplateImage(true);
  return resized;
}

function stopTrayAnimation(): void {
  if (trayAnimationTimer) {
    clearInterval(trayAnimationTimer);
    trayAnimationTimer = undefined;
  }
  trayAnimationFrame = 0;
}

async function refreshTrayUsageIfNeeded(force = false): Promise<void> {
  const refreshIntervalMs = Math.max(
    TRAY_USAGE_REFRESH_MIN_INTERVAL_MS,
    normalizeAutoRefreshIntervalSeconds(
      getStoredDesktopSystemSettings().autoRefreshIntervalSeconds,
    ) * 1_000,
  );
  const now = Date.now();
  if (!force && now - lastTrayUsageRefreshAt < refreshIntervalMs) {
    return;
  }

  if (trayUsageRefreshInFlight) {
    return trayUsageRefreshInFlight;
  }

  trayUsageRefreshInFlight = (async () => {
    try {
      await refreshDesktopManagedUsage();
      lastTrayUsageRefreshAt = Date.now();
    } catch (error) {
      console.warn(
        `[desktop] 状态栏后台额度刷新失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      trayUsageRefreshInFlight = undefined;
    }
  })();

  return trayUsageRefreshInFlight;
}

function configureTrayUsageRefreshTimer(): void {
  if (trayUsageRefreshTimer) {
    clearInterval(trayUsageRefreshTimer);
    trayUsageRefreshTimer = undefined;
  }

  const refreshIntervalMs = Math.max(
    TRAY_USAGE_REFRESH_MIN_INTERVAL_MS,
    normalizeAutoRefreshIntervalSeconds(
      getStoredDesktopSystemSettings().autoRefreshIntervalSeconds,
    ) * 1_000,
  );

  trayUsageRefreshTimer = setInterval(() => {
    void refreshTrayUsageIfNeeded(false).finally(() => {
      void refreshTrayStatus();
    });
  }, refreshIntervalMs);
}

function applyTrayImage(state: TrayVisualState): void {
  if (!statusTray) {
    return;
  }
  const icon = loadTrayIcon(state, trayAnimationFrame);
  if (icon) {
    statusTray.setImage(icon);
  }
}

function ensureTrayAnimation(): void {
  if (!statusTray || trayAnimationTimer || trayVisualState !== "active") {
    return;
  }

  trayAnimationTimer = setInterval(() => {
    if (!statusTray || trayVisualState !== "active") {
      stopTrayAnimation();
      return;
    }
    trayAnimationFrame = (trayAnimationFrame + 1) % ACTIVE_TRAY_FRAME_COUNT;
    applyTrayImage("active");
  }, ACTIVE_TRAY_FRAME_INTERVAL_MS);
}

async function resolveTraySnapshot(): Promise<TraySnapshot> {
  try {
    await gatewayManager.ensureRunning();
    const usage30m = getTrayUsageSummary30m();
    const [healthPayload, sessionPayload, poolSettingsPayload] = await Promise.all([
      callAdmin("/admin/health") as Promise<{
        activeSessionId?: string;
        inferenceObservability?: GatewayInferenceObservability;
        routingObservability?: {
          lastMatchedAt?: number;
          matchedLast5m?: number;
          recent?: GatewayRoutingHitEvent[];
        };
        poolObservability?: GatewayPoolObservability[];
      }>,
      callAdmin("/admin/sessions") as Promise<{
        activeSessionId?: string;
        data?: SessionSummary[];
      }>,
      callAdminWithPoolCompatibility("/admin/config/pools")
        .then((payload) => payload as GatewaySessionPoolSettings)
        .catch(() => undefined),
    ]);

    const activeSessionId = healthPayload.activeSessionId ?? sessionPayload.activeSessionId;
    const inference = healthPayload.inferenceObservability;
    const routing = healthPayload.routingObservability;
    const lastMatchedAt = routing?.lastMatchedAt;
    const matchedLast5m = routing?.matchedLast5m ?? 0;
    const latestRouting = routing?.recent?.[0];
    const sessions = sessionPayload.data ?? [];
    const currentSessionId =
      inference?.currentSessionId ??
      latestRouting?.resolvedSessionId ??
      trayStickyContext.sessionId ??
      activeSessionId;
    const activeSession =
      sessions.find((session) => session.id === currentSessionId) ??
      (activeSessionId
        ? sessions.find((session) => session.id === activeSessionId)
        : undefined);
    const poolObservability = healthPayload.poolObservability ?? [];
    const currentPool = resolveCurrentPool(
      poolObservability,
      inference?.currentPoolId,
      currentSessionId,
      latestRouting,
    );
    const currentPoolDefinition = poolSettingsPayload?.pools?.find(
      (pool) => pool.id === currentPool?.poolId,
    );
    const activeSessionLabel =
      formatSessionLabel(activeSession) ?? trayStickyContext.sessionLabel;
    const clientLabel =
      formatClientTagLabel(
        inference?.currentClientTag ?? latestRouting?.clientTag,
      ) ?? trayStickyContext.clientLabel;
    const modelAlias =
      inference?.currentModelAlias ??
      latestRouting?.requestedModelAlias ??
      latestRouting?.resolvedModelAlias ??
      trayStickyContext.modelAlias;
    const isActivelyBridging = (inference?.inFlightCount ?? 0) > 0;
    const justFinished =
      !isActivelyBridging &&
      Boolean(
        inference?.lastFinishedAt &&
          Date.now() - inference.lastFinishedAt <= TRAY_RECENT_FINISH_GRACE_MS,
      );
    const usage30mTopClientLabel = usage30m.topClientTag;

    if (currentSessionId) {
      trayStickyContext.sessionId = currentSessionId;
    }
    if (activeSessionLabel) {
      trayStickyContext.sessionLabel = activeSessionLabel;
    }
    if (clientLabel) {
      trayStickyContext.clientLabel = clientLabel;
    }
    if (modelAlias) {
      trayStickyContext.modelAlias = modelAlias;
    }
    if (currentPool?.poolId || currentPool?.poolName) {
      trayStickyContext.poolId = currentPool?.poolId;
      trayStickyContext.poolName = currentPool?.poolName;
    }
    const activePoolThreshold = currentPoolDefinition?.minRemainingPercentage;
    if (typeof activePoolThreshold === "number") {
      trayStickyContext.poolThreshold = activePoolThreshold;
    }
    if (typeof activeSession?.quota?.percentage === "number") {
      trayStickyContext.quotaPercentage = activeSession.quota.percentage;
    }
    if (typeof activeSession?.quota?.resetAt === "number") {
      trayStickyContext.resetAt = activeSession.quota.resetAt;
    }

    if (!activeSessionId && !currentSessionId && !trayStickyContext.sessionLabel) {
      return {
        state: "error",
        label: "授权异常",
        detail: "当前没有可用活动账号",
        activePoolName: currentPool?.poolName ?? trayStickyContext.poolName,
      };
    }

    if (isActivelyBridging || justFinished) {
      return {
        state: "active",
        label: isActivelyBridging ? "中转桥接中" : "请求刚结束",
        detail: isActivelyBridging
          ? `正在桥接 ${clientLabel ?? "第三方客户端"} 请求`
          : "请求已完成，正在回落为空闲态",
        clientLabel,
        modelAlias,
        activePoolName: currentPool?.poolName ?? trayStickyContext.poolName,
        activePoolThreshold:
          currentPoolDefinition?.minRemainingPercentage ??
          trayStickyContext.poolThreshold,
        activeSessionLabel,
        activeSessionQuotaPercentage:
          activeSession?.quota?.percentage ?? trayStickyContext.quotaPercentage,
        activeSessionResetAt:
          activeSession?.quota?.resetAt ?? trayStickyContext.resetAt,
        inFlightCount: inference?.inFlightCount ?? 0,
        recentlyFinished: justFinished,
        usage30mTotalTokens: usage30m.totalTokens,
        usage30mRequestCount: usage30m.requestCount,
        usage30mTopClientLabel,
        lastActivityAt: inference?.lastFinishedAt ?? lastMatchedAt,
      };
    }

    return {
      state: "idle",
      label: "空闲待机",
      detail:
        matchedLast5m > 0
          ? `最近 5 分钟累计命中 ${matchedLast5m} 次`
          : "网关已就绪，当前没有新请求",
      clientLabel,
      modelAlias,
      activePoolName: currentPool?.poolName ?? trayStickyContext.poolName,
      activePoolThreshold:
        currentPoolDefinition?.minRemainingPercentage ??
        trayStickyContext.poolThreshold,
      activeSessionLabel,
      activeSessionQuotaPercentage:
        activeSession?.quota?.percentage ?? trayStickyContext.quotaPercentage,
      activeSessionResetAt:
        activeSession?.quota?.resetAt ?? trayStickyContext.resetAt,
      usage30mTotalTokens: usage30m.totalTokens,
      usage30mRequestCount: usage30m.requestCount,
      usage30mTopClientLabel,
      lastActivityAt: inference?.lastFinishedAt ?? lastMatchedAt,
    };
  } catch (error) {
    return {
      state: "error",
      label: "服务异常",
      detail: toErrorMessage(error),
    };
  }
}

async function showMainWindow(): Promise<void> {
  if (process.platform === "darwin") {
    app.dock?.show();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  try {
    await createWindow();
  } catch (error) {
    handleStartupError(error);
  }
}

function hideMainWindowToTray(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
}

async function refreshTrayStatus(showMenu = false): Promise<void> {
  if (!statusTray) {
    return;
  }

  if (showMenu) {
    await refreshTrayUsageIfNeeded(true);
  }

  const snapshot = await resolveTraySnapshot();
  trayVisualState = snapshot.state;
  if (snapshot.state === "active") {
    ensureTrayAnimation();
  } else {
    stopTrayAnimation();
  }
  applyTrayImage(snapshot.state);

  statusTray.setToolTip(`Local AI Gateway · ${snapshot.label}`);
  if (trayMenuIsOpen && !showMenu) {
    return;
  }
  const quotaLine = formatQuotaLine(snapshot.activeSessionQuotaPercentage);
  const clientTagLine = formatClientTagBadgeLabel(
    snapshot.clientLabel ?? snapshot.usage30mTopClientLabel,
  );
  const modelLine = snapshot.modelAlias ?? "codex-default";
  const usage30mLine =
    typeof snapshot.usage30mTotalTokens === "number"
      ? `${formatCompactNumber(snapshot.usage30mTotalTokens) ?? "0"} Token · ${formatCompactNumber(snapshot.usage30mRequestCount) ?? "0"} 请求`
      : undefined;
  const lastActivityLine =
    formatRelativePast(snapshot.lastActivityAt) ?? snapshot.detail;
  const poolLine = snapshot.activePoolName
    ? typeof snapshot.activePoolThreshold === "number"
      ? `${snapshot.activePoolName} · 阈值 ${snapshot.activePoolThreshold}%`
      : snapshot.activePoolName
    : undefined;
  const menu = Menu.buildFromTemplate([
      {
        label: APP_NAME,
        enabled: false,
      },
      {
        type: "separator",
      },
      {
        label: `状态 · ${snapshot.label}`,
        enabled: false,
      },
      {
        label: `活动 · ${lastActivityLine}`,
        enabled: false,
      },
      ...(typeof snapshot.inFlightCount === "number" && snapshot.inFlightCount > 0
        ? [
            {
              label: `并发 · ${snapshot.inFlightCount} 个请求`,
              enabled: false,
            },
          ]
        : []),
      ...(clientTagLine
        ? [
            {
              label: `客户端 · ${clientTagLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(snapshot.modelAlias
        ? [
            {
              label: `模型 · ${modelLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(snapshot.activeSessionLabel
        ? [
            {
              label: `账号 · ${snapshot.activeSessionLabel}`,
              enabled: false,
            },
          ]
        : []),
      ...(poolLine
        ? [
            {
              label: `号池 · ${poolLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(usage30mLine
        ? [
            {
              label: `30 分钟消耗 · ${usage30mLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(quotaLine
        ? [
            {
              label: `额度 · ${quotaLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(snapshot.activeSessionResetAt
        ? [
            {
              label: `重置 · ${formatRelativeDuration(snapshot.activeSessionResetAt) ?? "待同步"}`,
              enabled: false,
            },
          ]
        : []),
      ...(snapshot.recentlyFinished
        ? [
            {
              label: "状态 · 请求刚结束，正在回落为空闲态",
              enabled: false,
            },
          ]
        : []),
      {
        type: "separator",
      },
      {
        label: "重启本地网关",
        click: () => {
          void gatewayManager
            .restartManaged()
            .catch(() => undefined)
            .finally(() => {
              void refreshTrayStatus();
            });
        },
      },
      {
        type: "separator",
      },
      {
        label: "退出并停止网关",
        click: () => {
          allowAppQuit = true;
          app.quit();
        },
      },
    ]);
  menu.once("menu-will-show", () => {
    trayMenuIsOpen = true;
  });
  menu.once("menu-will-close", () => {
    trayMenuIsOpen = false;
  });
  statusTray.setContextMenu(menu);
  if (showMenu) {
    statusTray.popUpContextMenu(menu);
  }
}

function setupStatusTray(): void {
  if (process.platform !== "darwin" || statusTray) {
    return;
  }

  const icon = loadTrayIcon("idle");
  if (!icon) {
    return;
  }

  statusTray = new Tray(icon);
  statusTray.on("click", () => {
    void refreshTrayStatus(true);
  });
  statusTray.on("right-click", () => {
    void refreshTrayStatus(true);
  });
  nativeTheme.on("updated", () => {
    trayAnimationFrame = 0;
    void refreshTrayStatus();
  });
  configureTrayUsageRefreshTimer();
  void refreshTrayStatus();
  trayRefreshTimer = setInterval(() => {
    void refreshTrayStatus();
  }, TRAY_REFRESH_INTERVAL_MS);
}

function pruneBackupStoreDir(): void {
  pruneStoredBackups(getBackupStoreDir(), {
    maxFiles: BACKUP_STORE_MAX_FILES,
    retainDays: BACKUP_STORE_RETAIN_DAYS,
  });
}

function applyDesktopZoom(window: BrowserWindow): void {
  const lockZoom = () => {
    window.webContents.setZoomLevel(DESKTOP_UI_ZOOM_LEVEL);
  };

  void window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  lockZoom();
  window.webContents.on("did-finish-load", lockZoom);
  window.webContents.on("zoom-changed", lockZoom);
  window.webContents.on("before-input-event", (event, input) => {
    if (!(input.meta || input.control)) {
      return;
    }
    if (["+", "=", "-", "_", "0"].includes(input.key)) {
      event.preventDefault();
      lockZoom();
    }
  });
}

async function createWindow(): Promise<void> {
  await gatewayManager.ensureRunning();

  if (process.platform === "darwin" && existsSync(appIconPath)) {
    app.dock?.setIcon(appIconPath);
  }

  const window = new BrowserWindow({
    width: 980,
    height: 760,
    icon: existsSync(appIconPath) ? appIconPath : undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyDesktopZoom(window);
  mainWindow = window;
  window.on("close", (event) => {
    if (process.platform === "darwin" && !allowAppQuit) {
      event.preventDefault();
      hideMainWindowToTray();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  await window.loadFile(indexHtmlPath);
}

function handleStartupError(error: unknown): void {
  const message = toErrorMessage(error);
  console.error("[desktop] 启动失败:", message);
  dialog.showErrorBox(
    "Local AI Gateway 启动失败",
    `桌面端未能成功启动本地网关或加载控制台界面。\n\n原因：${message}\n\n请先确认当前安装包为最新版本，或重新运行“重启服务”后再试。`,
  );
  app.quit();
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

function getBackupStoreDir(): string {
  const backupDir = join(gatewayPaths.rootDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function createSafetyBackupSnapshot(): { path: string; fileCount: number; totalBytes: number } {
  const bundle = createAppDataBackupBundle(gatewayPaths, APP_VERSION);
  const targetPath = join(
    getBackupStoreDir(),
    createBackupFileName("local-ai-gateway-before-import"),
  );
  writeAppDataBackupBundle(targetPath, bundle);
  pruneBackupStoreDir();
  return {
    path: targetPath,
    fileCount: bundle.files.length,
    totalBytes: getBackupBundleSizeBytes(bundle),
  };
}

function statSafe(filePath: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

function normalizeStatNumber(value: number | bigint | undefined): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getLatestBackupSnapshot(): {
  path: string;
  fileName: string;
  createdAt?: number;
  sizeBytes?: number;
} | undefined {
  const backupDir = getBackupStoreDir();
  const latest = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const absolutePath = join(backupDir, entry.name);
      const stat = statSafe(absolutePath);
      return {
        path: absolutePath,
        fileName: entry.name,
        createdAt: normalizeStatNumber(stat?.mtimeMs),
        sizeBytes: normalizeStatNumber(stat?.size),
      };
    })
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0];

  return latest;
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

ipcMain.handle("gateway:get-usage-summary", async (_event, clientFilter?: string) => {
  await gatewayManager.ensureRunning();
  const params = new URLSearchParams();
  if (typeof clientFilter === "string" && clientFilter.trim()) {
    params.set("clientFilter", clientFilter.trim());
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return callAdmin(`/admin/usage/summary${query}`);
});

ipcMain.handle("gateway:get-access-alerts", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/access/alerts");
});

ipcMain.handle("gateway:acknowledge-access-alert", async (_event, id: number) => {
  await gatewayManager.ensureRunning();
  const normalizedId = Number.isFinite(id) ? Math.floor(id) : 0;
  if (normalizedId <= 0) {
    throw new Error("Access alert id is invalid.");
  }
  return callAdmin(`/admin/access/alerts/${normalizedId}/acknowledge`, {
    method: "POST",
    body: JSON.stringify({ acknowledgedBy: "desktop-admin" }),
  });
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

ipcMain.handle("gateway:get-routing-settings", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/config/routing");
});

ipcMain.handle("gateway:save-routing-settings", async (_event, payload: GatewayRoutingSettings) => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/config/routing", {
    method: "PUT",
    body: JSON.stringify(payload ?? {}),
  });
});

ipcMain.handle("gateway:preview-routing", async (_event, payload: GatewayRoutingPreviewInput) => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/config/routing/preview", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
});

ipcMain.handle("gateway:get-pool-settings", async () => {
  await gatewayManager.ensureRunning();
  return callAdminWithPoolCompatibility("/admin/config/pools");
});

ipcMain.handle("gateway:save-pool-settings", async (_event, payload: GatewaySessionPoolSettings) => {
  await gatewayManager.ensureRunning();
  return callAdminWithPoolCompatibility("/admin/config/pools", {
    method: "PUT",
    body: JSON.stringify(payload ?? {}),
  });
});

ipcMain.handle("gateway:get-security-settings", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/config/security");
});

ipcMain.handle(
  "gateway:save-security-settings",
  async (_event, payload: GatewayInferenceAuthSettings) => {
    await gatewayManager.ensureRunning();
    return callAdmin("/admin/config/security", {
      method: "PUT",
      body: JSON.stringify(payload ?? {}),
    });
  },
);

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
  const result = await callAdmin("/admin/sessions/active", {
    method: "PUT",
    body: JSON.stringify({ sessionId }),
  });
  void refreshTrayStatus();
  return result;
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

ipcMain.handle("gateway:reset-telemetry", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/telemetry/reset", {
    method: "POST",
    body: JSON.stringify({}),
  });
});

ipcMain.handle("gateway:delete-codex-account", async (_event, sessionId: string) => {
  const targetSession = desktopSessionSource
    .listSessions()
    .find((session) => session.id === sessionId);
  const deletionTargets: AccountDeletionTarget[] = targetSession
    ? [
        {
          sessionId: targetSession.id,
          profileId: targetSession.profileId,
          accountId: targetSession.accountId,
        },
      ]
    : [];
  const removed = desktopSessionSource.deleteImportedSession(sessionId);

  await gatewayManager.ensureRunning();
  const poolCleanup = await prunePoolsForDeletedAccounts(deletionTargets);
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

  void refreshTrayStatus();
  return {
    ok: true,
    data: {
      ...removed,
      poolCleanup,
    },
  };
});

ipcMain.handle("gateway:restart", async () => {
  await gatewayManager.ensureRunning();

  if (gatewayManager.isManaged()) {
    await gatewayManager.restartManaged();
    void refreshTrayStatus();
    return { ok: true, restarted: true, managed: true };
  }

  const result = await callAdmin("/admin/service/restart", {
    method: "POST",
  });
  void refreshTrayStatus();
  return result;
});

ipcMain.handle("gateway:copy-openclaw-snippet", async () => {
  await gatewayManager.ensureRunning();
  clipboard.writeText(await buildOpenClawSnippet());
  return { ok: true };
});

ipcMain.handle("gateway:copy-text", async (_event, text: string) => {
  clipboard.writeText(String(text ?? ""));
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

ipcMain.handle("gateway:export-app-data", async () => {
  const snapshot = getAppDataSnapshotSummary(gatewayPaths);
  const result = await dialog.showSaveDialog({
    title: "导出 Local AI Gateway 应用数据",
    defaultPath: join(
      app.getPath("downloads"),
      createBackupFileName("local-ai-gateway-backup"),
    ),
    filters: [{ name: "Local AI Gateway 备份", extensions: ["json"] }],
  });

  if (result.canceled || !result.filePath) {
    return {
      ok: false,
      canceled: true,
    };
  }

  const bundle = createAppDataBackupBundle(gatewayPaths, APP_VERSION);
  writeAppDataBackupBundle(result.filePath, bundle);
  return {
    ok: true,
    selectedPath: result.filePath,
    fileCount: bundle.files.length,
    totalBytes: getBackupBundleSizeBytes(bundle),
    snapshot,
  };
});

ipcMain.handle("gateway:get-app-data-status", async () => {
  const snapshot = getAppDataSnapshotSummary(gatewayPaths);
  const latestBackup = getLatestBackupSnapshot();
  return {
    ok: true,
    data: {
      rootDir: gatewayPaths.rootDir,
      backupDir: getBackupStoreDir(),
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      latestBackup,
    },
  };
});

ipcMain.handle("gateway:open-backups-folder", async () => {
  return shell.openPath(getBackupStoreDir());
});

ipcMain.handle("gateway:preview-import-app-data", async () => {
  const result = await dialog.showOpenDialog({
    title: "导入 Local AI Gateway 应用数据",
    properties: ["openFile"],
    filters: [{ name: "Local AI Gateway 备份", extensions: ["json"] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      canceled: true,
    };
  }

  const selectedPath = result.filePaths[0]!;
  const bundle = parseAppDataBackupBundle(readFileSync(selectedPath, "utf8"));
  return {
    ok: true,
    canceled: false,
    data: {
      selectedPath,
      fileName: basename(selectedPath),
      exportedAt: bundle.exportedAt,
      appVersion: bundle.appVersion,
      fileCount: bundle.files.length,
      totalBytes: getBackupBundleSizeBytes(bundle),
    },
  };
});

ipcMain.handle("gateway:import-app-data", async (_event, selectedPath?: string) => {
  let targetPath = selectedPath?.trim();
  if (!targetPath) {
    const result = await dialog.showOpenDialog({
      title: "导入 Local AI Gateway 应用数据",
      properties: ["openFile"],
      filters: [{ name: "Local AI Gateway 备份", extensions: ["json"] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        canceled: true,
      };
    }

    targetPath = result.filePaths[0]!;
  }

  if (!targetPath) {
    return {
      ok: false,
      canceled: true,
    };
  }

  const bundle = parseAppDataBackupBundle(readFileSync(targetPath, "utf8"));
  const safetyBackup = createSafetyBackupSnapshot();
  const wasManaged = gatewayManager.isManaged();

  if (wasManaged) {
    await gatewayManager.stopManaged();
  }

  const restored = restoreAppDataBackupBundle(gatewayPaths, bundle);
  applyLoginItemSetting(getStoredDesktopSystemSettings().launchAtLogin ?? false);

  let managedRestarted = false;
  let requiresManualRestart = false;
  if (wasManaged) {
    await gatewayManager.ensureRunning();
    managedRestarted = true;
  } else {
    requiresManualRestart = true;
  }

  void refreshTrayStatus();
  return {
    ok: true,
    selectedPath: targetPath,
    safetyBackupPath: safetyBackup.path,
    restoredFiles: restored.restoredFiles,
    restoredBytes: restored.restoredBytes,
    managedRestarted,
    requiresManualRestart,
  };
});

ipcMain.handle("gateway:save-system-settings", async (_event, payload: DesktopSystemSettings) => {
  const previous = getStoredDesktopSystemSettings();
  const next: DesktopSystemSettings = {
    launchAtLogin:
      typeof payload?.launchAtLogin === "boolean"
        ? payload.launchAtLogin
        : previous.launchAtLogin,
    autoRefreshIntervalSeconds:
      typeof payload?.autoRefreshIntervalSeconds === "number"
        ? normalizeAutoRefreshIntervalSeconds(payload.autoRefreshIntervalSeconds)
        : previous.autoRefreshIntervalSeconds,
    gatewayPort:
      typeof payload?.gatewayPort === "number"
        ? normalizeGatewayPort(payload.gatewayPort)
        : previous.gatewayPort,
    pinnedSessionId:
      typeof payload?.pinnedSessionId === "string" &&
      payload.pinnedSessionId.trim().length > 0
        ? payload.pinnedSessionId.trim()
        : undefined,
  };
  writeGatewayConfig({
    desktopSettings: next,
  });
  applyLoginItemSetting(next.launchAtLogin ?? false);
  configureTrayUsageRefreshTimer();

  if ((previous.gatewayPort ?? DEFAULT_PORT) !== (next.gatewayPort ?? DEFAULT_PORT)) {
    if (gatewayManager.isManaged()) {
      await gatewayManager.restartManaged();
    }
  }

  void refreshTrayStatus();
  return {
    ok: true,
    data: getDesktopSystemSettings(),
  };
});

app.whenReady().then(() => {
  const launchedAtLogin =
    canApplyLoginItemSetting() && app.getLoginItemSettings().wasOpenedAtLogin;
  applyLoginItemSetting(getStoredDesktopSystemSettings().launchAtLogin ?? false);
  pruneBackupStoreDir();
  setupStatusTray();
  if (launchedAtLogin) {
    if (process.platform === "darwin") {
      app.dock?.hide();
    }
    return;
  }
  void createWindow().catch(handleStartupError);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().catch(handleStartupError);
    return;
  }

  void showMainWindow();
});

app.on("before-quit", (event) => {
  if (process.platform === "darwin" && !allowAppQuit) {
    event.preventDefault();
    hideMainWindowToTray();
    return;
  }
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
    trayRefreshTimer = undefined;
  }
  if (trayUsageRefreshTimer) {
    clearInterval(trayUsageRefreshTimer);
    trayUsageRefreshTimer = undefined;
  }
  stopTrayAnimation();
  statusTray?.destroy();
  statusTray = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void gatewayManager.stopManaged().finally(() => app.quit());
  }
});
