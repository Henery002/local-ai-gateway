# 三期 Cloudflare 公网联调复盘

> 记录日期：2026-05-21  
> 适用范围：`Local AI Gateway` 三期邀请制公网 MVP  
> 当前入口：`https://gateway.henery.top/v1`

## 1. 结论快照

截至 2026-05-25，三期公网共享链路已完成基础打通并进入 Trae / Codex 等第三方客户端公网试运行排障阶段：

- 外部域名 `gateway.henery.top` 已通过 Cloudflare Tunnel 回源到本机 `Local AI Gateway`。
- Cloudflare 路由已收紧到 `^/v1`，当前只转发 OpenAI-compatible 推理面。
- `/healthz` 和 `/` 外部访问返回 `404`，不再暴露本机健康诊断。
- `/v1/models` 无 Key 返回网关侧 `401 gateway_api_key_required`，说明公网请求已到达网关鉴权层。
- 本地系统已启用公网配置，并存在启用中的 `public-user`、独立公网成员 Key、`public-ready` 号池和额度策略。
- 网关公网面已支持 `/v1/models`、`/v1/models/:model`、`/v1/chat/completions`、`/v1/responses`、成员余额查询和 Codex / Cockpit 风格额度兼容查询。
- 2026-05-25 晚间 Trae 公网试运行暴露出两类运维问题：健康检查误重启会打断公网流式请求；额度预警告警混入请求审计会造成“失败请求”假象。两者均已在代码层补强并纳入回归测试。

当前剩余重点是：继续用 Trae / Codex / CC Switch 等真实客户端做公网长时间试运行，观察 Cloudflare Tunnel、桌面健康检查、本地网关常驻服务和号池调度在长流式请求下的稳定性。

## 2. 关键配置总览

| 项 | 当前值 |
| --- | --- |
| 域名注册商 | 阿里云 |
| 根域名 | `henery.top` |
| Cloudflare nameserver | `haley.ns.cloudflare.com` / `wells.ns.cloudflare.com` |
| Cloudflare 站点 | `henery.top` |
| Cloudflare plan | Free |
| Tunnel 名称 | `local-ai-gateway-dev` |
| Tunnel ID | `80184101-1eeb-4941-a17b-3f824390d50a` |
| Public Hostname | `gateway.henery.top` |
| Tunnel Path | `^/v1` |
| Tunnel Service URL | `http://127.0.0.1:8787` |
| DNS 记录 | `gateway.henery.top` CNAME -> `80184101-1eeb-4941-a17b-3f824390d50a.cfargotunnel.com` |
| 本项目 Public Base URL | `https://gateway.henery.top/v1` |
| 本机网关端口 | `8787` |
| 本地公网成员类型 | `public-user` |
| 公网号池可见性 | `public-ready` |

## 3. 时间线与操作记录

### 3.1 域名选择与购买

本轮选择了性价比优先方案：在阿里云购买 `henery.top`，首年费用 1 元。

选择依据：

- `henery` 与用户英文名一致，便于个人 MVP 识别。
- `.top` 首年价格极低，适合早期验证，不把成本花在长期品牌域名上。
- 本项目当前目标是邀请制公网 MVP，不是正式 SaaS 品牌站。

注意事项：

- 购买后域名会经历注册局审核，审核完成前不能作为 Cloudflare Tunnel 的正式 Public Hostname 使用。
- 后续如果进入长期运营，应重新评估续费价格、品牌可信度和滥用风险。

### 3.2 Cloudflare 账号与 Zero Trust 激活

已完成 Cloudflare 登录、Zero Trust Free 激活和绑卡。

当时的判断：

- Cloudflare Free / Zero Trust Free 可以支撑本轮 Tunnel MVP。
- 绑卡本身不等于立即扣费，但未来如果开启付费能力、超出免费套餐、注册域名或购买增值功能，仍可能产生账单。
- `/v1/*` API 客户端不适合套 Cloudflare Access / SSO 交互式登录；身份边界应由本项目成员 API Key 控制。

### 3.3 创建 Tunnel connector

Cloudflare 控制台创建 Tunnel 后，使用控制台复制的 token 命令在本机运行：

```bash
cloudflared tunnel run --token <cloudflare-dashboard-token>
```

观测到的状态：

- Tunnel 名称：`local-ai-gateway-dev`
- Tunnel ID：`80184101-1eeb-4941-a17b-3f824390d50a`
- Connector 状态：connected
- 架构：`darwin_arm64`
- cloudflared 版本：`2026.5.0`
- 曾观测到的 edge location：`nrt12`、`nrt08`

运行方式说明：

- 开发阶段先由用户在自己的 Terminal 中保持 `cloudflared` 前台运行。
- Codex 终端后台进程不适合作为长期 connector 守护方式。
- 后续若需要“本机开机即服务”，再明确注册为 macOS 后台服务或登录项；这会持久化 token 和本机服务配置，需要单独确认。

### 3.4 将阿里云域名接入 Cloudflare

Cloudflare 添加站点 `henery.top` 后，Cloudflare 分配 nameserver：

```text
haley.ns.cloudflare.com
wells.ns.cloudflare.com
```

随后在阿里云域名控制台修改 DNS 服务器为上述 nameserver。

注意事项：

- 修改 nameserver 后，Cloudflare 可能短时间显示 `Invalid nameservers` 或 `Waiting for registrar to propagate`。
- `dig +short NS henery.top` 在传播窗口内可能仍返回旧阿里云 NS，例如 `dns11.hichina.com / dns12.hichina.com`。
- 最终以 Cloudflare 站点状态、Public Hostname 可解析和实际公网请求结果共同判断。

### 3.5 创建 Tunnel Public Hostname

在 Cloudflare Tunnel 的 Routes / Public Hostname 中创建路由：

```text
Hostname: gateway.henery.top
Service:  http://127.0.0.1:8787
```

首次创建时 Path 为空，外部访问 `https://gateway.henery.top/healthz` 能返回网关健康诊断，这会暴露运行状态、用量、账号池观测等敏感运维信息。

修正后配置为：

```text
Hostname: gateway.henery.top
Path:     ^/v1
Service:  http://127.0.0.1:8787
```

Cloudflare 确认 DNS 记录：

```text
Type: CNAME
Name: gateway.henery.top
Points to: 80184101-1eeb-4941-a17b-3f824390d50a.cfargotunnel.com
```

关键经验：

- Cloudflare Service URL 必须保持本地根服务 `http://127.0.0.1:8787`。
- 不要在 Service URL 中写 `/v1`。
- 用 Path `^/v1` 收紧入口范围，客户端 Base URL 使用 `https://gateway.henery.top/v1`。

### 3.6 本地 Local AI Gateway 配置

本地系统侧已完成：

- 启用公网共享配置。
- Public Base URL：`https://gateway.henery.top/v1`
- Provider：Cloudflare Tunnel
- Hostname：`gateway.henery.top`
- 创建 `public-ready` 号池。
- 创建启用中的公网成员，类型为 `public-user`。
- 为公网成员创建独立成员 API Key。
- 配置额度包、过期时间、模型权限和号池授权。

本轮发现并修复了一个产品口子：

- 访问成员弹窗此前默认创建 `lan-member`，即使成员名称叫 `public-user`，实际类型仍是 `lan-member`。
- 这会导致系统诊断显示“缺少启用中的公网成员”。
- 已补“成员类型”选择，并将现有公网成员修正为真正的 `public-user`。

### 3.7 当前验收结果

已验证：

```bash
curl -I --max-time 10 https://gateway.henery.top/healthz
```

结果：`404`

```bash
curl -I --max-time 10 https://gateway.henery.top/
```

结果：`404`

```bash
curl --max-time 10 https://gateway.henery.top/v1/models
```

结果：`401 gateway_api_key_required`

含义：

- Cloudflare 只把 `/v1/*` 转发给本机网关。
- 非 `/v1` 路径没有进入本机网关敏感诊断面。
- `/v1/models` 已进入网关鉴权层，缺少 API Key 时被拒绝。

待验证：

```bash
curl https://gateway.henery.top/v1/models \
  -H "Authorization: Bearer <公网成员 API Key>"
```

```bash
curl https://gateway.henery.top/v1/chat/completions \
  -H "Authorization: Bearer <公网成员 API Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"codex-default","messages":[{"role":"user","content":"ping"}],"stream":false}'
```

```bash
curl https://gateway.henery.top/v1/chat/completions \
  -H "Authorization: Bearer <公网成员 API Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"codex-default","messages":[{"role":"user","content":"ping"}],"stream":true}'
```

## 4. 安全边界复盘

必须保持：

- Cloudflare route 只匹配 `^/v1`。
- `/admin/*` 不创建 Cloudflare route。
- `/healthz` 不对公网暴露。
- 公网成员只使用 `public-user` 类型成员 Key。
- 公网成员只授权 `public-ready` 号池。
- 默认 Gateway Key、管理员本机 Key、LAN 成员 Key 不用于公网成员分发。
- 公网成员请求会经过网关代码层 payload guard：body、消息数、工具定义、工具 schema、单条文本和工具结果长度均有前置限制，超限不进入上游账号。
- 公网成员默认单请求输入估算上限为 `1050000`、输出上限为 `128000`；成员策略可进一步配置 `maxInputTokens / maxOutputTokens`。
- 同一上游账号按 `accountId / email / sessionId` 聚合并发和近 60 秒准入次数，默认公网成员单账号并发为 `16`、近 60 秒准入为 `240`；多把公网成员 Key 仍不会绕过该账号级高水位保险丝。
- 不启用 Cloudflare Access / SSO 保护 `/v1/*`，避免 Agent 客户端无法处理浏览器登录跳转。

## 5. 2026-05-25 Trae 公网试运行排障记录

### 5.1 22:33 前后 Trae 请求瞬断

现象：

- 用户在 Trae 公网 Provider 环境下继续使用本网关，约 `2026-05-25 22:33` 前后出现请求失败。
- Cloudflare / 本地日志中可见 origin `EOF`、`Unexpected end of JSON input` 与网关 `SIGTERM` / `gateway_started` 接近同时出现。

关键证据：

- `inference_usage_events` 中 `22:33:07`、`22:33:16`、`22:33:49`、`22:33:59` 多条 `codex-5.5` 请求均为 `ok=1`，说明上游模型和号池账号当时不是整体不可用。
- `event_logs` 中 `22:33:36.991` 出现 `Unexpected end of JSON input`。
- 紧接着 `22:33:37.063` 和 `22:33:37.775` 网关收到 `SIGTERM` 并重启。
- `request_content_audit_events` 中 `22:34:13` 有请求内容审计记录，但缺少对应完整 usage 完成记录，符合请求进入网关后被重启打断的特征。

结论：

- 本次不是上游模型集中限流，也不是成员 Key 本身失效。
- 根因更接近本地网关在公网请求过程中被管理 / 健康检查 / 自动接管逻辑重启，导致 Trae 端看到 EOF、连接中断或 JSON 解析失败。

已落地修复：

- `/admin/service/restart` 增加活跃推理保护：存在进行中推理时默认返回 `409 service_restart_inference_active` 与 `Retry-After`，不再立即 `process.exit(75)`。
- 桌面端“重启服务”、运维页网关操作、托盘“重启本地网关”均接入同一层保护。
- 请求失败日志补充 `requestPath`、`requestMethod`、`clientTag`、`userAgent`、`contentLength` 等排障字段。
- 对应提交：`899137d 增强网关重启请求保护`。

### 5.2 23:22 前后请求审计红框“失败”误报

现象：

- 用户在“请求审计明细”中看到同一时间附近出现一条 `access_policy_total_quota_warning`，状态显示为失败，账号显示“未归因账号”，Token 和延迟均为 0。
- 该条记录容易被误判为 Trae 推理失败。

关键证据：

- 同一秒 `2026-05-25 23:22:18` 的真实 `inference_usage_events` 存在一条成功请求：成员 `weifanguang`，模型 `codex-5.5`，stream，号池 `pool-mpf47s1p-w7fyiq`，上游账号 `1831552107@qq.com`，Token 约 `24.4K`，延迟约 `9682ms`，`ok=1`。
- 红框记录实际来自 `access_alert_events` 中的 `access_policy_total_quota_warning`，details 显示总额度上限 `100000000`、已用 `30387432`、比例约 `30.4%`。

结论：

- 红框不是一次真实失败推理，而是“成员总额度接近阈值”的预警告警。
- 早期拒绝审计为了补全未进入上游的失败请求，会把 `access_alert_events` 合并到请求审计；但 `*_warning` 预警类告警不应被当成失败请求展示。

已落地修复：

- 请求审计查询排除 `type LIKE '%_warning'` 的访问告警，只保留真正阻断 / 失败类告警作为失败审计补充。
- 新增回归测试，覆盖额度预警不进入请求审计失败明细。
- 对应提交：`64cb24e 修复请求审计误报与健康检查误重启`。

### 5.3 23:23 / 23:24 健康检查误重启

现象：

- 继续观察时发现 `23:23:41`、`23:24:21` 附近仍有本地网关 `SIGTERM` / `gateway_started`。
- 日志显示触发前是桌面端 / 本机 `node` 对 `/healthz` 的请求出现 `Unexpected end of JSON input` 或 `Unterminated string in JSON`。

关键证据：

- `event_logs` 中 `2026-05-25T15:23:41Z`：`requestPath=/healthz`，`userAgent=node`，错误 `Unexpected end of JSON input`，随后 `gateway_shutting_down` 和 `gateway_started`。
- `event_logs` 中 `2026-05-25T15:24:21Z`：`requestPath=/healthz`，`userAgent=node`，错误 `Unterminated string in JSON at position 8192`，随后再次 `gateway_shutting_down` 和 `gateway_started`。
- 手动连续 `curl http://127.0.0.1:8787/healthz` 多次均返回 `200`，说明 `/healthz` 不是永久不可用，而是健康检查链路的瞬时读取 / 解析异常被过度处理。

结论：

- 公网间歇报错的另一条主线是桌面端健康检查把一次瞬时 `/healthz` 异常误判为网关不可用，并自动接管 / 重启监听中的本网关进程。
- 对公网流式请求而言，这类“误重启”比单次健康检查失败更危险，会直接打断 Trae / Codex 客户端的长请求。

已落地修复：

- 桌面端 `ensureRunning()` 在 `/healthz` 不健康但端口仍有本网关进程监听时，不再杀掉该进程并重启，而是保留现有进程，避免误伤公网请求。
- 对应提交：`64cb24e 修复请求审计误报与健康检查误重启`。

### 5.4 当前操作建议

- 开发环境要加载上述修复，需要在没有 Trae / Codex 活跃请求时重启当前 dev 桌面端 / 网关进程。
- 不要在公网成员正在流式请求时点击“重启服务”“一键修复”“重启 Tunnel”或直接 `Ctrl+C` 终端。
- 如果必须重启，先让客户端请求结束，再停旧进程并重新 `yarn dev:desktop`。
- 后续如继续出现 Trae 端报错，应优先对齐三个时间源：Trae 错误时间、`event_logs` 中 `request_failed` / `gateway_shutting_down`、`inference_usage_events` 中同时间是否有 `ok=0` 或缺失 completion 的 request audit。
- 本机睡眠、网络切换、`cloudflared` 退出都会影响公网可用性。

## 6. 常见问题与经验

### 6.1 为什么 Cloudflare Service URL 不写 `/v1`

Tunnel 的 Service URL 表示回源服务根地址，本机网关服务根是 `http://127.0.0.1:8787`。客户端请求路径会原样带到回源服务，Cloudflare Path `^/v1` 负责匹配允许转发的路径。因此：

- 正确：Service `http://127.0.0.1:8787` + Path `^/v1`
- 错误：Service `http://127.0.0.1:8787/v1`

### 6.2 为什么不能空 Path

空 Path 表示该 hostname 下所有路径都转发到本机服务。实际观测中，空 Path 会让：

```text
https://gateway.henery.top/healthz
```

直接返回本机健康诊断。这不符合公网只暴露推理面的边界。

### 6.3 为什么公网成员必须是 `public-user`

服务端执行层会区分成员类型：

- `public-user` 只能在公网共享启用且 Public Base URL 为 HTTPS 时进入推理链路。
- `public-user` 只能使用 `public-ready` 号池。
- `lan-member` 不能使用 `public-ready` 号池。
- 非成员上下文的默认 Gateway Key 不能直连 `public-ready` 号池。

因此，仅把成员命名为 `public-user` 不够，实际 `type` 必须保存为 `public-user`。

### 6.4 重启后为什么要注册 LaunchAgent

2026-05-21 晚间重启后，公网测试出现 Cloudflare `1033` / `502`。本地排查结论：

- 本地网关 `http://127.0.0.1:8787/healthz` 正常返回 `200`，说明网关进程本身可用。
- 公网 `https://gateway.henery.top/v1/models` 返回 Cloudflare `1033`，说明 Cloudflare 侧没有健康在线的 tunnel connector。
- 手动 `cloudflared tunnel run --token ...` 在当前网络下默认 QUIC / UDP 曾出现超时；改用 `--protocol http2 --edge-ip-version 4` 后可以注册 tunnel connection。
- Codex 工具环境里的普通后台进程不能作为长期常驻方式，实际公网会很快退回 `502`。

已将 `cloudflared` 注册为 macOS LaunchAgent：

- Label：`com.local-ai-gateway.cloudflared`
- Plist：`~/Library/LaunchAgents/com.local-ai-gateway.cloudflared.plist`
- Token file：`~/Library/Application Support/local-ai-gateway/cloudflared/local-ai-gateway-dev.token`
- Log：`~/Library/Application Support/local-ai-gateway/cloudflared/local-ai-gateway-dev.log`
- 启动参数：`tunnel --protocol http2 --edge-ip-version 4 --loglevel info --logfile <log> run --token-file <token-file>`

验收口径：

- `launchctl print gui/$(id -u)/com.local-ai-gateway.cloudflared` 应显示 `state = running`。
- `https://gateway.henery.top/v1/models` 无 Key 应返回网关侧 `401 gateway_api_key_required`。
- `https://gateway.henery.top/healthz` 应返回 Cloudflare 侧 `404`，避免暴露本机健康诊断。

2026-05-22 继续补齐本地网关常驻：

- Label：`com.local-ai-gateway.gateway`
- Plist：`~/Library/LaunchAgents/com.local-ai-gateway.gateway.plist`
- Launcher：`~/Library/Application Support/local-ai-gateway/service/gateway-launcher.mjs`
- Log：`~/Library/Application Support/local-ai-gateway/logs/gateway-service.out.log` / `gateway-service.err.log`
- 行为：登录后自动拉起本地网关；启动前定向清理旧的本项目网关进程，避免开发环境、安装版和 LaunchAgent 重复监听 `8787`。

桌面端新增“运维与日志”页，用于查看网关常驻、Cloudflare Tunnel、公网 `/v1/models` 探测和日志 tail，并提供网关 / Tunnel 重启入口。

## 7. 后续建议

短期：

1. 用其他 Agent 客户端配置：
   - Base URL：`https://gateway.henery.top/v1`
   - API Key：公网成员专属 Key
   - Model：`codex-default` 或已授权模型别名
2. 验证 `/v1/models`、非流式对话和 `stream: true`。
3. 观察“用量与告警”和“消息通知”是否正确归因到公网成员。
4. 如果测试失败，优先按 401 / 403 / 429 / 5xx 分类排查成员 Key、模型权限、号池授权、额度、账号级安全阀、cloudflared LaunchAgent 和上游账号状态。

中期：

1. 继续观察两个 LaunchAgent 在重启、睡眠唤醒和网络切换后的稳定性：`com.local-ai-gateway.gateway` 负责本地网关，`com.local-ai-gateway.cloudflared` 负责公网 Tunnel。
2. 补更清晰的公网引导向导，减少 Cloudflare 配置路径误填。
3. 增加公网入口外部探测状态，但不要在探测中暴露真实 API Key。
4. 进入更稳定共享后，评估独立 `server edition` / `public gateway`，不要长期把桌面管理端作为公网产品外放。
