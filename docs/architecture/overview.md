# 架构总览

当前运行时由三层组成：

- `gateway app`：HTTP 路由、Admin API、SSE 输出与统一错误处理
- `runtime/core`：模型注册、provider 注册、配置存储、数据库与日志
- `providers`：Codex、OpenAI-compatible、Ollama 等具体上游适配器

## Provider 结构

- `provider-codex`：可复用 `~/.openclaw` 中已登录的本地 Codex OAuth 授权，也可消费桌面端导入的本地 Codex 账号
- `provider-openai-compatible`：通过标准 `/v1/chat/completions` 拉流接入任意兼容上游
- `provider-ollama`：通过 `/api/chat` 接入本机或局域网 Ollama

所有 provider 都实现统一的 `ProviderAdapter` 接口，向 gateway 层输出统一的 `ProviderStream` 事件，因此：

- gateway 无需关心上游是否是 Codex、OpenAI-compatible 还是 Ollama
- OpenAI-compatible 输出层只需要消费一套统一事件
- 后续继续增加 provider 时，不需要改动核心 HTTP 路由

## 桌面端定位

Electron 桌面端当前定位是“本地控制中心”，不是聊天前端。它主要负责：

- 查看 gateway 服务状态
- 查看 provider 与会话状态
- 导入和管理桌面端 Codex 账号
- 发现并复用 OpenClaw 本地授权
- 图形化填写 OpenAI-compatible / Ollama 配置
- 展示 OpenClaw 接入片段
- 展示账号卡片、诊断与最近错误
- 提供本地运行与排错指引

因此当前桌面端已经从早期的“薄壳面板”升级为可操作的本地 GUI，但它仍然是控制面，而不是对话消费面。
本文档描述 `Local AI Gateway` v1 当前已落地的整体结构、模块边界与关键请求流。

## 1. 总体结构

系统由两层入口组成：

- 本地 HTTP gateway service
- Electron 薄壳控制台

其中：

- gateway service 是核心执行层，负责对接 OpenClaw 与上游 provider
- Electron 是控制面，负责服务启停、状态展示、Provider 配置与活动会话切换

## 2. 仓库模块

### `apps/gateway`

职责：

- 暴露 OpenAI-compatible API
- 暴露本地 Admin API
- 组装 runtime、session source、model registry 与 provider adapter

关键文件：

- [app.ts](/Users/henery/code/local-ai-gateway/apps/gateway/src/app.ts)
- [runtime.ts](/Users/henery/code/local-ai-gateway/apps/gateway/src/runtime.ts)
- [cli.ts](/Users/henery/code/local-ai-gateway/apps/gateway/src/cli.ts)

### `apps/desktop`

职责：

- 管理 gateway 子进程
- 读取本地 Admin token
- 调用 Admin API
- 展示状态、会话、账号卡片与错误摘要
- 提供 Provider 图形化配置表单

关键文件：

- [main.ts](/Users/henery/code/local-ai-gateway/apps/desktop/src/main.ts)
- [preload.ts](/Users/henery/code/local-ai-gateway/apps/desktop/src/preload.ts)
- [renderer.ts](/Users/henery/code/local-ai-gateway/apps/desktop/src/renderer.ts)

### `packages/core`

职责：

- 管理 App Support 路径
- 管理本地配置文件
- 提供 SQLite 日志存储
- 提供日志器与模型注册
- 提供 `ProviderRegistry`，统一管理 provider adapter 的注册与选择
- `ModelRegistry` 当前支持通过桌面端配置切换 `codex-default` 背后的 Codex 上游模型

### `packages/openclaw-session`

职责：

- 扫描本机 OpenClaw `auth-profiles.json`
- 管理桌面端导入的本地 Codex 账号文件
- 列出可用 `openai-codex` 会话
- 解析导入账号中的邮箱、套餐、额度与重置时间快照
- 解析活动会话
- 通过 OAuth helper 获取可用 access token

当前 `SessionSource` 实际上会合并两类来源：

- `OpenClaw 本地授权`
- `桌面端本地导入账号`

两者当前不做跨来源自动去重，而是统一进入同一个会话列表，再由桌面端按来源分组展示。

其中：

- `OpenClaw 本地授权` 不是桌面端自己的 Codex 账号，而是可复用的本地 OAuth 凭据来源
- 桌面端展示层会按 `accountId` 把这些原始 session 聚合成授权卡片，避免把多个 agent 会话误展示成多个账号
- 用户可将某个 OpenClaw 授权一键导入为桌面端账号
- 如果同一个账号同时出现在 OpenClaw 来源和桌面端导入来源，当前仍按两个来源分别展示

### `packages/provider-codex`

职责：

- 将网关内部消息上下文转换为 `pi-ai` 所需结构
- 调用 `@mariozechner/pi-ai` 的 `openai-codex-responses`
- 复用其真实请求头、SSE/WebSocket 与 OAuth 刷新逻辑

### `packages/openai-compat`

职责：

- 解析 OpenAI-compatible `chat/completions` 请求
- 转换为内部统一消息结构
- 将 Codex 返回的结果映射为 OpenAI-compatible 非流式响应
- 将上游事件流映射为 SSE chunk

### `packages/shared`

职责：

- 统一常量
- 共享类型
- 公共错误模型
- 路径与脱敏工具函数

## 3. 请求流

### 3.0 运行时选择关系

当前 gateway 运行时已通过统一抽象进行解耦：

- `SessionSource` 负责提供会话列表与解析活动会话
- `ProviderAdapter` 负责真实推理请求
- `ProviderRegistry` 负责按模型选择正确的 adapter

这意味着后续新增 OpenAI-compatible 或 Ollama adapter 时，不需要再改 gateway 主路由结构，只需要新增 adapter 并注册到 registry。

### 3.1 OpenClaw 到 Codex 的主链路

1. OpenClaw 调用 `http://127.0.0.1:<gateway-port>/v1/chat/completions`（默认端口 `8787`，可在桌面端系统配置中修改）
2. gateway 在 `openai-compat` 中解析请求并转换为内部上下文
3. `ModelRegistry` 解析模型别名，例如 `codex-default`
4. `ProviderRegistry` 根据模型所属 provider 选择 `ProviderAdapter`
5. `OpenClawSessionSource` 解析当前活动会话并提供 access token
6. `CodexAdapter` 将上下文转换为 `pi-ai` 的 `Context`
7. `@mariozechner/pi-ai` 发起真实 Codex Responses 请求
8. 结果通过 `openai-compat` 转换为 OpenAI-compatible JSON 或 SSE
9. gateway 返回给 OpenClaw

### 3.2 Electron 控制流

1. Electron 启动时按系统配置中的网关端口检查 gateway 健康状态
2. 若服务未运行，则自动拉起本地 gateway 进程
3. Electron 读取 App Support 中的 `config.json` 获取 Admin token
4. 通过 Admin API 获取健康状态、provider 列表、会话列表
5. Electron 通过 `GET /admin/config/providers` 读取本地 Provider 配置
6. 用户可在桌面端发起 Codex OAuth 导入或 JSON 导入，本地写入 `codex-auth-profiles.json`
7. 用户也可将某个 OpenClaw 已登录授权导入为桌面端账号
8. 用户保存图形化配置后，Electron 调用 `PUT /admin/config/providers`
9. 用户选择活动会话后，Electron 调用 `PUT /admin/sessions/active`
10. 二期路由策略层可通过 `GET/PUT /admin/config/routing` 管理规则，并通过 `POST /admin/config/routing/preview` 预演命中结果；桌面端 Provider 配置页已接入该组接口进行可视化配置
11. `GET /admin/health` 现已附带 `routingObservability`，用于展示 5 分钟命中、累计命中、Top 规则/客户端与最近命中事件
12. 第三方推理接口可选启用 API Key 鉴权：通过 `GET/PUT /admin/config/security` 管理（仅回传 `mode/enabled/hasApiKey`），启用后 `/v1/models` 与 `/v1/chat/completions` 需携带密钥

## 4. 会话模型

v1 采用单活动会话模型：

- 系统可发现多个 `openai-codex` 会话
- 这些会话既可能来自 OpenClaw，也可能来自桌面端本地导入
- 但任一时刻只使用一个活动会话
- 活动会话 ID 持久化在 `config.json`
- access token 不写入本仓库

## 5. 存储结构

当前本地存储约定如下：

- `config.json`：管理 token、活动会话 ID、桌面端保存的 provider 配置
- `codex-auth-profiles.json`：桌面端导入的本地 Codex OAuth 凭据
- `gateway.db`：结构化日志与后续运维数据
- `logs/gateway.log`：文本日志

默认位置：

- `~/Library/Application Support/local-ai-gateway/`

## 6. 当前已知边界

- 首版只支持文本消息和函数工具调用
- 会话结构依赖 OpenClaw 当前认证文件格式
- 不支持多账号池化与自动切换
- 不对外网暴露服务
- 桌面端中的 Codex 额度与重置时间已接入实时刷新第一版，但仍需继续增强自动重试与多窗口展示
- 二期路由策略层已完成“配置 + 预演 + 实时链路命中”第二步，当前支持按客户端标签/请求模型别名匹配并重写目标模型与目标会话
- 推理接口鉴权当前支持 `none / api-key` 两种模式，适用于本机单用户与多应用共享两类场景
- Codex 模型当前已支持“默认别名 + 多别名并存”模式：`codex-default` 负责默认路由，`codex-5.4 / codex-5.4-mini / codex-5.3 / codex-5.2 / codex-5.2-core / codex-5.1-max / codex-5.1-mini` 可并行暴露给第三方客户端按需选择
- 会话活动快照当前已支持 `clientTag` 维度统计，可在桌面端账号卡片中查看主要调用来源

## 7. 后续架构演进建议

- 在现有 `ProviderAdapter` 抽象之上补 OpenAI-compatible 与 Ollama adapter
- 将 `ModelRegistry` 从静态定义演进为可配置模型目录
- 为 Admin API 增加更明确的运行状态与错误分类
- 为 Electron 增加更清晰的错误提示与配置视图
