import { describe, expect, it } from "vitest";

import {
  buildRuntimeDiagnostics,
  classifyLoadFailure,
} from "../apps/desktop/src/runtime-diagnostics.js";

describe("runtime diagnostics", () => {
  it("classifies port conflict as error diagnostic", () => {
    const diagnostic = classifyLoadFailure({
      scope: "health",
      message:
        "本地端口 8787 已被其他进程占用，网关无法启动。请在系统配置中更换网关端口或释放该端口后重试。",
    });

    expect(diagnostic).toMatchObject({
      title: "网关端口冲突",
      severity: "error",
    });
  });

  it("reports expired active session separately from generic load failures", () => {
    const diagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "expired",
        },
      ],
      loadFailures: [],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session-active-expired",
          title: "活动账号已过期",
          severity: "warning",
        }),
      ]),
    );
  });

  it("returns healthy diagnostic when runtime is fully ready", () => {
    const diagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 3,
          },
        },
      ],
      loadFailures: [],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        id: "gateway-ok",
        title: "网关运行正常",
        severity: "success",
      }),
    ]);
  });

  it("surfaces missing client traffic and unmatched routing as info diagnostics", () => {
    const noTrafficDiagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 0,
          },
        },
      ],
      routingEnabled: true,
      routingMatchedTotal: 0,
      loadFailures: [],
    });

    expect(noTrafficDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gateway-no-client-traffic",
          severity: "info",
        }),
      ]),
    );

    const unmatchedRoutingDiagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 5,
          },
        },
      ],
      routingEnabled: true,
      routingMatchedTotal: 0,
      loadFailures: [],
    });

    expect(unmatchedRoutingDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "routing-enabled-no-hit",
          severity: "info",
        }),
      ]),
    );
  });

  it("warns when gateway inference auth is misconfigured or recent requests use wrong key", () => {
    const diagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
        },
      ],
      loadFailures: [],
      inferenceAuthEnabled: true,
      inferenceAuthHasApiKey: false,
      recentErrors: [
        { message: "gateway_api_key_required" },
        { message: "gateway_api_key_invalid" },
      ],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gateway-inference-auth-missing-key",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "gateway-inference-auth-required",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "gateway-inference-auth-invalid",
          severity: "warning",
        }),
      ]),
    );
  });

  it("reports LAN sharing readiness and missing shared resources", () => {
    const incompleteDiagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 1,
          },
        },
      ],
      loadFailures: [],
      inferenceAuthEnabled: true,
      inferenceAuthHasApiKey: true,
      lanAccessEnabled: true,
      lanBaseUrl: "http://192.168.1.20:8787/v1",
      sharedLanPoolCount: 0,
      enabledLanConsumerCount: 1,
      enabledLanAccessKeyCount: 0,
    });

    expect(incompleteDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lan-shared-pool-missing",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "lan-member-key-missing",
          severity: "warning",
        }),
      ]),
    );

    const readyDiagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 1,
          },
        },
      ],
      loadFailures: [],
      inferenceAuthEnabled: true,
      inferenceAuthHasApiKey: true,
      lanAccessEnabled: true,
      lanBaseUrl: "http://192.168.1.20:8787/v1",
      sharedLanPoolCount: 1,
      enabledLanConsumerCount: 1,
      enabledLanAccessKeyCount: 1,
    });

    expect(readyDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lan-sharing-ready",
          severity: "success",
          message: expect.stringContaining("http://192.168.1.20:8787/v1"),
        }),
      ]),
    );
  });

  it("reports LAN exposure diagnostics for binding, firewall, sleep, and public-ready placeholders", () => {
    const diagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 1,
          },
        },
      ],
      loadFailures: [],
      inferenceAuthEnabled: true,
      inferenceAuthHasApiKey: true,
      lanAccessEnabled: true,
      lanBaseUrl: "http://192.168.1.20:8787/v1",
      gatewayHost: "127.0.0.1",
      gatewayPort: 8787,
      localNetworkAddressCount: 0,
      sharedLanPoolCount: 1,
      enabledLanConsumerCount: 1,
      enabledLanAccessKeyCount: 1,
      publicReadyPoolCount: 1,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lan-bind-loopback",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "lan-network-address-missing",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "lan-firewall-verification",
          message: expect.stringContaining("8787"),
          severity: "info",
        }),
        expect.objectContaining({
          id: "lan-host-sleep-risk",
          severity: "info",
        }),
        expect.objectContaining({
          id: "public-ready-placeholder",
          message: expect.stringContaining("显式启用公网共享"),
          suggestion: expect.stringContaining("LAN 成员仍只能访问 shared-lan 号池"),
          severity: "info",
        }),
      ]),
    );
  });

  it("reports public sharing readiness and missing Cloudflare prerequisites", () => {
    const incompleteDiagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 1,
          },
        },
      ],
      loadFailures: [],
      inferenceAuthEnabled: true,
      inferenceAuthHasApiKey: true,
      publicAccessEnabled: true,
      publicAccessProvider: "cloudflare-tunnel",
      publicBaseUrl: "",
      publicReadyPoolCount: 0,
      enabledPublicConsumerCount: 1,
      enabledPublicAccessKeyCount: 0,
    });

    expect(incompleteDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "public-base-url-missing",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "public-ready-pool-missing",
          severity: "warning",
        }),
        expect.objectContaining({
          id: "public-user-key-missing",
          severity: "warning",
        }),
      ]),
    );

    const readyDiagnostics = buildRuntimeDiagnostics({
      gatewayOk: true,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          status: "available",
          activity: {
            requestCount: 1,
          },
        },
      ],
      loadFailures: [],
      inferenceAuthEnabled: true,
      inferenceAuthHasApiKey: true,
      publicAccessEnabled: true,
      publicAccessProvider: "cloudflare-tunnel",
      publicBaseUrl: "https://gateway.example.com/v1",
      publicReadyPoolCount: 1,
      enabledPublicConsumerCount: 1,
      enabledPublicAccessKeyCount: 1,
    });

    expect(readyDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "public-sharing-ready",
          severity: "success",
          message: expect.stringContaining("https://gateway.example.com/v1"),
        }),
      ]),
    );
  });
});
