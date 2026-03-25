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
- `POST /v1/chat/completions`

并支持：

- 非流式聊天
- SSE 流式聊天
- 工具调用

不在首版暴露：

- `/v1/responses`
- Assistants
- Batch

## 影响

- OpenClaw 接入成本最低
- 外部客户端无需理解 Codex 专有协议
- 网关内部需要承担一次协议转换

