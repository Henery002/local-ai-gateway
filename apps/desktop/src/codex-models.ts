export const SUPPORTED_CODEX_UPSTREAM_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
] as const;

export type SupportedCodexUpstreamModel =
  (typeof SUPPORTED_CODEX_UPSTREAM_MODELS)[number];

export const CODEX_MODEL_ALIAS_PRESETS: Record<
  SupportedCodexUpstreamModel,
  string
> = {
  "gpt-5.4": "codex-5.4",
  "gpt-5.4-mini": "codex-5.4-mini",
  "gpt-5.3-codex": "codex-5.3",
  "gpt-5.2-codex": "codex-5.2",
  "gpt-5.2": "codex-5.2-core",
  "gpt-5.1-codex-max": "codex-5.1-max",
  "gpt-5.1-codex-mini": "codex-5.1-mini",
};

export function formatCodexUpstreamModelLabel(modelId: string): string {
  const labels: Record<string, string> = {
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-mini": "GPT-5.4-Mini",
    "gpt-5.3-codex": "GPT-5.3-Codex",
    "gpt-5.2-codex": "GPT-5.2-Codex",
    "gpt-5.2": "GPT-5.2",
    "gpt-5.1-codex-max": "GPT-5.1-Codex-Max",
    "gpt-5.1-codex-mini": "GPT-5.1-Codex-Mini",
  };
  return labels[modelId] ?? modelId;
}
