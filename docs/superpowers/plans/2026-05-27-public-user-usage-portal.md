# Public User Usage Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public `/v1/account` self-service page and read-only `/v1/user/*` APIs so members can query their own usage and quota with their RelayGate API Key.

**Architecture:** Keep the public surface inside the existing inference namespace `/v1/*`, reuse the current Access Key auth path, and filter all usage by the authenticated `consumerId` plus `accessKeyId`. Serve a lightweight static HTML page from the gateway process; do not expose `/admin/*` or introduce a cloud service.

**Tech Stack:** Fastify gateway, TypeScript, existing SQLite usage aggregation, Vitest gateway tests, inline HTML/CSS/JS for the MVP portal.

---

### Task 1: Document The Public Self-Service Boundary

**Files:**
- Create: `docs/architecture/shared-gateway/公网用户自助用量额度查询页技术方案.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture/shared-gateway/二期三期共享网关开发进度清单.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the design record**

Create the technical document with sections for goal, non-goals, routes, auth/security boundary, response shape, UI design, implementation checklist, and acceptance criteria.

- [ ] **Step 2: Link the design record**

Add the new document to the shared-gateway section in `docs/README.md`.

- [ ] **Step 3: Update project records**

Add a 2026-05-27 changelog bullet and progress-list note describing `/v1/account`, `/v1/user/profile`, and `/v1/user/usage/summary`.

### Task 2: Add Failing Gateway Tests

**Files:**
- Modify: `tests/gateway-app.test.ts`

- [ ] **Step 1: Test the public page**

Add a test asserting `GET /v1/account` returns status 200, `text/html`, and visible portal copy without requiring admin auth.

- [ ] **Step 2: Test profile auth**

Add a test asserting `GET /v1/user/profile` without a bearer key returns `401 gateway_api_key_required`.

- [ ] **Step 3: Test profile redaction**

Add a member access-control fixture, call `GET /v1/user/profile` with the member Key, and assert the response includes `consumer`, `accessKey.keyPrefix`, `accessKey.keySuffix`, `policy`, and `balance`, but does not include the raw API Key or `keyHash`.

- [ ] **Step 4: Test usage isolation**

Record usage for two different consumers and keys, call `GET /v1/user/usage/summary?range=7d`, and assert the totals only include the authenticated consumer/key.

- [ ] **Step 5: Verify RED**

Run `npm test -- tests/gateway-app.test.ts --runInBand` if supported, otherwise `npm test -- tests/gateway-app.test.ts`.

Expected before implementation: tests fail with missing `/v1/account`, `/v1/user/profile`, and `/v1/user/usage/summary` routes.

### Task 3: Implement User Self-Service Routes

**Files:**
- Modify: `apps/gateway/src/app.ts`

- [ ] **Step 1: Add authenticated user helper**

Add a helper that calls `requireInferenceNetworkAccess()` and `resolveAuthAndClientTag()`, then requires `authContext.accessContext`.

- [ ] **Step 2: Add profile builder**

Read current `inferenceAuthSettings.accessControl`, find the authenticated consumer/key/policy, return only redacted metadata plus `buildUserBalanceResponse()`.

- [ ] **Step 3: Add usage summary builder**

Parse `range=24h|7d|30d|all`, choose `hour` for 24h and `day` otherwise, call `runtime.getUsageAnalytics()` with authenticated `consumerId` and `accessKeyId`.

- [ ] **Step 4: Add static portal page**

Return inline HTML/CSS/JS for `/v1/account`. The page should have a Key input, query/refresh controls, KPI cards, quota progress, token composition, trend bars, and model ranking.

- [ ] **Step 5: Verify GREEN**

Run `npm test -- tests/gateway-app.test.ts`.

Expected after implementation: new tests pass.

### Task 4: Full Verification

**Files:**
- All modified files

- [ ] **Step 1: Typecheck**

Run `npm run typecheck`.

- [ ] **Step 2: Build**

Run `npm run build`.

- [ ] **Step 3: Diff hygiene**

Run `git diff --check`.

- [ ] **Step 4: Summarize delivery**

Report changed files, verification commands, and any residual risks.
