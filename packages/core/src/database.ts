import Database from "better-sqlite3";

import { GatewayLogRecord, GatewayPaths } from "@local-ai-gateway/shared";

export class GatewayDatabase {
  private readonly db: Database.Database;

  constructor(paths: GatewayPaths) {
    this.db = new Database(paths.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  insertLog(record: GatewayLogRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO event_logs (level, message, details_json, created_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(
        record.level,
        record.message,
        record.details ? JSON.stringify(record.details) : null,
        record.createdAt,
      );
  }

  getRecentErrors(limit = 20): GatewayLogRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT level, message, details_json, created_at
          FROM event_logs
          WHERE level IN ('warn', 'error')
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      level: GatewayLogRecord["level"];
      message: string;
      details_json: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      level: row.level,
      message: row.message,
      details: row.details_json ? (JSON.parse(row.details_json) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

