import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("desktop build output", () => {
  it("uses a light Figma-style desktop shell by default", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    expect(indexHtml).toContain("class=\"app-shell figma-shell\"");
    expect(indexHtml).toContain("class=\"console-header page-header\"");
    expect(indexHtml).toContain("class=\"view-stack page-body\"");
    expect(indexHtml).toContain("class=\"sidebar compact-sidebar\"");
    expect(styles).toContain("color-scheme: light");
    expect(styles).toContain("--color-bg-app: #f6f7fb");
    expect(styles).toContain("--color-bg-sidebar: #ffffff");
    expect(styles).toContain("--color-bg-card: #ffffff");
    expect(styles).not.toContain("color-scheme: dark");
  });

  it("uses the phase two shared-gateway navigation structure", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );

    const expectedNavItems = [
      ["overview", "总览"],
      ["access", "访问与密钥"],
      ["accounts", "账号资产"],
      ["pools", "号池与路由"],
      ["models", "模型与 Provider"],
      ["usage", "用量与告警"],
      ["system", "系统与诊断"],
    ];

    const navGroup = indexHtml.match(
      /<div class="nav-group">([\s\S]*?)<\/div>\s*<div class="sidebar-foot">/,
    )?.[1];

    expect(navGroup).toBeTruthy();
    expect(navGroup?.match(/data-nav-target="/g) ?? []).toHaveLength(7);

    for (const [target, label] of expectedNavItems) {
      expect(navGroup).toContain(`data-nav-target="${target}"`);
      expect(navGroup).toContain(`<span class="nav-label">${label}</span>`);
      expect(indexHtml).toContain(`data-view="${target}"`);
    }
  });

  it("uses real icon and component hooks from the Figma UI baseline", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const navGroup = indexHtml.match(
      /<div class="nav-group">([\s\S]*?)<\/div>\s*<div class="sidebar-foot">/,
    )?.[1];

    expect(navGroup).toBeTruthy();
    expect(navGroup?.match(/<svg class="nav-icon-svg"/g) ?? []).toHaveLength(7);
    expect(navGroup?.match(/aria-hidden="true"/g) ?? []).toHaveLength(7);
    expect(navGroup).not.toContain('<span class="nav-icon">总</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">钥</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">账</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">池</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">模</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">量</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">诊</span>');

    expect(indexHtml).toContain("class=\"account-assets-shell table-container-lite\"");
    expect(indexHtml).toContain("class=\"card access-member-drawer detail-drawer-panel mt-4\"");
    expect(indexHtml).toContain("class=\"card account-detail-drawer detail-drawer-panel mt-4\"");
    expect(indexHtml).toContain("class=\"card access-create-member-modal action-modal-card mt-4\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal\"");
    expect(indexHtml).toContain("class=\"modal-tabs figma-tabs\"");
    expect(styles).toContain(".secret-inline-row .input-field");
    expect(styles).toContain(".detail-drawer-panel,");
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain("max-height: min(86vh, 920px);");
    expect(styles).toContain(".modal-tabs {");
    expect(styles).toContain("overflow-x: auto;");
    expect(styles).toContain(".modal-content {\n    max-height: calc(100vh - 24px);");
  });

  it("uses Figma stat-card hooks for usage and overview metrics", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const overview = indexHtml.match(
      /<div class="view" data-view="overview">([\s\S]*?)<!-- View: Access & Keys -->/,
    )?.[1];

    expect(overview).toBeTruthy();
    expect(overview?.match(/class="card mini-stat stat-card"/g) ?? []).toHaveLength(11);
    expect(rendererSource).toContain("class=\"usage-overview-card\"");
    expect(rendererSource).toContain("class=\"card-header usage-card-header\"");
    expect(rendererSource).toContain("class=\"usage-observe-grid stat-card-grid\"");
    expect(rendererSource).toContain("class=\"usage-kpi-card stat-card");
    expect(styles).toContain(".stat-card {");
    expect(styles).toContain(".card-header {");
    expect(styles).toContain(".stat-card-grid {");
    expect(styles).toContain(".usage-overview-card {");
  });

  it("uses Figma table hooks for access members and account assets", () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    expect(rendererSource).toContain("class=\"figma-table access-consumer-table\"");
    expect(rendererSource).toContain("class=\"figma-table-head access-consumer-table-head\"");
    expect(rendererSource).toContain("class=\"figma-table-row access-consumer-row\"");
    expect(rendererSource).toContain("class=\"figma-table account-assets-table\"");
    expect(rendererSource).toContain("class=\"figma-table-head account-assets-table-head\"");
    expect(rendererSource).toContain("account-assets-table-row");
    expect(rendererSource).toContain("account-assets-main-cell");
    expect(rendererSource).toContain("account-assets-ownership-cell");
    expect(rendererSource).toContain("account-assets-usage-cell");
    expect(rendererSource).toContain("account-assets-actions-cell");
    expect(styles).toContain(".figma-table {");
    expect(styles).toContain(".figma-table-head {");
    expect(styles).toContain(".figma-table-row {");
    expect(styles).toContain(".account-assets-table {");
    expect(styles).toContain(".account-assets-table .account-assets-table-row {");
    expect(styles).toContain(".account-assets-table-row > .figma-table-cell {");
    expect(styles).toContain(".access-consumer-table {");
    expect(styles).toContain("min-width: 620px;");
    expect(styles).toContain(".figma-table-cell strong");
    expect(styles).not.toContain(".access-consumer-row {\n    grid-template-columns: 1fr;");
  });

  it("renders the phase two dashboard skeleton", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );

    const overview = indexHtml.match(
      /<div class="view" data-view="overview">([\s\S]*?)<!-- View: Access & Keys -->/,
    )?.[1];

    expect(overview).toBeTruthy();
    expect(overview).toContain("data-dashboard-mode=\"local\"");
    expect(overview).toContain("data-dashboard-mode=\"lan\"");
    expect(overview).toContain("data-dashboard-mode=\"public\"");
    expect(overview).toContain("id=\"dashboard-token-chart\"");
    expect(overview).toContain("id=\"dashboard-shared-summary\"");
    expect(overview).toContain("id=\"dashboard-alert-summary\"");
  });

  it("renders the phase two access and keys skeleton", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );

    const accessView = indexHtml.match(
      /<div class="view" data-view="access" hidden>([\s\S]*?)<!-- View: Accounts -->/,
    )?.[1];

    expect(accessView).toBeTruthy();
    expect(accessView).toContain("data-access-surface=\"local\"");
    expect(accessView).toContain("data-access-surface=\"lan\"");
    expect(accessView).toContain("data-access-surface=\"public\"");
    expect(accessView).toContain("id=\"access-consumer-list\"");
    expect(accessView).toContain("id=\"access-policy-preview\"");
    expect(accessView).toContain("访问策略摘要");
    expect(accessView).not.toContain("成员级额度、模型权限和号池授权将在后续切片接入。");
    expect(accessView).toContain("id=\"access-member-drawer\"");
    expect(accessView).toContain("id=\"access-create-member-modal\"");
  });

  it("renders routing preview access consumer controls", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const renderer = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );

    const routingView = indexHtml.match(
      /<div class="view" data-view="routing" hidden>([\s\S]*?)<!-- View: Pools -->/,
    )?.[1];

    expect(routingView).toBeTruthy();
    expect(routingView).toContain("id=\"routing-preview-access-consumer\"");
    expect(renderer).toContain("accessDecision");
    expect(renderer).toContain("renderRoutingPreviewConsumerOptions");
  });

  it("renders access member creation controls with one-time key output", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );

    const accessView = indexHtml.match(
      /<div class="view" data-view="access" hidden>([\s\S]*?)<!-- View: Accounts -->/,
    )?.[1];

    expect(accessView).toBeTruthy();
    expect(accessView).toContain("id=\"access-create-member-button\"");
    expect(accessView).not.toContain("id=\"access-create-member-button\" type=\"button\" disabled");
    expect(accessView).toContain("id=\"access-member-name\"");
    expect(accessView).toContain("id=\"access-member-client-tag\"");
    expect(accessView).toContain("id=\"create-access-member-submit\"");
    expect(accessView).toContain("id=\"access-member-one-time-key\"");
    expect(accessView).toContain("id=\"copy-access-member-key\"");
  });

  it("renders access member detail and key management hooks", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );

    const accessView = indexHtml.match(
      /<div class="view" data-view="access" hidden>([\s\S]*?)<!-- View: Accounts -->/,
    )?.[1];

    expect(accessView).toBeTruthy();
    expect(accessView).toContain("id=\"access-member-detail-name\"");
    expect(accessView).toContain("id=\"access-member-detail-client-tag\"");
    expect(accessView).toContain("id=\"access-member-detail-keys\"");
    expect(accessView).toContain("id=\"access-rotated-key-result\"");
    expect(accessView).toContain("id=\"access-rotated-one-time-key\"");
    expect(accessView).toContain("id=\"copy-access-rotated-key\"");
  });

  it("binds access member detail actions in the renderer", () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );

    expect(rendererSource).toContain("data-access-member-select");
    expect(rendererSource).toContain("data-access-key-toggle");
    expect(rendererSource).toContain("data-access-key-rotate");
    expect(rendererSource).toContain("data-access-key-expiry");
    expect(rendererSource).toContain("data-access-key-save-expiry");
    expect(rendererSource).toContain("data-access-policy-pool");
    expect(rendererSource).toContain("data-access-policy-save-pools");
    expect(rendererSource).toContain("data-access-policy-daily-token-limit");
    expect(rendererSource).toContain("data-access-policy-requests-per-minute");
    expect(rendererSource).toContain("data-access-policy-max-concurrent");
    expect(rendererSource).toContain("data-access-policy-model-aliases");
    expect(rendererSource).toContain("data-access-policy-save-settings");
    expect(rendererSource).toContain("rotateAccessKey");
    expect(rendererSource).toContain("saveAccessKeyExpiry");
    expect(rendererSource).toContain("saveAccessPolicySettings");
    expect(rendererSource).toContain("saveAccessPolicyPools");
    expect(rendererSource).toContain("renderAccessPolicyUsageSnapshot");
    expect(rendererSource).toContain("renderAccessPolicyRuntimeSnapshot");
    expect(rendererSource).toContain("buildAccessPolicyUsageSnapshot");
    expect(rendererSource).toContain("buildAccessPolicyRuntimeSnapshot");
    expect(rendererSource).toContain("buildAccessPolicyAlertRules");
    expect(rendererSource).toContain("buildAccessPolicyErrorSummaryRule");
    expect(rendererSource).toContain("dailyTokenLimit");
    expect(rendererSource).toContain("requestsPerMinute");
    expect(rendererSource).toContain("maxConcurrentRequests");
  });

  it("renders the phase two account assets ownership skeleton", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );

    const accountsView = indexHtml.match(
      /<div class="view" data-view="accounts" hidden>([\s\S]*?)<!-- View: Models & Providers -->/,
    )?.[1];

    expect(accountsView).toBeTruthy();
    expect(accountsView).toContain("id=\"accounts-source-ownership-alert\"");
    expect(accountsView).toContain("data-account-source=\"managed\"");
    expect(accountsView).toContain("data-account-source=\"external-readonly\"");
    expect(accountsView).toContain("id=\"account-assets-table-shell\"");
    expect(accountsView).toContain("id=\"account-detail-drawer\"");
    expect(accountsView).toContain("删除本地副本");
  });

  it("uses Figma hooks for the pools and routing workbench", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const poolsView = indexHtml.match(
      /<div class="view" data-view="pools" hidden>([\s\S]*?)<!-- View: System & Diagnostics -->/,
    )?.[1];

    expect(poolsView).toBeTruthy();
    expect(poolsView).toContain("class=\"pool-route-workbench\"");
    expect(poolsView).toContain("class=\"card pool-control-panel\"");
    expect(poolsView).toContain("class=\"pool-list-shell table-container-lite\"");
    expect(poolsView).toContain("id=\"pool-list\"");
    expect(rendererSource).toContain("pool-config-card detail-drawer-panel");
    expect(rendererSource).toContain("card-header pool-card-header");
    expect(rendererSource).toContain("pool-config-form-grid");
    expect(rendererSource).toContain("pool-member-table-shell");
    expect(rendererSource).toContain("pool-card-actions");
    expect(rendererSource).toContain('data-field="pool-visibility"');
    expect(rendererSource).toContain('visibility: "private"');
    expect(styles).toContain(".pool-route-workbench {");
    expect(styles).toContain(".pool-control-panel {");
    expect(styles).toContain(".pool-list-shell {");
    expect(styles).toContain(".pool-card-header {");
    expect(styles).toContain(".pool-card-title-text {");
    expect(styles).toContain(".pool-config-form-grid {");
    expect(styles).toContain(".pool-member-table-shell {");
    expect(styles).toContain(".pool-card-header,");
  });

  it("uses Figma hooks for the models and providers workbench", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const modelsView = indexHtml.match(
      /<div class="view" data-view="models" hidden>([\s\S]*?)<!-- View: Usage & Alerts -->/,
    )?.[1];

    expect(modelsView).toBeTruthy();
    expect(modelsView).toContain("class=\"model-provider-workbench\"");
    expect(modelsView).toContain("class=\"card provider-config-panel provider-codex-panel\"");
    expect(modelsView).toContain("class=\"card provider-config-panel provider-extension-panel\"");
    expect(modelsView).toContain("class=\"provider-config-form-grid\"");
    expect(modelsView).toContain("class=\"provider-registry-shell table-container-lite\"");
    expect(modelsView).toContain("id=\"provider-registry\"");
    expect(rendererSource).toContain("class=\"figma-table provider-registry-table\"");
    expect(rendererSource).toContain("class=\"figma-table-row provider-registry-row");
    expect(rendererSource).toContain("provider-registry-models-cell");
    expect(styles).toContain(".model-provider-workbench {");
    expect(styles).toContain(".provider-config-panel {");
    expect(styles).toContain(".provider-config-form-grid {");
    expect(styles).toContain(".provider-registry-table {");
    expect(styles).toContain(".provider-registry-row {");
  });

  it("renders LAN access controls with api key safety copy", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );

    const systemView = indexHtml.match(
      /<div class="view" data-view="system" hidden>([\s\S]*?)<\/main>/,
    )?.[1];

    expect(systemView).toBeTruthy();
    expect(systemView).toContain("id=\"gateway-lan-access-enabled\"");
    expect(systemView).toContain("启用局域网共享");
    expect(systemView).toContain("LAN 共享必须启用 API Key 鉴权");
  });

  it("uses Figma hooks for the system diagnostics workbench", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const systemView = indexHtml.match(
      /<div class="view" data-view="system" hidden>([\s\S]*?)<\/main>/,
    )?.[1];

    expect(systemView).toBeTruthy();
    expect(systemView).toContain("class=\"system-diagnostics-workbench\"");
    expect(systemView).toContain("class=\"card system-config-panel\"");
    expect(systemView).toContain("class=\"system-config-form-grid\"");
    expect(systemView).toContain("class=\"diagnostics-shell table-container-lite\"");
    expect(systemView).toContain("id=\"service-diagnostics\"");
    expect(systemView).toContain("id=\"provider-diagnostics\"");
    expect(systemView).toContain("id=\"recent-errors\"");
    expect(rendererSource).toContain("diagnostic-card detail-drawer-panel");
    expect(rendererSource).toContain("diagnostic-card-header");
    expect(rendererSource).toContain("diagnostic-fact-grid");
    expect(rendererSource).toContain("recent-error-card");
    expect(styles).toContain(".system-diagnostics-workbench {");
    expect(styles).toContain(".system-config-panel {");
    expect(styles).toContain(".system-config-form-grid {");
    expect(styles).toContain(".diagnostics-shell {");
    expect(styles).toContain(".diagnostic-card {");
  });

  it("uses Figma hooks for the usage and alerts workbench", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const preloadSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/preload.ts"),
      "utf8",
    );
    const mainSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/main.ts"),
      "utf8",
    );

    const usageView = indexHtml.match(
      /<div class="view" data-view="usage" hidden>([\s\S]*?)<!-- View: Routing -->/,
    )?.[1];

    expect(usageView).toBeTruthy();
    expect(usageView).toContain("class=\"usage-alerts-workbench\"");
    expect(usageView).toContain("class=\"usage-chart-panel\"");
    expect(usageView).toContain("class=\"usage-chart-frame\"");
    expect(usageView).toContain("窗口用量结构");
    expect(usageView).toContain("id=\"usage-trend-chart\"");
    expect(usageView).toContain("id=\"usage-dimension-insights\"");
    expect(usageView).toContain("id=\"usage-alert-rule-list\"");
    expect(usageView).toContain("class=\"usage-dimension-grid\"");
    expect(usageView).toContain("class=\"usage-alert-rule-list\"");
    expect(rendererSource).toContain("renderUsageWorkbench");
    expect(rendererSource).toContain("renderUsageTrendChart");
    expect(rendererSource).toContain("renderUsageConsumerTimelineChart");
    expect(rendererSource).toContain("consumerTimeline");
    expect(rendererSource).toContain("renderUsageDimensionInsights");
    expect(rendererSource).toContain("getAccessAlerts");
    expect(rendererSource).toContain("acknowledgeAccessAlert");
    expect(rendererSource).toContain("acknowledgeAllAccessAlerts");
    expect(rendererSource).toContain("data-action=\"ack-access-alert\"");
    expect(rendererSource).toContain("data-action=\"ack-all-access-alerts\"");
    expect(rendererSource).toContain("acknowledgedAt");
    expect(rendererSource).toContain("正式告警事件");
    expect(rendererSource).toContain("访问成员排行");
    expect(rendererSource).toContain("Access Key 排行");
    expect(rendererSource).toContain("号池排行");
    expect(rendererSource).toContain("summary.consumers.map");
    expect(rendererSource).toContain("summary.accessKeys.map");
    expect(rendererSource).toContain("(summary.pools ?? []).map");
    expect(rendererSource).toContain("class=\"usage-insight-card\"");
    expect(preloadSource).toContain("acknowledgeAccessAlert");
    expect(preloadSource).toContain("acknowledgeAllAccessAlerts");
    expect(mainSource).toContain("gateway:acknowledge-access-alert");
    expect(mainSource).toContain("gateway:acknowledge-all-access-alerts");
    expect(mainSource).toContain("/admin/access/alerts/acknowledge-all");
    expect(mainSource).toContain("/admin/access/alerts/");
    expect(styles).toContain(".usage-alerts-workbench {");
    expect(styles).toContain(".usage-chart-panel {");
    expect(styles).toContain(".usage-chart-frame {");
    expect(styles).toContain(".usage-chart-bars {");
    expect(styles).toContain(".usage-timeline-bars {");
    expect(styles).toContain(".usage-alert-rule em {");
    expect(styles).toContain("justify-self: end;");
    expect(styles).toContain(".usage-dimension-grid {");
    expect(styles).toContain(".usage-alert-rule-list {");
  });

  it(
    "does not leave unresolved workspace imports in renderer output",
    () => {
    execFileSync("npx", ["tsc", "-b", "apps/desktop", "--force"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const rendererOutput = readFileSync(
      resolve(process.cwd(), "apps/desktop/dist/renderer.js"),
      "utf8",
    );

    expect(rendererOutput).not.toMatch(/from "@local-ai-gateway\//);
    },
    15_000,
  );

  it(
    "does not keep packaged gateway startup on ELECTRON_RUN_AS_NODE child mode",
    () => {
      execFileSync("npx", ["tsc", "-b", "apps/desktop", "--force"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });

      const mainOutput = readFileSync(
        resolve(process.cwd(), "apps/desktop/dist/main.js"),
        "utf8",
      );

      expect(mainOutput).not.toContain("ELECTRON_RUN_AS_NODE");
      expect(mainOutput).toContain("gateway/dist/server.js");
      expect(mainOutput).toContain("startGatewayServer");
    },
    15_000,
  );
});
