# Local AI Gateway v1 产品需求文档

> 注：本文档记录的是 `v1` 基线范围。当前仓库实现已经超出这份首版 PRD，主接入对象已扩展为 `OpenClaw / Hermes`，并补齐了策略路由、Token 用量观测、接入鉴权与动态号池第一版能力。

## 1. 项目概述

`Local AI Gateway` v1 是一个运行在 macOS 本机的 AI 网关系统，优先服务第三方客户端通过本地网关接入 Codex 的场景。

产品定位：

- 本地单用户使用
- 本机常驻运行
- 对 OpenClaw / Hermes 暴露统一 AI 接口
- 首版先支持 Codex，架构上预留多 provider 扩展能力

v1 的交付物由两部分组成：

- 独立可运行的本地 gateway service
- Electron 薄壳控制台

实施顺序仍然是先打通服务主链路，再补桌面控制面，但首版交付需同时包含这两部分。

## 2. 产品目标

### 2.1 目标用户

目标用户是同一台 Mac 上长期运行 OpenClaw、Hermes、Codex 等工具的单个本地用户。

### 2.2 核心价值

`Local AI Gateway` 负责收口以下复杂度：

- provider 差异
- 本地 OAuth 会话状态
- 模型别名与真实 provider model 的映射
- 第三方客户端的本地统一接入入口
- 服务启停、状态查看与活动会话切换

### 2.3 成功标准

当 OpenClaw 或 Hermes 将 `baseUrl` 配置为 `http://127.0.0.1:8787/v1` 后，应能稳定完成以下链路：

- 列出可用模型
- 完成非流式聊天请求
- 完成流式聊天请求
- 完成工具调用请求

同时，Electron 控制台应能完成：

- 查看服务健康状态
- 查看当前 provider
- 查看当前活动账号/会话
- 手动切换活动会话
- 查看最近错误摘要
- 复制第三方客户端接入片段

## 3. 首版范围

### 3.1 v1 必做范围

- 本地 `127.0.0.1` 网关服务
- OpenAI-compatible 外部接口
- Codex provider adapter
- 从现有 `~/.openclaw` 读取 OAuth 会话
- 单活动账号模型
- 本地配置与日志存储
- Admin API
- Electron 薄壳控制台

### 3.2 v1 不做范围

- 多账号池化
- 自动切换账号规避限制
- 对公网暴露服务
- 多设备同步
- 云端控制台
- 复杂计费与权限系统
- 完整登录 UI
- 图片、音频、Assistants、Batch 等高级接口

## 4. 技术与架构要求

### 4.1 技术栈

v1 默认技术栈如下：

- Node.js 22
- TypeScript
- npm workspaces
- Fastify
- SQLite
- Electron

### 4.2 仓库结构

采用单仓 monorepo 结构：

- `apps/gateway`
- `apps/desktop`
- `packages/core`
- `packages/provider-codex`
- `packages/openclaw-session`
- `packages/openai-compat`
- `packages/shared`

### 4.3 模块职责

#### core

负责：

- 应用路径管理
- 配置文件管理
- SQLite 日志存储
- 模型注册
- 基础日志能力

#### provider-codex

负责：

- 将内部统一会话上下文转换为 Codex 所需格式
- 复用 `@mariozechner/pi-ai` 的 `openai-codex-responses` 能力
- 执行真实上游流式调用
- 输出统一的上游事件流

#### openclaw-session

负责：

- 扫描 `~/.openclaw/agents/*/agent/auth-profiles.json`
- 发现 `openai-codex` 可用会话
- 提供会话摘要列表
- 在必要时通过 OAuth helper 刷新 access token

#### openai-compat

负责：

- 解析 `chat/completions` 请求
- 将 OpenAI-compatible 请求转换为内部统一对话上下文
- 将 Codex 返回结果转换为 OpenAI-compatible 非流式响应
- 将上游流式事件转换为 SSE chunk

#### apps/gateway

负责：

- 对外提供推理 API
- 对内提供 Admin API
- 组织 runtime、session source、model registry、adapter

#### apps/desktop

负责：

- 启动/停止/重启本地 gateway
- 调用 Admin API
- 展示状态、provider、活动会话与错误摘要
- 复制第三方客户端接入片段

## 5. 外部接口设计

### 5.1 推理接口

v1 对第三方客户端暴露以下接口：

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`（三期公网共享阶段补充的兼容入口）

### 5.2 `POST /v1/chat/completions` 能力边界

首版必须支持：

- `stream=true`
- `stream=false`
- `messages`
- `tools`
- `tool_choice`
- 文本型 system/user/assistant/tool 消息

首版不支持：

- 图片输入
- 音频输入
- Assistants API
- Batch API

### 5.3 Admin API

首版 Admin API 固定为：

- `GET /admin/health`
- `GET /admin/providers`
- `GET /admin/sessions`
- `PUT /admin/sessions/active`
- `POST /admin/service/restart`

Admin API 使用本地生成的 `admin token` 进行访问控制。

## 6. 账号与会话策略

### 6.1 账号模型

首版采用：

- 单用户
- 单机
- 单活动账号

不做：

- 多账号池化
- 自动逃逸切换
- 限额规避逻辑

### 6.2 会话来源

首版会话来源固定为现有 OpenClaw 配置和认证资料：

- `~/.openclaw/agents/*/agent/auth-profiles.json`

OpenClaw 是 OAuth 源数据的事实来源，gateway 只负责读取、使用和最小必要的刷新，不向仓库写入敏感 token。

### 6.3 敏感信息处理

要求：

- 不将 access token、refresh token 写入仓库
- 不在日志中记录 token、cookie、Authorization 等敏感信息
- 配置中仅保存非敏感状态与活动会话选择

## 7. 模型策略

### 7.1 对外模型暴露

对外暴露使用网关自己的模型别名，而不是直接暴露 provider 内部模型名。

v1 默认模型：

- 别名：`codex-default`
- provider：`openai-codex`
- provider model：`gpt-5.4`

### 7.2 扩展要求

尽管首版只接 Codex，模型注册与 provider adapter 结构需预留后续扩展位，用于支持：

- OpenAI-compatible provider
- Ollama
- 其他官方 API provider

## 8. Electron 薄壳要求

Electron 在 v1 中定位为控制面，而不是承载核心推理逻辑。

必须提供：

- 服务健康状态展示
- 当前 provider 展示
- 当前活动会话展示
- 会话切换
- 最近错误摘要
- 打开日志目录
- 复制第三方客户端接入片段

不进入 v1：

- 复杂配置编辑器
- OAuth 登录向导
- 多 provider 图形化管理中心

## 9. 存储与运行约定

### 9.1 本地存储路径

本地持久化默认放在 macOS App Support：

- `~/Library/Application Support/local-ai-gateway/config.json`
- `~/Library/Application Support/local-ai-gateway/gateway.db`
- `~/Library/Application Support/local-ai-gateway/logs/`

### 9.2 日志策略

日志必须默认脱敏，不记录：

- token
- refresh token
- cookie
- Authorization header

### 9.3 服务监听范围

网关只监听：

- `127.0.0.1:8787`

不对外网暴露。

## 10. 错误语义

首版错误约定如下：

- 本地会话不可用：`503 gateway_auth_required`
- 请求不兼容：`400 invalid_request`
- 未找到模型：`400 model_not_found`
- 管理接口未授权：`401 unauthorized`
- 上游 provider 异常：`502 upstream_error`

## 11. 实施步骤

### 阶段 1：项目骨架

- 初始化 monorepo
- 建立 TypeScript、测试与构建配置
- 建立共享类型、core 基础设施、文档结构

### 阶段 2：服务主链路

- 实现 OpenClaw 会话发现
- 实现 Codex adapter
- 实现 OpenAI-compatible 路由
- 打通非流式与流式聊天

### 阶段 3：管理能力

- 实现 Admin API
- 实现活动会话切换
- 实现日志查询与健康状态接口

### 阶段 4：桌面壳

- 实现 Electron 主进程
- 连接 Admin API
- 提供最小可用控制面

## 12. 测试与验收

### 12.1 必测项

- `GET /v1/models`
- `POST /v1/chat/completions` 非流式
- `POST /v1/chat/completions` 流式 SSE
- 工具调用请求与返回
- OpenClaw 会话发现
- 活动会话切换
- 服务仅监听 `127.0.0.1`
- 日志脱敏

### 12.2 MVP 验收标准

以真实 OpenClaw 与真实 Codex 会话联调为准，满足：

- 模型列举成功
- 文本聊天成功
- 流式输出成功
- 工具调用成功
- 活动会话切换后仍可继续发起请求

## 13. 当前已实现状态

截至当前仓库版本，以下内容已经完成：

- monorepo 项目骨架
- gateway 服务
- OpenAI-compatible `/v1/models` 与 `/v1/chat/completions`
- Codex 真实上游调用
- 流式 SSE 返回
- 工具调用返回
- OpenClaw 会话发现与会话切换
- Admin API
- Electron 薄壳控制台
- 基础测试与 smoke 验证

## 14. 后续建议

后续可按优先级继续推进：

1. 增加更完整的 OpenClaw 接入说明与配置示例
2. 为 Electron 增加更完整的状态提示与错误反馈
3. 抽象 provider adapter 接口，准备接入 OpenAI-compatible 与 Ollama
4. 增加运行脚本、打包脚本和发布说明
5. 增加 architecture decision records（ADR）记录后续关键决策
