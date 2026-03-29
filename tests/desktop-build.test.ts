import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("desktop build output", () => {
  it(
    "does not leave unresolved workspace imports in renderer output",
    () => {
    execFileSync("npx", ["tsc", "-b", "apps/desktop", "--force"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const rendererOutput = readFileSync(
      resolve(process.cwd(), "apps/desktop/dist/renderer.js"),
      "utf8",
    );

    expect(rendererOutput).not.toMatch(/from "@local-ai-gateway\//);
    },
    15_000,
  );

  it(
    "does not keep packaged gateway startup on ELECTRON_RUN_AS_NODE child mode",
    () => {
      execFileSync("npx", ["tsc", "-b", "apps/desktop", "--force"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });

      const mainOutput = readFileSync(
        resolve(process.cwd(), "apps/desktop/dist/main.js"),
        "utf8",
      );

      expect(mainOutput).not.toContain("ELECTRON_RUN_AS_NODE");
      expect(mainOutput).toContain("gateway/dist/server.js");
      expect(mainOutput).toContain("startGatewayServer");
    },
    15_000,
  );
});
