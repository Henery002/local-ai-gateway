# 最低可行公网共享方案 A / B 记录

> 初始记录：2026-05-19
> 最近更新：2026-05-20

本文记录后续“极小范围公网共享”的两个最低可行方案。当前只做方案沉淀，不代表已经实施、部署或开放公网入口。

截至 2026-05-20，三期公网最小可行版本的推荐结论是：

- 主方案：`Cloudflare Tunnel + 自有域名 + 当前本机 Local AI Gateway + 成员 API Key / AccessPolicy / 号池授权`。
- 备选 / 快速试验：`Tailscale Funnel + 当前本机 Local AI Gateway`。
- 入口边界：公网只暴露 OpenAI-compatible 推理面 `/v1/*`，管理面 `/admin/*` 继续保持本机管理，不把桌面管理端当公网产品外放。
- 运行形态：仍以当前 Mac 作为服务端，本机开机、网关运行、`cloudflared` 连接正常时才可用；本机离线、睡眠或网络阻断属于管理员自负责任。

## 1. 适用目标

目标不是公网商业化平台，而是：

- 10 人以下、邀请制、可信小范围使用；
- 仍以当前 Mac 上运行的 `Local AI Gateway` 作为服务端；
- 只有本机开机、网关运行、网络连通时才可用；
- 对外只暴露 OpenAI-compatible 推理面，管理面仍保持本机可用；
- 接入方通过 `base_url + api_key` 使用，适配 Codex、OpenClaw、Hermes、`cc_switch` 或任何支持自定义 OpenAI-compatible Provider 的第三方 Agent 工具；
- 必须继续使用成员 API Key、限额、过期时间、模型权限、号池授权、QPS / 并发、用量观测和告警做边界控制。

## 2. 方案 A：Cloudflare Tunnel

### 2.1 形态

在本机运行 `cloudflared tunnel`，把受控域名转发到本机网关推理端，例如：

```text
https://gateway.example.com/v1 -> http://127.0.0.1:8787/v1
```

接入成员拿到的是：

```text
base_url: https://gateway.example.com/v1
api_key: lagw_xxx
model: gpt-5.5 或项目内暴露的其他模型别名
```

Cloudflare Tunnel 的核心价值是：本机不需要公网 IP，也不需要路由器端口映射；`cloudflared` 从本机主动向 Cloudflare 建立出站连接，外部请求经 Cloudflare 回到本机服务。网络从公司 Wi-Fi 切到家里 Wi-Fi 后，公网域名通常保持不变，但会出现短暂重连窗口；真正的风险是某些公司网络可能阻断或干扰 `cloudflared` 出站连接。

### 2.2 为什么推荐它作为三期 MVP 主方案

- 外部用户体验最接近正式公网 API：固定域名、HTTPS、`base_url + api_key`。
- 不依赖家庭宽带公网 IP，不需要路由器端口转发。
- 本机换网后只要 `cloudflared` 能重新连上 Cloudflare，外部地址仍不变。
- 后续可以继续叠加 Cloudflare DNS、WAF / Rules、日志、告警、独立 server edition。
- 相比 Tailscale Funnel，更像一个可长期演进的公网产品入口。

### 2.3 需要准备

- Cloudflare 账号，并完成邮箱验证。
- 一个可托管到 Cloudflare 的域名。可以在 Cloudflare Registrar 购买，也可以从其他注册商买好后把 DNS 托管到 Cloudflare。
- 本机安装并登录 `cloudflared`。
- `Local AI Gateway` 已启用 API Key 鉴权，并为外部成员创建独立成员 Key。
- 成员策略已配置：额度包、过期时间、模型权限、号池授权、QPS / 并发。
- macOS 睡眠策略、电源和网络稳定性需要手动保障。

### 2.4 域名与付款建议

是否必须自有域名：

- 正式推荐路径：需要自有域名，至少需要一个 `gateway.example.com` 之类的 hostname。
- `trycloudflare.com` Quick Tunnel 不适合作为本项目三期 MVP 正式入口：它主要用于测试和开发，随机域名不稳定，且 Quick Tunnel 官方说明不支持 SSE；本项目的流式响应 / Agent 工具调用会依赖 SSE 或长连接语义，不能把 Quick Tunnel 当长期方案。

域名购买：

- 可以在 Cloudflare Registrar 购买域名。Cloudflare 官方要求账户邮箱验证；通过 Cloudflare Registrar 购买的域名使用 Cloudflare nameservers，不能改到其他 DNS provider 的 nameservers；当前不支持 IDN / Unicode 域名。
- 性价比顺序建议：`.com` 优先，其次 `.dev` / `.app`；不建议为了这个 MVP 买 `.ai`，通常成本偏高。
- 价格以 Cloudflare 结算页实时价格为准。做这个项目不需要高级品牌域名，短、可读、不暴露敏感业务含义即可。

付款：

- Cloudflare 官方账单 FAQ 列出的支付方式包括 Visa、Mastercard、American Express、Discover、PayPal、Apple Pay、Google Pay、Stripe Link 和 UnionPay。
- 未在官方 FAQ 里确认支付宝；如果只有国内普通借记卡，需要实际到结算页验证是否可用。带 Visa / Mastercard / UnionPay 标识的卡更稳。

### 2.5 实施步骤

#### 阶段 0：实施前确认

1. 先在二期 LAN 版本里确认成员 API Key、额度、模型权限、号池授权、策略到期、QPS / 并发都能生效。
2. 确认 `/admin/*` 仍只允许本机访问，非本机请求即使带 token 也不能访问管理面。
3. 创建一个专门用于公网试用的 `public-ready` 号池或共享号池，不把管理员自用 private 号池直接给公网成员。
4. 给每个公网试用成员创建独立 Key，不复用默认 Gateway Key。

#### 阶段 1：Cloudflare 账号与域名

1. 注册 / 登录 Cloudflare。
2. 准备域名：
   - 方案 1：在 Cloudflare Registrar 直接购买。
   - 方案 2：从其他注册商购买，把 DNS 托管到 Cloudflare。
3. 规划子域名，例如 `gateway.example.com`。
4. 保留一个“管理员自查用”的本机地址，例如 `http://127.0.0.1:8787`，不要把管理入口写进公开说明。

#### 阶段 2：本机安装并创建 Tunnel

可行命令草案如下，实施前以 Cloudflare 控制台生成命令为准：

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create local-ai-gateway-public
cloudflared tunnel route dns local-ai-gateway-public gateway.example.com
```

本机 `~/.cloudflared/config.yml` 可采用类似结构：

```yaml
tunnel: local-ai-gateway-public
credentials-file: /Users/henery/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: gateway.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

然后启动：

```bash
cloudflared tunnel run local-ai-gateway-public
```

可进一步把 `cloudflared` 配置成 macOS 登录项或后台服务，但第一版 MVP 可以先手动启动，降低自动化误配置风险。

#### 阶段 3：本项目侧需要补的产品化配置

最小实现不需要把 Cloudflare SDK 深度接入项目，但建议在三期开发中补这些 UI / 配置口子：

- `系统与诊断` 增加公网入口配置卡：
  - Provider：Cloudflare Tunnel
  - Public Base URL：`https://gateway.example.com/v1`
  - Tunnel 状态：未配置 / 运行中 / 无法检测 / 需人工确认
  - 管理面暴露风险：必须显示 `/admin/*` 仅本机
  - Streaming / SSE 验证状态
- `访问与密钥` 增加公网成员类型：
  - `public-user` 从二期拒绝态改为三期可启用态，但必须显式开关。
  - 每个成员必须独立 Key、独立额度、过期时间和号池授权。
- `号池与路由` 增加公网共享约束：
  - `public-ready` 号池只允许 `public-user` 或明确授权成员访问。
  - private 号池永远不自动参与公网共享。
- `用量与告警` 增加公网观察维度：
  - 成员 / Key / IP / 模型 / 号池趋势。
  - 401 / 403 / 429 / 5xx 聚合。
  - 单成员异常高频、额度接近耗尽、连续失败告警。
- `复制接入片段` 增加公网模板：

```json
{
  "base_url": "https://gateway.example.com/v1",
  "api_key": "lagw_xxx",
  "model": "gpt-5.5"
}
```

#### 阶段 4：外部验收

实施时至少跑以下验收：

```bash
curl https://gateway.example.com/v1/models \
  -H "Authorization: Bearer lagw_xxx"
```

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer lagw_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"ping"}],"stream":false}'
```

还需要验证：

- `stream: true` 能持续返回，不被 Cloudflare / 客户端中断。
- 无 Key、错 Key、暂停 Key、过期 Key 均被拒绝。
- 超额度、策略到期、模型拒绝、号池拒绝均按预期返回。
- `/admin/health`、`/admin/*` 从外网访问失败。
- `cc_switch`、Codex、自定义 Provider 工具均能用 `base_url + api_key` 接入。
- 公司 Wi-Fi 与家里 Wi-Fi 切换后，域名不变，但允许短暂重连；如果某个网络阻断 `cloudflared`，需要换网络或换备选方案。

### 2.6 成本与工期估算

最低现金成本：

- Cloudflare Tunnel：通常可从免费能力起步，具体以 Cloudflare 当前套餐规则为准。
- 域名：按年付费，通常是本方案的主要现金成本；选择普通 `.com` / `.dev` / `.app` 即可，价格以购买时结算页为准。
- 服务器：不新增云服务器，继续使用当前 Mac；代价是电费、网络、维护和本机稳定性。

工期估算：

- 仅部署试通：0.5 - 1 天。
- 加入项目内公网配置、诊断、模板、文档和回归测试：1 - 3 天。
- 做成更像产品的三期公网入口，包括成员类型切换、public-ready 号池治理、用量告警和引导式配置：3 - 7 天。

可能遇到的非代码门槛：

- Cloudflare 注册、邮箱验证、域名购买和支付方式验证。
- 域名注册信息填写和 ICANN 邮箱验证。
- 公司网络阻断 `cloudflared` 出站连接。
- 本机睡眠、Wi-Fi 切换、VPN、代理软件导致隧道断开。
- Agent 工具对流式响应、超时、错误码的兼容性不同，需要逐个验收。

### 2.7 安全边界

三期 MVP 必须守住：

- 不把 `/admin/*` 暴露给公网成员。
- 不使用 Cloudflare Access 的交互式登录保护 `/v1/*`，因为 Codex / Agent 工具通常只能发送 `Authorization: Bearer <api_key>`，不能处理浏览器 SSO 跳转。身份控制应由本项目成员 Key 执行。
- 不复用管理员自用 Gateway Key 给公网成员。
- 不把 Cockpit / OpenClaw 外部导入账号改为可刷新；外部导入账号继续保持 `external-readonly`。
- 公网试用成员必须有过期时间、额度包、QPS / 并发和共享号池限制。
- 日志和错误响应不要泄露本机路径、账号 refresh token、上游完整错误栈或内部配置。

## 3. 方案 B：Tailscale Funnel

### 3.1 形态

通过 Tailscale Funnel 把本机服务暴露为 HTTPS 地址，外部成员通过该地址访问当前网关推理面。

### 3.2 适用场景

- 不想先买域名；
- 想快速验证“本机开机即服务”的公网可达性；
- 只给 1-2 个可信成员短期试用；
- 接受后续迁移到 Cloudflare Tunnel 或 server edition。

### 3.3 需要准备

- Tailscale 账号；
- 本机安装并登录 Tailscale；
- 开启并配置 Funnel；
- `Local AI Gateway` 已启用 API Key 鉴权，并为外部成员创建独立成员 Key。

### 3.4 成本

- 小规模个人 / 团队试用通常可以低成本甚至零成本起步，具体以 Tailscale 当前套餐和 Funnel 规则为准；
- 不需要单独域名也能拿到可访问入口；
- 主要代价仍是本机开机、网络稳定和 Tailscale 账号侧配置维护。

### 3.5 风险与限制

- Funnel 可用性、流量策略和账号套餐能力可能随 Tailscale 规则变化，需要实施前复核；
- 对外地址、访问策略和组织配置不如正式域名 + Cloudflare Tunnel 可控；
- 仍不能绕过网关侧 API Key、成员限额、号池隔离和管理面隔离。

## 4. 最终推荐顺序

如果目标是 10 人以下、邀请制、本机开机即服务的公网 MVP：

1. 优先方案 A：Cloudflare Tunnel + 自有域名 + 独立成员 Key + 严格限额。
2. 仅做临时验证时使用方案 B：Tailscale Funnel。
3. 一旦进入更稳定或更大范围共享，迁移到独立 `server edition` / `public gateway`，不要直接把桌面管理端作为公网产品长期外放。

## 5. 与当前二期实现的关系

当前二期应继续把重点放在：

- `/v1/*` 推理面可被共享成员使用；
- `/admin/*` 管理面只允许本机访问；
- 成员 Key、AccessPolicy、号池授权、Token 统计和告警在本机闭环；
- 所有外部导入账号继续保持只读边界，不主动刷新 Cockpit / OpenClaw 的 refresh token。

方案 A / B 只是公网入口层。它们不能替代网关内的成员身份、额度、限流、风控和观测能力。

## 6. 官方资料快照

本节仅记录 2026-05-20 做方案校准时使用的官方资料入口，实施前仍需复核最新文档：

- Cloudflare Tunnel：<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/>
- Cloudflare Tunnel DNS routing：<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/>
- Quick Tunnels / TryCloudflare：<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>
- Cloudflare Registrar：<https://developers.cloudflare.com/registrar/get-started/register-domain/>
- Cloudflare Billing FAQ：<https://developers.cloudflare.com/billing/understand/faq/>
- Tailscale Funnel：<https://tailscale.com/docs/features/funnel>
