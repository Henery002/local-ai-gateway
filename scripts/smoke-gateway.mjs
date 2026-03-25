import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const baseUrl = "http://127.0.0.1:8787";
const gatewayEntrypoint = join(process.cwd(), "apps/gateway/dist/cli.js");
const configPath = join(
  homedir(),
  "Library",
  "Application Support",
  "local-ai-gateway",
  "config.json",
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ||
        `HTTP ${response.status} for ${path}`,
    );
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function isUsageLimitError(error) {
  const message = String(error?.message ?? "");
  return (
    message.includes("usage_limit_reached") ||
    message.includes("The usage limit has been reached")
  );
}

async function isHealthy() {
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) {
      return;
    }
    await sleep(300);
  }
  throw new Error("Gateway health check timed out.");
}

function readAdminToken() {
  if (!existsSync(configPath)) {
    throw new Error(`Admin config not found: ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.adminToken) {
    throw new Error("adminToken is missing in config.json");
  }
  return config.adminToken;
}

function logStep(message) {
  console.log(`[smoke] ${message}`);
}

async function main() {
  let child;
  let startedByScript = false;
  let upstreamQuotaBlocked = false;

  try {
    if (!(await isHealthy())) {
      if (!existsSync(gatewayEntrypoint)) {
        throw new Error("Gateway build output was not found. Run npm run build first.");
      }

      logStep("启动本地 gateway 进程");
      child = spawn("node", [gatewayEntrypoint], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      startedByScript = true;
      await waitForHealth();
    } else {
      logStep("检测到已有 gateway 正在运行，复用现有实例");
    }

    logStep("验证健康检查");
    const health = await fetchJson("/healthz");
    console.log(health);

    logStep("验证模型列表");
    const models = await fetchJson("/v1/models");
    if (!Array.isArray(models.data) || !models.data.find((item) => item.id === "codex-default")) {
      throw new Error("未发现默认模型 codex-default");
    }

    try {
      logStep("验证非流式聊天");
      const chat = await fetchJson("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "codex-default",
          messages: [
            {
              role: "user",
              content: "Reply with exactly OK.",
            },
          ],
        }),
      });
      console.log(chat.choices?.[0]?.message);

      logStep("验证工具调用");
      const toolChat = await fetchJson("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "codex-default",
          messages: [
            {
              role: "user",
              content: "Use the get_weather tool for Shanghai and do not answer directly.",
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather by city",
                parameters: {
                  type: "object",
                  properties: {
                    city: {
                      type: "string",
                    },
                  },
                  required: ["city"],
                },
              },
            },
          ],
        }),
      });
      console.log(toolChat.choices?.[0]?.message?.tool_calls?.[0]);
    } catch (error) {
      if (!isUsageLimitError(error)) {
        throw error;
      }
      upstreamQuotaBlocked = true;
      logStep("检测到上游额度已达上限，跳过真实推理断言，但继续验证本地 Admin 链路");
      console.log(String(error.message));
    }

    const adminToken = readAdminToken();

    logStep("验证 Admin 健康接口");
    const adminHealth = await fetchJson("/admin/health", {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    console.log({
      activeSessionId: adminHealth.activeSessionId,
      provider: adminHealth.provider,
      sessionCount: adminHealth.sessionCount,
    });

    logStep("验证会话列表");
    const sessions = await fetchJson("/admin/sessions", {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });
    if (!Array.isArray(sessions.data) || sessions.data.length === 0) {
      throw new Error("Admin 会话列表为空");
    }
    console.log({
      activeSessionId: sessions.activeSessionId,
      count: sessions.data.length,
    });

    if (upstreamQuotaBlocked) {
      logStep("本地链路检查通过，但真实上游推理因额度限制被跳过");
    } else {
      logStep("全部 smoke 检查通过");
    }
  } finally {
    if (startedByScript && child) {
      child.kill("SIGTERM");
      await sleep(400);
      logStep("已关闭 smoke 过程中启动的 gateway 进程");
    }
  }
}

main().catch((error) => {
  console.error("[smoke] 失败:", error.message);
  process.exit(1);
});
