import type { FastifyInstance } from "fastify";

import {
  ensureAppPaths,
  AppLogger,
  ConfigStore,
  GatewayDatabase,
  ModelRegistry,
  ProviderRegistry,
} from "@local-ai-gateway/core";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  type GatewayPaths,
  type GatewayInferenceAuthSettings,
  type SessionSource,
} from "@local-ai-gateway/shared";

import { createGatewayApp } from "./app.js";
import { bootstrapProvidersFromEnvironment } from "./provider-bootstrap.js";
import { GatewayRuntime } from "./runtime.js";

export type StartedGatewayServer = {
  app: FastifyInstance;
  runtime: GatewayRuntime;
  database: GatewayDatabase;
  logger: AppLogger;
  configStore: ConfigStore;
  paths: GatewayPaths;
  host: string;
  port: number;
  close: (signal?: string) => Promise<void>;
};

export type StartGatewayServerOptions = {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  host?: string;
  port?: number;
  sessionSource?: SessionSource;
  providerRegistry?: ProviderRegistry;
};

export function resolveGatewayPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LOCAL_AI_GATEWAY_PORT?.trim();
  if (!raw) {
    return DEFAULT_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return DEFAULT_PORT;
  }

  return parsed;
}

export function resolveGatewayHostFromInferenceAuthSettings(
  settings: GatewayInferenceAuthSettings,
): string {
  const lanEnabled = Boolean(settings.lanAccess?.enabled);
  const mode = settings.mode === "api-key" ? "api-key" : "none";
  const hasDefaultKey = Boolean(settings.apiKey?.trim());
  const hasMappingKey = (settings.clientMappings ?? []).some((item) => {
    const apiKey = String(item?.apiKey ?? "").trim();
    return item?.enabled !== false && apiKey.length > 0;
  });
  const hasAccessKey = (settings.accessControl?.keys ?? []).some(
    (item) => item.status === "enabled" && item.keyHash.trim().length > 0,
  );

  if (
    lanEnabled &&
    mode === "api-key" &&
    (hasDefaultKey || hasMappingKey || hasAccessKey)
  ) {
    return "0.0.0.0";
  }

  return DEFAULT_HOST;
}

export async function startGatewayServer(
  options: StartGatewayServerOptions = {},
): Promise<StartedGatewayServer> {
  const env = options.env ?? process.env;
  const paths = ensureAppPaths(options.rootDir);
  const database = new GatewayDatabase(paths);
  const logger = new AppLogger(paths, database);
  const configStore = new ConfigStore(paths);
  const bootstrapped = bootstrapProvidersFromEnvironment(
    env,
    configStore.getProviderSettings(),
  );
  const host =
    options.host ??
    resolveGatewayHostFromInferenceAuthSettings(
      configStore.getInferenceAuthSettings(),
    );
  const port = options.port ?? resolveGatewayPort(env);
  const modelRegistry = new ModelRegistry(bootstrapped.models);
  const runtime = new GatewayRuntime(
    paths,
    configStore,
    database,
    logger,
    modelRegistry,
    options.sessionSource,
    options.providerRegistry,
    host,
    port,
  );
  const app = createGatewayApp(runtime);

  await app.listen({
    host,
    port,
  });

  logger.info("gateway_started", {
    host,
    port,
  });

  let closed = false;
  return {
    app,
    runtime,
    database,
    logger,
    configStore,
    paths,
    host,
    port,
    close: async (signal = "internal") => {
      if (closed) {
        return;
      }
      closed = true;
      logger.info("gateway_shutting_down", { signal });
      await app.close();
      database.close();
    },
  };
}
