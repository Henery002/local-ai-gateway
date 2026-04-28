import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAppPaths, GatewayDatabase } from "@local-ai-gateway/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { importGatewayHistoricalUsage } from "../apps/gateway/src/usage-backfill.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("usage backfill", () => {
  it("backfills usage from local gateway session activity events idempotently", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-usage-backfill-"));
    cleanupDirs.push(rootDir);
    const paths = ensureAppPaths(rootDir);
    const database = new GatewayDatabase(paths);
    database.insertSessionActivityEvent({
      sessionId: "session_a",
      timestamp: 1_777_171_000_000,
      clientTag: "openclaw",
      ok: true,
      stream: false,
    });
    database.insertSessionActivityEvent({
      sessionId: "session_b",
      timestamp: 1_777_181_000_000,
      clientTag: "hermes",
      ok: false,
      stream: true,
    });
    database.insertSessionActivityEvent({
      sessionId: "session_c",
      timestamp: 1_777_191_000_000,
      clientTag: "openclaw",
      ok: true,
      stream: false,
    });

    database.insertUsageEvent({
      timestamp: 1_777_185_000_000,
      sessionId: "live_session",
      accountId: "acct_live",
      email: "live@example.com",
      clientTag: "openclaw",
      providerId: "openai-codex",
      modelAlias: "codex-5.4",
      upstreamModelId: "gpt-5.4",
      success: true,
      stream: false,
      latencyMs: 2500,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 10,
      reasoningTokens: 5,
      cachedTokensPresent: true,
      reasoningTokensPresent: true,
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const first = importGatewayHistoricalUsage(database, logger);
    const second = importGatewayHistoricalUsage(database, logger);
    const summary = database.getUsageSummary();

    expect(first.imported).toBe(2);
    expect(second.imported).toBe(0);
    expect(summary.importedEventCount).toBe(2);
    expect(summary.totals).toMatchObject({
      requestCount: 3,
      successCount: 2,
      failureCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 10,
      reasoningTokens: 5,
    });

    database.close();
  });
});
