import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

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

console.log(`[smoke:desktop-package] 通过：${appBundlePath}`);
