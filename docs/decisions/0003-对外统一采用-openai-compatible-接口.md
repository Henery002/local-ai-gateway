# ADR 0003：对外统一采用 OpenAI-compatible 接口

## 状态

已采纳

## 日期

2026-03-25

## 背景

OpenClaw 已具备 provider 与 `baseUrl` 配置能力。为了降低接入成本，首版需要优先选择最容易兼容的外部接口形态。

## 决策

首版对外统一采用 OpenAI-compatible 接口：

- `GET /v1/models`
- `GET /v1/models/:model`
- `POST /v1/chat/completions`
- `POST /v1/responses`（三期公网共享阶段补充，用于 Codex App / CC Switch 等 Responses API 客户端）

三期公网共享阶段额外提供成员侧兼容查询：

- `GET /user/balance`
- `GET /v1/user/balance`
- `GET /backend-api/wham/usage`
- `GET /v1/backend-api/wham/usage`
- `GET /dashboard/billing/credit_grants`
- `GET /v1/dashboard/billing/credit_grants`

这些查询不是 OpenAI 官方账单接口的代理，而是本网关按当前成员 API Key 和 AccessPolicy 返回的成员包额度 / 已用 Token / 剩余 Token，用于 CC Switch 等第三方工具展示自定义 Provider 的可用额度。其中 `wham/usage` 和 `credit_grants` 只做兼容形态输出，不代表上游 Codex / OpenAI 官方额度。

并支持：

- 非流式聊天
- SSE 流式聊天
- 工具调用

不在首版暴露：

- Assistants
- Batch

## 影响

- OpenClaw 接入成本最低
- 外部客户端无需理解 Codex 专有协议
- 网关内部需要承担一次协议转换
