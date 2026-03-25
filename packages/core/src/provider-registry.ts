import {
  GatewayError,
  GatewayModelDefinition,
  ProviderAdapter,
  ProviderSummary,
} from "@local-ai-gateway/shared";

export class ProviderRegistry {
  constructor(private readonly adapters: ProviderAdapter[]) {}

  listAdapters(): ProviderAdapter[] {
    return [...this.adapters];
  }

  getAdapterById(id: string): ProviderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  getAdapterForModel(model: GatewayModelDefinition): ProviderAdapter {
    const adapter = this.adapters.find((candidate) => candidate.supportsModel(model));
    if (!adapter) {
      throw new GatewayError(
        500,
        "provider_not_registered",
        `No provider adapter is registered for model ${model.alias}.`,
        {
          provider: model.provider,
          providerModelId: model.providerModelId,
        },
      );
    }

    return adapter;
  }

  buildProviderSummaries(
    models: GatewayModelDefinition[],
    activeSessionId?: string,
  ): ProviderSummary[] {
    return this.adapters.map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      usesSessions: adapter.usesSessions ?? false,
      activeSessionId: adapter.usesSessions ? activeSessionId : undefined,
      models: models.filter((model) => adapter.supportsModel(model)),
    }));
  }
}
