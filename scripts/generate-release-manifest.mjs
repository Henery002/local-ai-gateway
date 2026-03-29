import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const rootDir = process.cwd();
const releaseDir = resolve(rootDir, "release");
const manifestPath = join(releaseDir, "release-manifest.json");

function walkFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function computeSha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function summarizeDirectory(dir) {
  const files = walkFiles(dir);
  const totalBytes = files.reduce((total, file) => total + statSync(file).size, 0);
  return {
    fileCount: files.length,
    totalBytes,
  };
}

function collectArtifacts(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const artifacts = [];

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) {
        const summary = summarizeDirectory(absolutePath);
        artifacts.push({
          path: relative(releaseDir, absolutePath).replace(/\\/g, "/"),
          kind: "app-bundle",
          fileCount: summary.fileCount,
          totalBytes: summary.totalBytes,
        });
        continue;
      }
      artifacts.push(...collectArtifacts(absolutePath));
      continue;
    }

    const relativePath = relative(releaseDir, absolutePath).replace(/\\/g, "/");
    artifacts.push({
      path: relativePath,
      kind: relativePath.endsWith(".yml") || relativePath.endsWith(".yaml")
        ? "metadata"
        : "file",
      sizeBytes: statSync(absolutePath).size,
      sha256: computeSha256(absolutePath),
    });
  }

  return artifacts.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

if (!existsSync(releaseDir)) {
  throw new Error("release 目录不存在。请先执行 package:desktop 或 dist:desktop。");
}

const manifest = {
  format: "local-ai-gateway-release-manifest",
  generatedAt: new Date().toISOString(),
  artifacts: collectArtifacts(releaseDir),
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`[release:manifest] 已生成 ${manifestPath}`);
