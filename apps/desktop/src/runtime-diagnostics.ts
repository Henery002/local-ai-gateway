export type RuntimeDiagnosticSeverity = "success" | "info" | "warning" | "error";

export interface RuntimeDiagnostic {
  id: string;
  title: string;
  message: string;
  severity: RuntimeDiagnosticSeverity;
  suggestion?: string;
}

export interface RuntimeDiagnosticLoadFailure {
  scope:
    | "health"
    | "providers"
    | "sessions"
    | "provider-settings"
    | "routing-settings"
    | "pool-settings"
    | "security-settings"
    | "system-settings"
    | "app-data-status"
    | "usage-summary"
    | "usage-analytics"
    | "access-alerts"
    | "operations-status"
    | "request-audit"
    | "account-health";
  message: string;
}

export interface RuntimeDiagnosticSessionLike {
  id: string;
  status: "available" | "expired" | "invalid";
  activity?: {
    requestCount?: number;
  };
}

export interface RuntimeDiagnosticContext {
  gatewayOk?: boolean;
  activeSessionId?: string;
  sessions: RuntimeDiagnosticSessionLike[];
  loadFailures: RuntimeDiagnosticLoadFailure[];
  routingEnabled?: boolean;
  routingMatchedTotal?: number;
  inferenceAuthEnabled?: boolean;
  inferenceAuthHasApiKey?: boolean;
  lanAccessEnabled?: boolean;
  lanBaseUrl?: string;
  publicAccessEnabled?: boolean;
  publicAccessProvider?: string;
  publicBaseUrl?: string;
  gatewayHost?: string;
  gatewayPort?: number;
  localNetworkAddressCount?: number;
  sharedLanPoolCount?: number;
  enabledLanConsumerCount?: number;
  enabledLanAccessKeyCount?: number;
  publicReadyPoolCount?: number;
  enabledPublicConsumerCount?: number;
  enabledPublicAccessKeyCount?: number;
  recentErrors?: Array<{
    level?: string;
    message: string;
  }>;
}

function includesAny(message: string, patterns: string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

export function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = host?.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

export function classifyLoadFailure(
  failure: RuntimeDiagnosticLoadFailure,
): RuntimeDiagnostic {
  const message = failure.message;

  if (includesAny(message, ["本地端口", "已被其他进程占用"])) {
    return {
      id: `load-${failure.scope}-port-conflict`,
      title: "网关端口冲突",
      message,
      severity: "error",
      suggestion: "请在系统配置中修改网关端口，或释放当前被占用的本地端口。",
    };
  }

  if (includesAny(message, ["Gateway did not become healthy", "fetch failed", "ECONNREFUSED"])) {
    return {
      id: `load-${failure.scope}-gateway-unreachable`,
      title: "网关未响应",
      message,
      severity: "error",
      suggestion: "请先检查本地网关进程是否正常启动，再尝试刷新状态。",
    };
  }

  if (includesAny(message, ["Admin token is not available yet", "Admin token is missing or invalid"])) {
    return {
      id: `load-${failure.scope}-admin-token`,
      title: "管理令牌不可用",
      message,
      severity: "error",
      suggestion: "请先启动网关，确保本地配置文件中已生成有效的管理令牌。",
    };
  }

  if (includesAny(message, ["Admin request failed (401)", "unauthorized"])) {
    return {
      id: `load-${failure.scope}-admin-auth`,
      title: "管理接口鉴权失败",
      message,
      severity: "error",
      suggestion: "本地管理令牌可能已失效，请重启网关后重试。",
    };
  }

  if (includesAny(message, ["gateway_auth_required", "No sessions available"])) {
    return {
      id: `load-${failure.scope}-auth-required`,
      title: "缺少可用授权",
      message,
      severity: "warning",
      suggestion: "请先导入 Codex 账号，或确认本机存在可复用的 Codex 授权来源。",
    };
  }

  const defaultTitles = {
    health: "健康检查失败",
    providers: "Provider 列表加载失败",
    sessions: "账号会话加载失败",
    "provider-settings": "Provider 配置加载失败",
    "routing-settings": "路由策略配置加载失败",
    "pool-settings": "号池调度配置加载失败",
    "security-settings": "接入鉴权配置加载失败",
    "system-settings": "系统配置加载失败",
    "app-data-status": "应用数据概况加载失败",
    "usage-summary": "Token 用量统计加载失败",
    "usage-analytics": "用量分析加载失败",
    "access-alerts": "访问告警事件加载失败",
    "operations-status": "运维状态加载失败",
    "request-audit": "请求审计加载失败",
    "account-health": "账号健康加载失败",
  } as const;

  return {
    id: `load-${failure.scope}-generic`,
    title: defaultTitles[failure.scope],
    message,
    severity: "warning",
  };
}

export function buildRuntimeDiagnostics(
  context: RuntimeDiagnosticContext,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = context.loadFailures.map(classifyLoadFailure);
  const availableSessions = context.sessions.filter((session) => session.status === "available");
  const totalRequestCount = context.sessions.reduce(
    (sum, session) => sum + (session.activity?.requestCount ?? 0),
    0,
  );

  if (context.inferenceAuthEnabled && !context.inferenceAuthHasApiKey) {
    diagnostics.push({
      id: "gateway-inference-auth-missing-key",
      title: "接入鉴权缺少密钥",
      message: "当前网关已启用第三方接入鉴权，但尚未配置可用的 Gateway API Key。",
      severity: "warning",
      suggestion: "请在“诊断与系统 -> 第三方客户端接入鉴权”中填写并保存 Gateway API Key。",
    });
  }

  if (context.lanAccessEnabled) {
    const publicFirstMode = Boolean(context.publicAccessEnabled);
    const sharedLanPoolCount = context.sharedLanPoolCount ?? 0;
    const enabledLanConsumerCount = context.enabledLanConsumerCount ?? 0;
    const enabledLanAccessKeyCount = context.enabledLanAccessKeyCount ?? 0;
    const gatewayPort = context.gatewayPort ?? 8787;

    if (!publicFirstMode && (!context.inferenceAuthEnabled || !context.inferenceAuthHasApiKey)) {
      diagnostics.push({
        id: "lan-api-key-required",
        title: "LAN 共享缺少可用 Key 保护",
        message: "局域网共享已开启，但推理面还没有可用的 Gateway Key、客户端映射 Key 或访问成员 Key。",
        severity: "warning",
        suggestion:
          "请启用第三方接入鉴权，并至少保存一类可用 Key，避免局域网内未授权设备直接访问推理接口。",
      });
    }

    if (!publicFirstMode && sharedLanPoolCount === 0) {
      diagnostics.push({
        id: "lan-shared-pool-missing",
        title: "缺少 shared-lan 号池",
        message: "局域网共享已开启，但当前没有可供 LAN 成员使用的 shared-lan 动态号池。",
        severity: "warning",
        suggestion:
          "请在“号池与路由”中将至少一个共享号池的可见性设为“局域网共享”，并确认池内账号可用。",
      });
    }

    if (!publicFirstMode && enabledLanConsumerCount === 0) {
      diagnostics.push({
        id: "lan-member-missing",
        title: "缺少启用中的 LAN 成员",
        message: "局域网共享已开启，但当前没有启用中的 LAN 访问成员。",
        severity: "warning",
        suggestion:
          "请在“访问与密钥”中新增或启用 LAN 成员，并为成员分配模型、额度和允许号池。",
      });
    } else if (!publicFirstMode && enabledLanAccessKeyCount === 0) {
      diagnostics.push({
        id: "lan-member-key-missing",
        title: "LAN 成员缺少可用 Key",
        message: "当前已有启用中的 LAN 成员，但没有可用的成员 API Key。",
        severity: "warning",
        suggestion:
          "请在成员详情中创建或轮换 API Key，并把一次性明文分发给对应接入方。",
      });
    }

    if (!publicFirstMode && isLoopbackHost(context.gatewayHost)) {
      diagnostics.push({
        id: "lan-bind-loopback",
        title: "LAN 共享仍绑定本机地址",
        message: `局域网共享已开启，但网关当前监听地址是 ${context.gatewayHost}，其他设备无法直接访问。`,
        severity: "warning",
        suggestion:
          "请保存 LAN 共享配置并重启网关，使推理面监听 0.0.0.0；管理面仍会保持本机访问保护。",
      });
    }

    if (!publicFirstMode && context.localNetworkAddressCount === 0) {
      diagnostics.push({
        id: "lan-network-address-missing",
        title: "未检测到局域网 IP",
        message: "局域网共享已开启，但桌面端暂未枚举到可分发的本机局域网 IPv4 地址。",
        severity: "warning",
        suggestion:
          "请确认本机已连接 Wi-Fi 或有线局域网；如使用 VPN、热点或虚拟网卡，请优先分发同网段设备可访问的地址。",
      });
    }

    if (!publicFirstMode) {
      diagnostics.push({
        id: "lan-firewall-verification",
        title: "请从成员设备验证端口连通",
        message: `桌面端无法稳定自动判断 macOS 防火墙、路由器隔离或公司网络策略；请从成员设备访问 Base URL 或 /v1/models 验证 ${gatewayPort} 端口。`,
        severity: "info",
        suggestion:
          "如果成员设备无法访问，请检查 macOS 防火墙、同网段隔离、路由器 AP isolation，以及当前网关端口是否被安全软件拦截。",
      });

      diagnostics.push({
        id: "lan-host-sleep-risk",
        title: "管理员主机睡眠会中断共享",
        message: "LAN 共享依赖管理员这台 Mac 持续开机并保持网关运行，主机睡眠或网络切换会让成员请求失败。",
        severity: "info",
        suggestion:
          "小范围共享期间建议连接电源，并在 macOS 设置中临时避免睡眠；长时间共享再考虑独立 server edition 或常驻主机。",
      });
    }

    if (!publicFirstMode && (context.publicReadyPoolCount ?? 0) > 0) {
      diagnostics.push({
        id: "public-ready-placeholder",
        title: "检测到外网预留号池",
        message:
          "当前存在 public-ready 号池配置；只有显式启用公网共享并配置 HTTPS Public Base URL 后，public-user 成员才可使用它。",
        severity: "info",
        suggestion:
          "LAN 成员仍只能访问 shared-lan 号池；公网成员必须使用独立 Key、额度包、过期时间、QPS / 并发和 public-ready 号池授权。",
      });
    }

    if (
      context.gatewayOk &&
      context.inferenceAuthEnabled &&
      context.inferenceAuthHasApiKey &&
      sharedLanPoolCount > 0 &&
      enabledLanConsumerCount > 0 &&
      enabledLanAccessKeyCount > 0
    ) {
      const lanBaseUrl = context.lanBaseUrl?.trim() || "请使用本机局域网 IP + 网关端口";
      diagnostics.push({
        id: "lan-sharing-ready",
        title: "LAN 共享入口已就绪",
        message: `局域网共享的关键条件已满足，可将 Base URL 分发为 ${lanBaseUrl}。`,
        severity: "success",
        suggestion:
          "请只把成员 API Key 分发给可信接入方，并优先在同一局域网内做一次 /v1/models 或对话请求验证。",
      });
    }
  }

  if (context.publicAccessEnabled) {
    const publicBaseUrl = context.publicBaseUrl?.trim();
    const publicReadyPoolCount = context.publicReadyPoolCount ?? 0;
    const enabledPublicConsumerCount = context.enabledPublicConsumerCount ?? 0;
    const enabledPublicAccessKeyCount = context.enabledPublicAccessKeyCount ?? 0;
    const providerLabel =
      context.publicAccessProvider === "tailscale-funnel"
        ? "Tailscale Funnel"
        : context.publicAccessProvider === "manual-reverse-proxy"
          ? "手动反向代理"
          : "Cloudflare Tunnel";

    if (!context.inferenceAuthEnabled || !context.inferenceAuthHasApiKey) {
      diagnostics.push({
        id: "public-api-key-required",
        title: "公网共享缺少可用 Key 保护",
        message: "公网共享已开启，但推理面还没有可用的 Gateway Key、客户端映射 Key 或公网成员 Key。",
        severity: "warning",
        suggestion:
          "请先启用 API Key 鉴权，并为每个公网试用成员创建独立 Key；不要复用管理员自用 Gateway Key。",
      });
    }

    if (!publicBaseUrl) {
      diagnostics.push({
        id: "public-base-url-missing",
        title: "缺少 Public Base URL",
        message: `公网共享已开启，但尚未配置 ${providerLabel} 对外 HTTPS 入口。`,
        severity: "warning",
        suggestion:
          "域名准备好后填写类似 https://gateway.example.com/v1 的 Public Base URL；Quick Tunnel 只适合临时测试。",
      });
    } else if (!publicBaseUrl.startsWith("https://")) {
      diagnostics.push({
        id: "public-base-url-not-https",
        title: "Public Base URL 不是 HTTPS",
        message: `当前公网入口为 ${publicBaseUrl}，不符合公网共享的 HTTPS 边界。`,
        severity: "warning",
        suggestion:
          "公网成员应只使用 HTTPS 入口；Cloudflare Tunnel 正式域名完成后再保存 Public Base URL。",
      });
    }

    if (publicReadyPoolCount === 0) {
      diagnostics.push({
        id: "public-ready-pool-missing",
        title: "缺少 public-ready 号池",
        message: "公网共享已开启，但当前没有可供公网成员使用的 public-ready 动态号池。",
        severity: "warning",
        suggestion:
          "请在“号池与路由”中准备独立 public-ready 号池，不要把 private 自用号池直接暴露给公网成员。",
      });
    }

    if (enabledPublicConsumerCount === 0) {
      diagnostics.push({
        id: "public-user-missing",
        title: "缺少启用中的公网成员",
        message: "公网共享已开启，但当前没有启用中的 public-user 访问成员。",
        severity: "warning",
        suggestion:
          "请在“访问与密钥”中创建公网试用成员，并设置过期时间、额度包、QPS / 并发、模型和号池授权。",
      });
    } else if (enabledPublicAccessKeyCount === 0) {
      diagnostics.push({
        id: "public-user-key-missing",
        title: "公网成员缺少可用 Key",
        message: "当前已有启用中的公网成员，但没有可用的成员 API Key。",
        severity: "warning",
        suggestion:
          "请为每个公网试用成员创建独立 API Key；不要分发默认 Gateway Key 或管理员本机密钥。",
      });
    }

    diagnostics.push({
      id: "public-admin-surface-local-only",
      title: "管理面保持本机访问",
      message: "公网共享配置只面向 OpenAI-compatible 推理面 `/v1/*`，管理面 `/admin/*` 仍由本机 loopback guard 保护。",
      severity: "info",
      suggestion:
        "Cloudflare 或反代规则应只作为推理入口使用；不要把桌面控制台或管理 token 当公网产品能力分发。",
    });

    if (
      context.gatewayOk &&
      context.inferenceAuthEnabled &&
      context.inferenceAuthHasApiKey &&
      publicBaseUrl?.startsWith("https://") &&
      publicReadyPoolCount > 0 &&
      enabledPublicConsumerCount > 0 &&
      enabledPublicAccessKeyCount > 0
    ) {
      diagnostics.push({
        id: "public-sharing-ready",
        title: "公网共享入口配置已就绪",
        message: `${providerLabel} 公网入口的关键本地条件已满足，可将 Base URL 分发为 ${publicBaseUrl}。`,
        severity: "success",
        suggestion:
          "正式分发前请从外部网络分别验收 /v1/models、非流式对话和 stream: true 长连接；公司网络切换后允许短暂重连窗口。",
      });
    }
  }

  if (!context.sessions.length) {
    diagnostics.push({
      id: "session-none",
      title: "暂无本地授权来源",
      message: "当前未检测到任何桌面端 Codex 账号或可复用 Codex 授权来源。",
      severity: "warning",
      suggestion: "请导入 Codex 账号，或在本机已有可复用授权时重新扫描本地授权。",
    });
  } else if (context.activeSessionId) {
    const activeSession = context.sessions.find((session) => session.id === context.activeSessionId);
    if (!activeSession) {
      diagnostics.push({
        id: "session-active-missing",
        title: "活动账号不存在",
        message: `当前活动账号 ${context.activeSessionId} 已不在本地会话列表中。`,
        severity: "warning",
        suggestion: "请重新选择一个可用账号作为活动账号。",
      });
    } else if (activeSession.status === "expired") {
      diagnostics.push({
        id: "session-active-expired",
        title: "活动账号已过期",
        message: "当前活动账号的 OAuth 授权已过期，后续推理请求可能失败。",
        severity: "warning",
        suggestion: "请重新授权该账号，或切换到其他可用账号。",
      });
    } else if (activeSession.status === "invalid") {
      diagnostics.push({
        id: "session-active-invalid",
        title: "活动账号不可用",
        message: "当前活动账号的授权信息不完整或解析失败。",
        severity: "error",
        suggestion: "请删除后重新导入该账号，或切换到其他可用账号。",
      });
    }
  } else if (availableSessions.length > 0) {
    diagnostics.push({
      id: "session-active-unset",
      title: "尚未选择活动账号",
      message: `当前检测到 ${availableSessions.length} 个可用授权，但尚未指定活动账号。`,
      severity: "info",
      suggestion: "请在账号页将一个可用账号设为活动账号，第三方请求才会走该授权。",
    });
  }

  if (context.gatewayOk && availableSessions.length > 0 && totalRequestCount === 0) {
    diagnostics.push({
      id: "gateway-no-client-traffic",
      title: "尚未观测到第三方请求",
      message: "本地网关和账号授权已就绪，但目前还没有任何真实请求经过该网关。",
      severity: "info",
      suggestion:
        "请在第三方客户端中将 baseUrl 指向本地网关，并发起一次真实请求以验证 clientTag、路由命中和账号活动统计。",
    });
  }

  if (
    context.gatewayOk &&
    context.routingEnabled &&
    totalRequestCount > 0 &&
    (context.routingMatchedTotal ?? 0) === 0
  ) {
    diagnostics.push({
      id: "routing-enabled-no-hit",
      title: "策略路由尚未命中",
      message: "当前已有真实请求经过网关，但启用的策略规则暂未命中任何一次。",
      severity: "info",
      suggestion:
        "如果你希望按客户端或模型分流，请检查 clientTag、请求模型别名与规则优先级，并先用“路由预演”验证匹配结果。",
    });
  }

  const recentErrorMessages = (context.recentErrors ?? []).map((item) => item.message);
  if (
    recentErrorMessages.some((message) =>
      includesAny(message, ["gateway_api_key_required", "Missing API key for gateway inference endpoint"]),
    )
  ) {
    diagnostics.push({
      id: "gateway-inference-auth-required",
      title: "第三方请求缺少 Gateway API Key",
      message: "最近有第三方请求命中了本地网关，但没有携带正确的 Gateway API Key。",
      severity: "warning",
      suggestion:
        "请在第三方客户端里填写本地网关 API Key，或暂时把接入鉴权模式切回“无鉴权”后再验证。",
    });
  }

  if (
    recentErrorMessages.some((message) =>
      includesAny(message, ["gateway_api_key_invalid", "Invalid API key for gateway inference endpoint"]),
    )
  ) {
    diagnostics.push({
      id: "gateway-inference-auth-invalid",
      title: "第三方请求使用了错误的 Gateway API Key",
      message: "最近有第三方请求访问本地网关，但提供的 Gateway API Key 与当前配置不一致。",
      severity: "warning",
      suggestion:
        "请重新复制当前网关 API Key 到第三方客户端，避免旧密钥或手工录入错误导致请求被拒绝。",
    });
  }

  if (!diagnostics.length && context.gatewayOk) {
    diagnostics.push({
      id: "gateway-ok",
      title: "网关运行正常",
      message: "桌面端、网关服务与本地授权状态均已就绪。",
      severity: "success",
    });
  }

  return diagnostics;
}
