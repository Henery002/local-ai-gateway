import { mkdirSync } from "node:fs";

import { GatewayPaths, resolveGatewayPaths } from "@local-ai-gateway/shared";

export function ensureAppPaths(rootDir?: string): GatewayPaths {
  const paths = resolveGatewayPaths(rootDir);
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  return paths;
}

