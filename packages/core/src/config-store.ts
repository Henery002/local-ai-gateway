import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  GatewayProviderSettings,
  GatewayStoredConfig,
  GatewayPaths,
  toIsoNow,
} from "@local-ai-gateway/shared";

export class ConfigStore {
  constructor(private readonly paths: GatewayPaths) {}

  load(): GatewayStoredConfig {
    if (!existsSync(this.paths.configPath)) {
      const created = this.createDefault();
      this.save(created);
      return created;
    }

    const raw = readFileSync(this.paths.configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayStoredConfig>;

    if (!parsed.adminToken || !parsed.createdAt || !parsed.updatedAt) {
      const repaired = {
        ...this.createDefault(),
        ...parsed,
        adminToken: parsed.adminToken ?? randomUUID(),
        createdAt: parsed.createdAt ?? toIsoNow(),
        updatedAt: toIsoNow(),
      };
      this.save(repaired);
      return repaired;
    }

    return parsed as GatewayStoredConfig;
  }

  save(config: GatewayStoredConfig): GatewayStoredConfig {
    writeFileSync(this.paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }

  setActiveSession(sessionId?: string): GatewayStoredConfig {
    const current = this.load();
    const next = {
      ...current,
      activeSessionId: sessionId,
      updatedAt: toIsoNow(),
    };
    return this.save(next);
  }

  getProviderSettings(): GatewayProviderSettings {
    return this.load().providerSettings ?? {};
  }

  setProviderSettings(providerSettings: GatewayProviderSettings): GatewayStoredConfig {
    const current = this.load();
    const next = {
      ...current,
      providerSettings,
      updatedAt: toIsoNow(),
    };
    return this.save(next);
  }

  getAdminToken(): string {
    return this.load().adminToken;
  }

  private createDefault(): GatewayStoredConfig {
    const now = toIsoNow();
    return {
      adminToken: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
  }
}
