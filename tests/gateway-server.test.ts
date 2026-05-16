import { describe, expect, it } from "vitest";

import { resolveGatewayHostFromInferenceAuthSettings } from "../apps/gateway/src/server.js";

describe("gateway server host resolution", () => {
  it("keeps loopback host unless LAN access has api key protection", () => {
    expect(resolveGatewayHostFromInferenceAuthSettings({})).toBe("127.0.0.1");
    expect(
      resolveGatewayHostFromInferenceAuthSettings({
        mode: "none",
        lanAccess: {
          enabled: true,
        },
      }),
    ).toBe("127.0.0.1");
    expect(
      resolveGatewayHostFromInferenceAuthSettings({
        mode: "api-key",
        lanAccess: {
          enabled: true,
        },
      }),
    ).toBe("127.0.0.1");
  });

  it("binds all interfaces only when LAN access and api key auth are configured", () => {
    expect(
      resolveGatewayHostFromInferenceAuthSettings({
        mode: "api-key",
        apiKey: "gateway-secret",
        lanAccess: {
          enabled: true,
        },
      }),
    ).toBe("0.0.0.0");
    expect(
      resolveGatewayHostFromInferenceAuthSettings({
        mode: "api-key",
        lanAccess: {
          enabled: true,
        },
        clientMappings: [
          {
            name: "Hermes",
            apiKey: "hermes-key",
            clientTag: "hermes",
            enabled: true,
          },
        ],
      }),
    ).toBe("0.0.0.0");
    expect(
      resolveGatewayHostFromInferenceAuthSettings({
        mode: "api-key",
        lanAccess: {
          enabled: true,
        },
        accessControl: {
          consumers: [],
          keys: [
            {
              id: "key-alice",
              consumerId: "consumer-alice",
              name: "Alice",
              keyHash: "19096294cec548d83b1658b7cc0c5d897a3d69f5cc1bf9d8455625346f3d52d4",
              keyPrefix: "lag_alic",
              keySuffix: "3456",
              status: "enabled",
              createdAt: "2026-05-16T00:00:00.000Z",
            },
          ],
          policies: [],
        },
      }),
    ).toBe("0.0.0.0");
  });
});
