import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("desktop build output", () => {
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
      expect(indexHtml).toContain(`<span>${label}</span>`);
      expect(indexHtml).toContain(`data-view="${target}"`);
    }
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
    expect(accessView).toContain("id=\"access-member-drawer\"");
    expect(accessView).toContain("id=\"access-create-member-modal\"");
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
    expect(rendererSource).toContain("rotateAccessKey");
    expect(rendererSource).toContain("saveAccessKeyExpiry");
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
