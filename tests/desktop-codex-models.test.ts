import { describe, expect, it } from "vitest";

import {
  CODEX_MODEL_ALIAS_PRESETS as DESKTOP_CODEX_MODEL_ALIAS_PRESETS,
  normalizeCodexUpstreamModel as normalizeDesktopCodexUpstreamModel,
  SUPPORTED_CODEX_UPSTREAM_MODELS as DESKTOP_SUPPORTED_CODEX_UPSTREAM_MODELS,
} from "../apps/desktop/src/codex-models.js";
import {
  CODEX_MODEL_ALIAS_PRESETS,
  normalizeCodexUpstreamModel,
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

  it("exposes the current Codex selectable model list with stable aliases", () => {
    expect(SUPPORTED_CODEX_UPSTREAM_MODELS).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
    expect(CODEX_MODEL_ALIAS_PRESETS).toEqual({
      "gpt-5.5": "codex-5.5",
      "gpt-5.4": "codex-5.4",
      "gpt-5.4-mini": "codex-5.4-mini",
      "gpt-5.3-codex": "codex-5.3",
      "gpt-5.2": "codex-5.2",
    });
  });

  it("normalizes legacy Codex model ids to current upstream ids", () => {
    expect(normalizeCodexUpstreamModel("gpt-5.2-codex")).toBe("gpt-5.2");
    expect(normalizeDesktopCodexUpstreamModel("gpt-5.2-codex")).toBe(
      "gpt-5.2",
    );
  });
});
