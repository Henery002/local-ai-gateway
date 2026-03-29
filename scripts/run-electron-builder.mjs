import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const builderArgs = process.argv.slice(2);
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;

let builderError;
let prebuildError;
let rebuildError;

try {
  console.log(`[electron-builder] 预编译 better-sqlite3 到 Electron ABI（${electronVersion}）…`);
  execFileSync(
    "npm",
    [
      "rebuild",
      "better-sqlite3",
      "--runtime=electron",
      `--target=${electronVersion}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    {
      cwd: rootDir,
      stdio: "inherit",
    },
  );
} catch (error) {
  prebuildError = error;
}

try {
  if (prebuildError) {
    throw prebuildError;
  }
  execFileSync("npx", ["electron-builder", ...builderArgs], {
    cwd: rootDir,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
    },
    stdio: "inherit",
  });
} catch (error) {
  builderError = error;
} finally {
  try {
    console.log("[electron-builder] 恢复 better-sqlite3 到当前 Node 运行时 ABI…");
    execFileSync("npm", ["rebuild", "better-sqlite3"], {
      cwd: rootDir,
      stdio: "inherit",
    });
  } catch (error) {
    rebuildError = error;
  }
}

if (prebuildError) {
  throw prebuildError;
}

if (builderError) {
  throw builderError;
}

if (rebuildError) {
  throw rebuildError;
}
