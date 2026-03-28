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
});
