import { createRequire } from "node:module";
import { join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import {
  GatewayAccessAlertAcknowledgeAllResult,
  GatewayAccessAlertClearAcknowledgedResult,
  GatewayAccessAlertEvent,
  GatewayLogRecord,
  GatewayPaths,
  GatewayPoolSelectionEvent,
  GatewayRequestAuditContent,
  GatewayRequestAuditEntry,
  GatewayRequestAuditFacetOption,
  GatewayRequestAuditQuery,
  GatewayRequestAuditResult,
  GatewayRoutingHitEvent,
  GatewayUsageAccountSummary,
  GatewayUsageAccessKeyTimelinePoint,
  GatewayUsageAccessKeySummary,
  GatewayUsageClientFilter,
  GatewayUsageClientSummary,
  GatewayUsageConsumerSummary,
  GatewayUsageConsumerTimelinePoint,
  GatewayUsageCounters,
  GatewayUsageEvent,
  GatewayUsageModelSummary,
  GatewayUsageModelTimelinePoint,
  GatewayUsagePoolTimelinePoint,
  GatewayUsagePoolSummary,
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

type AccessAlertEventRow = {
  id: number;
  timestamp: number;
  severity: GatewayAccessAlertEvent["severity"];
  consumer_id: string | null;
  consumer_type: GatewayAccessAlertEvent["consumerType"] | null;
  access_key_id: string | null;
  type: string;
  message: string;
  details_json: string | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  dedupe_key: string | null;
  occurrence_count: number | null;
  last_seen_at: number | null;
};

type RequestAuditEventRow = {
  id: number;
  timestamp: number;
  session_id: string | null;
  account_id: string | null;
  email: string | null;
  client_tag: string | null;
  consumer_id: string | null;
  access_key_id: string | null;
  pool_id: string | null;
  provider_id: string;
  model_alias: string;
  upstream_model_id: string | null;
  ok: number;
  stream: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  source_kind: string | null;
  source_event_key: string | null;
};

type RequestContentAuditRow = {
  source_event_key: string;
  timestamp: number;
  model_alias: string | null;
  consumer_id: string | null;
  access_key_id: string | null;
  prompt_text: string | null;
  content_json: string;
  captured_characters: number;
  truncated: number;
};

function mapRequestAuditEventRow(row: RequestAuditEventRow): GatewayRequestAuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    sessionId: row.session_id ?? undefined,
    accountId: row.account_id ?? undefined,
    email: row.email ?? undefined,
    clientTag: row.client_tag ?? undefined,
    consumerId: row.consumer_id ?? undefined,
    accessKeyId: row.access_key_id ?? undefined,
    poolId: row.pool_id ?? undefined,
    providerId: row.provider_id,
    modelAlias: row.model_alias,
    upstreamModelId: row.upstream_model_id ?? undefined,
    success: row.ok === 1,
    stream: row.stream === 1,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cachedTokens: row.cached_tokens,
    reasoningTokens: row.reasoning_tokens,
    sourceKind: row.source_kind ?? undefined,
    sourceEventKey: row.source_event_key ?? undefined,
  };
}

function stringifyAuditPromptContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (!part || typeof part !== "object") {
          return "";
        }
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") {
          return record.text;
        }
        return typeof record.type === "string" ? `[${record.type}]` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function inferPromptTextFromContentJson(contentJson: string): string | undefined {
  try {
    const parsed = JSON.parse(contentJson) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    };
    const latestUser = [...(parsed.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    const promptText = stringifyAuditPromptContent(latestUser?.content).trim();
    return promptText || undefined;
  } catch {
    return undefined;
  }
}

function getAuditDetailString(
  details: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getAuditDetailNumber(
  details: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function getAuditDetailBoolean(
  details: Record<string, unknown> | undefined,
  keys: string[],
): boolean {
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return false;
}

function mapAccessAlertEventRowToRequestAuditEntry(
  row: AccessAlertEventRow,
): GatewayRequestAuditEntry {
  let details: Record<string, unknown> | undefined;
  try {
    details = row.details_json
      ? (JSON.parse(row.details_json) as Record<string, unknown>)
      : undefined;
  } catch {
    details = undefined;
  }
  const statusCode = getAuditDetailNumber(details, ["statusCode"]);
  return {
    id: -row.id,
    timestamp: row.last_seen_at ?? row.timestamp,
    sessionId: getAuditDetailString(details, ["sessionId", "resolvedSessionId"]),
    accountId: getAuditDetailString(details, ["accountId"]),
    email: getAuditDetailString(details, ["email"]),
    clientTag: getAuditDetailString(details, ["clientTag"]),
    consumerId: row.consumer_id ?? undefined,
    accessKeyId: row.access_key_id ?? undefined,
    poolId: getAuditDetailString(details, ["poolId", "resolvedPoolId"]),
    providerId: "gateway",
    modelAlias:
      getAuditDetailString(details, [
        "resolvedModelAlias",
        "requestedModelAlias",
        "modelAlias",
      ]) ?? "unknown",
    upstreamModelId: undefined,
    success: false,
    stream: getAuditDetailBoolean(details, ["stream"]),
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    errorCode: getAuditDetailString(details, ["errorCode"]) ?? row.type,
    statusCode,
    sourceKind: "access-alert",
    sourceEventKey:
      getAuditDetailString(details, ["requestAuditSourceEventKey"]) ??
      `access-alert:${row.id}`,
  };
}

function mapAccessAlertEventRow(row: AccessAlertEventRow): GatewayAccessAlertEvent {
  const occurrenceCount =
    typeof row.occurrence_count === "number" && row.occurrence_count > 0
      ? row.occurrence_count
      : 1;
  return {
    id: row.id,
    timestamp: row.timestamp,
    severity: row.severity,
    consumerId: row.consumer_id ?? undefined,
    consumerType: row.consumer_type ?? undefined,
    accessKeyId: row.access_key_id ?? undefined,
    type: row.type,
    message: row.message,
    details: row.details_json
      ? (JSON.parse(row.details_json) as Record<string, unknown>)
      : undefined,
    acknowledgedAt: row.acknowledged_at ?? undefined,
    acknowledgedBy: row.acknowledged_by ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    occurrenceCount,
    lastSeenAt: row.last_seen_at ?? row.timestamp,
  };
}

function incrementFacet(
  map: Map<string, GatewayRequestAuditFacetOption>,
  value: string | undefined,
  label?: string,
): void {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }
  const existing = map.get(normalized);
  if (existing) {
    existing.count += 1;
    if (!existing.label && label) {
      existing.label = label;
    }
    return;
  }
  map.set(normalized, {
    value: normalized,
    label,
    count: 1,
  });
}

function toFacetOptions(
  map: Map<string, GatewayRequestAuditFacetOption>,
): GatewayRequestAuditFacetOption[] {
  return Array.from(map.values()).sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return left.value.localeCompare(right.value);
  });
}

function normalizeAccessAlertDedupePart(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "-";
}

function buildAccessAlertDedupeKey(event: GatewayAccessAlertEvent): string {
  const details = event.details ?? {};
  const poolId =
    typeof details.poolId === "string"
      ? details.poolId
      : typeof details.resolvedPoolId === "string"
        ? details.resolvedPoolId
        : undefined;
  const modelAlias =
    typeof details.modelAlias === "string"
      ? details.modelAlias
      : typeof details.requestedModelAlias === "string"
        ? details.requestedModelAlias
        : undefined;

  return [
    normalizeAccessAlertDedupePart(event.type),
    normalizeAccessAlertDedupePart(event.consumerId),
    normalizeAccessAlertDedupePart(event.consumerType),
    normalizeAccessAlertDedupePart(event.accessKeyId),
    normalizeAccessAlertDedupePart(poolId),
    normalizeAccessAlertDedupePart(modelAlias),
  ].join("|");
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
        consumer_id TEXT,
        consumer_type TEXT,
        access_key_id TEXT,
        pool_id TEXT,
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS access_alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        severity TEXT NOT NULL,
        consumer_id TEXT,
        access_key_id TEXT,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        acknowledged_at INTEGER,
        acknowledged_by TEXT,
        dedupe_key TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_content_audit_events (
        source_event_key TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model_alias TEXT,
        consumer_id TEXT,
        access_key_id TEXT,
        prompt_text TEXT,
        content_json TEXT NOT NULL,
        captured_characters INTEGER NOT NULL,
        truncated INTEGER NOT NULL
      );
    `);
    ensureColumnIfMissing(
      this.db,
      "request_content_audit_events",
      "prompt_text",
      "prompt_text TEXT",
    );
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
    ensureColumnIfMissing(
      this.db,
      "inference_usage_events",
      "consumer_id",
      "consumer_id TEXT",
    );
    ensureColumnIfMissing(
      this.db,
      "inference_usage_events",
      "access_key_id",
      "access_key_id TEXT",
    );
    ensureColumnIfMissing(
      this.db,
      "inference_usage_events",
      "pool_id",
      "pool_id TEXT",
    );
    ensureColumnIfMissing(
      this.db,
      "access_alert_events",
      "consumer_type",
      "consumer_type TEXT",
    );
    ensureColumnIfMissing(
      this.db,
      "access_alert_events",
      "acknowledged_at",
      "acknowledged_at INTEGER",
    );
    ensureColumnIfMissing(
      this.db,
      "access_alert_events",
      "acknowledged_by",
      "acknowledged_by TEXT",
    );
    ensureColumnIfMissing(
      this.db,
      "access_alert_events",
      "dedupe_key",
      "dedupe_key TEXT",
    );
    ensureColumnIfMissing(
      this.db,
      "access_alert_events",
      "occurrence_count",
      "occurrence_count INTEGER NOT NULL DEFAULT 1",
    );
    ensureColumnIfMissing(
      this.db,
      "access_alert_events",
      "last_seen_at",
      "last_seen_at INTEGER",
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
      CREATE INDEX IF NOT EXISTS idx_inference_usage_events_consumer_id
      ON inference_usage_events (consumer_id, timestamp);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inference_usage_events_access_key_id
      ON inference_usage_events (access_key_id, timestamp);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inference_usage_events_pool_id
      ON inference_usage_events (pool_id, timestamp);
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
      CREATE INDEX IF NOT EXISTS idx_access_alert_events_timestamp
      ON access_alert_events (timestamp);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_access_alert_events_consumer_id
      ON access_alert_events (consumer_id, timestamp);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_request_content_audit_events_timestamp
      ON request_content_audit_events (timestamp);
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
            consumer_id,
            access_key_id,
            pool_id,
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.timestamp,
        event.sessionId ?? null,
        event.accountId ?? null,
        event.email ?? null,
        event.clientTag ?? null,
        event.consumerId ?? null,
        event.accessKeyId ?? null,
        event.poolId ?? null,
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

  insertRequestContentAuditEvent(event: GatewayRequestAuditContent): void {
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO request_content_audit_events (
            source_event_key,
            timestamp,
            model_alias,
            consumer_id,
            access_key_id,
            prompt_text,
            content_json,
            captured_characters,
            truncated
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.sourceEventKey,
        event.timestamp,
        event.modelAlias ?? null,
        event.consumerId ?? null,
        event.accessKeyId ?? null,
        event.promptText ?? null,
        event.contentJson,
        Math.max(0, Math.floor(event.capturedCharacters)),
        event.truncated ? 1 : 0,
      );
  }

  getRequestContentAuditEvent(
    sourceEventKey: string,
  ): GatewayRequestAuditContent | undefined {
    const normalized = sourceEventKey.trim();
    if (!normalized) {
      return undefined;
    }
    const row = this.db
      .prepare(
        `
          SELECT
            source_event_key,
            timestamp,
            model_alias,
            consumer_id,
            access_key_id,
            prompt_text,
            content_json,
            captured_characters,
            truncated
          FROM request_content_audit_events
          WHERE source_event_key = ?
        `,
      )
      .get(normalized) as RequestContentAuditRow | undefined;
    return row
      ? {
          sourceEventKey: row.source_event_key,
          timestamp: row.timestamp,
          modelAlias: row.model_alias ?? undefined,
          consumerId: row.consumer_id ?? undefined,
          accessKeyId: row.access_key_id ?? undefined,
          promptText: row.prompt_text ?? inferPromptTextFromContentJson(row.content_json),
          contentJson: row.content_json,
          capturedCharacters: row.captured_characters,
          truncated: row.truncated === 1,
        }
      : undefined;
  }

  pruneRequestContentAuditEvents(maxEvents: number): number {
    const normalized = Math.max(0, Math.floor(maxEvents));
    if (normalized <= 0) {
      const result = this.db
        .prepare("DELETE FROM request_content_audit_events")
        .run();
      return result.changes;
    }
    const result = this.db
      .prepare(
        `
          DELETE FROM request_content_audit_events
          WHERE source_event_key NOT IN (
            SELECT source_event_key
            FROM request_content_audit_events
            ORDER BY timestamp DESC
            LIMIT ?
          )
        `,
      )
      .run(normalized);
    return result.changes;
  }

  insertAccessAlertEvent(event: GatewayAccessAlertEvent): void {
    const dedupeKey = event.dedupeKey ?? buildAccessAlertDedupeKey(event);
    const occurrenceCount = Math.max(1, Math.floor(event.occurrenceCount ?? 1));
    const lastSeenAt = event.lastSeenAt ?? event.timestamp;
    if (!event.acknowledgedAt) {
      const existing = this.db
        .prepare(
          `
            SELECT id
            FROM access_alert_events
            WHERE dedupe_key = ? AND acknowledged_at IS NULL
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get(dedupeKey) as { id: number } | undefined;

      if (existing) {
        this.db
          .prepare(
            `
              UPDATE access_alert_events
              SET
                severity = ?,
                consumer_id = ?,
                consumer_type = ?,
                access_key_id = ?,
                type = ?,
                message = ?,
                details_json = ?,
                last_seen_at = ?,
                occurrence_count = occurrence_count + ?
              WHERE id = ?
            `,
          )
          .run(
            event.severity,
            event.consumerId ?? null,
            event.consumerType ?? null,
            event.accessKeyId ?? null,
            event.type,
            event.message,
            event.details ? JSON.stringify(event.details) : null,
            lastSeenAt,
            occurrenceCount,
            existing.id,
          );
        return;
      }
    }

    this.db
      .prepare(
        `
          INSERT INTO access_alert_events (
            timestamp,
            severity,
            consumer_id,
            consumer_type,
            access_key_id,
            type,
            message,
            details_json,
            acknowledged_at,
            acknowledged_by,
            dedupe_key,
            occurrence_count,
            last_seen_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.timestamp,
        event.severity,
        event.consumerId ?? null,
        event.consumerType ?? null,
        event.accessKeyId ?? null,
        event.type,
        event.message,
        event.details ? JSON.stringify(event.details) : null,
        event.acknowledgedAt ?? null,
        event.acknowledgedBy ?? null,
        dedupeKey,
        occurrenceCount,
        lastSeenAt,
      );
  }

  getRecentAccessAlertEvents(limit = 50): GatewayAccessAlertEvent[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            timestamp,
            severity,
            consumer_id,
            consumer_type,
            access_key_id,
            type,
            message,
            details_json,
            acknowledged_at,
            acknowledged_by,
            dedupe_key,
            occurrence_count,
            last_seen_at
          FROM access_alert_events
          ORDER BY COALESCE(last_seen_at, timestamp) DESC, id DESC
          LIMIT ?
        `,
      )
      .all(Math.max(1, Math.min(200, Math.floor(limit)))) as AccessAlertEventRow[];

    return rows.map(mapAccessAlertEventRow);
  }

  queryRequestAuditEvents(query: GatewayRequestAuditQuery = {}): GatewayRequestAuditResult {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    const addTextFilter = (column: string, value: string | undefined) => {
      const normalized = value?.trim();
      if (!normalized) {
        return;
      }
      filters.push(`${column} = ?`);
      params.push(normalized);
    };

    const status = query.status ?? "all";
    if (status === "success") {
      filters.push("ok = 1");
    } else if (status === "failure") {
      filters.push("ok = 0");
    }
    addTextFilter("client_tag", query.clientTag);
    addTextFilter("consumer_id", query.consumerId);
    addTextFilter("access_key_id", query.accessKeyId);
    addTextFilter("pool_id", query.poolId);
    addTextFilter("account_id", query.accountId);
    addTextFilter("model_alias", query.modelAlias);
    addTextFilter("provider_id", query.providerId);
    if (typeof query.since === "number" && Number.isFinite(query.since)) {
      filters.push("timestamp >= ?");
      params.push(Math.floor(query.since));
    }
    if (typeof query.until === "number" && Number.isFinite(query.until)) {
      filters.push("timestamp <= ?");
      params.push(Math.floor(query.until));
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const summaryRow = this.db
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
          ${whereClause}
        `,
      )
      .get(...params) as
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
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            timestamp,
            session_id,
            account_id,
            email,
            client_tag,
            consumer_id,
            access_key_id,
            pool_id,
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
            source_kind,
            source_event_key
          FROM inference_usage_events
          ${whereClause}
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        `,
      )
      .all(...params, limit) as RequestAuditEventRow[];
    const usageItems = rows.map(mapRequestAuditEventRow);
    const alertItems =
      status === "success" ? [] : this.queryAccessAlertRequestAuditEntries(query);
    const items = this.attachRequestContentAvailability([...usageItems, ...alertItems])
      .sort((left, right) => {
        if (right.timestamp !== left.timestamp) {
          return right.timestamp - left.timestamp;
        }
        if (left.contentAvailable !== right.contentAvailable) {
          return left.contentAvailable ? -1 : 1;
        }
        if (left.sourceKind !== right.sourceKind) {
          return left.sourceKind === "access-alert" ? 1 : -1;
        }
        return Math.abs(right.id) - Math.abs(left.id);
      })
      .slice(0, limit);
    const alertCount = alertItems.length;

    return {
      filters: {
        limit,
        status,
        ...(query.clientTag?.trim() ? { clientTag: query.clientTag.trim() } : {}),
        ...(query.consumerId?.trim() ? { consumerId: query.consumerId.trim() } : {}),
        ...(query.accessKeyId?.trim() ? { accessKeyId: query.accessKeyId.trim() } : {}),
        ...(query.poolId?.trim() ? { poolId: query.poolId.trim() } : {}),
        ...(query.accountId?.trim() ? { accountId: query.accountId.trim() } : {}),
        ...(query.modelAlias?.trim() ? { modelAlias: query.modelAlias.trim() } : {}),
        ...(query.providerId?.trim() ? { providerId: query.providerId.trim() } : {}),
        ...(typeof query.since === "number" && Number.isFinite(query.since)
          ? { since: Math.floor(query.since) }
          : {}),
        ...(typeof query.until === "number" && Number.isFinite(query.until)
          ? { until: Math.floor(query.until) }
          : {}),
      },
      summary: {
        requestCount: normalizeUsageCounterValue(summaryRow?.request_count) + alertCount,
        successCount: normalizeUsageCounterValue(summaryRow?.success_count),
        failureCount: normalizeUsageCounterValue(summaryRow?.failure_count) + alertCount,
        totalLatencyMs: normalizeUsageCounterValue(summaryRow?.total_latency_ms),
        inputTokens: normalizeUsageCounterValue(summaryRow?.input_tokens),
        outputTokens: normalizeUsageCounterValue(summaryRow?.output_tokens),
        totalTokens: normalizeUsageCounterValue(summaryRow?.total_tokens),
        cachedTokens: normalizeUsageCounterValue(summaryRow?.cached_tokens),
        reasoningTokens: normalizeUsageCounterValue(summaryRow?.reasoning_tokens),
      },
      facets: this.buildRequestAuditFacets(),
      items,
    };
  }

  private attachRequestContentAvailability(
    items: GatewayRequestAuditEntry[],
  ): GatewayRequestAuditEntry[] {
    const keys = Array.from(
      new Set(
        items
          .map((item) => item.sourceEventKey?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    );
    if (!keys.length) {
      return items;
    }
    const placeholders = keys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
          SELECT source_event_key
          FROM request_content_audit_events
          WHERE source_event_key IN (${placeholders})
        `,
      )
      .all(...keys) as Array<{ source_event_key: string }>;
    const available = new Set(rows.map((row) => row.source_event_key));
    const fallbackRows = this.db
      .prepare(
        `
          SELECT
            source_event_key,
            timestamp,
            model_alias,
            consumer_id,
            access_key_id
          FROM request_content_audit_events
          ORDER BY timestamp DESC
          LIMIT 500
        `,
      )
      .all() as Array<{
        source_event_key: string;
        timestamp: number;
        model_alias: string | null;
        consumer_id: string | null;
        access_key_id: string | null;
      }>;
    return items.map((item) => {
      if (item.sourceEventKey && available.has(item.sourceEventKey)) {
        return {
          ...item,
          contentAvailable: true,
        };
      }
      const fallback = fallbackRows.find((row) => {
        if (row.model_alias !== item.modelAlias) {
          return false;
        }
        if ((row.consumer_id ?? undefined) !== item.consumerId) {
          return false;
        }
        if ((row.access_key_id ?? undefined) !== item.accessKeyId) {
          return false;
        }
        return Math.abs(row.timestamp - item.timestamp) <= 10_000;
      });
      return {
        ...item,
        sourceEventKey: fallback?.source_event_key ?? item.sourceEventKey,
        contentAvailable: Boolean(fallback),
      };
    });
  }

  private buildRequestAuditFacets(): GatewayRequestAuditResult["facets"] {
    const consumers = new Map<string, GatewayRequestAuditFacetOption>();
    const accessKeys = new Map<string, GatewayRequestAuditFacetOption>();
    const models = new Map<string, GatewayRequestAuditFacetOption>();
    const accounts = new Map<string, GatewayRequestAuditFacetOption>();
    const usageRows = this.db
      .prepare(
        `
          SELECT consumer_id, access_key_id, model_alias, account_id, email
          FROM inference_usage_events
          ORDER BY timestamp DESC
          LIMIT 1000
        `,
      )
      .all() as Array<{
        consumer_id: string | null;
        access_key_id: string | null;
        model_alias: string | null;
        account_id: string | null;
        email: string | null;
      }>;
    for (const row of usageRows) {
      incrementFacet(consumers, row.consumer_id ?? undefined);
      incrementFacet(accessKeys, row.access_key_id ?? undefined);
      incrementFacet(models, row.model_alias ?? undefined);
      incrementFacet(accounts, row.account_id ?? undefined, row.email ?? undefined);
    }

    const alertRows = this.db
      .prepare(
        `
          SELECT consumer_id, access_key_id, details_json
          FROM access_alert_events
          ORDER BY COALESCE(last_seen_at, timestamp) DESC
          LIMIT 1000
        `,
      )
      .all() as Array<{
        consumer_id: string | null;
        access_key_id: string | null;
        details_json: string | null;
      }>;
    for (const row of alertRows) {
      let details: Record<string, unknown> | undefined;
      try {
        details = row.details_json
          ? (JSON.parse(row.details_json) as Record<string, unknown>)
          : undefined;
      } catch {
        details = undefined;
      }
      incrementFacet(consumers, row.consumer_id ?? undefined);
      incrementFacet(accessKeys, row.access_key_id ?? undefined);
      incrementFacet(
        models,
        getAuditDetailString(details, [
          "resolvedModelAlias",
          "requestedModelAlias",
          "modelAlias",
        ]),
      );
      incrementFacet(accounts, getAuditDetailString(details, ["accountId"]), getAuditDetailString(details, ["email"]));
    }

    return {
      consumers: toFacetOptions(consumers),
      accessKeys: toFacetOptions(accessKeys),
      models: toFacetOptions(models),
      accounts: toFacetOptions(accounts),
    };
  }

  private queryAccessAlertRequestAuditEntries(
    query: GatewayRequestAuditQuery = {},
  ): GatewayRequestAuditEntry[] {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    const addTextFilter = (column: string, value: string | undefined) => {
      const normalized = value?.trim();
      if (!normalized) {
        return;
      }
      filters.push(`${column} = ?`);
      params.push(normalized);
    };

    addTextFilter("consumer_id", query.consumerId);
    addTextFilter("access_key_id", query.accessKeyId);
    if (typeof query.since === "number" && Number.isFinite(query.since)) {
      filters.push("COALESCE(last_seen_at, timestamp) >= ?");
      params.push(Math.floor(query.since));
    }
    if (typeof query.until === "number" && Number.isFinite(query.until)) {
      filters.push("COALESCE(last_seen_at, timestamp) <= ?");
      params.push(Math.floor(query.until));
    }
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            timestamp,
            severity,
            consumer_id,
            consumer_type,
            access_key_id,
            type,
            message,
            details_json,
            acknowledged_at,
            acknowledged_by,
            dedupe_key,
            occurrence_count,
            last_seen_at
          FROM access_alert_events
          ${whereClause}
          ORDER BY COALESCE(last_seen_at, timestamp) DESC, id DESC
        `,
      )
      .all(...params) as AccessAlertEventRow[];

    return rows
      .map(mapAccessAlertEventRowToRequestAuditEntry)
      .filter((entry) => {
        const matches = (actual: string | undefined, expected: string | undefined) => {
          const normalized = expected?.trim();
          return !normalized || actual === normalized;
        };
        if (!matches(entry.clientTag, query.clientTag)) {
          return false;
        }
        if (!matches(entry.poolId, query.poolId)) {
          return false;
        }
        if (!matches(entry.accountId, query.accountId)) {
          return false;
        }
        if (!matches(entry.modelAlias, query.modelAlias)) {
          return false;
        }
        if (!matches(entry.providerId, query.providerId)) {
          return false;
        }
        return true;
      });
  }

  getAccessAlertEvent(id: number): GatewayAccessAlertEvent | undefined {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            timestamp,
            severity,
            consumer_id,
            consumer_type,
            access_key_id,
            type,
            message,
            details_json,
            acknowledged_at,
            acknowledged_by,
            dedupe_key,
            occurrence_count,
            last_seen_at
          FROM access_alert_events
          WHERE id = ?
        `,
      )
      .get(id) as AccessAlertEventRow | undefined;

    return row ? mapAccessAlertEventRow(row) : undefined;
  }

  acknowledgeAccessAlertEvent(
    id: number,
    input: { acknowledgedAt?: number; acknowledgedBy?: string } = {},
  ): GatewayAccessAlertEvent | undefined {
    const acknowledgedAt = input.acknowledgedAt ?? Date.now();
    const acknowledgedBy = input.acknowledgedBy?.trim() || "admin";
    const result = this.db
      .prepare(
        `
          UPDATE access_alert_events
          SET acknowledged_at = ?, acknowledged_by = ?
          WHERE id = ?
        `,
      )
      .run(acknowledgedAt, acknowledgedBy, id);

    if (result.changes === 0) {
      return undefined;
    }

    return this.getAccessAlertEvent(id);
  }

  acknowledgeAllAccessAlertEvents(
    input: { acknowledgedAt?: number; acknowledgedBy?: string } = {},
  ): GatewayAccessAlertAcknowledgeAllResult {
    const acknowledgedAt = input.acknowledgedAt ?? Date.now();
    const acknowledgedBy = input.acknowledgedBy?.trim() || "admin";
    const result = this.db
      .prepare(
        `
          UPDATE access_alert_events
          SET acknowledged_at = ?, acknowledged_by = ?
          WHERE acknowledged_at IS NULL
        `,
      )
      .run(acknowledgedAt, acknowledgedBy);

    return {
      updatedCount: result.changes,
      acknowledgedAt,
      acknowledgedBy,
    };
  }

  deleteAcknowledgedAccessAlertEvents(): GatewayAccessAlertClearAcknowledgedResult {
    const result = this.db
      .prepare(
        `
          DELETE FROM access_alert_events
          WHERE acknowledged_at IS NOT NULL
        `,
      )
      .run();

    return {
      deletedCount: result.changes,
    };
  }

  getUsageTotalsForAccessConsumer(options: {
    consumerId: string;
    sinceTimestamp?: number;
  }): GatewayUsageCounters {
    const params: Array<string | number> = [options.consumerId];
    const sinceClause =
      typeof options.sinceTimestamp === "number" && Number.isFinite(options.sinceTimestamp)
        ? " AND timestamp >= ?"
        : "";
    if (sinceClause) {
      params.push(options.sinceTimestamp as number);
    }

    const row = this.db
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
          WHERE consumer_id = ?${sinceClause}
        `,
      )
      .get(...params) as
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

    return {
      requestCount: normalizeUsageCounterValue(row?.request_count),
      successCount: normalizeUsageCounterValue(row?.success_count),
      failureCount: normalizeUsageCounterValue(row?.failure_count),
      totalLatencyMs: normalizeUsageCounterValue(row?.total_latency_ms),
      inputTokens: normalizeUsageCounterValue(row?.input_tokens),
      outputTokens: normalizeUsageCounterValue(row?.output_tokens),
      totalTokens: normalizeUsageCounterValue(row?.total_tokens),
      cachedTokens: normalizeUsageCounterValue(row?.cached_tokens),
      reasoningTokens: normalizeUsageCounterValue(row?.reasoning_tokens),
    };
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
      timelineBucketMs?: number;
      timelineLimit?: number;
      consumerId?: string;
      accessKeyId?: string;
      modelAlias?: string;
      poolId?: string;
      outcome?: "success" | "failure";
    } = {},
  ): GatewayUsageWindowSummary {
    const clientFilter = options.clientFilter ?? "all";
    const accountLimit = Math.max(1, options.accountLimit ?? 12);
    const clientLimit = Math.max(1, options.clientLimit ?? 12);
    const modelLimit = Math.max(1, options.modelLimit ?? 12);
    const timelineBucketMs =
      typeof options.timelineBucketMs === "number" &&
      Number.isFinite(options.timelineBucketMs) &&
      options.timelineBucketMs > 0
        ? Math.floor(options.timelineBucketMs)
        : undefined;
    const timelineLimit = Math.max(1, options.timelineLimit ?? 240);
    const filter = this.buildUsageWhereClause({
      sinceTimestamp: options.sinceTimestamp,
      clientFilter,
      consumerId: options.consumerId,
      accessKeyId: options.accessKeyId,
      modelAlias: options.modelAlias,
      poolId: options.poolId,
      outcome: options.outcome,
    });

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

    const consumers = this.db
      .prepare(
        `
          SELECT
            consumer_id,
            access_key_id,
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
          ${filter.sql}${filter.sql ? " AND " : " WHERE "}consumer_id IS NOT NULL AND consumer_id != ''
          GROUP BY consumer_id, access_key_id, normalized_client_tag
          ORDER BY total_tokens DESC, request_count DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(...filter.params, clientLimit) as Array<{
      consumer_id: string;
      access_key_id: string | null;
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

    const accessKeys = this.db
      .prepare(
        `
          SELECT
            access_key_id,
            consumer_id,
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
          ${filter.sql}${filter.sql ? " AND " : " WHERE "}access_key_id IS NOT NULL AND access_key_id != ''
          GROUP BY access_key_id, consumer_id, normalized_client_tag
          ORDER BY total_tokens DESC, request_count DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(...filter.params, clientLimit) as Array<{
      access_key_id: string;
      consumer_id: string | null;
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

    const pools = this.db
      .prepare(
        `
          SELECT
            pool_id,
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
          ${filter.sql}${filter.sql ? " AND " : " WHERE "}pool_id IS NOT NULL AND pool_id != ''
          GROUP BY pool_id, normalized_client_tag
          ORDER BY total_tokens DESC, request_count DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(...filter.params, clientLimit) as Array<{
      pool_id: string;
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

    const consumerTimeline = timelineBucketMs
      ? (this.db
          .prepare(
            `
              SELECT
                CAST(timestamp / ? AS INTEGER) * ? AS bucket_start,
                consumer_id,
                access_key_id,
                COALESCE(NULLIF(client_tag, ''), 'unknown') AS normalized_client_tag,
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
              ${filter.sql}${filter.sql ? " AND " : " WHERE "}consumer_id IS NOT NULL AND consumer_id != ''
              GROUP BY bucket_start, consumer_id, access_key_id, normalized_client_tag
              ORDER BY bucket_start ASC, total_tokens DESC, request_count DESC
              LIMIT ?
            `,
          )
          .all(
            timelineBucketMs,
            timelineBucketMs,
            ...filter.params,
            timelineLimit,
          ) as Array<{
          bucket_start: number;
          consumer_id: string;
          access_key_id: string | null;
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
        }>)
      : [];
    const modelTimeline = timelineBucketMs
      ? (this.db
          .prepare(
            `
              SELECT
                CAST(timestamp / ? AS INTEGER) * ? AS bucket_start,
                model_alias,
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
              GROUP BY bucket_start, model_alias
              ORDER BY bucket_start ASC, total_tokens DESC, request_count DESC
              LIMIT ?
            `,
          )
          .all(
            timelineBucketMs,
            timelineBucketMs,
            ...filter.params,
            timelineLimit,
          ) as Array<{
          bucket_start: number;
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
        }>)
      : [];
    const accessKeyTimeline = timelineBucketMs
      ? (this.db
          .prepare(
            `
              SELECT
                CAST(timestamp / ? AS INTEGER) * ? AS bucket_start,
                access_key_id,
                consumer_id,
                COALESCE(NULLIF(client_tag, ''), 'unknown') AS normalized_client_tag,
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
              ${filter.sql}${filter.sql ? " AND " : " WHERE "}access_key_id IS NOT NULL AND access_key_id != ''
              GROUP BY bucket_start, access_key_id, consumer_id, normalized_client_tag
              ORDER BY bucket_start ASC, total_tokens DESC, request_count DESC
              LIMIT ?
            `,
          )
          .all(
            timelineBucketMs,
            timelineBucketMs,
            ...filter.params,
            timelineLimit,
          ) as Array<{
          bucket_start: number;
          access_key_id: string;
          consumer_id: string | null;
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
        }>)
      : [];
    const poolTimeline = timelineBucketMs
      ? (this.db
          .prepare(
            `
              SELECT
                CAST(timestamp / ? AS INTEGER) * ? AS bucket_start,
                pool_id,
                COALESCE(NULLIF(client_tag, ''), 'unknown') AS normalized_client_tag,
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
              ${filter.sql}${filter.sql ? " AND " : " WHERE "}pool_id IS NOT NULL AND pool_id != ''
              GROUP BY bucket_start, pool_id, normalized_client_tag
              ORDER BY bucket_start ASC, total_tokens DESC, request_count DESC
              LIMIT ?
            `,
          )
          .all(
            timelineBucketMs,
            timelineBucketMs,
            ...filter.params,
            timelineLimit,
          ) as Array<{
          bucket_start: number;
          pool_id: string;
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
        }>)
      : [];

    return {
      since,
      updatedAt,
      totals,
      cachedSignalCount: normalizeUsageCounterValue(metaRow?.cached_signal_count),
      reasoningSignalCount: normalizeUsageCounterValue(metaRow?.reasoning_signal_count),
      importedEventCount: normalizeUsageCounterValue(metaRow?.imported_event_count),
      accounts: accounts.map((row) => this.mapUsageAccountSummary(row)),
      clients: clients.map((row) => this.mapUsageClientSummary(row)),
      consumers: consumers.map((row) => this.mapUsageConsumerSummary(row)),
      ...(timelineBucketMs
        ? {
            consumerTimeline: consumerTimeline.map((row) =>
              this.mapUsageConsumerTimelinePoint(row, timelineBucketMs),
            ),
            modelTimeline: modelTimeline.map((row) =>
              this.mapUsageModelTimelinePoint(row, timelineBucketMs),
            ),
            accessKeyTimeline: accessKeyTimeline.map((row) =>
              this.mapUsageAccessKeyTimelinePoint(row, timelineBucketMs),
            ),
            poolTimeline: poolTimeline.map((row) =>
              this.mapUsagePoolTimelinePoint(row, timelineBucketMs),
            ),
          }
        : {}),
      accessKeys: accessKeys.map((row) => this.mapUsageAccessKeySummary(row)),
      pools: pools.map((row) => this.mapUsagePoolSummary(row)),
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
  }

  pruneAccessAlertEvents(options: { maxRows?: number; retainDays?: number } = {}): void {
    const maxRows = Math.max(1, options.maxRows ?? 50_000);
    const retainDays = Math.max(1, options.retainDays ?? 90);
    const minTimestamp = Date.now() - retainDays * 24 * 60 * 60 * 1000;

    this.db
      .prepare(
        `
          DELETE FROM access_alert_events
          WHERE timestamp < ?
        `,
      )
      .run(minTimestamp);

    const row = this.db
      .prepare(
        `
          SELECT COUNT(1) AS count
          FROM access_alert_events
        `,
      )
      .get() as { count?: number } | undefined;
    const count = typeof row?.count === "number" ? row.count : 0;
    if (count <= maxRows) {
      return;
    }

    this.db
      .prepare(
        `
          DELETE FROM access_alert_events
          WHERE id IN (
            SELECT id
            FROM access_alert_events
            ORDER BY id ASC
            LIMIT ?
          )
        `,
      )
      .run(count - maxRows);
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
    input: {
      sinceTimestamp?: number;
      clientFilter?: GatewayUsageClientFilter;
      consumerId?: string;
      accessKeyId?: string;
      modelAlias?: string;
      poolId?: string;
      outcome?: "success" | "failure";
    } = {},
  ): {
    sql: string;
    params: Array<number | string>;
  } {
    const clauses: string[] = [];
    const params: Array<number | string> = [];
    const clientFilter = input.clientFilter ?? "all";

    if (typeof input.sinceTimestamp === "number" && Number.isFinite(input.sinceTimestamp)) {
      clauses.push("timestamp >= ?");
      params.push(input.sinceTimestamp);
    }

    if (clientFilter === "openclaw" || clientFilter === "hermes") {
      clauses.push("LOWER(COALESCE(client_tag, '')) = ?");
      params.push(clientFilter);
    } else if (clientFilter === "other") {
      clauses.push("LOWER(COALESCE(client_tag, '')) NOT IN ('openclaw', 'hermes')");
    }

    if (typeof input.consumerId === "string" && input.consumerId.trim()) {
      clauses.push("consumer_id = ?");
      params.push(input.consumerId.trim());
    }
    if (typeof input.accessKeyId === "string" && input.accessKeyId.trim()) {
      clauses.push("access_key_id = ?");
      params.push(input.accessKeyId.trim());
    }
    if (typeof input.modelAlias === "string" && input.modelAlias.trim()) {
      clauses.push("model_alias = ?");
      params.push(input.modelAlias.trim());
    }
    if (typeof input.poolId === "string" && input.poolId.trim()) {
      clauses.push("pool_id = ?");
      params.push(input.poolId.trim());
    }
    if (input.outcome === "success") {
      clauses.push("ok = 1");
    } else if (input.outcome === "failure") {
      clauses.push("ok = 0");
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

  private mapUsageConsumerSummary(row: {
    consumer_id: string;
    access_key_id: string | null;
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
  }): GatewayUsageConsumerSummary {
    return {
      consumerId: row.consumer_id,
      accessKeyId: row.access_key_id ?? undefined,
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

  private mapUsageConsumerTimelinePoint(
    row: {
      bucket_start: number;
      consumer_id: string;
      access_key_id: string | null;
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
    },
    bucketMs: number,
  ): GatewayUsageConsumerTimelinePoint {
    return {
      bucketStart: row.bucket_start,
      bucketEnd: row.bucket_start + bucketMs,
      consumerId: row.consumer_id,
      accessKeyId: row.access_key_id ?? undefined,
      clientTag: row.normalized_client_tag,
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

  private mapUsageModelTimelinePoint(
    row: {
      bucket_start: number;
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
    },
    bucketMs: number,
  ): GatewayUsageModelTimelinePoint {
    return {
      bucketStart: row.bucket_start,
      bucketEnd: row.bucket_start + bucketMs,
      modelAlias: row.model_alias,
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

  private mapUsageAccessKeyTimelinePoint(
    row: {
      bucket_start: number;
      access_key_id: string;
      consumer_id: string | null;
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
    },
    bucketMs: number,
  ): GatewayUsageAccessKeyTimelinePoint {
    return {
      bucketStart: row.bucket_start,
      bucketEnd: row.bucket_start + bucketMs,
      accessKeyId: row.access_key_id,
      consumerId: row.consumer_id ?? undefined,
      clientTag: row.normalized_client_tag,
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

  private mapUsagePoolTimelinePoint(
    row: {
      bucket_start: number;
      pool_id: string;
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
    },
    bucketMs: number,
  ): GatewayUsagePoolTimelinePoint {
    return {
      bucketStart: row.bucket_start,
      bucketEnd: row.bucket_start + bucketMs,
      poolId: row.pool_id,
      clientTag: row.normalized_client_tag,
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

  private mapUsageAccessKeySummary(row: {
    access_key_id: string;
    consumer_id: string | null;
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
  }): GatewayUsageAccessKeySummary {
    return {
      accessKeyId: row.access_key_id,
      consumerId: row.consumer_id ?? undefined,
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

  private mapUsagePoolSummary(row: {
    pool_id: string;
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
  }): GatewayUsagePoolSummary {
    return {
      poolId: row.pool_id,
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
