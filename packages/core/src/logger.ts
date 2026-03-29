import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

import {
  GatewayLogRecord,
  GatewayPaths,
  redactSensitiveValue,
  toIsoNow,
} from "@local-ai-gateway/shared";

import { GatewayDatabase } from "./database.js";

type LogLevel = GatewayLogRecord["level"];

const LOG_FILE_MAX_BYTES = 1_024 * 1_024;
const LOG_FILE_KEEP_BYTES = 512 * 1_024;
const LOG_PRUNE_CHECK_INTERVAL = 80;

export class AppLogger {
  private writesSincePrune = 0;

  constructor(
    private readonly paths: GatewayPaths,
    private readonly database?: GatewayDatabase,
  ) {
    this.pruneLogFileIfNeeded(true);
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.write("info", message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.write("warn", message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.write("error", message, details);
  }

  debug(message: string, details?: Record<string, unknown>): void {
    this.write("debug", message, details);
  }

  private write(level: LogLevel, message: string, details?: Record<string, unknown>): void {
    this.pruneLogFileIfNeeded();
    const record: GatewayLogRecord = {
      level,
      message,
      details: details ? (redactSensitiveValue(details) as Record<string, unknown>) : undefined,
      createdAt: toIsoNow(),
    };

    appendFileSync(this.paths.logFilePath, `${JSON.stringify(record)}\n`);
    this.database?.insertLog(record);
    this.pruneLogFileIfNeeded();

    const consoleMethod =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    consoleMethod(`[${level}] ${message}`);
  }

  private pruneLogFileIfNeeded(force = false): void {
    if (!force) {
      this.writesSincePrune += 1;
      if (this.writesSincePrune < LOG_PRUNE_CHECK_INTERVAL) {
        return;
      }
    }
    this.writesSincePrune = 0;

    if (!existsSync(this.paths.logFilePath)) {
      return;
    }

    const size = statSync(this.paths.logFilePath).size;
    if (!Number.isFinite(size) || size <= LOG_FILE_MAX_BYTES) {
      return;
    }

    const buffer = readFileSync(this.paths.logFilePath);
    const slice = buffer.subarray(Math.max(0, buffer.byteLength - LOG_FILE_KEEP_BYTES));
    const newlineIndex = slice.indexOf(0x0a);
    const trimmed =
      newlineIndex >= 0 && newlineIndex < slice.byteLength - 1
        ? slice.subarray(newlineIndex + 1)
        : slice;
    writeFileSync(this.paths.logFilePath, trimmed);
  }
}
