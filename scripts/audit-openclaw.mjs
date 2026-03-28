import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv) {
  const options = {
    root: join(homedir(), ".openclaw"),
    baseUrl: "http://127.0.0.1:8787/v1",
    clientTag: "openclaw",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--root" && next) {
      options.root = next;
      index += 1;
    } else if (current === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
    } else if (current === "--client-tag" && next) {
      options.clientTag = next;
      index += 1;
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function findGatewayProvider(providers, expectedBaseUrl) {
  return Object.entries(providers ?? {}).find(([, provider]) => {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    return (
      provider?.baseUrl === expectedBaseUrl &&
      models.some((model) => model?.id === "codex-default")
    );
  });
}

function auditProviderContainer({
  label,
  providers,
  expectedBaseUrl,
  expectedClientTag,
}) {
  const gatewayEntry = findGatewayProvider(providers, expectedBaseUrl);

  if (!gatewayEntry) {
    return {
      label,
      ok: false,
      issues: [
        `未发现指向 ${expectedBaseUrl} 且暴露 codex-default 的本地网关 Provider`,
      ],
    };
  }

  const [providerKey, provider] = gatewayEntry;
  const issues = [];
  const headers = provider?.headers ?? {};
  const models = Array.isArray(provider?.models) ? provider.models : [];

  if (provider?.baseUrl !== expectedBaseUrl) {
    issues.push(`baseUrl 不是 ${expectedBaseUrl}`);
  }

  if (headers["x-client-tag"] !== expectedClientTag) {
    issues.push(`x-client-tag 不是 ${expectedClientTag}`);
  }

  if (!models.some((model) => model?.id === "codex-default")) {
    issues.push("未暴露 codex-default 模型");
  }

  return {
    label,
    ok: issues.length === 0,
    providerKey,
    issues,
  };
}

function auditRootConfig(rootConfig, expectedBaseUrl, expectedClientTag) {
  const providerAudit = auditProviderContainer({
    label: "根配置 openclaw.json",
    providers: rootConfig?.models?.providers,
    expectedBaseUrl,
    expectedClientTag,
  });
  const defaults = rootConfig?.agents?.defaults?.model ?? {};
  const expectedPrimary = providerAudit.providerKey
    ? `${providerAudit.providerKey}/codex-default`
    : undefined;
  const issues = [...providerAudit.issues];

  if (expectedPrimary && defaults.primary !== expectedPrimary) {
    issues.push(
      `默认主模型当前为 ${defaults.primary ?? "未配置"}，期望为 ${expectedPrimary}`,
    );
  }

  return {
    ...providerAudit,
    ok: issues.length === 0,
    issues,
    primary: defaults.primary ?? null,
  };
}

function auditAgentModels(root, expectedBaseUrl, expectedClientTag) {
  const agentsRoot = join(root, "agents");
  if (!existsSync(agentsRoot)) {
    return [
      {
        label: "agents",
        ok: false,
        issues: ["未找到 agents 目录"],
      },
    ];
  }

  return readdirSync(agentsRoot)
    .map((agentName) => ({
      agentName,
      filePath: join(agentsRoot, agentName, "agent", "models.json"),
    }))
    .filter((item) => existsSync(item.filePath))
    .map((item) => {
      const payload = readJson(item.filePath);
      return auditProviderContainer({
        label: `Agent ${item.agentName}`,
        providers: payload?.providers,
        expectedBaseUrl,
        expectedClientTag,
      });
    });
}

function printAuditSummary(title, rows) {
  console.log(`\n[审计] ${title}`);
  for (const row of rows) {
    const prefix = row.ok ? "✓" : "✗";
    const providerSegment = row.providerKey
      ? ` provider=${row.providerKey}`
      : "";
    console.log(`${prefix} ${row.label}${providerSegment}`);
    for (const issue of row.issues ?? []) {
      console.log(`  - ${issue}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootConfigPath = join(options.root, "openclaw.json");

  if (!existsSync(rootConfigPath)) {
    console.error(`[审计] 未找到 OpenClaw 根配置：${rootConfigPath}`);
    process.exit(1);
  }

  const rootConfig = readJson(rootConfigPath);
  const rootAudit = auditRootConfig(
    rootConfig,
    options.baseUrl,
    options.clientTag,
  );
  const agentAudits = auditAgentModels(
    options.root,
    options.baseUrl,
    options.clientTag,
  );

  printAuditSummary("根配置", [rootAudit]);
  printAuditSummary("Agent 配置", agentAudits);

  const allRows = [rootAudit, ...agentAudits];
  const failed = allRows.filter((row) => !row.ok);

  if (failed.length > 0) {
    console.error(
      `\n[审计] 发现 ${failed.length} 项配置未通过，请修复后再进行 OpenClaw 实际联调。`,
    );
    process.exit(1);
  }

  console.log(
    "\n[审计] OpenClaw 本地网关接入配置检查通过，可进入低扰动联调与真实验收阶段。",
  );
}

main();
