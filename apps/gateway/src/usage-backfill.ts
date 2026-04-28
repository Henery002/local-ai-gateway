import type { AppLogger, GatewayDatabase } from "@local-ai-gateway/core";
export function importGatewayHistoricalUsage(
  database: GatewayDatabase,
  logger: Pick<AppLogger, "info" | "warn">,
): { imported: number; skipped: number } {
  try {
    const result = database.backfillUsageFromSessionActivityEvents();
    if (result.imported > 0) {
      logger.info("historical_usage_imported", {
        imported: result.imported,
        skipped: result.skipped,
        source: "local-ai-gateway",
      });
    }
    return result;
  } catch (error) {
    logger.warn("historical_usage_import_failed", {
      source: "local-ai-gateway",
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      imported: 0,
      skipped: 0,
    };
  }
}
