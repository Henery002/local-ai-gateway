import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const rootDir = process.cwd();
const arch = process.arch === "arm64" ? "mac-arm64" : "mac";
const appBundlePath = resolve(
  rootDir,
  "release",
  arch,
  "Local AI Gateway.app",
);
const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
const asarPath = join(appBundlePath, "Contents", "Resources", "app.asar");
const asarUnpackedPath = join(appBundlePath, "Contents", "Resources", "app.asar.unpacked");
const bundleIconPath = join(appBundlePath, "Contents", "Resources", "icon.icns");
const executablePath = join(appBundlePath, "Contents", "MacOS", "Local AI Gateway");
const smokePort = 18_787;

function ensureFileExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} 不存在：${path}`);
  }
}

function ensureAsarContains(pattern, label) {
  const output = execFileSync("npx", ["asar", "list", asarPath], {
    cwd: rootDir,
    encoding: "utf8",
  });

  if (!output.includes(pattern)) {
    throw new Error(`${label} 未打入 app.asar：${pattern}`);
  }
}

function ensurePackagedDependencyExists(relativePathCandidates, label) {
  const candidates = Array.isArray(relativePathCandidates)
    ? relativePathCandidates
    : [relativePathCandidates];
  const resolved = candidates.map((relativePath) => join(appBundlePath, "Contents", "Resources", relativePath));
  if (!resolved.some((path) => existsSync(path))) {
    throw new Error(`${label} 未进入安装包：${resolved.join(" 或 ")}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore
    }
    await sleep(400);
  }
  throw new Error(`安装版健康检查超时：${baseUrl}/healthz`);
}

async function launchPackagedAppAndVerify() {
  const tempHome = mkdtempSync(join(tmpdir(), "local-ai-gateway-smoke-home-"));
  const tempAppDataDir = join(
    tempHome,
    "Library",
    "Application Support",
    "local-ai-gateway",
  );
  mkdirSync(tempAppDataDir, { recursive: true });
  writeFileSync(
    join(tempAppDataDir, "config.json"),
    `${JSON.stringify(
      {
        desktopSettings: {
          gatewayPort: smokePort,
        },
      },
      null,
      2,
    )}\n`,
  );

  let stderrOutput = "";
  const child = spawn(executablePath, {
    env: {
      ...process.env,
      HOME: tempHome,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => {
    stderrOutput += chunk.toString("utf8");
    if (stderrOutput.length > 8_000) {
      stderrOutput = stderrOutput.slice(-8_000);
    }
  });

  try {
    await waitForHealth(`http://127.0.0.1:${smokePort}`);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "安装版健康检查失败";
    const detail = stderrOutput.trim()
      ? `\n最近 stderr：\n${stderrOutput.trim()}`
      : "";
    throw new Error(`${reason}${detail}`);
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    rmSync(tempHome, { recursive: true, force: true });
  }
}

console.log("[smoke:desktop-package] 开始构建目录包…");
execFileSync("npm", ["run", "build"], {
  cwd: rootDir,
  stdio: "inherit",
});
execFileSync("npm", ["run", "generate:icons"], {
  cwd: rootDir,
  stdio: "inherit",
});
execFileSync("node", ["scripts/run-electron-builder.mjs", "--dir"], {
  cwd: rootDir,
  stdio: "inherit",
});

console.log("[smoke:desktop-package] 检查桌面产物…");
ensureFileExists(appBundlePath, "桌面应用包");
ensureFileExists(infoPlistPath, "Info.plist");
ensureFileExists(asarPath, "app.asar");
ensureFileExists(asarUnpackedPath, "app.asar.unpacked");
ensureFileExists(bundleIconPath, "应用图标资源");

const infoPlist = readFileSync(infoPlistPath, "utf8");
if (!infoPlist.includes("<string>Local AI Gateway</string>")) {
  throw new Error("Info.plist 未包含预期的产品名 `Local AI Gateway`。");
}

ensureAsarContains("/node_modules/@mariozechner/pi-ai/package.json", "pi-ai 运行时依赖");
ensureAsarContains("/node_modules/fastify/package.json", "Fastify 运行时依赖");
ensureAsarContains("/packages/openclaw-session/package.json", "OpenClaw Session 工作区元数据");
ensureAsarContains("/packages/core/package.json", "Core 工作区元数据");
ensureAsarContains("/apps/gateway/dist/server.js", "安装版主进程托管的 gateway 模块");
ensureAsarContains("/apps/desktop/assets/icons/generated/app-icon.png", "Dock/窗口图标资源");
ensureAsarContains("/apps/desktop/assets/icons/generated/tray-idle-light.png", "状态栏空闲图标资源");
ensureAsarContains("/apps/desktop/assets/icons/generated/tray-active-light.png", "状态栏活跃图标资源");
ensureAsarContains("/apps/desktop/assets/icons/generated/tray-error.png", "状态栏异常图标资源");

const betterSqliteNode = join(
  asarUnpackedPath,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
ensureFileExists(betterSqliteNode, "better-sqlite3 原生模块");
ensurePackagedDependencyExists(
  [
    "app.asar/node_modules/better-sqlite3/package.json",
    "app.asar.unpacked/node_modules/better-sqlite3/package.json",
  ],
  "better-sqlite3 包元数据",
);

console.log("[smoke:desktop-package] 验证安装版可执行文件可成功拉起本地网关…");
await launchPackagedAppAndVerify();

console.log(`[smoke:desktop-package] 通过：${appBundlePath}`);
