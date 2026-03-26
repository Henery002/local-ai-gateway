import { ensureAppPaths, AppLogger, ConfigStore, GatewayDatabase, ModelRegistry } from "@local-ai-gateway/core";
import { DEFAULT_HOST, DEFAULT_PORT } from "@local-ai-gateway/shared";

import { createGatewayApp } from "./app.js";
import { bootstrapProvidersFromEnvironment } from "./provider-bootstrap.js";
import { GatewayRuntime } from "./runtime.js";

function resolveGatewayPort(): number {
  const raw = process.env.LOCAL_AI_GATEWAY_PORT?.trim();
  if (!raw) {
    return DEFAULT_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return DEFAULT_PORT;
  }

  return parsed;
}

async function main(): Promise<void> {
  const paths = ensureAppPaths();
  const database = new GatewayDatabase(paths);
  const logger = new AppLogger(paths, database);
  const configStore = new ConfigStore(paths);
  const bootstrapped = bootstrapProvidersFromEnvironment(
    process.env,
    configStore.getProviderSettings(),
  );
  const host = DEFAULT_HOST;
  const port = resolveGatewayPort();
  const modelRegistry = new ModelRegistry(bootstrapped.models);
  const runtime = new GatewayRuntime(
    paths,
    configStore,
    database,
    logger,
    modelRegistry,
    undefined,
    undefined,
    host,
    port,
  );
  const app = createGatewayApp(runtime);

  const close = async (signal: string) => {
    logger.info("gateway_shutting_down", { signal });
    await app.close();
    database.close();
    process.exit(signal === "SIGTERM" ? 0 : 0);
  };

  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));

  await app.listen({
    host,
    port,
  });

  logger.info("gateway_started", {
    host,
    port,
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
