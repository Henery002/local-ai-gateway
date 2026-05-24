import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAppPaths, GatewayDatabase } from "@local-ai-gateway/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("adds request prompt audit column when upgrading older content audit tables", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-db-migration-"));
    const paths = ensureAppPaths(rootDir);
    const sqlite = new Database(paths.dbPath);

    try {
      sqlite.exec(`
        CREATE TABLE request_content_audit_events (
          source_event_key TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          model_alias TEXT,
          consumer_id TEXT,
          access_key_id TEXT,
          TEXT,
          content_json TEXT NOT NULL,
          captured_characters INTEGER NOT NULL,
          truncated INTEGER NOT NULL
        );
      `);
      sqlite.close();

      const database = new GatewayDatabase(paths);
      database.close();

      const migrated = new Database(paths.dbPath);
      try {
        const columns = migrated
          .prepare("PRAGMA table_info(request_content_audit_events)")
          .all() as Array<{ name?: string }>;
        expect(columns.map((column) => column.name)).toContain("prompt_text");
      } finally {
        migrated.close();
      }
    } finally {
      if (sqlite.open) {
        sqlite.close();
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
