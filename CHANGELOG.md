# Changelog

本文件用于记录 `Local AI Gateway` 项目的所有重要变更，包括新增需求、设计调整、功能开发、缺陷修复、调试结论与优化事项。

记录规则：

- 所有后续改动都必须同步更新本文件
- 按日期降序排列，新的记录放在最上方
- 同一天内的内容收敛到同一个时间戳条目下
- 每条记录尽量简短，只保留便于回溯的关键信息

## [2026-03-25 01:20 CST]

### 新增

- 初始化 Node.js + TypeScript + npm workspaces 单仓结构。
- 新增 gateway、desktop、core、provider-codex、openclaw-session、openai-compat、shared 七个模块。
- 新增 OpenAI-compatible `GET /healthz`、`GET /v1/models`、`POST /v1/chat/completions`。
- 新增 Admin API：健康检查、provider 查询、会话查询、活动会话切换、服务重启。
- 新增 Electron 薄壳控制台，支持状态查看、会话切换、打开日志与复制 OpenClaw 接入片段。
- 新增 `docs/` 文档体系、v1 PRD、架构文档、运行文档与开发流程文档。
- 新增 ADR 文档，固化首版的服务优先、会话复用与 OpenAI-compatible 接口决策。
- 新增 `npm run smoke:gateway` 一键回归脚本，用于验证基础主链路。
- 新增基础测试，覆盖 OpenAI-compatible 转换与 OpenClaw 会话发现。
- 新增 gateway 路由与 Admin API 自动化测试，覆盖健康检查、模型列表、流式响应、工具调用、鉴权与活动会话切换。
- 新增打包与发布脚手架，包括 `electron-builder.yml`、`package:desktop`、`dist:desktop` 与发布说明文档。
- 新增目录包构建验证，已可生成 `release/mac-arm64/Local AI Gateway.app`。
- 新增 `provider-openai-compatible` 与 `provider-ollama` 两个真实 provider 模块。
- 新增 provider 环境变量引导、provider bootstrap 与扩展配置文档。
- 新增外部 provider 自动化测试，覆盖 OpenAI-compatible SSE 与 Ollama NDJSON 拉流。
- 新增 Electron provider 视图，可展示默认 provider、模型别名列表与会话型/固定配置差异。
- 新增 provider 只读配置视图，可在桌面端查看配置来源、鉴权方式、Base URL 与所用环境变量。
- 新增 provider 诊断视图，可展示启用状态、缺失环境变量与默认模型选择依据。
- 新增桌面端“使用说明”区块，直接展示产品定位、OpenClaw 接入片段与 provider 配置示例。
- 新增静态 `apps/desktop/static/preload.cjs`，用于稳定注入桌面桥接 API。
- 新增桌面端图形化 Provider 配置表单，支持在应用内填写 OpenAI-compatible / Ollama 参数并保存本地配置。
- 新增桌面端 Codex 账号卡片面板、最近错误视图与“添加账号”弹窗骨架。
- 新增《桌面控制台使用说明》，说明 GUI 配置方式、使用路径与当前预留能力。
- 新增本地 `codex-auth-profiles.json` 存储，用于保存桌面端导入的 Codex OAuth 凭据。
- 新增 Codex 账号浏览器 OAuth 导入链路，桌面端可直接拉起授权并写入本地账号存储。
- 新增 Codex JSON 导入链路，支持导入 OpenClaw `auth-profiles.json` 与常见兼容凭据结构。
- 新增 OpenClaw 会话源合并逻辑，可同时发现 `~/.openclaw` 会话与桌面端本地导入账号。
- 新增 OpenClaw Session 测试用例，覆盖本地导入账号合并与 JSON 导入。
- 新增账号来源分组展示，桌面端会按 `OpenClaw 本地会话 / 桌面端导入账号` 两类来源展示全部 Codex 账号。
- 新增 OpenClaw 授权一键导入能力，可将已扫描到的本地授权直接转存为桌面端 Codex 账号。
- 新增桌面端账号聚合测试与 OpenClaw 授权导入测试，覆盖账号/授权语义拆分后的回归场景。

### 调整

- 网关默认模型别名固定为 `codex-default`，默认映射到 `gpt-5.4`。
- 会话来源固定为 `~/.openclaw/agents/*/agent/auth-profiles.json`，仅复用现有 OpenClaw OAuth 会话。
- 本地持久化固定为 `~/Library/Application Support/local-ai-gateway/`。
- 项目内自维护 Markdown 文档统一改为中文。
- gateway 运行时已引入通用 `ProviderAdapter`、`SessionSource` 与 `ProviderRegistry` 抽象，为后续 OpenAI-compatible 与 Ollama provider 预留正式扩展位。
- gateway 启动时可根据环境变量装配 OpenAI-compatible / Ollama provider，并支持切换默认模型别名。
- Electron 复制 OpenClaw 接入片段改为读取实时 Admin 健康信息，避免固定输出 `codex-default`。
- Electron preload 改为静态 `preload.cjs`，修复桌面桥接未注入导致的 `getHealth` 初始化失败。
- Electron 控制台增强为中文状态面板，补充错误横幅、操作反馈、活动会话详情与最近刷新时间。
- Electron 桌面端界面重构为侧边导航 + 总览 + 账号 + 配置 + 诊断布局，整体从开发面板升级为可操作的本地控制台。
- Provider 扩展逻辑调整为同时兼容环境变量和桌面端本地配置，且环境变量优先于 GUI 保存项。
- README 与运维文档更新为新的桌面端使用路径，不再把 GUI 仅表述为只读薄壳。
- 桌面端账号面板现在会标注账号来源，区分 OpenClaw 检测账号与本地导入账号。
- 桌面端总览新增 Codex 账号来源分布统计，便于快速判断双来源会话覆盖情况。
- OpenClaw 来源账号改为按 `accountId` 聚合展示，不再把多个 agent 会话直接当成多个 Codex 账号。
- 桌面端界面语义调整为“桌面端 Codex 账号”与“OpenClaw 可复用授权”两类对象分开展示，不再把 OpenClaw 本地授权直接表述为本应用账号。
- smoke 脚本调整为区分“本地链路失败”和“上游额度限制”，降低真实上游限额带来的误报。
- 构建忽略规则补充 `release/` 与 `*.tsbuildinfo`，避免产物和缓存污染工作树。

### 修复

- 修复 `chat/completions` 请求在连接关闭事件上被过早中断的问题，避免本地请求被误判为已取消。
- 修复 Codex Responses 上游要求 `instructions` 必填导致的 400 错误，补充默认 system prompt。
- 修复工具调用与流式 SSE 在 OpenAI-compatible 输出过程中的兼容性细节。
- 修复测试层对编译产物的隐式依赖，改为直接验证源码入口。
- 修复桌面端 OAuth 登录在浏览器回调成功后仍可能因主进程 `fetch failed` 报错的问题，改为优先使用 Electron 网络栈完成令牌交换。
- 修复 OpenClaw 已登录授权与桌面端导入账号在产品语义上的混淆，改由 UI 与文档显式区分“授权源”和“账号”。
