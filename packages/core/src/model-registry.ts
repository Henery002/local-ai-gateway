import {
  DEFAULT_MODEL_ALIAS,
  DEFAULT_PROVIDER_ID,
  DEFAULT_PROVIDER_MODEL_ID,
  GatewayModelDefinition,
} from "@local-ai-gateway/shared";

const DEFAULT_MODEL: GatewayModelDefinition = {
  alias: DEFAULT_MODEL_ALIAS,
  displayName: "Codex Default",
  provider: DEFAULT_PROVIDER_ID,
  providerModelId: DEFAULT_PROVIDER_MODEL_ID,
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  input: ["text"],
  reasoning: true,
};

export class ModelRegistry {
  constructor(private readonly models: GatewayModelDefinition[] = [DEFAULT_MODEL]) {}

  list(): GatewayModelDefinition[] {
    return [...this.models];
  }

  resolve(alias: string): GatewayModelDefinition | undefined {
    return this.models.find((model) => model.alias === alias);
  }

  getDefault(): GatewayModelDefinition {
    return this.models[0] ?? DEFAULT_MODEL;
  }
}

