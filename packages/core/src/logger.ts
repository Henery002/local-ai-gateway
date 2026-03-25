import { appendFileSync } from "node:fs";

import {
  GatewayLogRecord,
  GatewayPaths,
  redactSensitiveValue,
  toIsoNow,
} from "@local-ai-gateway/shared";

import { GatewayDatabase } from "./database.js";

type LogLevel = GatewayLogRecord["level"];

export class AppLogger {
  constructor(
    private readonly paths: GatewayPaths,
    private readonly database?: GatewayDatabase,
  ) {}

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
    const record: GatewayLogRecord = {
      level,
      message,
      details: details ? (redactSensitiveValue(details) as Record<string, unknown>) : undefined,
      createdAt: toIsoNow(),
    };

    appendFileSync(this.paths.logFilePath, `${JSON.stringify(record)}\n`);
    this.database?.insertLog(record);

    const consoleMethod =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    consoleMethod(`[${level}] ${message}`);
  }
}

