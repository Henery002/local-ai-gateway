# OpenClaw 接入与运行说明

本文档说明如何在本地启动 `Local AI Gateway`，以及如何让 OpenClaw 通过本地地址接入。

## 1. 环境要求

建议环境：

- macOS
- Node.js 22
- npm 10+
- 已存在可用的 OpenClaw `openai-codex` OAuth 会话

## 2. 安装依赖

在项目根目录执行：

```bash
npm install
```

## 3. 构建项目

```bash
npm run build
```

如需一键验证基础链路，可执行：

```bash
npm run smoke:gateway
```

## 4. 启动方式

### 4.1 启动 gateway 服务

```bash
npm run dev:gateway
```

默认监听地址：

```txt
http://127.0.0.1:8787
```

如果你在桌面端 `诊断 -> 系统配置` 中修改了网关端口，请将文档中的 `8787` 替换为你设置的新端口。

### 4.2 启动 Electron 控制台

```bash
npm run dev:desktop
```

Electron 会优先检查本地 gateway 是否已运行；若未运行，会尝试拉起受管服务。

如果你希望完全不走终端配置 provider，可直接在桌面端的 `Provider 配置` 区块填写 OpenAI-compatible / Ollama 参数，再点击“保存并重启服务”。

如果你希望在本应用内直接接入新的 Codex 账号，也可以使用桌面端的：

- 浏览器 OAuth 导入
- 本地 JSON / `auth-profiles.json` 文件导入

## 5. OpenClaw 接入

OpenClaw 侧需要将 provider 指向本地 OpenAI-compatible 地址。

最小接入片段：

```txt
provider=openai
baseUrl=http://127.0.0.1:8787/v1
model=codex-default
```

如果启用了额外 provider，也可以改用桌面端控制台中展示的其他模型别名，例如：

- `openai-compatible-default`
- `ollama-default`

## 6. 验证方法

### 6.1 健康检查

```bash
curl http://127.0.0.1:8787/healthz
```

### 6.2 模型列表

```bash
curl http://127.0.0.1:8787/v1/models
```

### 6.3 非流式聊天

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex-default","messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

### 6.4 流式聊天

```bash
curl -N -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex-default","stream":true,"messages":[{"role":"user","content":"Reply with exactly OK."}]}'
```

### 6.5 一键 smoke 回归

```bash
npm run smoke:gateway
```

该脚本会验证：

- 健康检查
- 模型列表
- 非流式聊天
- 工具调用
- Admin 健康接口
- Admin 会话列表

## 7. 会话切换

当前活动会话可通过 Electron 控制台切换，也可通过 Admin API 切换。

当前会话来源可能包括：

- OpenClaw 现有本地会话
- 桌面端导入的本地 Codex 账号

Admin API 需要本地 `admin token`，该值存放于：

```txt
~/Library/Application Support/local-ai-gateway/config.json
```

## 8. 日志与数据位置

本地运行数据默认位于：

```txt
~/Library/Application Support/local-ai-gateway/
```

其中包括：

- `config.json`
- `codex-auth-profiles.json`
- `gateway.db`
- `logs/gateway.log`

## 9. 常见问题

### 9.1 没有发现可用会话

请确认：

- `~/.openclaw/agents/*/agent/auth-profiles.json` 存在
- 至少有一个 `provider=openai-codex` 的 profile
- profile 中存在 `access`、`refresh`、`expires`

### 9.2 上游返回认证错误

通常表示：

- OpenClaw 现有会话已过期且刷新失败
- 本地 OAuth 资料不完整
- 上游接口协议发生变化

优先排查：

- OpenClaw 中对应账号是否仍可正常使用
- `auth-profiles.json` 中相关 profile 是否完整

### 9.3 Electron 启动但页面无数据

请优先检查：

- gateway 是否已成功构建
- `config.json` 是否已生成
- `admin token` 是否可读取
- 当前网关端口是否被其他程序占用（默认 `8787`，可在系统配置中改）
