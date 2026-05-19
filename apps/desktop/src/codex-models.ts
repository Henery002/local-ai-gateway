export const SUPPORTED_CODEX_UPSTREAM_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
] as const;

export type SupportedCodexUpstreamModel =
  (typeof SUPPORTED_CODEX_UPSTREAM_MODELS)[number];

export const CODEX_MODEL_ALIAS_PRESETS: Record<
  SupportedCodexUpstreamModel,
  string
> = {
  "gpt-5.5": "codex-5.5",
  "gpt-5.4": "codex-5.4",
  "gpt-5.4-mini": "codex-5.4-mini",
  "gpt-5.3-codex": "codex-5.3",
  "gpt-5.2": "codex-5.2",
};

const LEGACY_CODEX_UPSTREAM_MODEL_ALIASES: Record<string, SupportedCodexUpstreamModel> = {
  "gpt-5.2-codex": "gpt-5.2",
};

export function normalizeCodexUpstreamModel(
  value: string | undefined,
): SupportedCodexUpstreamModel | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    SUPPORTED_CODEX_UPSTREAM_MODELS.includes(
      trimmed as SupportedCodexUpstreamModel,
    )
  ) {
    return trimmed as SupportedCodexUpstreamModel;
  }
  return LEGACY_CODEX_UPSTREAM_MODEL_ALIASES[trimmed];
}

export function formatCodexUpstreamModelLabel(modelId: string): string {
  const labels: Record<string, string> = {
    "gpt-5.5": "GPT-5.5",
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-mini": "GPT-5.4-Mini",
    "gpt-5.3-codex": "GPT-5.3-Codex",
    "gpt-5.2": "GPT-5.2",
  };
  return labels[modelId] ?? modelId;
}
