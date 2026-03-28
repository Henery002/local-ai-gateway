import { describe, expect, it } from "vitest";

import {
  CODEX_MODEL_ALIAS_PRESETS as DESKTOP_CODEX_MODEL_ALIAS_PRESETS,
  SUPPORTED_CODEX_UPSTREAM_MODELS as DESKTOP_SUPPORTED_CODEX_UPSTREAM_MODELS,
} from "../apps/desktop/src/codex-models.js";
import {
  CODEX_MODEL_ALIAS_PRESETS,
  SUPPORTED_CODEX_UPSTREAM_MODELS,
} from "../packages/shared/src/index.js";

describe("desktop codex model mirror", () => {
  it("keeps desktop codex upstream model list aligned with shared definitions", () => {
    expect(DESKTOP_SUPPORTED_CODEX_UPSTREAM_MODELS).toEqual(
      SUPPORTED_CODEX_UPSTREAM_MODELS,
    );
    expect(DESKTOP_CODEX_MODEL_ALIAS_PRESETS).toEqual(
      CODEX_MODEL_ALIAS_PRESETS,
    );
  });
});
