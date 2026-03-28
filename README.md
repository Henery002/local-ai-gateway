# Local AI Gateway

`Local AI Gateway` 是一个面向 macOS 本地单机环境的 AI 网关项目，当前优先服务本地第三方客户端接入场景，`OpenClaw` 是已验证的一类典型接入方。

首版目标：

- 提供本地 `127.0.0.1` 网关服务
- 对外暴露 OpenAI-compatible 接口
- 首先接入 Codex provider
- 复用本机现有本地 OAuth 授权作为可选会话来源，当前优先兼容 OpenClaw 已登录会话
- 提供 Electron 桌面控制台用于配置 Provider、导入和管理桌面端 Codex 账号、查看状态和切换活动授权

当前三期正在增量接入：

- 动态号池 / 号池调度
  - 允许命中某条路由规则的请求在多个桌面端 Codex 账号之间按阈值、冷却和有限重试自动挑号
  - 不会破坏现有“活动账号 / 固定账号”链路

## 项目结构

- `apps/gateway`：Fastify 网关服务与 Admin API
- `apps/desktop`：Electron 桌面控制台与本地操作台
- `packages/core`：配置、路径、日志、SQLite 存储、模型注册
- `packages/openclaw-session`：本地可复用授权发现与 OAuth token 解析，当前首版优先兼容 OpenClaw 会话格式
- `packages/provider-codex`：Codex 适配器，底层复用 `@mariozechner/pi-ai`
- `packages/openai-compat`：OpenAI-compatible 请求与响应转换
- `packages/shared`：共享常量、类型与错误模型
- `docs`：项目文档、PRD 与后续设计资料

## 常用命令

- `npm install`
- `npm run build`
- `npm run test`
- `npm run smoke:gateway`
- `npm run smoke:desktop-package`
- `npm run preflight:release`
- `npm run package:desktop`
- `npm run dist:desktop`
- `npm run dev:gateway`
- `npm run dev:desktop`

## 可选 Provider 扩展

当前版本除默认 Codex 外，还支持通过桌面端表单或环境变量启用：

- OpenAI-compatible provider
- Ollama provider

示例：

```bash
export LOCAL_AI_GATEWAY_OPENAI_BASE_URL="https://example.com/v1"
export LOCAL_AI_GATEWAY_OPENAI_API_KEY="sk-..."
export LOCAL_AI_GATEWAY_OPENAI_MODEL="gpt-4.1-mini"

export LOCAL_AI_GATEWAY_OLLAMA_BASE_URL="http://127.0.0.1:11434"
export LOCAL_AI_GATEWAY_OLLAMA_MODEL="qwen2.5-coder:7b"
```

如需让某个扩展模型成为默认模型别名，可设置：

```bash
export LOCAL_AI_GATEWAY_DEFAULT_MODEL_ALIAS="ollama-default"
```

如果你不想走终端，也可以直接启动桌面端，在 `Provider 配置` 区块中填写 OpenAI-compatible / Ollama 参数并保存。保存后桌面端会自动重启 gateway。

你也可以在桌面端 `诊断 -> 系统配置` 中调整网关端口（默认 `8787`）。保存后，托管网关会按新端口自动重启。

当前桌面端支持两类 Codex 接入对象：

- 桌面端自己的 Codex 账号
  - 浏览器 OAuth 自动导入
  - 本地 JSON / `auth-profiles.json` 文件导入
- 本机已登录的本地 Codex OAuth 授权
  - 自动扫描发现
  - 可直接作为网关授权来源
  - 当前首版优先兼容 OpenClaw 会话格式
  - 可一键导入为桌面端账号

## 接入说明

启动本地服务后，可将任意支持 OpenAI-compatible 的第三方客户端 `baseUrl` 指向：

```txt
http://127.0.0.1:8787/v1
```

默认模型别名为：

```txt
codex-default
```

## 文档入口

- [文档总览](./docs/README.md)
- [v1 产品需求文档（PRD）](./docs/prd/local-ai-gateway-v1.md)
- [架构总览](./docs/architecture/overview.md)
- [概念地图](./docs/architecture/%E6%A6%82%E5%BF%B5%E5%9C%B0%E5%9B%BE.md)
- [动态号池设计方案](./docs/architecture/%E5%8A%A8%E6%80%81%E5%8F%B7%E6%B1%A0%E8%AE%BE%E8%AE%A1%E6%96%B9%E6%A1%88.md)
- [OpenClaw 接入与运行说明](./docs/operations/openclaw-%E6%8E%A5%E5%85%A5%E4%B8%8E%E8%BF%90%E8%A1%8C.md)
- [Provider 扩展配置](./docs/operations/provider-%E6%89%A9%E5%B1%95%E9%85%8D%E7%BD%AE.md)
- [桌面控制台使用说明](./docs/operations/%E6%A1%8C%E9%9D%A2%E6%8E%A7%E5%88%B6%E5%8F%B0%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md)
- [安装与升级检查清单](./docs/operations/%E5%AE%89%E8%A3%85%E4%B8%8E%E5%8D%87%E7%BA%A7%E6%A3%80%E6%9F%A5%E6%B8%85%E5%8D%95.md)
- [Codex 接入风险与限流说明](./docs/operations/codex-%E6%8E%A5%E5%85%A5%E9%A3%8E%E9%99%A9%E4%B8%8E%E9%99%90%E6%B5%81%E8%AF%B4%E6%98%8E.md)
- [项目答疑与开发清单](./docs/operations/%E9%A1%B9%E7%9B%AE%E7%AD%94%E7%96%91%E4%B8%8E%E5%BC%80%E5%8F%91%E6%B8%85%E5%8D%95.md)
- [开发与变更流程](./docs/operations/%E5%BC%80%E5%8F%91%E4%B8%8E%E5%8F%98%E6%9B%B4%E6%B5%81%E7%A8%8B.md)
- [打包与发布说明](./docs/operations/%E6%89%93%E5%8C%85%E4%B8%8E%E5%8F%91%E5%B8%83.md)
- [架构决策记录（ADR）](./docs/decisions/0001-%E6%9C%8D%E5%8A%A1%E4%BC%98%E5%85%88%E4%BA%8E%E6%A1%8C%E9%9D%A2%E5%A3%B3.md)
- [变更记录](./CHANGELOG.md)
