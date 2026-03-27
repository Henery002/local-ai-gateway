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
    | "security-settings"
    | "system-settings";
  message: string;
}

export interface RuntimeDiagnosticSessionLike {
  id: string;
  status: "available" | "expired" | "invalid";
}

export interface RuntimeDiagnosticContext {
  gatewayOk?: boolean;
  activeSessionId?: string;
  sessions: RuntimeDiagnosticSessionLike[];
  loadFailures: RuntimeDiagnosticLoadFailure[];
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
      suggestion: "请先导入 Codex 账号或确认本机存在可复用的 OpenClaw 授权。",
    };
  }

  const defaultTitles = {
    health: "健康检查失败",
    providers: "Provider 列表加载失败",
    sessions: "账号会话加载失败",
    "provider-settings": "Provider 配置加载失败",
    "routing-settings": "路由策略配置加载失败",
    "security-settings": "接入鉴权配置加载失败",
    "system-settings": "系统配置加载失败",
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

  if (!context.sessions.length) {
    diagnostics.push({
      id: "session-none",
      title: "暂无本地授权来源",
      message: "当前未检测到任何桌面端 Codex 账号或 OpenClaw 可复用授权。",
      severity: "warning",
      suggestion: "请导入 Codex 账号，或在本机已有 OpenClaw 登录状态时重新扫描本地授权。",
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
