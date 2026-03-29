import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

import { describe, expect, it, afterEach } from "vitest";

import { ensureAppPaths } from "../packages/core/src/app-paths.js";
import {
  createAppDataBackupBundle,
  parseAppDataBackupBundle,
  restoreAppDataBackupBundle,
  writeAppDataBackupBundle,
} from "../apps/desktop/src/backup-utils.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("desktop backup utils", () => {
  it("exports current app support data and skips internal backups", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-backup-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);

    writeFileSync(paths.configPath, JSON.stringify({ foo: "bar" }));
    writeFileSync(paths.codexProfilesPath, JSON.stringify({ profiles: {} }));
    writeFileSync(paths.dbPath, Buffer.from("sqlite-binary"));
    writeFileSync(join(paths.logsDir, "gateway.log"), "hello log");

    const backupsDir = join(paths.rootDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, "should-not-export.json"), "hidden");

    const bundle = createAppDataBackupBundle(paths, "0.1.0");
    const exportedPaths = bundle.files.map((file) => file.relativePath);

    expect(exportedPaths).toEqual(
      expect.arrayContaining([
        "codex-auth-profiles.json",
        "config.json",
        "gateway.db",
        "logs/gateway.log",
      ]),
    );
    expect(exportedPaths.some((file) => file.startsWith("backups/"))).toBe(false);
  });

  it("restores exported data back into app support directory", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-backup-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);

    writeFileSync(paths.configPath, JSON.stringify({ foo: "before" }));
    writeFileSync(paths.codexProfilesPath, JSON.stringify({ profiles: { a: { label: "A" } } }));
    writeFileSync(paths.dbPath, Buffer.from("first-db"));
    writeFileSync(join(paths.logsDir, "gateway.log"), "first-log");

    const bundle = createAppDataBackupBundle(paths, "0.1.0");
    const exportPath = join(rootDir, "export.json");
    writeAppDataBackupBundle(exportPath, bundle);

    writeFileSync(paths.configPath, JSON.stringify({ foo: "after" }));
    writeFileSync(paths.codexProfilesPath, JSON.stringify({ profiles: { b: { label: "B" } } }));
    writeFileSync(paths.dbPath, Buffer.from("second-db"));
    writeFileSync(join(paths.logsDir, "gateway.log"), "second-log");

    const parsed = parseAppDataBackupBundle(readFileSync(exportPath, "utf8"));
    const restored = restoreAppDataBackupBundle(paths, parsed);

    expect(restored.restoredFiles).toBe(bundle.files.length);
    expect(JSON.parse(readFileSync(paths.configPath, "utf8"))).toEqual({ foo: "before" });
    expect(JSON.parse(readFileSync(paths.codexProfilesPath, "utf8"))).toEqual({
      profiles: { a: { label: "A" } },
    });
    expect(readFileSync(paths.dbPath).toString("utf8")).toBe("first-db");
    expect(readFileSync(join(paths.logsDir, "gateway.log"), "utf8")).toBe("first-log");
  });
});
