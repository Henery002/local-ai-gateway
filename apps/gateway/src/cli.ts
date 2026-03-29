import { DEFAULT_HOST } from "@local-ai-gateway/shared";

import { resolveGatewayPort, startGatewayServer } from "./server.js";

async function main(): Promise<void> {
  const host = DEFAULT_HOST;
  const port = resolveGatewayPort(process.env);
  const server = await startGatewayServer({
    env: process.env,
    host,
    port,
  });

  const close = async (signal: string) => {
    await server.close(signal);
    process.exit(0);
  };

  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
