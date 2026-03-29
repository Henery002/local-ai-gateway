import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const builderArgs = process.argv.slice(2);

let builderError;
let rebuildError;

try {
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

if (builderError) {
  throw builderError;
}

if (rebuildError) {
  throw rebuildError;
}
