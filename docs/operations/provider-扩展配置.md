# Provider 扩展配置

本文档说明如何在 `Local AI Gateway` 中启用额外的 OpenAI-compatible 与 Ollama provider。

## 设计原则

- Codex 仍然是首版默认 provider，继续复用现有 `~/.openclaw` 会话。
- OpenAI-compatible 与 Ollama 以“可选扩展位”形式启用，不会影响默认链路。
- 当前版本支持两种方式启用扩展 provider：环境变量、桌面端图形化表单。
- 环境变量优先级高于桌面端保存的本地配置。
- 所有敏感配置只保存在本机，不写入仓库或日志。

## 配置方式

### 方式一：桌面端图形化配置

启动桌面端：

```bash
npm run dev:desktop
```

在 `Provider 配置` 区块中可以直接填写：

- Codex 默认上游模型与并行暴露模型别名（多别名并存）
- OpenAI-compatible 的 `Base URL`、`API Key`、模型名、模型别名
- Ollama 的 `Base URL`、模型名、模型别名
- 默认模型别名

点击“保存并重启服务”后，桌面端会调用本地 Admin API 持久化配置，并自动重启 gateway。

当前桌面端保存的本地配置位于：

```txt
~/Library/Application Support/local-ai-gateway/config.json
```

### 方式二：环境变量配置

如果你更习惯终端方式，也可以继续通过环境变量启用。

## OpenAI-compatible

启用条件：

- `LOCAL_AI_GATEWAY_OPENAI_BASE_URL`
- `LOCAL_AI_GATEWAY_OPENAI_API_KEY`

常用变量：

- `LOCAL_AI_GATEWAY_OPENAI_MODEL`
- `LOCAL_AI_GATEWAY_OPENAI_ALIAS`
- `LOCAL_AI_GATEWAY_OPENAI_LABEL`
- `LOCAL_AI_GATEWAY_OPENAI_DISPLAY_NAME`
- `LOCAL_AI_GATEWAY_OPENAI_CONTEXT_WINDOW`
- `LOCAL_AI_GATEWAY_OPENAI_MAX_TOKENS`
- `LOCAL_AI_GATEWAY_OPENAI_REASONING`

示例：

```bash
export LOCAL_AI_GATEWAY_OPENAI_BASE_URL="https://example.com/v1"
export LOCAL_AI_GATEWAY_OPENAI_API_KEY="sk-..."
export LOCAL_AI_GATEWAY_OPENAI_MODEL="gpt-4.1-mini"
export LOCAL_AI_GATEWAY_OPENAI_ALIAS="relay-default"
```

启用后，gateway 会新增一个 `openai-compatible` provider，并在 `/v1/models` 中暴露对应模型别名。

## Codex 多别名并存

默认行为：

- `codex-default` 始终存在，并指向当前选中的 Codex 上游模型
- 额外可并行暴露多个固定别名（当前为 `codex-5.5`、`codex-5.4`、`codex-5.4-mini`、`codex-5.3`、`codex-5.2`）

可选环境变量：

- `LOCAL_AI_GATEWAY_CODEX_MODEL`：设置 `codex-default` 对应的上游模型
- `LOCAL_AI_GATEWAY_CODEX_EXPOSED_MODELS`：设置并行暴露模型列表（逗号分隔）

示例：

```bash
export LOCAL_AI_GATEWAY_CODEX_MODEL="gpt-5.4-mini"
export LOCAL_AI_GATEWAY_CODEX_EXPOSED_MODELS="gpt-5.5,gpt-5.4,gpt-5.4-mini,gpt-5.3-codex,gpt-5.2"
```

此时 `/v1/models` 中将同时包含：

- `codex-default`（指向 `gpt-5.4-mini`）
- `codex-5.5`
- `codex-5.4`
- `codex-5.4-mini`
- `codex-5.3`
- `codex-5.2`

## Ollama

启用条件：

- `LOCAL_AI_GATEWAY_OLLAMA_MODEL`

常用变量：

- `LOCAL_AI_GATEWAY_OLLAMA_BASE_URL`
- `LOCAL_AI_GATEWAY_OLLAMA_ALIAS`
- `LOCAL_AI_GATEWAY_OLLAMA_LABEL`
- `LOCAL_AI_GATEWAY_OLLAMA_DISPLAY_NAME`
- `LOCAL_AI_GATEWAY_OLLAMA_CONTEXT_WINDOW`
- `LOCAL_AI_GATEWAY_OLLAMA_MAX_TOKENS`
- `LOCAL_AI_GATEWAY_OLLAMA_REASONING`

示例：

```bash
export LOCAL_AI_GATEWAY_OLLAMA_BASE_URL="http://127.0.0.1:11434"
export LOCAL_AI_GATEWAY_OLLAMA_MODEL="qwen2.5-coder:7b"
export LOCAL_AI_GATEWAY_OLLAMA_ALIAS="ollama-local"
```

## 默认模型切换

如果希望 OpenClaw 连接片段默认使用某个外部 provider 的模型别名，可额外设置：

```bash
export LOCAL_AI_GATEWAY_DEFAULT_MODEL_ALIAS="ollama-local"
```

该变量会把对应模型移动到注册表首位，并影响：

- `/healthz` 默认模型展示
- Electron 控制台中的默认模型信息
- OpenClaw 接入片段中的默认 `model`

## 配置优先级

如果同一项配置同时出现在环境变量和桌面端本地配置中，运行时优先采用环境变量。

这意味着：

- 桌面端适合本机长期使用
- 环境变量适合脚本化、临时覆盖或更严格的敏感信息管理

## 当前边界

- 当前版本只支持文本消息与工具调用，不支持图片、音频与 Responses API。
- Electron 控制台现已提供图形化 provider 配置、账号面板、诊断视图与最近错误视图。
- Electron 控制台中的 Codex 账号与 OpenClaw 授权卡片目前主要基于本地授权扫描与桌面端导入结果，额度与重置时间仍属于后续接入项。
- 会话切换仍只作用于 Codex provider；其他 provider 当前使用固定配置凭据。
