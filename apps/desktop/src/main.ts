import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { networkInterfaces } from "node:os";
import {
  appendFileSync,
  chmodSync,
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
  Notification,
  shell,
  type MessageBoxOptions,
  type MenuItemConstructorOptions,
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
const launchAgentsDir = join(app.getPath("home"), "Library", "LaunchAgents");
const GATEWAY_SERVICE_LABEL = "com.relaygate.gateway";
const CLOUDFLARED_SERVICE_LABEL = "com.local-ai-gateway.cloudflared";
const LEGACY_DEV_GATEWAY_SERVICE_LABELS = [
  "com.local-ai-gateway.gateway",
  "com.local-ai-gateway.gateway.devsource",
];
const gatewayServiceDir = join(gatewayPaths.rootDir, "service");
const gatewayServiceLauncherPath = join(gatewayServiceDir, "gateway-launcher.mjs");
const gatewayServiceRunnerPath = join(gatewayServiceDir, "gateway-service-runner.mjs");
const gatewayServicePlistPath = join(launchAgentsDir, `${GATEWAY_SERVICE_LABEL}.plist`);
const gatewayServiceOutLogPath = join(gatewayPaths.logsDir, "gateway-service.out.log");
const gatewayServiceErrLogPath = join(gatewayPaths.logsDir, "gateway-service.err.log");
const ELECTRON_RUN_AS_NODE_ENV_KEY = "ELECTRON_RUN_AS_NODE";
const cloudflaredPlistPath = join(launchAgentsDir, `${CLOUDFLARED_SERVICE_LABEL}.plist`);
const cloudflaredDir = join(gatewayPaths.rootDir, "cloudflared");
const cloudflaredLogPath = join(cloudflaredDir, "local-ai-gateway-dev.log");
const cloudflaredOutLogPath = join(cloudflaredDir, "local-ai-gateway-dev.launchd.out.log");
const cloudflaredErrLogPath = join(cloudflaredDir, "local-ai-gateway-dev.launchd.err.log");
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
const TRAY_REFRESH_INTERVAL_MS = 15_000;
const TRAY_ACTIVE_WINDOW_MS = 3_000;
const TRAY_RECENT_FINISH_GRACE_MS = 1_200;
const TRAY_USAGE_REFRESH_MIN_INTERVAL_MS = 30_000;
const GATEWAY_HEALTH_PROBE_TIMEOUT_MS = 1_500;
const IGNORABLE_STDIO_ERROR_CODES = new Set(["EIO", "EPIPE", "ENXIO"]);
const GATEWAY_HEALTH_WAIT_TIMEOUT_MS = 45_000;

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
  publicAccessEnabled?: boolean;
  publicBaseUrl?: string;
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

function quitControlConsole(): void {
  allowAppQuit = true;
  app.quit();
}
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
      "RelayGate 主进程异常",
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

type LaunchAgentStatus = {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  disabled?: boolean;
  running: boolean;
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  error?: string;
};

type GatewayServiceStatus = LaunchAgentStatus & {
  port: number;
  baseUrl: string;
  launcherPath: string;
  outLogPath: string;
  errLogPath: string;
  endpointHealthy: boolean;
  portProcess?: {
    pid: number;
    command: string;
    localGateway: boolean;
  };
};

type OperationsLogSource = {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes?: number;
  updatedAt?: number;
};

type GatewayServiceAction = "install" | "start" | "stop" | "restart" | "repair";
type CloudflareServiceAction = "start" | "stop" | "restart";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getLaunchctlDomain(): string {
  const uid =
    typeof process.getuid === "function"
      ? process.getuid()
      : Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim());
  return `gui/${uid}`;
}

function getLaunchctlServiceTarget(label: string): string {
  return `${getLaunchctlDomain()}/${label}`;
}

function execText(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryExecText(command: string, args: string[]): string | undefined {
  try {
    return execText(command, args);
  } catch {
    return undefined;
  }
}

function tryExecFile(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function findListeningProcessId(port: number): number | undefined {
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

function readProcessCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function looksLikeRelayGateDesktopMainCommand(command: string): boolean {
  if (
    command.includes("gateway-service-runner.mjs") ||
    command.includes("gateway-launcher.mjs") ||
    command.includes("apps/gateway/dist/cli.js") ||
    command.includes("apps/gateway/dist/server.js") ||
    command.includes("app.asar/apps/gateway/dist/cli.js") ||
    command.includes("app.asar/apps/gateway/dist/server.js")
  ) {
    return false;
  }

  return (
    (
      command.includes("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron") &&
      command.includes("apps/desktop/dist/main.js")
    ) ||
    command.includes("Local AI Gateway.app/Contents/MacOS/Local AI Gateway") ||
    command.includes("RelayGate.app/Contents/MacOS/RelayGate")
  );
}

function terminateStaleDesktopMainProcesses(): void {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return;
  }

  const currentPid = process.pid;
  const parentPid = process.ppid;
  for (const line of output.split("\n")) {
    const match = line.trimStart().match(/^(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (
      !Number.isFinite(pid) ||
      pid === currentPid ||
      pid === parentPid ||
      !looksLikeRelayGateDesktopMainCommand(command)
    ) {
      continue;
    }

    try {
      process.kill(pid, "SIGTERM");
      appendDesktopMainLog("info", [
        "terminated_stale_desktop_process",
        { pid, command },
      ]);
    } catch (error) {
      appendDesktopMainLog("warn", [
        "failed_to_terminate_stale_desktop_process",
        { pid, error: toErrorMessage(error) },
      ]);
    }
  }
}

function looksLikeLocalGatewayCommand(command: string): boolean {
  if (!command) {
    return false;
  }
  return (
    command.includes(gatewayEntrypoint) ||
    command.includes(gatewayServerEntrypoint) ||
    command.includes(gatewayServiceLauncherPath) ||
    command.includes(gatewayServiceRunnerPath) ||
    command.includes("apps/gateway/src/cli.ts") ||
    command.includes("apps/gateway/src/server.ts") ||
    command.includes("apps/gateway/dist/cli.js") ||
    command.includes("apps/gateway/dist/server.js") ||
    command.includes("app.asar/apps/gateway/dist/cli.js") ||
    command.includes("app.asar/apps/gateway/dist/server.js")
  );
}

function isKnownLocalGatewayProcess(pid: number, knownGatewayPids?: Iterable<number | undefined>): boolean {
  if (!knownGatewayPids) {
    return false;
  }
  for (const knownPid of knownGatewayPids) {
    if (typeof knownPid === "number" && Number.isFinite(knownPid) && knownPid === pid) {
      return true;
    }
  }
  return false;
}

async function waitUntilPortFree(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findListeningProcessId(port)) {
      return true;
    }
    await sleep(200);
  }
  return !findListeningProcessId(port);
}

async function killLocalGatewayProcessOnPort(
  port: number,
  options: { knownGatewayPids?: Iterable<number | undefined> } = {},
): Promise<{ killed: boolean; pid?: number; command?: string; blocked?: boolean }> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const pid = findListeningProcessId(port);
    if (!pid || pid === process.pid) {
      return { killed: false };
    }

    const command = readProcessCommand(pid);
    const localGateway =
      looksLikeLocalGatewayCommand(command) ||
      isKnownLocalGatewayProcess(pid, options.knownGatewayPids);

    if (!command && !localGateway) {
      await sleep(200);
      continue;
    }

    if (!localGateway) {
      return { killed: false, pid, command, blocked: true };
    }

    try {
      process.kill(pid, "SIGTERM");
      const stopped = await waitUntilPortFree(port);
      if (!stopped) {
        process.kill(pid, "SIGKILL");
        await waitUntilPortFree(port, 2_000);
      }
      return { killed: true, pid, command };
    } catch {
      return { killed: false, pid, command, blocked: true };
    }
  }

  const pid = findListeningProcessId(port);
  return { killed: false, pid, command: pid ? readProcessCommand(pid) : undefined };
}

function parseLaunchAgentStatus(
  label: string,
  plistPath: string,
): LaunchAgentStatus {
  const installed = existsSync(plistPath);
  const target = getLaunchctlServiceTarget(label);
  const disabled = isLaunchAgentDisabled(label);
  try {
    const output = execText("launchctl", ["print", target]);
    const state = output.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
    const pidText = output.match(/\bpid = (\d+)/)?.[1];
    const lastExitText = output.match(/\blast exit code = (-?\d+)/)?.[1];
    const pid = pidText ? Number(pidText) : undefined;
    const lastExitStatus = lastExitText ? Number(lastExitText) : undefined;
    return {
      label,
      plistPath,
      installed,
      disabled,
      loaded: true,
      running: state === "running",
      state,
      pid: Number.isFinite(pid) ? pid : undefined,
      lastExitStatus: Number.isFinite(lastExitStatus) ? lastExitStatus : undefined,
    };
  } catch (error) {
    return {
      label,
      plistPath,
      installed,
      disabled,
      loaded: false,
      running: false,
      state: installed ? "unloaded" : "missing",
      error: installed ? undefined : toErrorMessage(error),
    };
  }
}

function isLaunchAgentDisabled(label: string): boolean | undefined {
  try {
    const output = execText("launchctl", ["print-disabled", getLaunchctlDomain()]);
    const pattern = new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*(enabled|disabled)`);
    const match = output.match(pattern);
    return match ? match[1] === "disabled" : undefined;
  } catch {
    return undefined;
  }
}

function enableLaunchAgent(label: string): void {
  tryExecFile("launchctl", ["enable", getLaunchctlServiceTarget(label)]);
}

function disableLaunchAgent(label: string): void {
  tryExecFile("launchctl", ["disable", getLaunchctlServiceTarget(label)]);
}

function stopLegacyDevGatewayLaunchAgents(): void {
  for (const label of LEGACY_DEV_GATEWAY_SERVICE_LABELS) {
    bootoutLaunchAgent(label);
    disableLaunchAgent(label);
  }
}

function bootstrapLaunchAgent(label: string, plistPath: string): void {
  enableLaunchAgent(label);
  try {
    execFileSync("launchctl", ["bootstrap", getLaunchctlDomain(), plistPath], {
      stdio: "pipe",
    });
  } catch (error) {
    enableLaunchAgent(label);
    if (!parseLaunchAgentStatus(label, plistPath).loaded) {
      execFileSync("launchctl", ["bootstrap", getLaunchctlDomain(), plistPath], {
        stdio: "pipe",
      });
    }
  }
  enableLaunchAgent(label);
}

function bootoutLaunchAgent(label: string): void {
  tryExecFile("launchctl", ["bootout", getLaunchctlServiceTarget(label)]);
}

function kickstartLaunchAgent(label: string): void {
  execFileSync("launchctl", ["kickstart", "-k", getLaunchctlServiceTarget(label)], {
    stdio: "pipe",
  });
}

function tryKickstartLaunchAgent(label: string): boolean {
  return tryExecFile("launchctl", ["kickstart", "-k", getLaunchctlServiceTarget(label)]);
}

async function waitForLaunchAgentLoaded(
  label: string,
  plistPath: string,
  timeoutMs = 8_000,
): Promise<LaunchAgentStatus> {
  const deadline = Date.now() + timeoutMs;
  let latest = parseLaunchAgentStatus(label, plistPath);
  while (Date.now() < deadline) {
    latest = parseLaunchAgentStatus(label, plistPath);
    if (latest.loaded) {
      return latest;
    }
    await sleep(300);
  }
  return latest;
}

async function waitForLaunchAgentRunning(
  label: string,
  plistPath: string,
  timeoutMs = 10_000,
): Promise<LaunchAgentStatus> {
  const deadline = Date.now() + timeoutMs;
  let latest = parseLaunchAgentStatus(label, plistPath);
  while (Date.now() < deadline) {
    latest = parseLaunchAgentStatus(label, plistPath);
    if (latest.running) {
      return latest;
    }
    await sleep(400);
  }
  return latest;
}

function resolveNodeExecutable(): string {
  const nvmNodePath = join(
    app.getPath("home"),
    ".nvm/versions/node/v22.22.0/bin/node",
  );
  const candidates = [
    process.env.LOCAL_AI_GATEWAY_NODE_PATH,
    process.env.npm_node_execpath,
    basename(process.execPath) === "node" ? process.execPath : undefined,
    nvmNodePath,
    tryExecText("/bin/zsh", ["-lc", "command -v node"])?.trim(),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].filter((item): item is string => Boolean(item && item.trim()));

  for (const candidate of Array.from(new Set(candidates))) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "未找到可用于 LaunchAgent 的 Node.js 可执行文件。请确认 `node` 已安装，或设置 LOCAL_AI_GATEWAY_NODE_PATH。",
  );
}

function resolveGatewayEntrypointCandidates(): string[] {
  const devRepoEntrypoint = join(
    app.getPath("home"),
    "code/local-ai-gateway/apps/gateway/dist/cli.js",
  );
  return Array.from(
    new Set([
      gatewayEntrypoint,
      devRepoEntrypoint,
    ]),
  );
}

function resolveGatewayServerEntrypointCandidates(): string[] {
  const installedAppServerEntrypoint = join(
    "/Applications",
    "Local AI Gateway.app",
    "Contents",
    "Resources",
    "app.asar",
    "apps/gateway/dist/server.js",
  );
  const devRepoServerEntrypoint = join(
    app.getPath("home"),
    "code/local-ai-gateway/apps/gateway/dist/server.js",
  );
  return Array.from(
    new Set([
      gatewayServerEntrypoint,
      installedAppServerEntrypoint,
      devRepoServerEntrypoint,
    ]),
  );
}

function writeGatewayServiceLauncher(): void {
  mkdirSync(gatewayServiceDir, { recursive: true });
  mkdirSync(gatewayPaths.logsDir, { recursive: true });
  const candidates = JSON.stringify(resolveGatewayEntrypointCandidates(), null, 2);
  const script = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const port = Number(process.env.LOCAL_AI_GATEWAY_PORT || "${DEFAULT_PORT}");
const candidates = ${candidates};

function read(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function findListeningPid() {
  try {
    const output = read("lsof", ["-ti", \`tcp:\${port}\`, "-sTCP:LISTEN"]).trim().split("\\n").find(Boolean);
    const pid = Number(output);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function readCommand(pid) {
  try {
    return read("ps", ["-p", String(pid), "-o", "command="]).trim();
  } catch {
    return "";
  }
}

function looksLikeGateway(command) {
  return command.includes("apps/gateway/src/cli.ts") ||
    command.includes("apps/gateway/src/server.ts") ||
    command.includes("apps/gateway/dist/cli.js") ||
    command.includes("apps/gateway/dist/server.js") ||
    command.includes("app.asar/apps/gateway/dist/cli.js") ||
    command.includes("app.asar/apps/gateway/dist/server.js") ||
    command.includes("gateway-launcher.mjs") ||
    command.includes("gateway-service-runner.mjs");
}

async function waitForPortFree(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findListeningPid()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !findListeningPid();
}

const pid = findListeningPid();
if (pid && pid !== process.pid) {
  const command = readCommand(pid);
  if (looksLikeGateway(command)) {
    try {
      process.kill(pid, "SIGTERM");
      const stopped = await waitForPortFree();
      if (!stopped) {
        process.kill(pid, "SIGKILL");
        await waitForPortFree(2000);
      }
    } catch (error) {
      console.error("[gateway-service] failed to stop previous gateway process:", error?.message || error);
    }
  }
}

const entrypoint = candidates.find((candidate) => existsSync(candidate));
if (!entrypoint) {
  console.error("[gateway-service] gateway entrypoint not found:", candidates.join(", "));
  process.exit(75);
}

const child = spawn(process.execPath, [entrypoint], {
  cwd: dirname(entrypoint),
  env: {
    ...process.env,
    LOCAL_AI_GATEWAY_PORT: String(port),
    LOCAL_AI_GATEWAY_SERVICE: "1",
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(typeof code === "number" ? code : 1);
});
`;
  writeFileSync(gatewayServiceLauncherPath, script, "utf8");
  chmodSync(gatewayServiceLauncherPath, 0o755);
}

function writeGatewayServiceRunner(): void {
  mkdirSync(gatewayServiceDir, { recursive: true });
  mkdirSync(gatewayPaths.logsDir, { recursive: true });
  const candidates = JSON.stringify(resolveGatewayServerEntrypointCandidates(), null, 2);
  const script = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const port = Number(process.env.LOCAL_AI_GATEWAY_PORT || "${DEFAULT_PORT}");
const candidates = ${candidates};

function read(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function findListeningPid() {
  try {
    const output = read("lsof", ["-ti", \`tcp:\${port}\`, "-sTCP:LISTEN"]).trim().split("\\n").find(Boolean);
    const pid = Number(output);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function readCommand(pid) {
  try {
    return read("ps", ["-p", String(pid), "-o", "command="]).trim();
  } catch {
    return "";
  }
}

function looksLikeGateway(command) {
  return command.includes("apps/gateway/src/cli.ts") ||
    command.includes("apps/gateway/src/server.ts") ||
    command.includes("apps/gateway/dist/cli.js") ||
    command.includes("apps/gateway/dist/server.js") ||
    command.includes("app.asar/apps/gateway/dist/cli.js") ||
    command.includes("app.asar/apps/gateway/dist/server.js") ||
    command.includes("gateway-launcher.mjs") ||
    command.includes("gateway-service-runner.mjs");
}

async function waitForPortFree(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findListeningPid()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !findListeningPid();
}

const pid = findListeningPid();
if (pid && pid !== process.pid) {
  const command = readCommand(pid);
  if (looksLikeGateway(command)) {
    try {
      process.kill(pid, "SIGTERM");
      const stopped = await waitForPortFree();
      if (!stopped) {
        process.kill(pid, "SIGKILL");
        await waitForPortFree(2000);
      }
    } catch (error) {
      console.error("[gateway-service] failed to stop previous gateway process:", error?.message || error);
    }
  }
}

const entrypoint = candidates.find((candidate) => existsSync(candidate));
if (!entrypoint) {
  console.error("[gateway-service] gateway server entrypoint not found:", candidates.join(", "));
  process.exit(75);
}

const { startGatewayServer } = await import(pathToFileURL(entrypoint).href);
const handle = await startGatewayServer({
  env: {
    ...process.env,
    LOCAL_AI_GATEWAY_PORT: String(port),
    LOCAL_AI_GATEWAY_SERVICE: "1",
  },
  port,
});

console.log("[gateway-service] gateway server started", JSON.stringify({ host: handle.host, port: handle.port, pid: process.pid }));

let closing = false;
async function close(signal) {
  if (closing) {
    return;
  }
  closing = true;
  try {
    await handle.close(signal);
  } catch (error) {
    console.error("[gateway-service] failed to close gateway server:", error?.message || error);
  } finally {
    process.exit(0);
  }
}

process.once("SIGTERM", () => void close("SIGTERM"));
process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGHUP", () => void close("SIGHUP"));
`;
  writeFileSync(gatewayServiceRunnerPath, script, "utf8");
  chmodSync(gatewayServiceRunnerPath, 0o755);
}

function writeGatewayServiceFiles(): void {
  if (app.isPackaged) {
    writeGatewayServiceRunner();
    return;
  }
  writeGatewayServiceLauncher();
}

function getGatewayServiceProgramArguments(): string[] {
  if (app.isPackaged) {
    try {
      return [resolveNodeExecutable(), gatewayServiceRunnerPath];
    } catch {
      return [app.getPath("exe"), gatewayServiceRunnerPath];
    }
  }
  return [resolveNodeExecutable(), gatewayServiceLauncherPath];
}

function getGatewayServiceEnvironment(port: number): Record<string, string> {
  const programArguments = getGatewayServiceProgramArguments();
  return {
    LOCAL_AI_GATEWAY_PORT: String(port),
    LOCAL_AI_GATEWAY_SERVICE: "1",
    ...(programArguments[0] === app.getPath("exe")
      ? { [ELECTRON_RUN_AS_NODE_ENV_KEY]: "1" }
      : {}),
  };
}

function writeGatewayServicePlist(): void {
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(gatewayPaths.logsDir, { recursive: true });
  const port = getConfiguredGatewayPort();
  const programArguments = getGatewayServiceProgramArguments()
    .map((item) => `    <string>${xmlEscape(item)}</string>`)
    .join("\n");
  const environmentVariables = Object.entries(getGatewayServiceEnvironment(port))
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(GATEWAY_SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentVariables}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(gatewayPaths.rootDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(gatewayServiceOutLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(gatewayServiceErrLogPath)}</string>
</dict>
</plist>
`;
  writeFileSync(gatewayServicePlistPath, plist, "utf8");
}

function getPortProcess(port: number): GatewayServiceStatus["portProcess"] {
  const pid = findListeningProcessId(port);
  if (!pid) {
    return undefined;
  }
  const command = readProcessCommand(pid);
  return {
    pid,
    command,
    localGateway: looksLikeLocalGatewayCommand(command),
  };
}

function buildGatewayServiceStatus(endpointHealthy = false): GatewayServiceStatus {
  const port = getConfiguredGatewayPort();
  return {
    ...parseLaunchAgentStatus(GATEWAY_SERVICE_LABEL, gatewayServicePlistPath),
    port,
    baseUrl: buildGatewayBaseUrl(port),
    launcherPath: app.isPackaged ? gatewayServiceRunnerPath : gatewayServiceLauncherPath,
    outLogPath: gatewayServiceOutLogPath,
    errLogPath: gatewayServiceErrLogPath,
    endpointHealthy,
    portProcess: getPortProcess(port),
  };
}

class GatewayServiceManager {
  isInstalled(): boolean {
    return existsSync(gatewayServicePlistPath);
  }

  async status(): Promise<GatewayServiceStatus> {
    const port = getConfiguredGatewayPort();
    return buildGatewayServiceStatus(await isGatewayEndpointHealthy(port));
  }

  async installAndStart(): Promise<GatewayServiceStatus> {
    const port = getConfiguredGatewayPort();
    const previousServicePid = parseLaunchAgentStatus(
      GATEWAY_SERVICE_LABEL,
      gatewayServicePlistPath,
    ).pid;
    stopLegacyDevGatewayLaunchAgents();
    writeGatewayServiceFiles();
    writeGatewayServicePlist();
    bootoutLaunchAgent(GATEWAY_SERVICE_LABEL);
    const duplicate = await killLocalGatewayProcessOnPort(port, {
      knownGatewayPids: [previousServicePid],
    });
    if (duplicate.blocked) {
      throw new Error(
        `端口 ${port} 已被非网关进程占用，无法启动常驻服务。PID=${duplicate.pid}`,
      );
    }
    bootstrapLaunchAgent(GATEWAY_SERVICE_LABEL, gatewayServicePlistPath);
    kickstartLaunchAgent(GATEWAY_SERVICE_LABEL);
    await waitForGatewayEndpointHealthy(port);
    return this.status();
  }

  async start(): Promise<GatewayServiceStatus> {
    const port = getConfiguredGatewayPort();
    const previousServicePid = parseLaunchAgentStatus(
      GATEWAY_SERVICE_LABEL,
      gatewayServicePlistPath,
    ).pid;
    stopLegacyDevGatewayLaunchAgents();
    writeGatewayServiceFiles();
    writeGatewayServicePlist();
    bootoutLaunchAgent(GATEWAY_SERVICE_LABEL);
    const duplicate = await killLocalGatewayProcessOnPort(port, {
      knownGatewayPids: [previousServicePid],
    });
    if (duplicate.blocked) {
      throw new Error(
        `端口 ${port} 已被非网关进程占用，无法启动常驻服务。PID=${duplicate.pid}`,
      );
    }
    bootstrapLaunchAgent(GATEWAY_SERVICE_LABEL, gatewayServicePlistPath);
    kickstartLaunchAgent(GATEWAY_SERVICE_LABEL);
    await waitForGatewayEndpointHealthy(port);
    return this.status();
  }

  async stop(): Promise<GatewayServiceStatus> {
    bootoutLaunchAgent(GATEWAY_SERVICE_LABEL);
    return this.status();
  }

  async restart(): Promise<GatewayServiceStatus> {
    const port = getConfiguredGatewayPort();
    const previousServicePid = parseLaunchAgentStatus(
      GATEWAY_SERVICE_LABEL,
      gatewayServicePlistPath,
    ).pid;
    stopLegacyDevGatewayLaunchAgents();
    writeGatewayServiceFiles();
    writeGatewayServicePlist();
    bootoutLaunchAgent(GATEWAY_SERVICE_LABEL);
    const duplicate = await killLocalGatewayProcessOnPort(port, {
      knownGatewayPids: [previousServicePid],
    });
    if (duplicate.blocked) {
      throw new Error(
        `端口 ${port} 已被非网关进程占用，无法重启常驻服务。PID=${duplicate.pid}`,
      );
    }
    bootstrapLaunchAgent(GATEWAY_SERVICE_LABEL, gatewayServicePlistPath);
    kickstartLaunchAgent(GATEWAY_SERVICE_LABEL);
    await waitForGatewayEndpointHealthy(port);
    return this.status();
  }

  async repair(): Promise<GatewayServiceStatus> {
    const port = getConfiguredGatewayPort();
    const previousServicePid = parseLaunchAgentStatus(
      GATEWAY_SERVICE_LABEL,
      gatewayServicePlistPath,
    ).pid;
    stopLegacyDevGatewayLaunchAgents();
    writeGatewayServiceFiles();
    writeGatewayServicePlist();
    enableLaunchAgent(GATEWAY_SERVICE_LABEL);
    bootoutLaunchAgent(GATEWAY_SERVICE_LABEL);
    const duplicate = await killLocalGatewayProcessOnPort(port, {
      knownGatewayPids: [previousServicePid],
    });
    if (duplicate.blocked) {
      throw new Error(
        `端口 ${port} 已被非网关进程占用，无法一键修复网关服务。PID=${duplicate.pid}`,
      );
    }
    bootstrapLaunchAgent(GATEWAY_SERVICE_LABEL, gatewayServicePlistPath);
    kickstartLaunchAgent(GATEWAY_SERVICE_LABEL);
    await waitForGatewayEndpointHealthy(port);
    return this.status();
  }
}

async function isGatewayEndpointHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${buildGatewayBaseUrl(port)}/__relaygate/livez`,
      GATEWAY_HEALTH_PROBE_TIMEOUT_MS,
    );
    return response.status < 500;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForGatewayEndpointHealthy(port: number): Promise<void> {
  const deadline = Date.now() + GATEWAY_HEALTH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isGatewayEndpointHealthy(port)) {
      return;
    }
    await sleep(300);
  }
  throw new Error(
    `Gateway service did not become healthy within ${GATEWAY_HEALTH_WAIT_TIMEOUT_MS / 1000} seconds.`,
  );
}

const gatewayServiceManager = new GatewayServiceManager();

function shouldAutoManageGatewayService(): boolean {
  return app.isPackaged;
}

class GatewayProcessManager {
  private child?: ChildProcess;
  private hostedGateway?: HostedGatewayHandle;
  private managed = false;
  private ensuring?: Promise<{ managed: boolean }>;

  async ensureRunning(): Promise<{ managed: boolean }> {
    if (this.ensuring) {
      return this.ensuring;
    }

    this.ensuring = (async () => {
      const port = getConfiguredGatewayPort();
      if (await this.isHealthy(port)) {
        return { managed: this.managed };
      }

      const existingPid = this.findListeningProcessId(port);
      if (existingPid && existingPid !== process.pid) {
        const command = this.readProcessCommand(existingPid);
        if (this.looksLikeLocalGatewayCommand(command) && !shouldAutoManageGatewayService()) {
          return { managed: false };
        }
      }

      if (shouldAutoManageGatewayService()) {
        await gatewayServiceManager.start();
        this.managed = false;
        return { managed: false };
      }

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

    if (shouldAutoManageGatewayService()) {
      await gatewayServiceManager.restart();
      return true;
    }

    const pid = findListeningProcessId(port);
    if (!pid) {
      return false;
    }

    const command = readProcessCommand(pid);
    if (!looksLikeLocalGatewayCommand(command)) {
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

  async recoverMissingAdminEndpoint(): Promise<boolean> {
    const port = getConfiguredGatewayPort();
    if (this.child || this.hostedGateway) {
      await this.restartManaged();
      return true;
    }

    if (shouldAutoManageGatewayService()) {
      await gatewayServiceManager.restart();
      return true;
    }

    const pid = findListeningProcessId(port);
    if (!pid) {
      return false;
    }

    const command = readProcessCommand(pid);
    if (!looksLikeLocalGatewayCommand(command)) {
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
    if (!app.isPackaged && gatewayServiceManager.isInstalled()) {
      bootoutLaunchAgent(GATEWAY_SERVICE_LABEL);
    }
    if (!app.isPackaged) {
      stopLegacyDevGatewayLaunchAgents();
    }
    const duplicate = await killLocalGatewayProcessOnPort(port);
    if (duplicate.blocked) {
      throw new Error(
        `本地端口 ${port} 已被其他进程占用，网关无法启动。请在系统配置中更换网关端口或释放该端口后重试。`,
      );
    }

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
    const deadline = Date.now() + GATEWAY_HEALTH_WAIT_TIMEOUT_MS;
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

    throw new Error(
      `Gateway did not become healthy within ${GATEWAY_HEALTH_WAIT_TIMEOUT_MS / 1000} seconds.`,
    );
  }

  private async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${buildGatewayBaseUrl(port)}/__relaygate/livez`,
        GATEWAY_HEALTH_PROBE_TIMEOUT_MS,
      );
      return response.status < 500;
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
    return looksLikeLocalGatewayCommand(command);
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

function getLocalNetworkAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      addresses.push(entry.address);
    }
  }
  return Array.from(new Set(addresses)).sort();
}

function buildLanBaseUrl(port: number): string | undefined {
  const [address] = getLocalNetworkAddresses();
  return address ? `http://${address}:${port}/v1` : undefined;
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
  const contentAudit = settings.requestContentAudit ?? {};
  return {
    launchAtLogin: Boolean(settings.launchAtLogin),
    autoRefreshIntervalSeconds: normalizeAutoRefreshIntervalSeconds(settings.autoRefreshIntervalSeconds),
    gatewayPort: normalizeGatewayPort(settings.gatewayPort),
    pinnedSessionId:
      typeof settings.pinnedSessionId === "string" &&
      settings.pinnedSessionId.trim().length > 0
        ? settings.pinnedSessionId.trim()
        : undefined,
    requestContentAudit: {
      enabled: Boolean(contentAudit.enabled),
      maxCharacters:
        typeof contentAudit.maxCharacters === "number" &&
        Number.isFinite(contentAudit.maxCharacters)
          ? Math.max(1_000, Math.min(200_000, Math.floor(contentAudit.maxCharacters)))
          : 32_000,
      maxEvents:
        typeof contentAudit.maxEvents === "number" &&
        Number.isFinite(contentAudit.maxEvents)
          ? Math.max(0, Math.min(10_000, Math.floor(contentAudit.maxEvents)))
          : 500,
    },
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

  const request = async (): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const message =
        typeof payload?.error === "object" && payload.error && "message" in payload.error
          ? String(payload.error.message)
          : `Admin request failed (${response.status}) @ ${baseUrl}${path}`;
      throw new Error(message);
    }

    return payload;
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isTransientAdminRequestError(error) || attempt === 2) {
        break;
      }
      await sleep(350 * (attempt + 1));
    }
  }

  throw lastError;
}

function isTransientAdminRequestError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNRESET") ||
    message.includes("ECONNREFUSED") ||
    message.includes("terminated") ||
    message.includes("Unexpected end of JSON input") ||
    message.includes("Unterminated string in JSON")
  );
}

function readInFlightInferenceCountFromHealth(payload: unknown): number {
  const observability = (payload as {
    inferenceObservability?: { inFlightCount?: unknown };
  })?.inferenceObservability;
  const count = observability?.inFlightCount;
  return typeof count === "number" && Number.isFinite(count)
    ? Math.max(0, Math.floor(count))
    : 0;
}

async function assertNoActiveInferenceBeforeGatewayInterruption(
  actionLabel: string,
): Promise<void> {
  let health: unknown;
  try {
    health = await callAdmin("/admin/health");
  } catch {
    return;
  }

  const inFlightCount = readInFlightInferenceCountFromHealth(health);
  if (inFlightCount <= 0) {
    return;
  }

  throw new Error(
    `当前仍有 ${inFlightCount} 个推理请求进行中，已阻止${actionLabel}以避免打断 Trae/Codex 等客户端请求。请稍后重试。`,
  );
}

function isPoolEndpointMissing(error: unknown): boolean {
  const message = toErrorMessage(error);
  return message.includes("/admin/config/pools") && message.includes("404");
}

function isAdminEndpointMissing(error: unknown, path: string): boolean {
  const message = toErrorMessage(error);
  const endpoint = path.split("?")[0] ?? path;
  return message.includes(endpoint) && message.includes("404");
}

async function callAdminWithEndpointCompatibility(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  try {
    return await callAdmin(path, init);
  } catch (error) {
    if (!isAdminEndpointMissing(error, path)) {
      throw error;
    }

    const recovered = await gatewayManager.recoverMissingAdminEndpoint();
    if (!recovered) {
      throw new Error(
        "当前运行中的本地网关缺少该管理接口，且桌面端未能自动接管旧进程。请先点击“重启服务”，或完全退出旧网关后再重试。",
      );
    }

    return callAdmin(path, init);
  }
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

async function buildRelayGateProviderSnippet(): Promise<string> {
  const payload = (await callAdmin("/admin/health")) as {
    defaultModel?: string;
    openclaw?: {
      baseUrl?: string;
      provider?: string;
      model?: string;
    };
    inferenceAuth?: GatewayInferenceAuthPublicSettings;
  };

  const baseUrl = buildGatewayBaseUrl(getConfiguredGatewayPort());
  const providerBaseUrl =
    payload.inferenceAuth?.publicAccess?.enabled &&
    payload.inferenceAuth.publicAccess.publicBaseUrl?.startsWith("https://")
      ? payload.inferenceAuth.publicAccess.publicBaseUrl
      : `${baseUrl}/v1`;
  const model = payload.openclaw?.model ?? payload.defaultModel ?? "codex-default";
  const lines = [
    "RelayGate Provider",
    "",
    "provider_name: RelayGate Provider",
    "provider_type: OpenAI-compatible / Custom OpenAI",
    `base_url: ${providerBaseUrl}`,
    `model: ${model}`,
    "wire_api: responses 优先；不支持 Responses 时使用 chat/completions",
  ];
  if (payload.inferenceAuth?.enabled) {
    lines.push("api_key: <你的 RelayGate Provider API Key>");
  }
  return lines.join("\n");
}

function getOperationsLogSources(): OperationsLogSource[] {
  return [
    {
      id: "gateway-runtime",
      label: "网关运行日志",
      path: gatewayPaths.logFilePath,
    },
    {
      id: "gateway-service-out",
      label: "网关常驻 stdout",
      path: gatewayServiceOutLogPath,
    },
    {
      id: "gateway-service-err",
      label: "网关常驻 stderr",
      path: gatewayServiceErrLogPath,
    },
    {
      id: "cloudflare-tunnel",
      label: "Cloudflare Tunnel",
      path: cloudflaredLogPath,
    },
    {
      id: "cloudflare-launchd-out",
      label: "Cloudflare launchd stdout",
      path: cloudflaredOutLogPath,
    },
    {
      id: "cloudflare-launchd-err",
      label: "Cloudflare launchd stderr",
      path: cloudflaredErrLogPath,
    },
    {
      id: "desktop-main",
      label: "桌面主进程",
      path: desktopMainLogPath,
    },
  ].map((source) => {
    const stat = statSafe(source.path);
    return {
      ...source,
      exists: Boolean(stat),
      sizeBytes: normalizeStatNumber(stat?.size),
      updatedAt: normalizeStatNumber(stat?.mtimeMs),
    };
  });
}

function getOperationLogSource(sourceId: string): OperationsLogSource | undefined {
  return getOperationsLogSources().find((source) => source.id === sourceId);
}

function readOperationLog(sourceId: string, maxLinesInput?: number): {
  ok: boolean;
  source: OperationsLogSource;
  text: string;
  maxLines: number;
} {
  const source = getOperationLogSource(sourceId);
  if (!source) {
    throw new Error("未知日志来源。");
  }
  const maxLines =
    typeof maxLinesInput === "number" && Number.isFinite(maxLinesInput)
      ? Math.max(20, Math.min(2_000, Math.round(maxLinesInput)))
      : 300;
  if (!source.exists) {
    return {
      ok: true,
      source,
      text: "日志文件暂不存在。",
      maxLines,
    };
  }
  const text = execFileSync("tail", ["-n", String(maxLines), source.path], {
    encoding: "utf8",
  });
  return {
    ok: true,
    source,
    text,
    maxLines,
  };
}

function buildCloudflareServiceStatus() {
  const config = readGatewayConfig();
  const publicAccess = config.inferenceAuthSettings?.publicAccess;
  const status = parseLaunchAgentStatus(CLOUDFLARED_SERVICE_LABEL, cloudflaredPlistPath);
  return {
    ...status,
    logPath: cloudflaredLogPath,
    outLogPath: cloudflaredOutLogPath,
    errLogPath: cloudflaredErrLogPath,
    publicBaseUrl: publicAccess?.publicBaseUrl,
    hostname: publicAccess?.hostname,
    tunnelName: publicAccess?.tunnelName,
  };
}

function buildPublicModelsProbeUrl(publicBaseUrl?: string): string | undefined {
  const normalized = publicBaseUrl?.trim().replace(/\/+$/, "");
  if (!normalized || !normalized.startsWith("https://")) {
    return undefined;
  }
  return `${normalized}/models`;
}

async function probePublicModelsEndpoint(publicBaseUrl?: string): Promise<
  | {
      url: string;
      reachable: boolean;
      status?: number;
      expectedGatewayAuth?: boolean;
      error?: string;
    }
  | undefined
> {
  const url = buildPublicModelsProbeUrl(publicBaseUrl);
  if (!url) {
    return undefined;
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
    });
    return {
      url,
      reachable: true,
      status: response.status,
      expectedGatewayAuth: response.status === 401,
    };
  } catch (error) {
    return {
      url,
      reachable: false,
      error: toErrorMessage(error),
    };
  }
}

async function buildOperationsStatus() {
  const gateway = await gatewayServiceManager.status();
  const cloudflare = buildCloudflareServiceStatus();
  const publicProbe = await probePublicModelsEndpoint(cloudflare.publicBaseUrl);
  return {
    ok: true,
    data: {
      generatedAt: toIsoNow(),
      gateway,
      cloudflare,
      publicProbe,
      logs: getOperationsLogSources(),
    },
  };
}

async function controlGatewayService(action: GatewayServiceAction) {
  if (action === "install" || action === "start" || action === "restart" || action === "repair") {
    await assertNoActiveInferenceBeforeGatewayInterruption("网关服务操作");
    await gatewayManager.stopManaged();
  }
  if (action === "install") {
    return gatewayServiceManager.installAndStart();
  }
  if (action === "start") {
    return gatewayServiceManager.start();
  }
  if (action === "stop") {
    return gatewayServiceManager.stop();
  }
  if (action === "repair") {
    return gatewayServiceManager.repair();
  }
  return gatewayServiceManager.restart();
}

async function repairPublicGatewayConnectivity() {
  const gateway = await controlGatewayService("repair");
  let cloudflare = buildCloudflareServiceStatus();
  let cloudflareRepaired = false;
  if (cloudflare.installed) {
    try {
      cloudflare = await controlCloudflareService("restart");
      cloudflareRepaired = true;
    } catch (error) {
      cloudflare = {
        ...buildCloudflareServiceStatus(),
        error: toErrorMessage(error),
      };
    }
  }
  const publicProbe = await probePublicModelsEndpoint(cloudflare.publicBaseUrl);
  return {
    ok: true,
    data: {
      generatedAt: toIsoNow(),
      gateway,
      cloudflare,
      cloudflareRepaired,
      publicProbe,
      logs: getOperationsLogSources(),
    },
  };
}

async function controlCloudflareService(action: CloudflareServiceAction) {
  if (!existsSync(cloudflaredPlistPath)) {
    throw new Error("尚未发现 Cloudflare Tunnel LaunchAgent，请先完成 Tunnel 常驻配置。");
  }
  if (action === "stop") {
    bootoutLaunchAgent(CLOUDFLARED_SERVICE_LABEL);
    return buildCloudflareServiceStatus();
  }
  if (action === "restart") {
    bootoutLaunchAgent(CLOUDFLARED_SERVICE_LABEL);
    await sleep(500);
    bootstrapLaunchAgent(CLOUDFLARED_SERVICE_LABEL, cloudflaredPlistPath);
    tryKickstartLaunchAgent(CLOUDFLARED_SERVICE_LABEL);
    let status = await waitForLaunchAgentRunning(
      CLOUDFLARED_SERVICE_LABEL,
      cloudflaredPlistPath,
    );
    if (!status.loaded) {
      bootstrapLaunchAgent(CLOUDFLARED_SERVICE_LABEL, cloudflaredPlistPath);
      tryKickstartLaunchAgent(CLOUDFLARED_SERVICE_LABEL);
      status = await waitForLaunchAgentRunning(
        CLOUDFLARED_SERVICE_LABEL,
        cloudflaredPlistPath,
      );
    }
    return buildCloudflareServiceStatus();
  }
  if (!parseLaunchAgentStatus(CLOUDFLARED_SERVICE_LABEL, cloudflaredPlistPath).loaded) {
    bootstrapLaunchAgent(CLOUDFLARED_SERVICE_LABEL, cloudflaredPlistPath);
    await waitForLaunchAgentLoaded(CLOUDFLARED_SERVICE_LABEL, cloudflaredPlistPath);
  }
  tryKickstartLaunchAgent(CLOUDFLARED_SERVICE_LABEL);
  await waitForLaunchAgentRunning(CLOUDFLARED_SERVICE_LABEL, cloudflaredPlistPath);
  return buildCloudflareServiceStatus();
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

function formatPublicBaseUrl(publicBaseUrl?: string): string | undefined {
  const normalized = publicBaseUrl?.trim().replace(/\/+$/, "");
  if (!normalized) {
    return undefined;
  }
  return normalized;
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
  resized.setTemplateImage(false);
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
        inferenceAuth?: GatewayInferenceAuthPublicSettings;
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
    const publicAccess = healthPayload.inferenceAuth?.publicAccess;
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
        publicAccessEnabled: Boolean(publicAccess?.enabled),
        publicBaseUrl: publicAccess?.publicBaseUrl,
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
        publicAccessEnabled: Boolean(publicAccess?.enabled),
        publicBaseUrl: publicAccess?.publicBaseUrl,
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
      publicAccessEnabled: Boolean(publicAccess?.enabled),
      publicBaseUrl: publicAccess?.publicBaseUrl,
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

async function stopPublicLinkAndQuit(): Promise<void> {
  const options: MessageBoxOptions = {
    type: "warning",
    title: "停止公网链路并退出",
    message: "确定要停止 RelayGate 公网链路吗？",
    detail:
      "这会停止本机网关服务和 Cloudflare Tunnel，公网 Provider 会立即不可用，正在运行的 Trae/Codex 请求也可能被中断。仅退出控制台不需要执行此操作。",
    buttons: ["停止公网链路并退出", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const response =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);

  if (response.response !== 0) {
    return;
  }

  try {
    await assertNoActiveInferenceBeforeGatewayInterruption("停止公网链路");
    if (existsSync(cloudflaredPlistPath)) {
      await controlCloudflareService("stop");
    }
    if (gatewayServiceManager.isInstalled()) {
      await gatewayServiceManager.stop();
    } else {
      await gatewayManager.stopManaged();
    }
    quitControlConsole();
  } catch (error) {
    dialog.showErrorBox(
      "停止公网链路失败",
      `公网链路未完全停止。\n\n原因：${toErrorMessage(error)}`,
    );
    void refreshTrayStatus();
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

  statusTray.setToolTip(`RelayGate · ${snapshot.label}`);
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
  const publicBaseUrl = formatPublicBaseUrl(snapshot.publicBaseUrl);
  const publicLinkLine = snapshot.publicAccessEnabled
    ? publicBaseUrl
      ? `公网入口 · ${publicBaseUrl}`
      : "公网入口 · 已启用，待配置域名"
    : "公网入口 · 未启用";
  const activityLine =
    snapshot.state === "active"
      ? snapshot.detail
      : lastActivityLine
        ? `最近活动 · ${lastActivityLine}`
        : undefined;
  const menu = Menu.buildFromTemplate([
      {
        label: "RelayGate 公网中转",
        enabled: false,
      },
      {
        type: "separator",
      },
      {
        label: `链路状态 · ${snapshot.label}`,
        enabled: false,
      },
      {
        label: publicLinkLine,
        enabled: false,
      },
      ...(activityLine
        ? [
            {
              label: activityLine,
              enabled: false,
            },
          ]
        : []),
      ...(typeof snapshot.inFlightCount === "number" && snapshot.inFlightCount > 0
        ? [
            {
              label: `实时并发 · ${snapshot.inFlightCount} 个请求`,
              enabled: false,
            },
          ]
        : []),
      ...(clientTagLine
        ? [
            {
              label: `访问成员 · ${clientTagLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(snapshot.modelAlias
        ? [
            {
              label: `请求模型 · ${modelLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(poolLine
        ? [
            {
              label: `调度号池 · ${poolLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(usage30mLine
        ? [
            {
              label: `近 30 分钟 · ${usage30mLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(snapshot.activeSessionLabel
        ? [
            {
              label: `当前上游 · ${snapshot.activeSessionLabel}`,
              enabled: false,
            },
          ]
        : []),
      ...(quotaLine
        ? [
            {
              label: `上游额度 · ${quotaLine}`,
              enabled: false,
            },
          ]
        : []),
      ...(snapshot.activeSessionResetAt
        ? [
            {
              label: `额度重置 · ${formatRelativeDuration(snapshot.activeSessionResetAt) ?? "待同步"}`,
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
        label: "打开控制台",
        click: () => {
          void showMainWindow();
        },
      },
      ...(publicBaseUrl
        ? [
            {
              label: "复制公网 Provider 地址",
              click: () => {
                clipboard.writeText(publicBaseUrl);
              },
            },
          ]
        : []),
      {
        label: "重启公网网关",
        click: () => {
          void assertNoActiveInferenceBeforeGatewayInterruption("重启网关")
            .then(() => gatewayManager.restartManaged())
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
        label: "退出控制台（公网链路继续运行）",
        click: () => {
          quitControlConsole();
        },
      },
      {
        label: "停止公网链路并退出...",
        click: () => {
          void stopPublicLinkAndQuit();
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
    appendDesktopMainLog("error", ["tray_icon_load_failed", getTrayIconBaseName("idle")]);
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

function setupApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "显示控制台",
          click: () => {
            void showMainWindow();
          },
        },
        {
          label: "隐藏到菜单栏",
          accelerator: "Command+Q",
          click: () => {
            hideMainWindowToTray();
          },
        },
        { type: "separator" },
        {
          label: "重启公网网关服务",
          click: () => {
            void assertNoActiveInferenceBeforeGatewayInterruption("重启网关")
              .then(() => gatewayManager.restartManaged())
              .catch((error) => {
                dialog.showErrorBox("重启网关失败", toErrorMessage(error));
              })
              .finally(() => {
                void refreshTrayStatus();
              });
          },
        },
        { type: "separator" },
        {
          label: "退出控制台（公网链路继续运行）",
          click: () => {
            quitControlConsole();
          },
        },
        {
          label: "停止公网链路并退出...",
          click: () => {
            void stopPublicLinkAndQuit();
          },
        },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        {
          label: "显示控制台",
          click: () => {
            void showMainWindow();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

async function ensureGatewayForWindowStartup(): Promise<void> {
  try {
    await gatewayManager.ensureRunning();
  } catch (error) {
    console.error(
      "[desktop] 网关启动失败，仍打开控制台以便修复:",
      toErrorMessage(error),
    );
  }
}

async function createWindow(): Promise<void> {
  await ensureGatewayForWindowStartup();

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
    "RelayGate 启动失败",
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
  const gatewayPort = getConfiguredGatewayPort();
  const localNetworkAddresses = getLocalNetworkAddresses();
  return {
    managed: running.managed,
    desktopNetwork: {
      localNetworkAddresses,
      lanBaseUrl: buildLanBaseUrl(gatewayPort),
    },
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

ipcMain.handle("gateway:get-usage-analytics", async (_event, filters?: Record<string, unknown>) => {
  await gatewayManager.ensureRunning();
  const params = new URLSearchParams();
  for (const key of [
    "range",
    "granularity",
    "clientFilter",
    "consumerId",
    "accessKeyId",
    "modelAlias",
    "poolId",
    "outcome",
  ]) {
    const value = filters?.[key];
    if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
    }
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return callAdmin(`/admin/usage/analytics${query}`);
});

ipcMain.handle("gateway:get-request-audit", async (_event, filters?: Record<string, unknown>) => {
  await gatewayManager.ensureRunning();
  const params = new URLSearchParams();
  for (const key of [
    "limit",
    "status",
    "clientTag",
    "consumerId",
    "accessKeyId",
    "poolId",
    "accountId",
    "modelAlias",
    "providerId",
    "since",
    "until",
  ]) {
    const value = filters?.[key];
    if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
    } else if (typeof value === "number" && Number.isFinite(value)) {
      params.set(key, String(Math.floor(value)));
    }
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return callAdminWithEndpointCompatibility(`/admin/requests/audit${query}`);
});

ipcMain.handle("gateway:get-account-health", async () => {
  await gatewayManager.ensureRunning();
  return callAdminWithEndpointCompatibility("/admin/routing/account-health");
});

ipcMain.handle("gateway:get-request-audit-content", async (_event, sourceEventKey: string) => {
  await gatewayManager.ensureRunning();
  const key = typeof sourceEventKey === "string" ? sourceEventKey.trim() : "";
  if (!key) {
    throw new Error("sourceEventKey is required.");
  }
  return callAdminWithEndpointCompatibility(
    `/admin/requests/audit/content?sourceEventKey=${encodeURIComponent(key)}`,
  );
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

ipcMain.handle("gateway:acknowledge-all-access-alerts", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/access/alerts/acknowledge-all", {
    method: "POST",
    body: JSON.stringify({ acknowledgedBy: "desktop-admin" }),
  });
});

ipcMain.handle("gateway:clear-acknowledged-access-alerts", async () => {
  await gatewayManager.ensureRunning();
  return callAdmin("/admin/access/alerts/clear-acknowledged", {
    method: "POST",
  });
});

ipcMain.handle("gateway:show-native-notification", async (_event, payload: unknown) => {
  const input = (payload ?? {}) as { title?: string; body?: string };
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : "RelayGate";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!Notification.isSupported()) {
    return { ok: false, supported: false };
  }
  new Notification({
    title,
    body,
    silent: false,
  }).show();
  return { ok: true, supported: true };
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
  await assertNoActiveInferenceBeforeGatewayInterruption("重启网关");
  if (shouldAutoManageGatewayService()) {
    await gatewayManager.stopManaged();
    const status = await gatewayServiceManager.restart();
    void refreshTrayStatus();
    return { ok: true, restarted: true, managed: false, service: status };
  }

  await gatewayManager.ensureRunning();

  if (gatewayManager.isManaged()) {
    await gatewayManager.restartManaged();
    void refreshTrayStatus();
    return { ok: true, restarted: true, managed: true };
  }

  if (!app.isPackaged) {
    const restarted = await gatewayManager.recoverMissingAdminEndpoint();
    if (!restarted) {
      throw new Error("未能接管并重启当前开发态网关进程。");
    }
    void refreshTrayStatus();
    return { ok: true, restarted: true, managed: true };
  }

  const result = await callAdmin("/admin/service/restart", {
    method: "POST",
  });
  void refreshTrayStatus();
  return result;
});

ipcMain.handle("gateway:copy-provider-snippet", async () => {
  await gatewayManager.ensureRunning();
  clipboard.writeText(await buildRelayGateProviderSnippet());
  return { ok: true };
});

ipcMain.handle("gateway:copy-text", async (_event, text: string) => {
  clipboard.writeText(String(text ?? ""));
  return { ok: true };
});

ipcMain.handle("gateway:open-logs", async () => {
  return shell.openPath(gatewayPaths.logsDir);
});

ipcMain.handle("gateway:get-operations-status", async () => {
  return buildOperationsStatus();
});

ipcMain.handle(
  "gateway:read-operations-log",
  async (_event, sourceId: string, maxLines?: number) =>
    readOperationLog(String(sourceId ?? ""), maxLines),
);

ipcMain.handle(
  "gateway:control-gateway-service",
  async (_event, action: GatewayServiceAction) => {
    const normalized = String(action ?? "") as GatewayServiceAction;
    if (!["install", "start", "stop", "restart", "repair"].includes(normalized)) {
      throw new Error("不支持的网关服务操作。");
    }
    const data = await controlGatewayService(normalized);
    void refreshTrayStatus();
    return { ok: true, data };
  },
);

ipcMain.handle("gateway:repair-public-gateway", async () => {
  const result = await repairPublicGatewayConnectivity();
  void refreshTrayStatus();
  return result;
});

ipcMain.handle(
  "gateway:control-cloudflare-service",
  async (_event, action: CloudflareServiceAction) => {
    const normalized = String(action ?? "") as CloudflareServiceAction;
    if (!["start", "stop", "restart"].includes(normalized)) {
      throw new Error("不支持的 Cloudflare Tunnel 操作。");
    }
    return { ok: true, data: await controlCloudflareService(normalized) };
  },
);

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
    title: "导出 RelayGate 应用数据",
    defaultPath: join(
      app.getPath("downloads"),
      createBackupFileName("local-ai-gateway-backup"),
    ),
    filters: [{ name: "RelayGate 备份", extensions: ["json"] }],
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
    title: "导入 RelayGate 应用数据",
    properties: ["openFile"],
    filters: [{ name: "RelayGate 备份", extensions: ["json"] }],
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
      title: "导入 RelayGate 应用数据",
      properties: ["openFile"],
      filters: [{ name: "RelayGate 备份", extensions: ["json"] }],
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
    requestContentAudit: {
      enabled: Boolean(payload?.requestContentAudit?.enabled),
      maxCharacters:
        typeof payload?.requestContentAudit?.maxCharacters === "number"
          ? Math.max(1_000, Math.min(200_000, Math.floor(payload.requestContentAudit.maxCharacters)))
          : previous.requestContentAudit?.maxCharacters,
      maxEvents:
        typeof payload?.requestContentAudit?.maxEvents === "number"
          ? Math.max(0, Math.min(10_000, Math.floor(payload.requestContentAudit.maxEvents)))
          : previous.requestContentAudit?.maxEvents,
    },
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
  terminateStaleDesktopMainProcesses();
  const launchedAtLogin =
    canApplyLoginItemSetting() && app.getLoginItemSettings().wasOpenedAtLogin;
  applyLoginItemSetting(getStoredDesktopSystemSettings().launchAtLogin ?? false);
  pruneBackupStoreDir();
  setupApplicationMenu();
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
