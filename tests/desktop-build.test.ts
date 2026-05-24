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

  it("uses the shared-gateway navigation structure", () => {
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
      ["notifications", "消息通知"],
      ["operations", "运维与日志"],
      ["system", "系统与诊断"],
    ];

    const navGroup = indexHtml.match(
      /<div class="nav-group">([\s\S]*?)<\/div>\s*<div class="sidebar-foot">/,
    )?.[1];

    expect(navGroup).toBeTruthy();
    expect(navGroup?.match(/data-nav-target="/g) ?? []).toHaveLength(9);

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
    expect(navGroup?.match(/<svg class="nav-icon-svg"/g) ?? []).toHaveLength(9);
    expect(navGroup?.match(/aria-hidden="true"/g) ?? []).toHaveLength(9);
    expect(navGroup).not.toContain('<span class="nav-icon">总</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">钥</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">账</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">池</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">模</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">量</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">消</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">运</span>');
    expect(navGroup).not.toContain('<span class="nav-icon">诊</span>');

    expect(indexHtml).toContain("class=\"account-assets-shell table-container-lite\"");
    expect(indexHtml).toContain("id=\"access-member-key-management-section\"");
    expect(indexHtml).toContain("class=\"card account-detail-drawer detail-drawer-panel mt-4\"");
    expect(indexHtml).toContain("id=\"access-create-member-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal access-create-member-modal\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal\"");
    expect(indexHtml).toContain("class=\"modal-tabs figma-tabs\"");
    expect(styles).toContain(".secret-inline-row .input-field");
    expect(styles).toContain(".detail-drawer-panel,");
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain(".modal-content.access-create-member-modal");
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
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    expect(rendererSource).toContain("class=\"figma-table access-consumer-table\"");
    expect(rendererSource).toContain("class=\"figma-table-head access-consumer-table-head\"");
    expect(rendererSource).toContain("class=\"figma-table-row access-consumer-row\"");
    expect(rendererSource).toContain("access-consumer-actions-cell");
    expect(rendererSource).toContain("创建时间");
    expect(rendererSource).toContain("更新时间");
    expect(rendererSource).toContain("data-access-member-toggle");
    expect(rendererSource).toContain(">编辑</button>");
    expect(rendererSource).not.toContain("查看/编辑");
    expect(rendererSource).toContain("class=\"figma-table account-assets-table\"");
    expect(rendererSource).toContain("class=\"figma-table-head account-assets-table-head\"");
    expect(rendererSource).toContain("account-assets-table-row");
    expect(rendererSource).toContain("account-assets-main-cell");
    expect(rendererSource).toContain("account-assets-ownership-cell");
    expect(rendererSource).toContain("account-assets-usage-cell");
    expect(rendererSource).toContain("account-assets-actions-cell");
    expect(rendererSource).toContain("同步额度（不刷新 refresh token）");
    expect(rendererSource).toContain("shouldProtectAccessDraftFromLiveRefresh");
    expect(rendererSource).toContain("markAccessDraftDirtyFromElement");
    expect(rendererSource).toContain("SESSION_ACTIVITY_REFRESH_INTERVAL_MS = 30_000");
    expect(indexHtml).toContain("id=\"refresh-accounts\">同步额度</button>");
    expect(styles).toContain(".figma-table {");
    expect(styles).toContain(".figma-table-head {");
    expect(styles).toContain(".figma-table-row {");
    expect(styles).toContain(".account-assets-table {");
    expect(styles).toContain(".account-assets-table .account-assets-table-row {");
    expect(styles).toContain(".account-assets-table-row > .figma-table-cell {");
    expect(styles).toContain(".account-assets-actions-cell .icon-btn[data-tooltip]::after");
    expect(styles).toContain(".access-consumer-table {");
    expect(styles).toContain("min-width: 1240px;");
    expect(styles).toContain(".access-consumer-actions-cell {");
    expect(styles).toContain("position: sticky;");
    expect(styles).toContain("right: 0;");
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
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const accessView = indexHtml.match(
      /<div class="view" data-view="access" hidden>([\s\S]*?)<!-- View: Accounts -->/,
    )?.[1];

    expect(accessView).toBeTruthy();
    expect(accessView).toContain("data-access-surface=\"local\"");
    expect(accessView).toContain("data-access-surface=\"lan\"");
    expect(accessView).toContain("data-access-surface=\"public\"");
    expect(accessView).not.toContain("待接入");
    expect(accessView).toContain("id=\"access-consumer-list\"");
    expect(accessView).toContain("id=\"access-policy-preview\"");
    expect(accessView).toContain("访问策略摘要");
    expect(accessView).not.toContain("成员级额度、模型权限和号池授权将在后续切片接入。");
    expect(accessView).not.toContain("id=\"access-member-drawer\"");
    expect(accessView).not.toContain("id=\"access-create-member-modal\"");
    expect(indexHtml).toContain("id=\"account-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"confirm-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"pool-events-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"usage-details-modal\" class=\"modal-overlay\"");
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
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const accessView = indexHtml.match(
      /<div class="view" data-view="access" hidden>([\s\S]*?)<!-- View: Accounts -->/,
    )?.[1];

    expect(accessView).toBeTruthy();
    expect(accessView).toContain("id=\"access-create-member-button\"");
    expect(accessView).not.toContain("id=\"access-create-member-button\" type=\"button\" disabled");
    expect(accessView).not.toContain("id=\"access-member-name\"");
    expect(indexHtml).toContain("id=\"access-create-member-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal access-create-member-modal\"");
    expect(indexHtml).toContain("id=\"access-member-name\"");
    expect(indexHtml).toContain("id=\"access-member-client-tag\"");
    expect(indexHtml).toContain("access-member-identity-section");
    expect(indexHtml).toContain("access-member-identity-grid");
    expect(indexHtml).toContain("id=\"access-member-quota-mode\"");
    expect(indexHtml).toContain("access-member-quota-grid");
    expect(indexHtml).toContain("quota-fields-panel");
    expect(indexHtml).toContain("quota-inline-fields");
    expect(indexHtml).toContain("quota-description");
    expect(indexHtml).toContain("<option value=\"period\">周期包</option>");
    expect(indexHtml).toContain("<option value=\"total\">总量包</option>");
    expect(indexHtml).toContain("<option value=\"none\">不限制</option>");
    expect(indexHtml).not.toContain("周期包：x 天共 xx M Token");
    expect(indexHtml).toContain("id=\"access-member-period-days\"");
    expect(indexHtml).toContain("id=\"access-member-period-token-limit\"");
    expect(indexHtml).toContain("id=\"access-member-period-token-unit\"");
    expect(indexHtml).toContain("id=\"access-member-total-token-limit\"");
    expect(indexHtml).toContain("data-quota-mode-panel=\"period\"");
    expect(indexHtml).toContain("data-quota-mode-panel=\"total\"");
    expect(indexHtml).toContain("<option value=\"M\">M</option>");
    expect(indexHtml).toContain("id=\"create-access-member-submit\"");
    expect(indexHtml).toContain("id=\"access-member-one-time-key\"");
    expect(indexHtml).toContain("class=\"input-field one-time-key-input\"");
    expect(indexHtml).toContain("id=\"access-member-save-state\"");
    expect(indexHtml).toContain("id=\"toggle-access-member-key-visibility\"");
    expect(indexHtml).toContain("id=\"copy-access-member-key\"");
    expect(styles).toContain(".access-member-identity-section");
    expect(styles).toContain(".access-member-identity-grid");
    expect(styles).toContain(".access-member-quota-grid");
    expect(styles).toContain(".quota-fields-panel");
    expect(styles).toContain(".quota-inline-fields");
    expect(styles).toContain(".quota-description");
  });

  it("renders selectable model aliases for access members while preserving custom input", () => {
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

    expect(indexHtml).toContain("id=\"access-member-model-alias-options\"");
    expect(indexHtml).toContain("data-access-member-model-alias-options");
    expect(indexHtml).toContain("自选已暴露模型");
    expect(indexHtml).toContain("自定义模型别名");
    expect(indexHtml).toContain("id=\"access-member-model-aliases\"");
    expect(rendererSource).toContain("function getAvailableModelAliases");
    expect(rendererSource).toContain("function getRecommendedModelAlias");
    expect(rendererSource).toContain("renderAccessMemberModelAliasOptions");
    expect(rendererSource).toContain("data-access-member-model-alias-option");
    expect(rendererSource).toContain("getSelectedAccessMemberModelAliases");
    expect(rendererSource).toContain("getCustomAccessMemberModelAliases");
    expect(styles).toContain(".model-alias-option-list");
    expect(styles).toContain(".model-alias-option");
  });

  it("uses current model aliases in LAN and copied integration snippets", () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const mainSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/main.ts"),
      "utf8",
    );

    expect(rendererSource).toContain("推荐 Model");
    expect(rendererSource).toContain("可用模型别名");
    expect(rendererSource).toContain("getAvailableModelAliases()");
    expect(rendererSource).toContain("getRecommendedModelAlias()");
    expect(rendererSource).toContain("model: ${recommendedModel}");
    expect(rendererSource).toContain("allowedModelAliases");
    expect(mainSource).toContain("defaultModel?: string");
    expect(mainSource).toContain("payload.openclaw?.model ?? payload.defaultModel");
    expect(mainSource).toContain("apiKey=<你的 Gateway API Key 或成员 API Key>");
    expect(mainSource).not.toContain("apiKey=<你的 Local AI Gateway API Key>");
  });

  it("renders access member detail and key management hooks", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    const accessView = indexHtml.match(
      /<div class="view" data-view="access" hidden>([\s\S]*?)<!-- View: Accounts -->/,
    )?.[1];

    expect(accessView).toBeTruthy();
    expect(indexHtml).toContain("id=\"access-member-modal-title\"");
    expect(indexHtml).toContain("id=\"access-member-modal-key-list\"");
    expect(indexHtml).toContain("id=\"access-member-create-extra-key\"");
    expect(indexHtml).toContain("id=\"access-member-new-key-name\"");
    expect(indexHtml).toContain("class=\"access-key-manager-grid\"");
    expect(indexHtml).toContain("class=\"access-key-create-panel\"");
    expect(indexHtml).toContain("class=\"access-key-create-form\"");
    expect(indexHtml).toContain("本次生成的 Key 明文");
    expect(indexHtml).toContain("id=\"access-member-pool-list\"");
    expect(indexHtml).toContain("id=\"access-member-quota-mode\"");
    expect(indexHtml).toContain("id=\"access-member-period-days\"");
    expect(indexHtml).toContain("id=\"access-member-period-token-limit\"");
    expect(styles).toContain(".access-key-row {");
    expect(styles).toContain("grid-template-columns: 1fr;");
    expect(styles).toContain(".access-key-create-form");
    expect(styles).toContain(".access-key-create-form .btn");
  });

  it("renders member-first request audit controls and stronger operations cards", () => {
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

    const operationsView = indexHtml.match(
      /<div class="view" data-view="operations" hidden>([\s\S]*?)<!-- View: System & Diagnostics -->/,
    )?.[1];
    const requestAuditToolbar = operationsView?.match(
      /<div class="ops-audit-toolbar">([\s\S]*?)<\/div>\s*<div id="request-audit-member-focus">/,
    )?.[1];

    expect(operationsView).toBeTruthy();
    expect(operationsView).toContain('data-action="gateway-service-restart"');
    expect(operationsView).toContain('data-action="cloudflare-service-restart"');
    expect(operationsView).toContain('data-action="copy-public-snippet"');
    expect(operationsView).toContain("高级服务控制");
    const advancedControlPanel = operationsView?.match(
      /<div class="card ops-control-panel">([\s\S]*?)<\/div>\s*<div id="ops-control-result"/,
    )?.[1];
    expect(advancedControlPanel).toBeTruthy();
    expect(advancedControlPanel).not.toContain('data-action="gateway-service-restart"');
    expect(advancedControlPanel).not.toContain('data-action="cloudflare-service-restart"');
    expect(advancedControlPanel).not.toContain('data-action="copy-public-snippet"');
    expect(requestAuditToolbar).toBeTruthy();
    expect(requestAuditToolbar?.indexOf('id="request-audit-consumer"')).toBeLessThan(
      requestAuditToolbar?.indexOf('id="request-audit-status"') ?? Number.MAX_SAFE_INTEGER,
    );
    expect(indexHtml).toContain('id="request-audit-member-focus"');
    expect(rendererSource).toContain("function buildAuditConsumerOptions");
    expect(rendererSource).toContain("function buildAuditAccessKeyOptions");
    expect(rendererSource).toContain("function scheduleRequestAuditRefresh");
    expect(rendererSource).toContain("request-audit-consumer");
    expect(rendererSource).toContain("renderRequestAuditMemberFocus");
    expect(styles).toContain("--card-border: #cfd8e6");
    expect(styles).toContain("--card-shadow-hover:");
    expect(styles).toContain(".ops-audit-member-focus");
    expect(styles).toContain(".notification-summary-card:hover");
    expect(styles).toContain(".system-status-strip .startup-check-item:hover");
    expect(styles).toContain("#ops-cloudflare-status");
    expect(styles).toContain(".notification-summary-card.tone-danger");
    expect(styles).toContain(".inline-help::after");
    expect(styles).toContain(".inline-page-note");
  });

  it("binds access member detail actions in the renderer", () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );

    expect(rendererSource).toContain("data-access-member-select");
    expect(rendererSource).toContain("data-access-member-toggle");
    expect(rendererSource).toContain("data-access-member-delete");
    expect(rendererSource).toContain("data-access-key-toggle");
    expect(rendererSource).toContain("data-access-key-rotate");
    expect(rendererSource).toContain("data-access-key-expiry");
    expect(rendererSource).toContain("data-access-key-save-expiry");
    expect(rendererSource).toContain("data-access-member-pool");
    expect(rendererSource).toContain("collectAccessMemberPolicyInput");
    expect(rendererSource).toContain("parseTokenLimitMillionsInput");
    expect(rendererSource).toContain("resolveAccessMemberQuotaMode");
    expect(rendererSource).toContain("data-quota-mode-panel");
    expect(rendererSource).toContain("access-member-quota-mode");
    expect(rendererSource).toContain("access-member-period-days");
    expect(rendererSource).toContain("access-member-period-token-limit");
    expect(rendererSource).toContain("access-member-requests-per-minute");
    expect(rendererSource).toContain("access-member-max-concurrent");
    expect(rendererSource).toContain("access-member-max-input-tokens");
    expect(rendererSource).toContain("access-member-max-output-tokens");
    expect(rendererSource).toContain("access-member-total-token-limit");
    expect(rendererSource).toContain("access-member-policy-expires-at");
    expect(rendererSource).toContain("access-member-model-aliases");
    expect(rendererSource).toContain("access-member-new-key-name");
    expect(rendererSource).toContain("access-member-new-key-expires-at");
    expect(rendererSource).toContain("data-access-key-create");
    expect(rendererSource).toContain("data-access-key-delete");
    expect(rendererSource).toContain("deleteAccessConsumer");
    expect(rendererSource).toContain("deleteAccessKey");
    expect(rendererSource).toContain("rotateAccessKey");
    expect(rendererSource).toContain("createAccessKeyForConsumer");
    expect(rendererSource).toContain("saveAccessConsumerBasics");
    expect(rendererSource).toContain("saveAccessKeyExpiry");
    expect(rendererSource).toContain("saveAccessPolicySettings");
    expect(rendererSource).toContain("saveAccessPolicyPools");
    expect(rendererSource).toContain("renderAccessPolicyUsageSnapshot");
    expect(rendererSource).toContain("renderAccessPolicyRuntimeSnapshot");
    expect(rendererSource).toContain("buildAccessPolicyUsageSnapshot");
    expect(rendererSource).toContain("buildAccessPolicyRuntimeSnapshot");
    expect(rendererSource).toContain("buildAccessPolicyAlertRules");
    expect(rendererSource).toContain("buildAccessPolicyErrorSummaryRule");
    expect(rendererSource).toContain("focusName?: boolean");
    expect(rendererSource).toContain("preserveScroll?: boolean");
    expect(rendererSource).toContain("setAccessMemberModalSaveState");
    expect(rendererSource).toContain("if (apiKey) {");
    expect(rendererSource).toContain("closeAccessMemberModal();");
    expect(rendererSource).toContain("openAccessMemberModal(memberSelectTrigger.dataset.accessMemberSelect, {");
    expect(rendererSource).toContain("openAccessMemberModal(target.dataset.accessMemberSelect, {");
    expect(rendererSource).toContain("focusName: false");
    expect(rendererSource).not.toContain(")?.focus();");
    expect(rendererSource).toContain("periodDays");
    expect(rendererSource).toContain("periodTokenLimit");
    expect(rendererSource).toContain("periodStartedAt");
    expect(rendererSource).toContain("dailyTokenLimit");
    expect(rendererSource).toContain("monthlyTokenLimit");
    expect(rendererSource).toContain("totalTokenLimit");
    expect(rendererSource).toContain("requestsPerMinute");
    expect(rendererSource).toContain("maxConcurrentRequests");
    expect(rendererSource).toContain("maxInputTokens");
    expect(rendererSource).toContain("maxOutputTokens");
  });

  it("renders hot-effective access policy summary hooks", () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );
    const styleSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/styles.css"),
      "utf8",
    );

    expect(rendererSource).toContain("LAN URL 随健康检查刷新");
    expect(rendererSource).toContain("配置保存后热生效");
    expect(rendererSource).toContain("周期包");
    expect(rendererSource).toContain("总量包");
    expect(rendererSource).not.toContain("兼容客户端 key");
    expect(styleSource).toContain("access-policy-item-grid");
  });

  it("keeps access control out of the generic security save payload", () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );

    const saveSecuritySettingsBody = rendererSource.match(
      /async function saveSecuritySettings\(\): Promise<SecuritySettings> \{([\s\S]*?)\nasync function saveSystemAndSecuritySettings/,
    )?.[1];

    expect(saveSecuritySettingsBody).toBeTruthy();
    expect(saveSecuritySettingsBody).not.toContain("accessControl:");
    expect(saveSecuritySettingsBody).toContain("publicAccess:");
    expect(saveSecuritySettingsBody).toContain("lanAccess:");
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
      /<div class="view" data-view="pools" hidden>([\s\S]*?)<!-- View: Operations -->/,
    )?.[1];

    expect(poolsView).toBeTruthy();
    expect(poolsView).toContain("class=\"pool-route-workbench\"");
    expect(poolsView).toContain("class=\"card pool-control-panel\"");
    expect(poolsView).toContain("class=\"pool-list-shell table-container-lite\"");
    expect(poolsView).toContain("id=\"pool-list\"");
    expect(poolsView).not.toContain("保存号池配置");
    expect(poolsView).toContain("id=\"save-pool-settings\" class=\"btn secondary mini\"");
    expect(poolsView).toContain("保存调度开关");
    expect(indexHtml).toContain("id=\"pool-config-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal pool-config-modal\"");
    expect(indexHtml).toContain("id=\"pool-config-modal-title\"");
    expect(indexHtml).toContain("id=\"save-pool-config-modal\"");
    expect(indexHtml).toContain("直接保存到网关");
    expect(rendererSource).toContain("openPoolConfigModal");
    expect(rendererSource).toContain("closePoolConfigModal");
    expect(rendererSource).toContain("persistPoolSettingsFromState");
    expect(rendererSource).toContain("await savePoolConfigModalDraft");
    expect(rendererSource).toContain("创建并保存");
    expect(rendererSource).not.toContain("保存到编辑态");
    expect(rendererSource).not.toContain("saveSinglePoolSettings");
    expect(rendererSource).not.toContain("save-pool-card");
    expect(rendererSource).toContain("pool-list-table");
    expect(rendererSource).toContain("pool-list-row");
    expect(rendererSource).toContain("pool-config-modal-grid");
    expect(rendererSource).toContain("pool-config-section pool-config-basic-section");
    expect(rendererSource).toContain("pool-config-section pool-config-guard-section");
    expect(rendererSource).not.toContain("pool-member-scroll-panel");
    expect(rendererSource).toContain("pool-member-option compact-pool-member-option");
    expect(rendererSource).toContain("data-action=\"pool-edit\"");
    expect(rendererSource).toContain("pool-config-form-grid");
    expect(rendererSource).toContain("pool-member-table-shell");
    expect(rendererSource).toContain("pool-card-actions");
    expect(rendererSource).toContain('data-field="pool-visibility"');
    expect(rendererSource).toContain('visibility: "private"');
    expect(styles).toContain(".pool-route-workbench {");
    expect(styles).toContain(".pool-control-panel {");
    expect(styles).toContain(".pool-list-shell {");
    expect(styles).toContain(".pool-list-table {");
    expect(styles).toContain("overflow-x: auto;");
    expect(styles).toContain(".pool-list-row {");
    expect(styles).toContain(".pool-config-modal {");
    expect(styles).toContain("width: min(1480px, calc(100vw - 40px));");
    expect(styles).toContain(".pool-config-modal-layout {");
    expect(styles).toContain(".pool-config-modal-grid {");
    expect(styles).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
    expect(styles).toContain(".pool-config-fields-grid .form-field.span-4 {");
    expect(styles).toContain(".pool-config-switch-grid .switch-label {");
    expect(styles).toContain(".pool-card-header {");
    expect(styles).toContain(".pool-card-title-text {");
    expect(styles).toContain(".pool-config-form-grid {");
    expect(styles).toContain(".pool-member-table-shell {");
    expect(styles).not.toContain(".pool-member-scroll-panel {");
    expect(styles).toContain(".compact-pool-member-option {");
    expect(styles).toContain(".pool-card-header,");
  });

  it("renders the operations and logs workbench with service controls", () => {
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
    const preloadSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/preload.ts"),
      "utf8",
    );
    const staticPreloadSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/preload.cjs"),
      "utf8",
    );
    const mainSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/main.ts"),
      "utf8",
    );

    const operationsView = indexHtml.match(
      /<div class="view" data-view="operations" hidden>([\s\S]*?)<!-- View: System & Diagnostics -->/,
    )?.[1];

    expect(operationsView).toBeTruthy();
    expect(operationsView).toContain("class=\"operations-workbench\"");
    expect(operationsView).toContain("id=\"ops-gateway-status\"");
    expect(operationsView).toContain("id=\"ops-cloudflare-status\"");
    expect(operationsView).toContain("id=\"ops-log-source\"");
    expect(operationsView).toContain("id=\"ops-log-output\"");
    expect(operationsView).toContain("data-action=\"gateway-service-install\"");
    expect(operationsView).toContain("data-action=\"gateway-service-start\"");
    expect(operationsView).toContain("data-action=\"gateway-service-stop\"");
    expect(operationsView).toContain("data-action=\"gateway-service-restart\"");
    expect(operationsView).toContain("data-action=\"repair-public-gateway\"");
    expect(operationsView).toContain("data-action=\"cloudflare-service-restart\"");
    expect(rendererSource).toContain("type OperationsStatus");
    expect(rendererSource).toContain("renderOperations");
    expect(rendererSource).toContain("refreshOperationsStatus");
    expect(rendererSource).toContain("readOperationsLog");
    expect(rendererSource).toContain("controlGatewayService");
    expect(rendererSource).toContain("controlCloudflareService");
    expect(rendererSource).toContain("repairPublicGateway");
    expect(rendererSource).toContain("buildPublicIntegrationSnippet");
    expect(preloadSource).toContain("getOperationsStatus");
    expect(preloadSource).toContain("readOperationsLog");
    expect(preloadSource).toContain("controlGatewayService");
    expect(preloadSource).toContain("controlCloudflareService");
    expect(preloadSource).toContain("repairPublicGateway");
    expect(staticPreloadSource).toContain("getOperationsStatus");
    expect(staticPreloadSource).toContain("readOperationsLog");
    expect(staticPreloadSource).toContain("controlGatewayService");
    expect(staticPreloadSource).toContain("controlCloudflareService");
    expect(staticPreloadSource).toContain("repairPublicGateway");
    expect(mainSource).toContain("com.local-ai-gateway.gateway");
    expect(mainSource).toContain("gateway:get-operations-status");
    expect(mainSource).toContain("gateway:read-operations-log");
    expect(mainSource).toContain("gateway:control-gateway-service");
    expect(mainSource).toContain("gateway:control-cloudflare-service");
    expect(mainSource).toContain("gateway:repair-public-gateway");
    expect(styles).toContain(".operations-workbench {");
    expect(styles).toContain(".ops-status-grid {");
    expect(styles).toContain(".ops-log-viewer {");
    expect(styles).toContain(".ops-log-output {");
  });

  it("removes stale phase labels from active UI copy", () => {
    const indexHtml = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/index.html"),
      "utf8",
    );
    const rendererSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer.ts"),
      "utf8",
    );

    for (const source of [indexHtml, rendererSource]) {
      expect(source).not.toContain("二期可用");
      expect(source).not.toContain("三期可用");
      expect(source).not.toContain("三期预留");
      expect(source).not.toContain("二期开发入口");
      expect(source).not.toContain("三期预留入口");
      expect(source).not.toContain("待 server edition");
    }
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
    expect(modelsView).toContain("class=\"provider-config-grid\"");
    expect(modelsView).toContain("class=\"card provider-config-panel provider-codex-panel provider-hero-panel\"");
    expect(modelsView).toContain("class=\"provider-panel-status-strip\"");
    expect(modelsView).toContain("class=\"provider-form-section\"");
    expect(modelsView).toContain("class=\"provider-extension-grid\"");
    expect(modelsView).toContain("class=\"provider-config-form-grid\"");
    expect(modelsView).toContain("class=\"provider-registry-shell table-container-lite\"");
    expect(modelsView).toContain("id=\"provider-registry\"");
    expect(rendererSource).toContain("class=\"provider-registry-row-list\"");
    expect(rendererSource).toContain("class=\"provider-registry-row");
    expect(rendererSource).toContain("provider-registry-card-head");
    expect(rendererSource).toContain("provider-registry-models-cell");
    expect(styles).toContain(".model-provider-workbench {");
    expect(styles).toContain(".provider-config-grid {");
    expect(styles).toContain(".provider-hero-panel {");
    expect(styles).toContain(".provider-panel-status-strip {");
    expect(styles).toContain(".provider-form-section {");
    expect(styles).toContain(".provider-extension-grid {");
    expect(styles).toContain(".provider-config-panel {");
    expect(styles).toContain(".provider-config-form-grid {");
    expect(styles).toContain(".provider-registry-summary-grid {");
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
    expect(systemView).toContain("保存本页配置");
    expect(systemView).toContain("访问成员 Key");
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
    const runtimeDiagnosticsSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/runtime-diagnostics.ts"),
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
    expect(systemView).toContain("class=\"system-config-layout\"");
    expect(systemView).toContain("class=\"system-config-fieldset\"");
    expect(systemView).toContain("class=\"system-status-strip\"");
    expect(systemView).toContain("class=\"system-action-grid\"");
    expect(systemView).toContain("class=\"diagnostics-shell table-container-lite\"");
    expect(systemView).toContain("id=\"service-diagnostics\"");
    expect(systemView).toContain("id=\"provider-diagnostics\"");
    expect(systemView).toContain("id=\"recent-errors\"");
    expect(systemView).toContain("data-action=\"open-system-modal\"");
    expect(systemView).not.toContain("id=\"system-lan-template-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"system-lan-template-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"system-public-template-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"system-public-validation-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"system-troubleshooting-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal system-diagnostics-modal\"");
    expect(indexHtml).toContain("data-action=\"close-system-modal\"");
    expect(systemView).toContain("id=\"gateway-public-access-enabled\"");
    expect(systemView).toContain("id=\"gateway-public-access-provider\"");
    expect(systemView).toContain("id=\"gateway-public-base-url\"");
    expect(systemView).toContain("id=\"gateway-public-tunnel-name\"");
    expect(systemView).toContain("id=\"gateway-public-hostname\"");
    expect(rendererSource).toContain("diagnostic-card detail-drawer-panel");
    expect(rendererSource).toContain("diagnostic-card-header");
    expect(rendererSource).toContain("diagnostic-fact-grid");
    expect(rendererSource).toContain("renderLanAccessTemplate");
    expect(rendererSource).toContain("renderPublicAccessTemplate");
    expect(rendererSource).toContain("renderPublicValidationChecklist");
    expect(rendererSource).toContain("renderRuntimeTroubleshootingGuide");
    expect(rendererSource).toContain("openSystemDiagnosticsModal");
    expect(rendererSource).toContain("closeSystemDiagnosticsModal");
    expect(rendererSource).toContain("saveSystemAndSecuritySettings");
    expect(rendererSource).toContain("hasAnyInferenceCredential");
    expect(rendererSource).toContain("setModeCardStatus");
    expect(rendererSource).toContain("LAN 成员设备访问不通");
    expect(rendererSource).toContain("401 / 403 鉴权失败");
    expect(rendererSource).toContain("copy-lan-access-template");
    expect(rendererSource).toContain("copy-public-access-template");
    expect(rendererSource).toContain("copy-public-validation-command");
    expect(rendererSource).toContain("toggle-public-validation-check");
    expect(rendererSource).toContain("公网外部验收清单");
    expect(rendererSource).toContain("公网 /v1/models 验收");
    expect(rendererSource).toContain("公网非流式对话验收");
    expect(rendererSource).toContain("公网 stream: true 验收");
    expect(rendererSource).toContain("cc_switch");
    expect(rendererSource).toContain("自定义 Provider");
    expect(rendererSource).toContain("recent-error-card");
    expect(runtimeDiagnosticsSource).toContain("lan-sharing-ready");
    expect(runtimeDiagnosticsSource).toContain("lan-bind-loopback");
    expect(runtimeDiagnosticsSource).toContain("lan-firewall-verification");
    expect(runtimeDiagnosticsSource).toContain("lan-host-sleep-risk");
    expect(runtimeDiagnosticsSource).toContain("public-ready-placeholder");
    expect(runtimeDiagnosticsSource).toContain("public-sharing-ready");
    expect(runtimeDiagnosticsSource).toContain("public-base-url-missing");
    expect(rendererSource).toContain("sharedLanPoolCount");
    expect(rendererSource).toContain("enabledLanAccessKeyCount");
    expect(rendererSource).toContain("publicReadyPoolCount");
    expect(rendererSource).toContain("enabledPublicAccessKeyCount");
    expect(rendererSource).toContain("publicAccessEnabled");
    expect(rendererSource).toContain("localNetworkAddressCount");
    expect(rendererSource).toContain("lanBaseUrl");
    expect(styles).toContain(".system-diagnostics-workbench {");
    expect(styles).toContain(".system-config-panel {");
    expect(styles).toContain(".system-config-layout {");
    expect(styles).toContain(".system-config-fieldset {");
    expect(styles).toContain(".system-status-strip {");
    expect(styles).toContain(".system-action-grid {");
    expect(styles).toContain(".system-diagnostics-modal {");
    expect(styles).toContain(".diagnostics-shell {");
    expect(styles).toContain(".troubleshooting-guide-grid {");
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
    const staticPreloadSource = readFileSync(
      resolve(process.cwd(), "apps/desktop/static/preload.cjs"),
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
    expect(usageView).toContain("成员观测");
    expect(usageView).toContain("id=\"usage-observe-mode\"");
    expect(usageView).toContain("id=\"usage-trend-dimension\"");
    expect(usageView).toContain("data-action=\"usage-trend-dimension\"");
    expect(usageView).toContain("id=\"usage-trend-chart\"");
    expect(usageView).toContain("id=\"usage-operations-dashboard\"");
    expect(usageView).toContain("id=\"usage-dimension-insights\"");
    expect(usageView).toContain("data-action=\"open-usage-alerts-modal\"");
    expect(usageView).toContain("data-action=\"open-usage-alert-events-modal\"");
    expect(usageView).toContain("id=\"usage-alert-summary-preview\"");
    expect(usageView).toContain("id=\"usage-alert-events-preview\"");
    expect(usageView).not.toContain("id=\"usage-alerts-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"usage-alerts-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("id=\"usage-alert-events-modal\" class=\"modal-overlay\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal usage-alert-modal\"");
    expect(indexHtml).toContain("class=\"modal-content figma-modal usage-alert-events-modal\"");
    expect(indexHtml).toContain("id=\"usage-alert-rule-list\"");
    expect(indexHtml).toContain("id=\"usage-alert-event-list\"");
    expect(indexHtml).toContain("告警事件列表");
    expect(indexHtml).toContain("id=\"usage-alert-daily-threshold\"");
    expect(indexHtml).toContain("id=\"usage-alert-runtime-threshold\"");
    expect(indexHtml).toContain("id=\"usage-alert-failure-threshold\"");
    expect(indexHtml).toContain("data-action=\"save-usage-alert-thresholds\"");
    expect(indexHtml).toContain("id=\"usage-alert-status-filter\"");
    expect(indexHtml).toContain("id=\"usage-alert-severity-filter\"");
    expect(indexHtml).toContain("id=\"usage-alert-consumer-type-filter\"");
    expect(indexHtml).toContain("id=\"notification-type-filter\"");
    expect(indexHtml).toContain("id=\"notification-page-size\"");
    expect(indexHtml).toContain("id=\"notification-pagination\"");
    expect(indexHtml).toContain("公网成员");
    expect(usageView).toContain("class=\"usage-dimension-grid\"");
    expect(rendererSource).toContain("renderUsageWorkbench");
    expect(rendererSource).toContain("normalizeUsageObservability");
    expect(rendererSource).toContain("normalizeAccessAlertEvents");
    expect(rendererSource).toContain("formatAccessAlertConsumerTypeLabel");
    expect(rendererSource).toContain("usageAlertConsumerTypeFilter");
    expect(rendererSource).toContain("renderUsageTrendChart");
    expect(rendererSource).toContain("renderUsageOperationsDashboard");
    expect(rendererSource).toContain("renderUsageTokenTrendLine");
    expect(rendererSource).toContain("renderUsageRankingBars");
    expect(rendererSource).toContain("renderUsageTokenMixDonut");
    expect(rendererSource).toContain("renderUsageOutcomeBars");
    expect(rendererSource).toContain("renderUsageLatencySnapshot");
    expect(rendererSource).toContain("renderUsageScopeMatrix");
    expect(rendererSource).toContain("renderUsageAlertSummaryPreview");
    expect(rendererSource).toContain("openUsageAlertsModal");
    expect(rendererSource).toContain("openUsageAlertEventsModal");
    expect(rendererSource).toContain("renderNotificationCenter");
    expect(rendererSource).toContain("deriveNotificationItems");
    expect(rendererSource).toContain("notificationUnreadBadge");
    expect(rendererSource).toContain("showNativeNotification");
    expect(rendererSource).toContain("markNotificationRead");
    expect(rendererSource).toContain("UsageTrendDimension");
    expect(rendererSource).toContain("usageTrendDimension: \"members\"");
    expect(rendererSource).not.toContain(
      "state.activeView === \"overview\" || state.activeView === \"usage\"",
    );
    expect(rendererSource).toContain("renderUsageConsumerTimelineChart");
    expect(rendererSource).toContain("renderUsageModelTimelinePanel");
    expect(rendererSource).toContain("renderUsageAttributionTimelinePanel");
    expect(rendererSource).toContain("consumerTimeline");
    expect(rendererSource).toContain("modelTimeline");
    expect(rendererSource).toContain("accessKeyTimeline");
    expect(rendererSource).toContain("poolTimeline");
    expect(rendererSource).toContain("模型 24h 趋势");
    expect(rendererSource).toContain("Key / 号池 24h 趋势");
    expect(rendererSource).toContain("class=\"usage-trend-empty-state\"");
    expect(rendererSource).toContain("renderUsageTrendEmptyState");
    expect(rendererSource).toContain("data-usage-tooltip");
    expect(rendererSource).toContain("当前视角暂无小时曲线");
    expect(rendererSource).toContain("当前视角暂无排行数据");
    expect(rendererSource).toContain("ensureUsageTooltip");
    expect(rendererSource).toContain("showUsageTooltip");
    expect(rendererSource).toContain("hideUsageTooltip");
    expect(rendererSource).toContain("bindUsageTooltipInteractions");
    expect(rendererSource).toContain("usage-tooltip-popover");
    expect(styles).toContain(".usage-tooltip-popover");
    expect(styles).toContain(".usage-tooltip-popover[data-visible=\"true\"]");
    expect(styles).toContain(".usage-timeline-bars { grid-template-columns: repeat(12");
    expect(rendererSource).toContain("renderUsageDimensionInsights");
    expect(rendererSource).toContain("getAccessAlerts");
    expect(rendererSource).toContain("acknowledgeAccessAlert");
    expect(rendererSource).toContain("acknowledgeAllAccessAlerts");
    expect(rendererSource).toContain("clearAcknowledgedAccessAlerts");
    expect(rendererSource).toContain("renderUsageAlertEvents");
    expect(rendererSource).toContain("usageAlertStatusFilter");
    expect(rendererSource).toContain("usageAlertSeverityFilter");
    expect(rendererSource).toContain("saveUsageAlertThresholds");
    expect(rendererSource).toContain("getAccessAlertThresholds");
    expect(rendererSource).toContain("usage-alert-group-title");
    expect(rendererSource).toContain("data-action=\"ack-access-alert\"");
    expect(rendererSource).toContain("data-action=\"ack-all-access-alerts\"");
    expect(rendererSource).toContain("data-action=\"clear-acknowledged-access-alerts\"");
    expect(rendererSource).toContain("formatAccessAlertTypeLabel");
    expect(rendererSource).toContain("buildAccessAlertReadableBody");
    expect(rendererSource).toContain("buildAccessAlertNotification");
    expect(rendererSource).toContain("normalizeNotificationTypeFilter");
    expect(rendererSource).toContain("notificationPageSize");
    expect(rendererSource).toContain("class=\"usage-alert-event-card");
    expect(rendererSource).toContain("acknowledgedAt");
    expect(rendererSource).toContain("occurrenceCount");
    expect(rendererSource).toContain("lastSeenAt");
    expect(rendererSource).toContain("重复");
    expect(rendererSource).toContain("正式告警事件");
    expect(rendererSource).toContain("访问成员排行");
    expect(rendererSource).toContain("Access Key 排行");
    expect(rendererSource).toContain("号池排行");
    expect(rendererSource).toContain("summary.consumers.map");
    expect(rendererSource).toContain("summary.accessKeys.map");
    expect(rendererSource).toContain("(summary.pools ?? []).map");
    expect(rendererSource).toContain("class=\"usage-insight-card\"");
    expect(preloadSource).toContain("getAccessAlerts");
    expect(preloadSource).toContain("acknowledgeAccessAlert");
    expect(preloadSource).toContain("acknowledgeAllAccessAlerts");
    expect(preloadSource).toContain("clearAcknowledgedAccessAlerts");
    expect(preloadSource).toContain("showNativeNotification");
    expect(staticPreloadSource).toContain("getAccessAlerts");
    expect(staticPreloadSource).toContain("acknowledgeAccessAlert");
    expect(staticPreloadSource).toContain("acknowledgeAllAccessAlerts");
    expect(staticPreloadSource).toContain("clearAcknowledgedAccessAlerts");
    expect(staticPreloadSource).toContain("showNativeNotification");
    expect(mainSource).toContain("gateway:acknowledge-access-alert");
    expect(mainSource).toContain("gateway:acknowledge-all-access-alerts");
    expect(mainSource).toContain("gateway:clear-acknowledged-access-alerts");
    expect(mainSource).toContain("gateway:show-native-notification");
    expect(mainSource).toContain("new Notification");
    expect(mainSource).toContain("/admin/access/alerts/acknowledge-all");
    expect(mainSource).toContain("/admin/access/alerts/clear-acknowledged");
    expect(mainSource).toContain("/admin/access/alerts/");
    expect(styles).toContain(".usage-alerts-workbench {");
    expect(styles).toContain(".usage-chart-panel {");
    expect(styles).toContain(".usage-chart-frame {");
    expect(styles).toContain(".usage-operations-dashboard {");
    expect(styles).toContain(".usage-line-chart {");
    expect(styles).toContain(".usage-ranking-chart {");
    expect(styles).toContain(".usage-donut-chart {");
    expect(styles).toContain(".usage-outcome-chart {");
    expect(styles).toContain(".usage-latency-chart {");
    expect(styles).toContain(".usage-scope-matrix {");
    expect(styles).toContain("height: 8px;");
    expect(styles).toContain(".usage-alert-modal,");
    expect(styles).toContain(".system-diagnostics-modal {");
    expect(styles).toContain(".usage-alert-action-grid {");
    expect(styles).toContain(".notification-list {");
    expect(styles).toContain(".notification-filter-row {");
    expect(styles).toContain(".notification-meta {");
    expect(styles).toContain(".notification-pagination {");
    expect(styles).toContain(".notification-card.tone-danger");
    expect(styles).toContain(".notification-unread-badge {");
    expect(styles).toContain(".usage-chart-bars {");
    expect(styles).toContain(".usage-timeline-bars {");
    expect(styles).toContain(".usage-alert-rule em {");
    expect(styles).toContain("justify-self: end;");
    expect(styles).toContain(".usage-dimension-grid {");
    expect(styles).toContain(".usage-alert-rule-list {");
    expect(styles).toContain(".usage-alert-threshold-toolbar {");
    expect(styles).toContain(".usage-alert-event-toolbar {");
    expect(styles).toContain(".usage-alert-group-title {");
    expect(styles).toContain(".usage-alert-event-list {");
    expect(styles).toContain(".usage-alert-event-card {");
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
    "uses packaged Electron node mode for the persistent gateway service",
    () => {
      execFileSync("npx", ["tsc", "-b", "apps/desktop", "--force"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });

      const mainOutput = readFileSync(
        resolve(process.cwd(), "apps/desktop/dist/main.js"),
        "utf8",
      );

      expect(mainOutput).toContain("ELECTRON_RUN_AS_NODE");
      expect(mainOutput).toContain("gateway-service-runner.mjs");
      expect(mainOutput).toContain("app.getPath(\"exe\")");
      expect(mainOutput).toContain("gateway/dist/server.js");
      expect(mainOutput).toContain("startGatewayServer");
      expect(mainOutput).toContain("await gatewayManager.stopManaged()");
      expect(mainOutput).toContain("knownGatewayPids");
      expect(mainOutput).toContain("isKnownLocalGatewayProcess");
      expect(mainOutput).toContain("parseLaunchAgentStatus(");
      expect(mainOutput).toContain("GATEWAY_HEALTH_WAIT_TIMEOUT_MS");
      expect(mainOutput).toContain("45_000");
      expect(mainOutput).toContain("ensureGatewayForWindowStartup");
      expect(mainOutput).toContain("仍打开控制台以便修复");
    },
    15_000,
  );
});
