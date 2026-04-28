import { createRequire } from "node:module";
import { join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import {
  GatewayLogRecord,
  GatewayPaths,
  GatewayPoolSelectionEvent,
  GatewayRoutingHitEvent,
  GatewayUsageAccountSummary,
  GatewayUsageClientFilter,
  GatewayUsageClientSummary,
  GatewayUsageCounters,
  GatewayUsageEvent,
  GatewayUsageModelSummary,
  GatewayUsageWindowSummary,
  SessionActivitySnapshot,
} from "@local-ai-gateway/shared";

const require = createRequire(import.meta.url);

function loadBetterSqlite3(): typeof BetterSqlite3 {
  try {
    return require("better-sqlite3") as typeof BetterSqlite3;
  } catch (error) {
    const resourcesPath =
      typeof process === "object" && process && "resourcesPath" in process
        ? process.resourcesPath
        : undefined;

    if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
      throw error;
    }

    const unpackedPackagePath = join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
    );
    return require(unpackedPackagePath) as typeof BetterSqlite3;
  }
}

const Database = loadBetterSqlite3();
type BetterSqliteDatabase = InstanceType<typeof Database>;

function createEmptyUsageCounters(): GatewayUsageCounters {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    totalLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

function normalizeUsageCounterValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ensureColumnIfMissing(
  db: BetterSqliteDatabase,
  tableName: string,
  columnName: string,
  definitionSql: string,
): void {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql};`);
}

export class GatewayDatabase {
  private readonly db: BetterSqliteDatabase;

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inference_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        session_id TEXT,
        account_id TEXT,
        email TEXT,
        client_tag TEXT,
        provider_id TEXT NOT NULL,
        model_alias TEXT NOT NULL,
        upstream_model_id TEXT,
        ok INTEGER NOT NULL,
        stream INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cached_tokens_present INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens_present INTEGER NOT NULL DEFAULT 0,
        source_kind TEXT,
        source_event_key TEXT
      );
    `);
    ensureColumnIfMissing(
      this.db,
      "inference_usage_events",
      "cached_tokens_present",
      "cached_tokens_present INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumnIfMissing(
      this.db,
      "inference_usage_events",
      "reasoning_tokens_present",
      "reasoning_tokens_present INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumnIfMissing(
      this.db,
      "inference_usage_events",
      "source_kind",
      "source_kind TEXT",
    );
    ensureColumnIfMissing(
      this.db,
      "inference_usage_events",
      "source_event_key",
      "source_event_key TEXT",
    );
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inference_usage_events_timestamp
      ON inference_usage_events (timestamp);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inference_usage_events_client_tag
      ON inference_usage_events (client_tag, timestamp);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inference_usage_events_account_id
      ON inference_usage_events (account_id, timestamp);
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inference_usage_events_source_event_key
      ON inference_usage_events (source_event_key)
      WHERE source_event_key IS NOT NULL;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pool_selection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        client_tag TEXT,
        requested_model_alias TEXT,
        selected_session_id TEXT,
        from_session_id TEXT,
        to_session_id TEXT,
        failure_class TEXT,
        reason TEXT
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pool_member_runtime_snapshots (
        pool_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (pool_id, session_id)
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

  insertUsageEvent(event: GatewayUsageEvent): boolean {
    const result = this.db
      .prepare(
        `
          INSERT OR IGNORE INTO inference_usage_events (
            timestamp,
            session_id,
            account_id,
            email,
            client_tag,
            provider_id,
            model_alias,
            upstream_model_id,
            ok,
            stream,
            latency_ms,
            input_tokens,
            output_tokens,
            total_tokens,
            cached_tokens,
            reasoning_tokens,
            cached_tokens_present,
            reasoning_tokens_present,
            source_kind,
            source_event_key
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.timestamp,
        event.sessionId ?? null,
        event.accountId ?? null,
        event.email ?? null,
        event.clientTag ?? null,
        event.providerId,
        event.modelAlias,
        event.upstreamModelId ?? null,
        event.success ? 1 : 0,
        event.stream ? 1 : 0,
        Math.max(0, Math.round(event.latencyMs)),
        Math.max(0, Math.round(event.inputTokens)),
        Math.max(0, Math.round(event.outputTokens)),
        Math.max(0, Math.round(event.totalTokens)),
        Math.max(0, Math.round(event.cachedTokens)),
        Math.max(0, Math.round(event.reasoningTokens)),
        event.cachedTokensPresent ? 1 : 0,
        event.reasoningTokensPresent ? 1 : 0,
        event.sourceKind ?? null,
        event.sourceEventKey ?? null,
      );
    return result.changes > 0;
  }

  backfillUsageFromSessionActivityEvents(): { imported: number; skipped: number } {
    const earliestLiveUsageRow = this.db
      .prepare(
        `
          SELECT MIN(timestamp) AS min_timestamp
          FROM inference_usage_events
          WHERE COALESCE(source_kind, '') != 'local-history-backfill'
        `,
      )
      .get() as { min_timestamp?: number | null } | undefined;
    const earliestLiveUsageTimestamp =
      typeof earliestLiveUsageRow?.min_timestamp === "number"
        ? earliestLiveUsageRow.min_timestamp
        : undefined;

    const eligibleCountSql =
      typeof earliestLiveUsageTimestamp === "number"
        ? `
            SELECT COUNT(1) AS count
            FROM session_activity_events
            WHERE timestamp < ?
          `
        : `
            SELECT COUNT(1) AS count
            FROM session_activity_events
          `;
    const eligibleCountParams =
      typeof earliestLiveUsageTimestamp === "number"
        ? [earliestLiveUsageTimestamp]
        : [];
    const eligibleRow = this.db
      .prepare(eligibleCountSql)
      .get(...eligibleCountParams) as { count?: number | null } | undefined;
    const eligibleCount = normalizeUsageCounterValue(eligibleRow?.count);
    if (eligibleCount <= 0) {
      return { imported: 0, skipped: 0 };
    }

    const insertSql =
      typeof earliestLiveUsageTimestamp === "number"
        ? `
            INSERT OR IGNORE INTO inference_usage_events (
              timestamp,
              session_id,
              account_id,
              email,
              client_tag,
              provider_id,
              model_alias,
              upstream_model_id,
              ok,
              stream,
              latency_ms,
              input_tokens,
              output_tokens,
              total_tokens,
              cached_tokens,
              reasoning_tokens,
              cached_tokens_present,
              reasoning_tokens_present,
              source_kind,
              source_event_key
            )
            SELECT
              session_activity_events.timestamp,
              session_activity_events.session_id,
              NULL,
              NULL,
              session_activity_events.client_tag,
              'local-ai-gateway-legacy',
              'legacy-unknown',
              NULL,
              session_activity_events.ok,
              session_activity_events.stream,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              'local-history-backfill',
              'session-activity:' || session_activity_events.id
            FROM session_activity_events
            WHERE session_activity_events.timestamp < ?
          `
        : `
            INSERT OR IGNORE INTO inference_usage_events (
              timestamp,
              session_id,
              account_id,
              email,
              client_tag,
              provider_id,
              model_alias,
              upstream_model_id,
              ok,
              stream,
              latency_ms,
              input_tokens,
              output_tokens,
              total_tokens,
              cached_tokens,
              reasoning_tokens,
              cached_tokens_present,
              reasoning_tokens_present,
              source_kind,
              source_event_key
            )
            SELECT
              session_activity_events.timestamp,
              session_activity_events.session_id,
              NULL,
              NULL,
              session_activity_events.client_tag,
              'local-ai-gateway-legacy',
              'legacy-unknown',
              NULL,
              session_activity_events.ok,
              session_activity_events.stream,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              'local-history-backfill',
              'session-activity:' || session_activity_events.id
            FROM session_activity_events
          `;
    const insertParams =
      typeof earliestLiveUsageTimestamp === "number"
        ? [earliestLiveUsageTimestamp]
        : [];
    const insertResult = this.db.prepare(insertSql).run(...insertParams);
    const imported = insertResult.changes;
    return {
      imported,
      skipped: Math.max(0, eligibleCount - imported),
    };
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

  insertPoolSelectionEvent(event: GatewayPoolSelectionEvent): void {
    this.db
      .prepare(
        `
          INSERT INTO pool_selection_events (
            timestamp,
            pool_id,
            pool_name,
            event_type,
            client_tag,
            requested_model_alias,
            selected_session_id,
            from_session_id,
            to_session_id,
            failure_class,
            reason
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.timestamp,
        event.poolId,
        event.poolName,
        event.eventType,
        event.clientTag ?? null,
        event.requestedModelAlias ?? null,
        event.selectedSessionId ?? null,
        event.fromSessionId ?? null,
        event.toSessionId ?? null,
        event.failureClass ?? null,
        event.reason ?? null,
      );
  }

  upsertPoolMemberRuntimeState(input: {
    poolId: string;
    sessionId: string;
    state: {
      cooldownUntil?: number;
      lastFailureClass?: string;
      consecutiveFailures: number;
      lastSelectedAt?: number;
      lastSuccessAt?: number;
      lastFailureAt?: number;
    };
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO pool_member_runtime_snapshots (
            pool_id,
            session_id,
            state_json,
            updated_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(pool_id, session_id) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.poolId,
        input.sessionId,
        JSON.stringify(input.state),
        Date.now(),
      );
  }

  getPoolMemberRuntimeStates(limit = 2_000): Array<{
    poolId: string;
    sessionId: string;
    state: {
      cooldownUntil?: number;
      lastFailureClass?: string;
      consecutiveFailures: number;
      lastSelectedAt?: number;
      lastSuccessAt?: number;
      lastFailureAt?: number;
    };
  }> {
    const rows = this.db
      .prepare(
        `
          SELECT pool_id, session_id, state_json
          FROM pool_member_runtime_snapshots
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      pool_id: string;
      session_id: string;
      state_json: string;
    }>;

    return rows
      .map((row) => {
        try {
          return {
            poolId: row.pool_id,
            sessionId: row.session_id,
            state: JSON.parse(row.state_json) as {
              cooldownUntil?: number;
              lastFailureClass?: string;
              consecutiveFailures: number;
              lastSelectedAt?: number;
              lastSuccessAt?: number;
              lastFailureAt?: number;
            },
          };
        } catch {
          return undefined;
        }
      })
      .filter(
        (
          row,
        ): row is {
          poolId: string;
          sessionId: string;
          state: {
            cooldownUntil?: number;
            lastFailureClass?: string;
            consecutiveFailures: number;
            lastSelectedAt?: number;
            lastSuccessAt?: number;
            lastFailureAt?: number;
          };
        } => Boolean(row),
      );
  }

  deletePoolMemberRuntimeStatesExcept(sessionIds: string[]): void {
    if (!sessionIds.length) {
      this.db
        .prepare(
          `
            DELETE FROM pool_member_runtime_snapshots
          `,
        )
        .run();
      return;
    }

    const placeholders = sessionIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `
          DELETE FROM pool_member_runtime_snapshots
          WHERE session_id NOT IN (${placeholders})
        `,
      )
      .run(...sessionIds);
  }

  getRecentPoolSelectionEvents(limit = 500): GatewayPoolSelectionEvent[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            timestamp,
            pool_id,
            pool_name,
            event_type,
            client_tag,
            requested_model_alias,
            selected_session_id,
            from_session_id,
            to_session_id,
            failure_class,
            reason
          FROM pool_selection_events
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      timestamp: number;
      pool_id: string;
      pool_name: string;
      event_type: GatewayPoolSelectionEvent["eventType"];
      client_tag: string | null;
      requested_model_alias: string | null;
      selected_session_id: string | null;
      from_session_id: string | null;
      to_session_id: string | null;
      failure_class: GatewayPoolSelectionEvent["failureClass"] | null;
      reason: string | null;
    }>;

    return rows.reverse().map((row) => ({
      timestamp: row.timestamp,
      poolId: row.pool_id,
      poolName: row.pool_name,
      eventType: row.event_type,
      clientTag: row.client_tag ?? undefined,
      requestedModelAlias: row.requested_model_alias ?? undefined,
      selectedSessionId: row.selected_session_id ?? undefined,
      fromSessionId: row.from_session_id ?? undefined,
      toSessionId: row.to_session_id ?? undefined,
      failureClass: row.failure_class ?? undefined,
      reason: row.reason ?? undefined,
    }));
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

  getUsageSummary(
    options: {
      sinceTimestamp?: number;
      clientFilter?: GatewayUsageClientFilter;
      accountLimit?: number;
      clientLimit?: number;
      modelLimit?: number;
    } = {},
  ): GatewayUsageWindowSummary {
    const clientFilter = options.clientFilter ?? "all";
    const accountLimit = Math.max(1, options.accountLimit ?? 12);
    const clientLimit = Math.max(1, options.clientLimit ?? 12);
    const modelLimit = Math.max(1, options.modelLimit ?? 12);
    const filter = this.buildUsageWhereClause(options.sinceTimestamp, clientFilter);

    const metaRow = this.db
      .prepare(
        `
          SELECT
            MIN(timestamp) AS since_timestamp,
            MAX(timestamp) AS updated_at,
            SUM(CASE WHEN cached_tokens_present = 1 THEN 1 ELSE 0 END) AS cached_signal_count,
            SUM(CASE WHEN reasoning_tokens_present = 1 THEN 1 ELSE 0 END) AS reasoning_signal_count,
            SUM(CASE WHEN source_kind = 'local-history-backfill' THEN 1 ELSE 0 END) AS imported_event_count
          FROM inference_usage_events
          ${filter.sql}
        `,
      )
      .get(...filter.params) as
      | {
          since_timestamp?: number | null;
          updated_at?: number | null;
          cached_signal_count?: number | null;
          reasoning_signal_count?: number | null;
          imported_event_count?: number | null;
        }
      | undefined;

    const since =
      typeof metaRow?.since_timestamp === "number"
        ? metaRow.since_timestamp
        : typeof options.sinceTimestamp === "number" && Number.isFinite(options.sinceTimestamp)
          ? options.sinceTimestamp
          : Date.now();
    const updatedAt =
      typeof metaRow?.updated_at === "number" ? metaRow.updated_at : since;

    const totalsRow = this.db
      .prepare(
        `
          SELECT
            COUNT(1) AS request_count,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failure_count,
            SUM(latency_ms) AS total_latency_ms,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens
          FROM inference_usage_events
          ${filter.sql}
        `,
      )
      .get(...filter.params) as
      | {
          request_count?: number | null;
          success_count?: number | null;
          failure_count?: number | null;
          total_latency_ms?: number | null;
          input_tokens?: number | null;
          output_tokens?: number | null;
          total_tokens?: number | null;
          cached_tokens?: number | null;
          reasoning_tokens?: number | null;
        }
      | undefined;

    const totals: GatewayUsageCounters = {
      requestCount: normalizeUsageCounterValue(totalsRow?.request_count),
      successCount: normalizeUsageCounterValue(totalsRow?.success_count),
      failureCount: normalizeUsageCounterValue(totalsRow?.failure_count),
      totalLatencyMs: normalizeUsageCounterValue(totalsRow?.total_latency_ms),
      inputTokens: normalizeUsageCounterValue(totalsRow?.input_tokens),
      outputTokens: normalizeUsageCounterValue(totalsRow?.output_tokens),
      totalTokens: normalizeUsageCounterValue(totalsRow?.total_tokens),
      cachedTokens: normalizeUsageCounterValue(totalsRow?.cached_tokens),
      reasoningTokens: normalizeUsageCounterValue(totalsRow?.reasoning_tokens),
    };

    const accounts = this.db
      .prepare(
        `
          SELECT
            account_id,
            email,
            COUNT(1) AS request_count,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failure_count,
            SUM(latency_ms) AS total_latency_ms,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            MAX(timestamp) AS updated_at
          FROM inference_usage_events
          ${filter.sql}${filter.sql ? " AND " : " WHERE "}account_id IS NOT NULL AND account_id != ''
          GROUP BY account_id, email
          ORDER BY total_tokens DESC, request_count DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(...filter.params, accountLimit) as Array<{
      account_id: string;
      email: string | null;
      request_count: number | null;
      success_count: number | null;
      failure_count: number | null;
      total_latency_ms: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      cached_tokens: number | null;
      reasoning_tokens: number | null;
      updated_at: number | null;
    }>;

    const clients = this.db
      .prepare(
        `
          SELECT
            COALESCE(NULLIF(client_tag, ''), 'unknown') AS normalized_client_tag,
            COUNT(1) AS request_count,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failure_count,
            SUM(latency_ms) AS total_latency_ms,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            MAX(timestamp) AS updated_at
          FROM inference_usage_events
          ${filter.sql}
          GROUP BY normalized_client_tag
          ORDER BY total_tokens DESC, request_count DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(...filter.params, clientLimit) as Array<{
      normalized_client_tag: string;
      request_count: number | null;
      success_count: number | null;
      failure_count: number | null;
      total_latency_ms: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      cached_tokens: number | null;
      reasoning_tokens: number | null;
      updated_at: number | null;
    }>;

    const models = this.db
      .prepare(
        `
          SELECT
            model_alias,
            COUNT(1) AS request_count,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failure_count,
            SUM(latency_ms) AS total_latency_ms,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(cached_tokens) AS cached_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            MAX(timestamp) AS updated_at
          FROM inference_usage_events
          ${filter.sql}
          GROUP BY model_alias
          ORDER BY total_tokens DESC, request_count DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(...filter.params, modelLimit) as Array<{
      model_alias: string;
      request_count: number | null;
      success_count: number | null;
      failure_count: number | null;
      total_latency_ms: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      cached_tokens: number | null;
      reasoning_tokens: number | null;
      updated_at: number | null;
    }>;

    return {
      since,
      updatedAt,
      totals,
      cachedSignalCount: normalizeUsageCounterValue(metaRow?.cached_signal_count),
      reasoningSignalCount: normalizeUsageCounterValue(metaRow?.reasoning_signal_count),
      importedEventCount: normalizeUsageCounterValue(metaRow?.imported_event_count),
      accounts: accounts.map((row) => this.mapUsageAccountSummary(row)),
      clients: clients.map((row) => this.mapUsageClientSummary(row)),
      models: models.map((row) => this.mapUsageModelSummary(row)),
    };
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
    this.db
      .prepare(
        `
          DELETE FROM pool_selection_events
        `,
      )
      .run();
    this.db
      .prepare(
        `
          DELETE FROM pool_member_runtime_snapshots
        `,
      )
      .run();
    this.db
      .prepare(
        `
          DELETE FROM inference_usage_events
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

  prunePoolSelectionEvents(options: { maxRows?: number; retainDays?: number } = {}): void {
    const maxRows = Math.max(200, options.maxRows ?? 10_000);
    const retainDays = Math.max(1, options.retainDays ?? 30);
    const minTimestamp = Date.now() - retainDays * 24 * 60 * 60 * 1000;

    this.db
      .prepare(
        `
          DELETE FROM pool_selection_events
          WHERE timestamp < ?
        `,
      )
      .run(minTimestamp);

    const row = this.db
      .prepare(
        `
          SELECT id
          FROM pool_selection_events
          ORDER BY id DESC
          LIMIT 1 OFFSET ?
        `,
      )
      .get(maxRows - 1) as { id?: number } | undefined;

    if (typeof row?.id === "number") {
      this.db
        .prepare(
          `
            DELETE FROM pool_selection_events
            WHERE id < ?
          `,
        )
        .run(row.id);
    }
  }

  pruneUsageEvents(options: { maxRows?: number; retainDays?: number } = {}): void {
    const maxRows = Math.max(2_000, options.maxRows ?? 250_000);
    const retainDays = Math.max(7, options.retainDays ?? 365);
    const minTimestamp = Date.now() - retainDays * 24 * 60 * 60 * 1000;

    this.db
      .prepare(
        `
          DELETE FROM inference_usage_events
          WHERE timestamp < ?
        `,
      )
      .run(minTimestamp);

    const row = this.db
      .prepare(
        `
          SELECT id
          FROM inference_usage_events
          ORDER BY id DESC
          LIMIT 1 OFFSET ?
        `,
      )
      .get(maxRows - 1) as { id?: number } | undefined;

    if (typeof row?.id === "number") {
      this.db
        .prepare(
          `
            DELETE FROM inference_usage_events
            WHERE id < ?
          `,
        )
        .run(row.id);
    }
  }

  close(): void {
    this.db.close();
  }

  private buildUsageWhereClause(
    sinceTimestamp?: number,
    clientFilter: GatewayUsageClientFilter = "all",
  ): {
    sql: string;
    params: Array<number | string>;
  } {
    const clauses: string[] = [];
    const params: Array<number | string> = [];

    if (typeof sinceTimestamp === "number" && Number.isFinite(sinceTimestamp)) {
      clauses.push("timestamp >= ?");
      params.push(sinceTimestamp);
    }

    if (clientFilter === "openclaw" || clientFilter === "hermes") {
      clauses.push("LOWER(COALESCE(client_tag, '')) = ?");
      params.push(clientFilter);
    } else if (clientFilter === "other") {
      clauses.push("LOWER(COALESCE(client_tag, '')) NOT IN ('openclaw', 'hermes')");
    }

    return {
      sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  private mapUsageAccountSummary(row: {
    account_id: string;
    email: string | null;
    request_count: number | null;
    success_count: number | null;
    failure_count: number | null;
    total_latency_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    cached_tokens: number | null;
    reasoning_tokens: number | null;
    updated_at: number | null;
  }): GatewayUsageAccountSummary {
    return {
      accountId: row.account_id,
      email: row.email ?? undefined,
      updatedAt:
        typeof row.updated_at === "number" ? row.updated_at : undefined,
      usage: {
        requestCount: normalizeUsageCounterValue(row.request_count),
        successCount: normalizeUsageCounterValue(row.success_count),
        failureCount: normalizeUsageCounterValue(row.failure_count),
        totalLatencyMs: normalizeUsageCounterValue(row.total_latency_ms),
        inputTokens: normalizeUsageCounterValue(row.input_tokens),
        outputTokens: normalizeUsageCounterValue(row.output_tokens),
        totalTokens: normalizeUsageCounterValue(row.total_tokens),
        cachedTokens: normalizeUsageCounterValue(row.cached_tokens),
        reasoningTokens: normalizeUsageCounterValue(row.reasoning_tokens),
      },
    };
  }

  private mapUsageClientSummary(row: {
    normalized_client_tag: string;
    request_count: number | null;
    success_count: number | null;
    failure_count: number | null;
    total_latency_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    cached_tokens: number | null;
    reasoning_tokens: number | null;
    updated_at: number | null;
  }): GatewayUsageClientSummary {
    return {
      clientTag: row.normalized_client_tag,
      updatedAt:
        typeof row.updated_at === "number" ? row.updated_at : undefined,
      usage: {
        requestCount: normalizeUsageCounterValue(row.request_count),
        successCount: normalizeUsageCounterValue(row.success_count),
        failureCount: normalizeUsageCounterValue(row.failure_count),
        totalLatencyMs: normalizeUsageCounterValue(row.total_latency_ms),
        inputTokens: normalizeUsageCounterValue(row.input_tokens),
        outputTokens: normalizeUsageCounterValue(row.output_tokens),
        totalTokens: normalizeUsageCounterValue(row.total_tokens),
        cachedTokens: normalizeUsageCounterValue(row.cached_tokens),
        reasoningTokens: normalizeUsageCounterValue(row.reasoning_tokens),
      },
    };
  }

  private mapUsageModelSummary(row: {
    model_alias: string;
    request_count: number | null;
    success_count: number | null;
    failure_count: number | null;
    total_latency_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    cached_tokens: number | null;
    reasoning_tokens: number | null;
    updated_at: number | null;
  }): GatewayUsageModelSummary {
    return {
      modelAlias: row.model_alias,
      updatedAt:
        typeof row.updated_at === "number" ? row.updated_at : undefined,
      usage: {
        requestCount: normalizeUsageCounterValue(row.request_count),
        successCount: normalizeUsageCounterValue(row.success_count),
        failureCount: normalizeUsageCounterValue(row.failure_count),
        totalLatencyMs: normalizeUsageCounterValue(row.total_latency_ms),
        inputTokens: normalizeUsageCounterValue(row.input_tokens),
        outputTokens: normalizeUsageCounterValue(row.output_tokens),
        totalTokens: normalizeUsageCounterValue(row.total_tokens),
        cachedTokens: normalizeUsageCounterValue(row.cached_tokens),
        reasoningTokens: normalizeUsageCounterValue(row.reasoning_tokens),
      },
    };
  }
}
