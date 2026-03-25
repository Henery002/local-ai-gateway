import { ensureAppPaths, AppLogger, ConfigStore, GatewayDatabase, ModelRegistry } from "@local-ai-gateway/core";
import { DEFAULT_HOST, DEFAULT_PORT } from "@local-ai-gateway/shared";

import { createGatewayApp } from "./app.js";
import { bootstrapProvidersFromEnvironment } from "./provider-bootstrap.js";
import { GatewayRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const paths = ensureAppPaths();
  const database = new GatewayDatabase(paths);
  const logger = new AppLogger(paths, database);
  const configStore = new ConfigStore(paths);
  const bootstrapped = bootstrapProvidersFromEnvironment(
    process.env,
    configStore.getProviderSettings(),
  );
  const modelRegistry = new ModelRegistry(bootstrapped.models);
  const runtime = new GatewayRuntime(paths, configStore, database, logger, modelRegistry);
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
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  });

  logger.info("gateway_started", {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
