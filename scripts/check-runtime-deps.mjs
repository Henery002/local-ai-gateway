import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = process.cwd();
const workspaceDirs = ["apps", "packages"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listWorkspacePackageJsons() {
  const files = [];
  for (const dir of workspaceDirs) {
    const absoluteDir = resolve(rootDir, dir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = join(absoluteDir, entry.name, "package.json");
      if (existsSync(packageJsonPath)) {
        files.push(packageJsonPath);
      }
    }
  }
  return files.sort();
}

const workspacePackageJsons = listWorkspacePackageJsons();
const workspaceNames = new Set(
  workspacePackageJsons.map((path) => readJson(path).name),
);

const externalRuntimeDeps = new Map();
for (const packageJsonPath of workspacePackageJsons) {
  const pkg = readJson(packageJsonPath);
  for (const section of ["dependencies", "optionalDependencies"]) {
    const deps = pkg[section] ?? {};
    for (const [depName, version] of Object.entries(deps)) {
      if (!workspaceNames.has(depName)) {
        externalRuntimeDeps.set(depName, version);
      }
    }
  }
}

const rootPackageJson = readJson(resolve(rootDir, "package.json"));
const rootDeps = rootPackageJson.dependencies ?? {};
const missing = [...externalRuntimeDeps.entries()].filter(
  ([depName]) => !(depName in rootDeps),
);

if (missing.length > 0) {
  const detail = missing
    .map(([depName, version]) => `- ${depName}: ${version}`)
    .join("\n");
  throw new Error(
    `根 package.json 缺少以下工作区运行时依赖，安装包可能会缺包：\n${detail}`,
  );
}

console.log(
  `[check:runtime-deps] 通过：根 package.json 已覆盖 ${externalRuntimeDeps.size} 个工作区运行时第三方依赖。`,
);
