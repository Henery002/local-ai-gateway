# ADR 0002：复用 OpenClaw 会话作为首版认证来源

## 状态

已采纳

## 日期

2026-03-25

## 背景

首版目标是尽快打通本地网关到 Codex 的真实调用链路。当前本机已有 OpenClaw `openai-codex` OAuth 会话，可直接复用。

## 决策

首版认证来源固定为：

- 读取 `~/.openclaw/agents/*/agent/auth-profiles.json`
- 复用现有 `openai-codex` OAuth 会话
- access token 仅在运行时使用

不在首版引入：

- 独立登录流
- 自建账号体系
- 多账号池化

## 影响

- 可以最快打通真实上游链路
- 会对 OpenClaw 当前认证文件结构存在一定耦合
- 后续若上游格式变化，只需收敛在 `openclaw-session` 模块修正

