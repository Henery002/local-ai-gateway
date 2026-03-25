import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@local-ai-gateway/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      "@local-ai-gateway/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@local-ai-gateway/openclaw-session": resolve(__dirname, "packages/openclaw-session/src/index.ts"),
      "@local-ai-gateway/provider-codex": resolve(__dirname, "packages/provider-codex/src/index.ts"),
      "@local-ai-gateway/provider-openai-compatible": resolve(
        __dirname,
        "packages/provider-openai-compatible/src/index.ts",
      ),
      "@local-ai-gateway/provider-ollama": resolve(__dirname, "packages/provider-ollama/src/index.ts"),
      "@local-ai-gateway/openai-compat": resolve(__dirname, "packages/openai-compat/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  }
});
