import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { GatewayPaths } from "@local-ai-gateway/shared";

export const APP_DATA_BACKUP_FORMAT = "local-ai-gateway-backup";
export const APP_DATA_BACKUP_VERSION = 1;

export interface AppDataBackupEntry {
  relativePath: string;
  contentBase64: string;
  sizeBytes: number;
}

export interface AppDataBackupBundle {
  format: typeof APP_DATA_BACKUP_FORMAT;
  version: typeof APP_DATA_BACKUP_VERSION;
  appVersion: string;
  exportedAt: string;
  files: AppDataBackupEntry[];
}

function isBackupRelativePath(relativePath: string): boolean {
  return (
    relativePath === "backups" ||
    relativePath.startsWith("backups/") ||
    relativePath.startsWith("backups\\")
  );
}

function listFilesRecursive(rootDir: string, currentDir = rootDir): string[] {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const relativePath = relative(rootDir, absolutePath);
    if (isBackupRelativePath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(rootDir, absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

export function createAppDataBackupBundle(
  paths: GatewayPaths,
  appVersion: string,
): AppDataBackupBundle {
  mkdirSync(paths.rootDir, { recursive: true });
  const files = listFilesRecursive(paths.rootDir)
    .map((absolutePath) => {
      const buffer = readFileSync(absolutePath);
      return {
        relativePath: relative(paths.rootDir, absolutePath).replace(/\\/g, "/"),
        contentBase64: buffer.toString("base64"),
        sizeBytes: buffer.byteLength,
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  return {
    format: APP_DATA_BACKUP_FORMAT,
    version: APP_DATA_BACKUP_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    files,
  };
}

export function parseAppDataBackupBundle(input: string): AppDataBackupBundle {
  const parsed = JSON.parse(input) as Partial<AppDataBackupBundle>;
  if (
    parsed.format !== APP_DATA_BACKUP_FORMAT ||
    parsed.version !== APP_DATA_BACKUP_VERSION ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("所选文件不是当前版本可识别的 Local AI Gateway 备份文件。");
  }

  const files = parsed.files.map((entry) => {
    if (
      !entry ||
      typeof entry.relativePath !== "string" ||
      typeof entry.contentBase64 !== "string"
    ) {
      throw new Error("备份文件格式不完整，缺少必要的文件内容。");
    }
    return {
      relativePath: entry.relativePath.replace(/\\/g, "/"),
      contentBase64: entry.contentBase64,
      sizeBytes:
        typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)
          ? entry.sizeBytes
          : Buffer.from(entry.contentBase64, "base64").byteLength,
    };
  });

  return {
    format: APP_DATA_BACKUP_FORMAT,
    version: APP_DATA_BACKUP_VERSION,
    appVersion:
      typeof parsed.appVersion === "string" ? parsed.appVersion : "unknown",
    exportedAt:
      typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
    files,
  };
}

export function writeAppDataBackupBundle(
  targetPath: string,
  bundle: AppDataBackupBundle,
): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

export function createBackupFileName(prefix = "local-ai-gateway-backup"): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${timestamp}.json`;
}

export function restoreAppDataBackupBundle(
  paths: GatewayPaths,
  bundle: AppDataBackupBundle,
): { restoredFiles: number; restoredBytes: number } {
  mkdirSync(paths.rootDir, { recursive: true });

  for (const entry of readdirSync(paths.rootDir, { withFileTypes: true })) {
    if (entry.name === "backups") {
      continue;
    }
    rmSync(join(paths.rootDir, entry.name), { recursive: true, force: true });
  }

  let restoredBytes = 0;
  for (const file of bundle.files) {
    const normalizedRelative = file.relativePath.replace(/\\/g, "/");
    if (!normalizedRelative || normalizedRelative.startsWith("..") || isBackupRelativePath(normalizedRelative)) {
      continue;
    }
    const absolutePath = join(paths.rootDir, normalizedRelative);
    mkdirSync(dirname(absolutePath), { recursive: true });
    const content = Buffer.from(file.contentBase64, "base64");
    writeFileSync(absolutePath, content);
    restoredBytes += content.byteLength;
  }

  return {
    restoredFiles: bundle.files.length,
    restoredBytes,
  };
}

export function getBackupBundleSizeBytes(bundle: AppDataBackupBundle): number {
  return bundle.files.reduce((total, file) => total + file.sizeBytes, 0);
}

export function getAppDataSnapshotSummary(paths: GatewayPaths): {
  fileCount: number;
  totalBytes: number;
} {
  if (!statSafe(paths.rootDir)) {
    return { fileCount: 0, totalBytes: 0 };
  }
  const files = listFilesRecursive(paths.rootDir);
  return {
    fileCount: files.length,
    totalBytes: files.reduce(
      (total, filePath) => total + normalizeStatSize(statSafe(filePath)?.size),
      0,
    ),
  };
}

function statSafe(filePath: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

function normalizeStatSize(value: number | bigint | undefined): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
