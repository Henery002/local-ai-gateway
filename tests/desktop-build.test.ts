import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("desktop build output", () => {
  it("does not leave unresolved workspace imports in renderer output", () => {
    const rendererOutput = readFileSync(
      resolve(process.cwd(), "apps/desktop/dist/renderer.js"),
      "utf8",
    );

    expect(rendererOutput).not.toMatch(/from "@local-ai-gateway\//);
  });
});
