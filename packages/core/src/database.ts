import Database from "better-sqlite3";

import {
  GatewayLogRecord,
  GatewayPaths,
  GatewayRoutingHitEvent,
  SessionActivitySnapshot,
} from "@local-ai-gateway/shared";

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_activity_snapshots (
        session_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_hit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        client_tag TEXT,
        requested_model_alias TEXT NOT NULL,
        resolved_model_alias TEXT NOT NULL,
        resolved_session_id TEXT,
        matched_rule_id TEXT NOT NULL,
        matched_rule_name TEXT NOT NULL,
        model_applied INTEGER NOT NULL,
        session_applied INTEGER NOT NULL,
        warnings_json TEXT
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        client_tag TEXT NOT NULL,
        ok INTEGER NOT NULL,
        stream INTEGER NOT NULL
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

  upsertSessionActivity(sessionId: string, snapshot: SessionActivitySnapshot): void {
    this.db
      .prepare(
        `
          INSERT INTO session_activity_snapshots (session_id, snapshot_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            snapshot_json = excluded.snapshot_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(sessionId, JSON.stringify(snapshot), Date.now());
  }

  getSessionActivities(limit = 2_000): Array<{
    sessionId: string;
    snapshot: SessionActivitySnapshot;
  }> {
    const rows = this.db
      .prepare(
        `
          SELECT session_id, snapshot_json
          FROM session_activity_snapshots
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      session_id: string;
      snapshot_json: string;
    }>;

    return rows
      .map((row) => {
        try {
          return {
            sessionId: row.session_id,
            snapshot: JSON.parse(row.snapshot_json) as SessionActivitySnapshot,
          };
        } catch {
          return undefined;
        }
      })
      .filter((row): row is { sessionId: string; snapshot: SessionActivitySnapshot } => Boolean(row));
  }

  deleteSessionActivitiesExcept(sessionIds: string[]): void {
    if (!sessionIds.length) {
      this.db
        .prepare(
          `
            DELETE FROM session_activity_snapshots
          `,
        )
        .run();
      return;
    }

    const placeholders = sessionIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `
          DELETE FROM session_activity_snapshots
          WHERE session_id NOT IN (${placeholders})
        `,
      )
      .run(...sessionIds);
  }

  insertSessionActivityEvent(input: {
    sessionId: string;
    timestamp: number;
    clientTag: string;
    ok: boolean;
    stream: boolean;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO session_activity_events (
            session_id,
            timestamp,
            client_tag,
            ok,
            stream
          )
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.sessionId,
        input.timestamp,
        input.clientTag,
        input.ok ? 1 : 0,
        input.stream ? 1 : 0,
      );
  }

  getRecentSessionClientActivity(
    sessionIds: string[],
    sinceTimestamp: number,
  ): Map<
    string,
    {
      total: number;
      byClientTag: SessionActivitySnapshot["byClientTag"];
    }
  > {
    const result = new Map<
      string,
      {
        total: number;
        byClientTag: NonNullable<SessionActivitySnapshot["byClientTag"]>;
      }
    >();
    if (!sessionIds.length) {
      return result;
    }

    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
          SELECT
            session_id,
            client_tag,
            COUNT(1) AS request_count,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failure_count,
            MAX(timestamp) AS last_request_at
          FROM session_activity_events
          WHERE timestamp >= ?
            AND session_id IN (${placeholders})
          GROUP BY session_id, client_tag
        `,
      )
      .all(sinceTimestamp, ...sessionIds) as Array<{
      session_id: string;
      client_tag: string;
      request_count: number;
      success_count: number;
      failure_count: number;
      last_request_at: number | null;
    }>;

    for (const row of rows) {
      const current = result.get(row.session_id) ?? {
        total: 0,
        byClientTag: [],
      };
      current.total += row.request_count;
      current.byClientTag.push({
        clientTag: row.client_tag,
        requestCount: row.request_count,
        successCount: row.success_count,
        failureCount: row.failure_count,
        lastRequestAt:
          typeof row.last_request_at === "number" ? row.last_request_at : undefined,
      });
      result.set(row.session_id, current);
    }

    for (const value of result.values()) {
      value.byClientTag.sort(
        (left, right) =>
          right.requestCount - left.requestCount ||
          (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0),
      );
    }

    return result;
  }

  insertRoutingHit(event: GatewayRoutingHitEvent): void {
    this.db
      .prepare(
        `
          INSERT INTO routing_hit_events (
            timestamp,
            client_tag,
            requested_model_alias,
            resolved_model_alias,
            resolved_session_id,
            matched_rule_id,
            matched_rule_name,
            model_applied,
            session_applied,
            warnings_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.timestamp,
        event.clientTag ?? null,
        event.requestedModelAlias,
        event.resolvedModelAlias,
        event.resolvedSessionId ?? null,
        event.matchedRuleId,
        event.matchedRuleName,
        event.modelApplied ? 1 : 0,
        event.sessionApplied ? 1 : 0,
        event.warnings?.length ? JSON.stringify(event.warnings) : null,
      );
  }

  getRecentRoutingHits(limit = 500): GatewayRoutingHitEvent[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            timestamp,
            client_tag,
            requested_model_alias,
            resolved_model_alias,
            resolved_session_id,
            matched_rule_id,
            matched_rule_name,
            model_applied,
            session_applied,
            warnings_json
          FROM routing_hit_events
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      timestamp: number;
      client_tag: string | null;
      requested_model_alias: string;
      resolved_model_alias: string;
      resolved_session_id: string | null;
      matched_rule_id: string;
      matched_rule_name: string;
      model_applied: number;
      session_applied: number;
      warnings_json: string | null;
    }>;

    return rows
      .reverse()
      .map((row) => ({
        timestamp: row.timestamp,
        clientTag: row.client_tag ?? undefined,
        requestedModelAlias: row.requested_model_alias,
        resolvedModelAlias: row.resolved_model_alias,
        resolvedSessionId: row.resolved_session_id ?? undefined,
        matchedRuleId: row.matched_rule_id,
        matchedRuleName: row.matched_rule_name,
        modelApplied: row.model_applied === 1,
        sessionApplied: row.session_applied === 1,
        warnings: row.warnings_json ? (JSON.parse(row.warnings_json) as string[]) : undefined,
      }));
  }

  countRoutingHitsSince(sinceTimestamp?: number): number {
    if (typeof sinceTimestamp !== "number" || !Number.isFinite(sinceTimestamp)) {
      const row = this.db
        .prepare(
          `
            SELECT COUNT(1) AS count
            FROM routing_hit_events
          `,
        )
        .get() as { count?: number } | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    }

    const row = this.db
      .prepare(
        `
          SELECT COUNT(1) AS count
          FROM routing_hit_events
          WHERE timestamp >= ?
        `,
      )
      .get(sinceTimestamp) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  clearTelemetry(): void {
    this.db
      .prepare(
        `
          DELETE FROM routing_hit_events
        `,
      )
      .run();
    this.db
      .prepare(
        `
          DELETE FROM session_activity_snapshots
        `,
      )
      .run();
    this.db
      .prepare(
        `
          DELETE FROM session_activity_events
        `,
      )
      .run();
  }

  pruneSessionActivityEvents(options: { maxRows?: number; retainDays?: number } = {}): void {
    const maxRows = Math.max(500, options.maxRows ?? 50_000);
    const retainDays = Math.max(1, options.retainDays ?? 30);
    const minTimestamp = Date.now() - retainDays * 24 * 60 * 60 * 1000;

    this.db
      .prepare(
        `
          DELETE FROM session_activity_events
          WHERE timestamp < ?
        `,
      )
      .run(minTimestamp);

    const row = this.db
      .prepare(
        `
          SELECT id
          FROM session_activity_events
          ORDER BY id DESC
          LIMIT 1 OFFSET ?
        `,
      )
      .get(maxRows - 1) as { id?: number } | undefined;

    if (typeof row?.id === "number") {
      this.db
        .prepare(
          `
            DELETE FROM session_activity_events
            WHERE id < ?
          `,
        )
        .run(row.id);
    }
  }

  pruneRoutingHits(options: { maxRows?: number; retainDays?: number } = {}): void {
    const maxRows = Math.max(200, options.maxRows ?? 20_000);
    const retainDays = Math.max(1, options.retainDays ?? 30);
    const minTimestamp = Date.now() - retainDays * 24 * 60 * 60 * 1000;

    this.db
      .prepare(
        `
          DELETE FROM routing_hit_events
          WHERE timestamp < ?
        `,
      )
      .run(minTimestamp);

    const row = this.db
      .prepare(
        `
          SELECT id
          FROM routing_hit_events
          ORDER BY id DESC
          LIMIT 1 OFFSET ?
        `,
      )
      .get(maxRows - 1) as { id?: number } | undefined;

    if (typeof row?.id === "number") {
      this.db
        .prepare(
          `
            DELETE FROM routing_hit_events
            WHERE id < ?
          `,
        )
        .run(row.id);
    }
  }

  close(): void {
    this.db.close();
  }
}
