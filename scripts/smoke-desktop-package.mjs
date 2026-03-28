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

function ensureFileExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} 不存在：${path}`);
  }
}

console.log("[smoke:desktop-package] 开始构建目录包…");
execFileSync("npm", ["run", "build"], {
  cwd: rootDir,
  stdio: "inherit",
});
execFileSync("npx", ["electron-builder", "--dir"], {
  cwd: rootDir,
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
  stdio: "inherit",
});

console.log("[smoke:desktop-package] 检查桌面产物…");
ensureFileExists(appBundlePath, "桌面应用包");
ensureFileExists(infoPlistPath, "Info.plist");
ensureFileExists(asarPath, "app.asar");

const infoPlist = readFileSync(infoPlistPath, "utf8");
if (!infoPlist.includes("<string>Local AI Gateway</string>")) {
  throw new Error("Info.plist 未包含预期的产品名 `Local AI Gateway`。");
}

console.log(`[smoke:desktop-package] 通过：${appBundlePath}`);
