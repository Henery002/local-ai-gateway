# Changelog

本文件用于记录 `Local AI Gateway` 项目的所有重要变更，包括新增需求、设计调整、功能开发、缺陷修复、调试结论与优化事项。

记录规则：

- 所有后续改动都必须同步更新本文件
- 按日期降序排列，新的记录放在最上方
- 同一天内的内容收敛到同一个时间戳条目下
- 每条记录尽量简短，只保留便于回溯的关键信息

## [2026-05-25 11:58 CST]

### 调整

- Grid.js 表格规范层加厚：表格字号提升到系统正文级，边框色加深，增加奇偶行底色、hover 高亮、横向滚动和弹窗宽度上限扩展，避免明细表格与系统视觉割裂或列宽挤压。
- 第二批列表迁移到 Grid.js：访问成员列表、号池列表、消息通知列表和用量告警事件列表开始使用统一表格渲染，保留现有操作按钮、筛选条件、告警确认、成员编辑和号池编辑入口。

### 说明

- 本轮仍只调整桌面端展示层，不写入、不迁移、不清空任何成员、Key、号池、账号资产、Token 用量或告警事件数据；账号资产主表因批量选择、账号状态和额度观测交互更重，留到下一批单独迁移。

## [2026-05-25 11:27 CST]

### 新增

- 桌面端引入 Grid.js 作为明细表格第一阶段组件库，按静态资源方式加载，不迁移 React / Vite，不改变现有 Electron 架构和本地持久化数据。
- 第一批低风险明细列表已切换为 Grid.js 渲染：请求审计明细、账号级 Token 用量明细、路由命中明细和最近错误日志弹窗。表格支持排序、分页和当前明细搜索，Grid.js 加载失败时保留原 HTML 明细兜底。

### 测试

- 扩展桌面构建回归测试，覆盖 Grid.js 静态入口、通用表格适配层和第一批明细容器。

## [2026-05-25 01:05 CST]

### 新增

- “用量与告警”可视化增强切片 1：桌面端引入 ECharts，核心 Token 趋势、Token 构成和观测排行优先使用专业图表渲染；图表库加载失败时仍保留原 DOM/SVG 兜底内容。
- “窗口用量结构”新增成员筛选入口，可基于现有 `usageSummary` 对成员、成员趋势和 Access Key 归因做本地聚焦观察；后续更细模型 / 号池按成员过滤将由 analytics API 承接。
- 用量趋势扩展到近 7 天和近 30 天：`weekly / monthly` summary 现在输出按天聚合的成员、模型、Access Key 和号池 timeline，供图表时间窗口切换使用。
- 新增只读用量分析接口 `GET /admin/usage/analytics`，支持 `range / granularity / clientFilter / consumerId / accessKeyId / modelAlias / poolId / outcome` 查询参数，便于后续图表按成员、Key、模型、号池和成功 / 失败状态做精细过滤。
- 桌面端“用量与告警”第一屏新增成员健康度横向大卡片，默认展示当前筛选成员或最近调用成员，按成功率、失败量、平均延迟和近 7 天告警数量给出健康分与语义状态。
- 桌面端用量图表刷新链路已优先消费 `/admin/usage/analytics`：刷新、后台轮询、时间窗口切换和成员筛选都会同步拉取精细分析数据；旧 `usageSummary` 继续作为兼容兜底。
- “窗口用量结构”筛选条扩展到成员、模型、Access Key、号池和请求结果，多维筛选会统一驱动 analytics 查询与 ECharts 看板刷新。
- 成员健康度从单成员卡片扩展为“成员健康矩阵”，按风险优先展示成员健康分、Token / 请求量、失败次数、近 7 天告警数和最近活跃时间；点击矩阵行可直接聚焦该成员。
- 主趋势图新增指标切换：可在 Token、请求数、失败数、失败率和平均延迟之间切换观察；指标切换只重绘当前已加载的分析数据，不额外触发写入或重置历史用量。
- 主趋势图 tooltip 按指标输出单位：Token 以 Token 展示，请求 / 失败以次数展示，失败率以百分比展示，平均延迟以毫秒展示，减少多指标切换后的读数歧义。
- 用量看板新增当前筛选摘要条和数据提示条：窗口、观测方式、指标、成员、模型、Key、号池和请求结果会以 chip 形式展示；当当前筛选暂无请求、暂无 Token、暂无失败或暂无成功延迟时给出明确解释。
- Token 构成图和排行图新增 ECharts 内部空态：当前筛选没有可绘制构成或排行时，图表区域直接展示“当前视角暂无 Token 构成 / 排行数据”，避免空画布误导。
- 主趋势图新增指标统计条：按当前指标展示峰值、窗口合计或均值、时间桶均值和最新非零值，切换 Token / 请求数 / 失败数 / 失败率 / 平均延迟时会自动换算单位。
- 补齐存量统计图表 ECharts 迁移：总览 Token 分布、账号资产页账号级 Token 用量排行、用量页请求结果和延迟稳定性图均优先使用 ECharts 渲染，原轻量 DOM 图表继续作为加载失败时的降级兜底。
- “窗口用量结构”筛选区调整为两行布局：第一行居右放置观测方式，第二行整行承载成员、模型、Key、号池、结果和指标筛选，减少图表标题区拥挤。
- 成员健康分卡片补齐语义色：左侧“成员健康度”标签改为独立 pill 样式，右侧分数按健康状态使用成功、活跃、警告或危险色，避免标签宽度和分数视觉失衡。

### 修复

- 请求审计列表在 usage 事件和访问告警同一毫秒产生时，优先展示已有关联请求正文的条目，避免“查看内容”误拿到无正文的告警事件而返回 404。
- 修复用量筛选区和小图表布局问题：“窗口用量结构”的筛选表单横向独占一行，请求结果 / 延迟稳定性图改为等宽展示。
- 调整用量看板图表排布：成员观测排行与 Token 构成合并为同一行，左侧排行占 2/3，右侧 Token 构成占 1/3。
- 运维与诊断界面继续收敛大列表：账号级 Token 明细、路由命中明细和最近错误日志改为弹窗详情，主区域只保留摘要和入口。
- 运维页高级服务控制去除与顶部操作重复的复制片段 / 日志入口，仅保留低频常驻安装和网关手动启停。
- 系统诊断弹窗内容样式压平，减少弹窗标题与内部卡片标题重复、过宽多列说明导致的排版异常。

### 文档

- 新增《用量与告警可视化增强方案》，记录 ECharts 选型、切片计划、成员健康度方向，以及“不重置、不删除现有业务数据”的持久化边界。

### 测试

- 扩展桌面构建回归测试，覆盖 ECharts 入口、成员筛选、趋势指标切换、筛选摘要、数据提示、趋势统计条和核心图表管理 hook。
- 扩展 gateway 回归测试，覆盖 weekly / monthly 用量摘要输出按天聚合的成员 timeline，以及 analytics API 的成员、Key 和失败状态筛选。

## [2026-05-23 18:20 CST]

### 新增

- 运维模块新增第一版“账号健康与路由解释”能力：`GET /admin/routing/account-health` 基于现有号池运行态汇总账号可用性、冷却、低额度、最近失败分类、健康分、当前选中账号和号池候选情况。
- 桌面端“运维与日志”页新增账号健康面板，展示账号总数、可用 / 冷却 / 异常 / 已选中数量、单账号健康分、额度百分比、连续失败、归属号池，以及每个号池的当前选择原因和最近切号事件。
- 请求审计继续补齐早期拒绝请求：`/admin/requests/audit` 现在会把 `AccessPolicy`、公网 payload guard、成员 Key 状态、账号安全阀等在上游调用前产生的 `access_alert_events` 合并为 `sourceKind=access-alert` 的失败审计项。
- 早期拒绝审计项只保存路径、方法、模型别名、成员、Key、号池、错误码和状态码等排障元数据，不保存 prompt 正文、messages、完整 API Key、OAuth token 或上游响应 body；同时不写入 `inference_usage_events`，避免污染 Token 用量统计。

### 说明

- 本轮只做只读观测层，不改变号池选择算法、冷却阈值、成员策略、Key、账号资产或持久化数据；后续调度策略变更需要单独建测试和回归。

### 测试

- 新增 gateway 回归测试，覆盖号池成员发生 quota failover 后，账号健康接口能返回健康账号优先、冷却账号失败分类、号池选择原因和最近切号事件。
- 新增 gateway 回归测试，覆盖成员日额度超限这类未触达上游的早期拒绝会出现在请求审计中，且审计项不包含请求正文或密钥明文。

## [2026-05-23 17:45 CST]

### 新增

- 运维模块新增第一版“请求审计”能力：`GET /admin/requests/audit` 可按状态、成员、Access Key、号池、账号、模型、Provider 和时间窗口筛选最近推理请求。
- 桌面端“运维与日志”页新增请求审计面板，展示请求数、成功 / 失败、Token、平均延迟以及最近请求列表；审计列表只读取本项目本地 `inference_usage_events`，不记录、不展示 prompt 正文、messages、完整 API Key 或 OAuth token。

### 测试

- 新增 gateway 回归测试，覆盖请求审计 API 的成员 / Key / 模型 / 账号 / 状态筛选、统计汇总和敏感字段不返回。

## [2026-05-23 15:10 CST]

### 修复

- 修复 Codex App / CC Switch 在 Cockpit Tools 与 Local AI Gateway 公网 Provider 之间切换后，继续另一侧既有会话时可能触发的 Responses `input[].call_id` 超长问题：OpenAI-compatible 转换层和 Codex Responses 上游回放层现在会把超 64 字符的 `call_id / tool_call_id` 稳定归一为短 ID，并保持同一请求内 `function_call` 与 `function_call_output` 对齐。
- Codex provider 不再把官方 Responses SSE 的 `call_id|item_id` 复合串作为对外工具调用 ID 写回客户端，避免后续会话历史携带过长、Provider 私有化的工具调用标识。

### 文档

- 记录 Cockpit Tools `v0.24.4` 对本网关后续公网产品化值得采纳的参考项：请求日志检索、Key 级模型策略、会话亲和与账号健康路由、`/backend-api/codex/*` 与 WebSocket 兼容面、图片 API 能力门控、上游代理诊断。
- 在第三方客户端接入文档中补充跨 Provider 存量会话连续性的边界：新会话切换已可用；既有会话仍可能受另一服务已写入历史中的 provider-specific ID / response ID / tool call ID 影响，本网关已对自身出入口和回放路径做兼容保护，但无法直接修补 Cockpit 已发出的回放请求。

### 测试

- 新增 `openai-compat` 与 `provider-codex-stream` 回归测试，覆盖 Responses -> Chat、Chat -> Responses、Codex 官方 Responses 回放三个方向的超长工具调用 ID 归一。

## [2026-05-23 01:10 CST]

### 新增

- 公网成员推理面补充 CC Switch 兼容的成员额度查询接口：`GET /user/balance` 与 `GET /v1/user/balance`。接口复用现有成员 API Key 鉴权，只返回该成员 / Key 在本网关内的周期包、总量包、日包或月包 Token 用量与剩余额度，不查询也不暴露上游 Codex 账号真实账单。
- 公网成员推理面补充 Codex / Cockpit 风格额度兼容接口：`GET /backend-api/wham/usage`、`GET /v1/backend-api/wham/usage`、`GET /dashboard/billing/credit_grants`、`GET /v1/dashboard/billing/credit_grants`。返回值仍来自本网关成员额度包，只作为第三方自定义 Provider 额度展示兼容层。
- 补充 OpenAI-compatible 单模型查询：`GET /v1/models/:model`，返回与 `/v1/models` 列表内 `data[]` 一致的模型对象，并复用成员模型权限校验。

### 文档

- 在第三方客户端接入文档中新增 CC Switch Usage Query 配置建议：公网 Base URL 使用 `https://gateway.henery.top/v1` 时，通用余额查询会命中 `/v1/user/balance`；该数值表示成员包额度，不代表上游账号官方剩余额度。补充 Cockpit Tools 观测结论：当前 Cockpit 自定义 API_KEY 卡片不会自动调用自定义 Provider 额度接口，卡片仍可能显示“暂无配额数据”。

### 测试

- 新增 gateway 回归测试，覆盖 `/user/balance`、`/v1/user/balance`、`/v1/backend-api/wham/usage`、`/v1/dashboard/billing/credit_grants` 的公网成员余额计算，以及 `/v1/models/:model` 成功与未知模型 `404 model_not_found`。

## [2026-05-22 13:14 CST]

### 修复

- 继续修复 Codex App 经 CC Switch 切到 `Local AI Gateway 公网` 后显示 Reconnecting / high demand 的问题：模型 `gpt-5.5` 已能通过公网成员策略和 `/v1/responses` 返回 `200`，新的根因收敛为 Responses SSE 事件形态不够贴近 Codex Desktop。
- Responses SSE 兼容层补齐 Codex Desktop 期望的完整事件序列：`response.created`、`response.in_progress`、`response.output_item.added`、`response.content_part.added`、`response.output_text.delta`、`response.output_text.done`、`response.content_part.done`、`response.output_item.done`、`response.completed`。
- 修正 `response.output_text.delta` 使用 `response_id` 的兼容问题：现在改为使用与最终 message output item 对齐的 `item_id`，并补充 `sequence_number / logprobs` 等字段，降低 Codex Desktop parser 收到 200 但无法形成有效输出的风险。
- 修复本机 CC Switch 的 `Local AI Gateway 公网` Provider 再次被短模板覆盖的问题：已恢复完整 Codex 配置段并保留当前选择的 `model = "gpt-5.5"`；切换脚本也改为从 CC Switch 目标 Provider 读取当前模型，不再强制改回 `codex-default`。

### 验证

- 已执行 `npm test -- tests/openai-compat.test.ts tests/gateway-app.test.ts`（76 项通过）、`npm run typecheck`、`npm run build` 与 `npm run package:desktop`。
- 已覆盖安装 `/Applications/Local AI Gateway.app` 并重启 `com.local-ai-gateway.gateway` 常驻服务；本地与公网 `POST /v1/responses` 使用 `model = "gpt-5.5"`、`stream = true` 均返回 `200`，事件序列已包含 `response.created` 和基于 `item_id` 的 `response.output_text.delta`。

## [2026-05-22 12:39 CST]

### 修复

- 定位 Codex App 切到 `Local AI Gateway 公网` 后仍报重连 / high demand 的直接原因：CC Switch Provider 仍使用 `gpt-5.5`，但当前公网成员 `/v1/models` 仅允许 `codex-default / codex-5.4 / codex-5.4-mini / codex-5.3 / codex-5.2`，请求被网关按 `403 access_policy_model_denied` 拒绝。
- 已修复本机 CC Switch 的 `Local AI Gateway 公网` Provider：改为完整 Codex 配置形态，保留 `mcp_servers / projects / memories / desktop`，默认模型改为 `codex-default`，公网入口保持 `https://gateway.henery.top/v1` 和 `wire_api = "responses"`。
- 增强本机切换脚本：切到 `Local AI Gateway 公网` 时不再信任 CC Switch 可能写回的短模板，而是从完整 Cockpit Provider 配置合成公网 Provider 配置，并强制使用 `codex-default`；同时把 `memories` 纳入完整配置校验。

### 文档

- 在公网成员接入模板中明确普通商业成员不需要管理员本机切换脚本；脚本仅用于管理员本机在 Cockpit Tools 与本网关之间低扰动切换。
- 在错误码速查中补充 `403 access_policy_model_denied`：Codex App 可能把模型策略拒绝显示成通用重连 / high demand，处理方式是先看 `/v1/models` 并使用已授权模型别名。

### 验证

- 使用公网成员 Key 验证：`/v1/responses` 请求 `gpt-5.5 / codex-5.5` 返回 `403 access_policy_model_denied`，请求 `gpt-5.4 / codex-5.4 / codex-default` 均返回 `200`。
- 已执行 `switch-codex-provider.mjs local-gateway --dry-run` 与 `cockpit --dry-run`，确认本地网关、公网 `/v1/models` 和 Cockpit `127.0.0.1:56267` 预检均通过。

## [2026-05-22 11:59 CST]

### 修复

- 修复 Codex App 在 CC Switch / Cockpit Tools / Local AI Gateway 公网三者之间切换时可能丢失项目列表、MCP、memory、desktop 配置段的风险：当前 CC Switch 的 `default` 与 `Local AI Gateway 公网` Codex Provider 均按完整 `~/.codex/config.toml` 形态保存，不再使用短模板覆盖。
- 新增本机 Codex Provider 低扰动切换脚本：`~/Library/Application Support/local-ai-gateway/codex-provider-switch/switch-to-local-gateway.sh` 与 `switch-to-cockpit.sh`。脚本会在写入前备份 `~/.codex/config.toml`、`~/.codex/auth.json` 和 `~/.cc-switch/cc-switch.db`，并拒绝写入缺少 `mcp_servers / projects / memories / desktop` 的短配置。
- 切到 `Local AI Gateway 公网` 前会预检本地网关 `/healthz` 和公网 `https://gateway.henery.top/v1/models`；切回 `Cockpit Tools` 前会预检 `127.0.0.1:56267`，若 Cockpit API 未启动则先打开 Cockpit Tools，并要求通过“多开实例 -> Codex -> 启动”拉起后再切换。

### 文档

- 在《第三方客户端接入模板与错误排查》中补充 Codex App / CC Switch 与 Cockpit 网关无损切换说明，明确 CC Switch 直接切换、脚本切换、Cockpit 多开实例启动和切换后重启 Codex 的推荐顺序。

### 验证

- 已执行 `switch-codex-provider.mjs cockpit --dry-run` 与 `local-gateway --dry-run`，确认 cockpit 端口、本地网关健康和公网 `/v1/models` 均通过预检。
- 已执行 `switch-to-cockpit.sh` 真实切回，当前 `~/.codex/config.toml` 保持 `model_provider = "codex_local_access"`、`model = "gpt-5.5"`，并保留 `mcp_servers / projects / memories / desktop`；CC Switch 当前 Provider 仍为 `default`。

## [2026-05-22 09:58 CST]

### 新增

- 公网推理面新增 `POST /v1/responses` 兼容入口，用于支持 CC Switch / Codex App 这类使用 OpenAI Responses API 的自定义 Provider；入口会先转换为现有 Chat Completions 内部请求，继续复用成员鉴权、访问策略、号池调度、用量统计与告警链路。
- Responses 兼容层支持 `input / instructions / tools / tool_choice / max_output_tokens / stream` 的基础映射，并将网关返回转换为 Responses 非流式 JSON 或 Responses SSE 事件。

### 修复

- 修复 CC Switch 中 `OpenAI Compatible` Provider 测试 `https://gateway.henery.top/v1` 时返回 `Not found (404)` 的问题。根因是 CC Switch / Codex 生成 `wire_api = "responses"` 后会请求 `/v1/responses`，而此前公网网关只暴露 `/v1/models` 与 `/v1/chat/completions`。
- 修复 Codex App 重启后切到本网关 Provider 新建会话返回 `403 access_policy_model_denied` 的问题：当客户端请求 `gpt-5.4 / gpt-5.5` 等 Codex 上游模型名时，网关会在访问策略校验前规范化为已注册的 `codex-5.4 / codex-5.5` 稳定别名，避免公网成员策略只允许 `codex-*` 时被误拒。
- 修复 Codex Desktop `model/list` 解析本网关 `/v1/models` 失败的问题：模型列表保留标准 OpenAI-compatible `{ object, data }` 结构，同时补充 Codex Desktop 可解析的 `models` 数组，且 `visibility` 使用当前客户端接受的 `list` 枚举。
- 重新打包并安装当前版本，重启 `com.local-ai-gateway.gateway` LaunchAgent 后，公网 `POST https://gateway.henery.top/v1/responses` 非流式与流式均返回 `200`；CC Switch 模型测试记录已从 `404` 变为 `200 Check succeeded`。

### 测试

- 新增 gateway 回归测试，覆盖 `POST /v1/responses` 非流式请求会正确转发到现有上下文和会话选项，并返回 Responses 形态输出。
- 新增模型列表兼容回归测试，覆盖 `/v1/models` 同时面向 OpenAI-compatible 客户端与 Codex Desktop 本地 Provider；新增模型别名兼容回归测试，覆盖 `/v1/chat/completions` 与 `/v1/responses` 请求 `gpt-5.4` 时均能命中 `codex-5.4` 策略。
- 已执行 `npm test`（18 个测试文件，169 项测试）、`npm run typecheck`、`npm run build` 与 `npm run dist:desktop`。

## [2026-05-22 02:05 CST]

### 修复

- 修复安装版点击“启动服务”后界面卡死、再次打开出现“Gateway service did not become healthy within 15 seconds.” 的问题。根因是安装版 LaunchAgent 仍可能使用外部 Homebrew Node 跑开发仓库入口，导致 `better-sqlite3` 原生模块 ABI 不匹配并反复退出。
- 安装版网关常驻服务改为通过当前 `.app` 自带 Electron runtime 的 `ELECTRON_RUN_AS_NODE=1` 运行 `gateway-service-runner.mjs`，由 runner 直接加载打包内 `apps/gateway/dist/server.js`，不再依赖系统 Node、nvm Node 或开发仓库 `node_modules`。
- “启动 / 安装 / 重启网关服务”前会先停止桌面端临时托管的内嵌网关，释放当前端口，避免首次安装版启动后再注册 LaunchAgent 时和同进程内临时网关抢占 `8787`。
- 补强“启动 / 重启网关”端口占用识别：LaunchAgent `bootout` 后若端口短暂仍由刚退出的本网关 PID 监听，或 `ps` 暂时读不到 command，不再误判为非网关进程，避免运维页提示“端口 8787 已被非网关进程占用”。
- 安装版常驻服务健康等待从 15 秒放宽到 45 秒，覆盖 Electron node-mode 冷启动、账号快照加载和 LaunchAgent 调度延迟，避免服务稍晚变健康但 UI 先报失败。
- 桌面窗口启动不再因常驻服务暂时不健康而直接退出；若网关启动失败，仍会打开控制台，便于进入“运维与日志”查看错误和执行重启服务。

### 测试

- 新增 desktop build 回归断言，覆盖安装版常驻服务使用 Electron node mode、生成 `gateway-service-runner.mjs`、启动服务前停止内嵌网关，以及服务异常时仍打开控制台的防线。

## [2026-05-22 01:30 CST]

### 新增

- 新增本地网关 macOS 用户级 LaunchAgent 常驻服务：`com.local-ai-gateway.gateway` 会写入 `~/Library/LaunchAgents/`，通过 `~/Library/Application Support/local-ai-gateway/service/gateway-launcher.mjs` 启动网关，日志写入 `logs/gateway-service.out.log / gateway-service.err.log`；服务使用 `RunAtLoad + KeepAlive`，登录后自动拉起，退出桌面控制台不会删除业务数据。
- 网关常驻启动前会检查配置端口：若发现旧的 `local-ai-gateway` 网关 CLI / launcher 进程占用端口，会定向停止旧进程后再启动，避免开发环境、安装版和 LaunchAgent 重复起多个网关；若端口被非网关进程占用，则拒绝启动并在运维状态中暴露。
- 左侧导航新增“运维与日志”模块：集中展示网关常驻服务、Cloudflare Tunnel、公网 `/v1/models` 探测、日志来源和服务控制；支持安装并启动网关常驻、启动 / 停止 / 重启网关、重启 Cloudflare Tunnel、打开日志目录、tail 查看网关 / 常驻服务 / Cloudflare / 桌面主进程日志。
- 在《项目答疑与开发清单》中补充 Agent 能力边界答疑：明确公网成员接入本项目 Provider 后，项目分析、文件改写、命令执行和重构能力主要取决于客户端 Agent 自身工具编排；本网关当前支持 Chat Completions、流式响应和函数工具调用，但尚未对外暴露 `/v1/responses` 或 Codex App 私有协议。

### 调整

- 桌面端接入片段生成收敛到同一套 `buildIntegrationSnippets` 逻辑：顶部复制、模板复制和运维页公网复制使用一致的 Base URL / Model / API Key 占位信息；公网片段固定使用公网 Public Base URL、`<公网成员 API Key>` 和 `public-user` clientTag。
- 清理活跃 UI 中的阶段标记文案：移除“二期可用 / 三期可用 / 三期预留 / 待 server edition”等面向开发阶段的标签，公网、LAN、号池和模板入口改为按真实启用 / 就绪 / 待配置状态表达。
- “系统与诊断”继续保留配置、诊断、模板与低频排障；服务启停、Cloudflare 连通性和日志滚动查看迁移到“运维与日志”，减少系统页职责混杂。
- 修正架构总览中的公网默认限制口径：与当前实现保持一致，公网成员无显式策略时默认输入估算上限 `1050000`、输出上限 `128000`、同账号公网并发 `16`、近 60 秒准入 `240`。

### 测试

- 扩展 desktop build 回归测试，覆盖新增“运维与日志”导航、网关 / Cloudflare 运维 IPC、日志读取入口、常驻服务控制按钮、运维页样式 hook，以及活跃 UI 不再出现旧阶段标记文案。

## [2026-05-22 00:30 CST]

### 调整

- 按公网试运行优先的产品口径再次放宽默认限制：公网成员无显式策略时，单请求输入估算上限调整为 `1050000`，输出上限调整为 `128000`，贴近当前 Codex 默认模型 `gpt-5.4` 的模型级能力；显式配置的 `limits.maxInputTokens / maxOutputTokens` 仍优先生效。
- 公网请求 payload guard 同步放宽：body 从 `1MB` 放宽到 `8MB`，消息数从 `120` 放宽到 `1000`，工具定义数从 `32` 放宽到 `128`，工具 schema 从 `256KB` 放宽到 `1MB`，单条文本和工具结果从 `512KB / 256KB` 均放宽到 `4MB`。
- 账号级调度保护调整为高水位保险丝：`public-user` 默认同一上游账号 `16` 并发、近 60 秒 `240` 次；`lan-member`、本机自用和系统客户端不再套用默认账号级安全阀，只保留显式 AccessPolicy 和上游真实限制。

### 测试

- 更新 gateway 回归测试，覆盖模型级公网默认输出 Token、放宽后的工具定义上限、同账号跨 Key `16` 并发阈值、近 60 秒 `240` 次短窗口阈值，以及动态号池在高水位过载后跳过账号。

## [2026-05-21 23:50 CST]

### 修复

- 修复重启后 Cloudflare Tunnel 连接器未常驻导致公网 `gateway.henery.top` 返回 Cloudflare `1033` / `502` 的问题：将 `cloudflared` 以 macOS LaunchAgent `com.local-ai-gateway.cloudflared` 方式注册，使用 token-file 启动，并固定 `--protocol http2 --edge-ip-version 4`，避开当前网络下 QUIC / UDP 容易超时的问题。
- 本机验证 `cloudflared` 已重新注册到 Cloudflare edge，`https://gateway.henery.top/v1/models` 无 Key 返回网关侧 `401 gateway_api_key_required`，`https://gateway.henery.top/healthz` 返回 Cloudflare 侧 `404`，公网路由仍只进入 `/v1/*` 推理面。

### 调整

- 放宽公网共享的默认安全阈值，避免对邀请制编码 Agent 过度限流；该口径已在 2026-05-22 继续上调到模型级高水位。
- 账号级安全阀从“极保守”调整为“小范围邀请制可用”；该口径已在 2026-05-22 继续上调，并移除 LAN / 本机 / 系统默认账号级安全阀。

### 测试

- 更新 gateway 回归测试，覆盖放宽后的公网默认输出 Token 上限、同账号跨 Key 并发阈值、短窗口限流阈值，以及动态号池在账号达到新阈值后跳过过载成员。

## [2026-05-21 17:30 CST]

### 新增

- 三期公网共享补强请求面安全守护：`public-user` 请求进入上游前会校验 body 体积、消息数量、工具定义数量、工具 schema 体积、单条文本长度和工具结果长度，超限直接返回 `413 request_*_limit_exceeded`，不触发上游账号调用。
- AccessPolicy 新增单请求输入 / 输出 Token 执行层：`limits.maxInputTokens` 以文本与工具 schema 做轻量估算并前置拒绝，`limits.maxOutputTokens` 会拒绝超大 `max_tokens`，且客户端未传 `max_tokens` 时自动压到成员上限；公网成员无显式配置时的默认值以后续 2026-05-22 模型级高水位记录为准。
- 号池 / 账号调度增加账号级安全阀：按同一上游账号 `accountId / email / sessionId` 聚合 in-flight 与近 60 秒准入次数；公网默认阈值和 LAN / 本机 / 系统默认安全阀口径以后续 2026-05-22 记录为准。
- 账号级安全阀拒绝会返回 `429 session_safety_concurrency_exceeded` 或 `429 session_safety_rate_limit_exceeded`，并写入本地访问告警事件，便于消息通知中心和用量告警弹窗及时暴露公网滥用 / 上游封控风险。

### 调整

- 访问成员新增 / 编辑弹窗和成员详情内联策略编辑区新增“单请求输入 Token”“单请求输出 Token”字段；保存后写入该成员 AccessPolicy，继续走本地持久化配置，不影响 Cockpit / OpenClaw 原始账号数据。
- 正式访问告警采集范围从访问 key / 成员 / 策略类拒绝扩展到公网请求守护和账号级调度安全阀，方便公网试运行期间统一从“消息通知”和“用量与告警”中处理风险事件。

### 测试

- 新增 gateway 回归测试，覆盖公网工具定义数量前置拒绝、成员输出 Token 超限拒绝、成员输出 Token 默认压限、公网成员默认输出上限、同账号跨 Key 并发拒绝、同账号跨 Key 短窗口限流，以及动态号池跳过过载公网账号。
- 扩展 desktop build 回归测试，覆盖访问成员策略 UI 对 `maxInputTokens / maxOutputTokens` 的接线。

## [2026-05-21 00:30 CST]

### 记录

- 三期公网联调链路完成首轮打通：阿里云域名 `henery.top` 已注册通过，Cloudflare Free 站点已接入该域名并使用 nameserver `haley.ns.cloudflare.com / wells.ns.cloudflare.com`；Tunnel `local-ai-gateway-dev` 已连接，Public Hostname 为 `gateway.henery.top`。
- Cloudflare Tunnel 路由已收紧为 `gateway.henery.top` + Path `^/v1` -> Service `http://127.0.0.1:8787`；外部验证显示 `/healthz` 与 `/` 均返回 Cloudflare 侧 `404`，`/v1/models` 无 Key 返回网关侧 `401 gateway_api_key_required`，说明公网入口只进入受 API Key 保护的 `/v1/*` 推理面。
- 本地网关已启用公网配置：Public Base URL 为 `https://gateway.henery.top/v1`，已创建 `public-ready` 号池、启用中的 `public-user` 公网成员、独立公网成员 Key 和额度策略；系统顶部诊断已从“缺少启用中的公网成员”恢复为“服务运行中”。
- 新增《三期 Cloudflare 公网联调复盘》专题文档，记录从阿里云域名购买 / 审核、Cloudflare 绑卡与 Zero Trust、Tunnel connector、DNS / Public Hostname、Path `^/v1` 安全收口、本地公网配置到当前验收结果的全过程。

### 调整

- “用量与告警”模块完成运维化重构第一段：用量页不再常驻展示总览页的摘要卡片，改为默认“成员观测”的操作台；管理员可在成员 / 模型 / Key 与号池 / 总览视角之间切换。
- 用量观测区新增多形态图表布局：主区域展示最近 24 小时 Token 曲线，侧栏展示输入 / 输出 / 缓存 / 思考 Token 构成饼图，下方展示当前视角 Top 消耗排行柱状图；图表沿用现有浅色控制台样式、紧凑标题和 badge 体系。
- 窗口用量结构继续扩展观测维度：新增请求成功 / 失败堆叠条、延迟与稳定性快照、成员 / Access Key / 号池 / 模型归因覆盖矩阵，使“用量与告警”页更接近专门的运维观测台。
- “告警与治理摘要”和“告警事件列表”从常驻卡片调整为弹窗入口：页面只保留策略预览 / 最近事件两张操作卡，具体阈值、治理规则、事件筛选和确认操作进入弹窗内处理，减少主看板噪音。
- 继续收口用量告警视觉一致性：请求结果堆叠条由粗条改为细进度条，统计图表卡片间距和背景更统一；两个用量告警弹窗统一挪到全局 modal 层并使用全屏 overlay 大尺寸弹窗，与访问成员、号池等通用弹窗交互保持一致。
- 新增“消息通知”模块：左侧导航增加独立入口和未读数字徽标，站内消息由持久化访问告警事件派生，支持全部 / 未读 / 已读筛选、单条标为已读、全部标为已读，并可在未确认告警上继续执行确认。
- 新增 macOS 原生通知通道：warning / critical 级别未读访问告警会触发系统通知；通知推送状态保存在本机浏览器存储，站内消息仍以本地 SQLite `access_alert_events` 为事实来源。
- “消息通知”未读徽标在未读数为 0 时不再展示，避免侧边栏出现无意义红点。
- “系统与诊断”模块完成信息架构重构：主页面保留高价值状态摘要、分组系统配置、核心诊断摘要和四个操作入口；LAN 模板、公网模板、公网外部验收和常见失败原因改为全局 modal 层的大弹窗查看，减少主页面卡片堆叠和冗余说明。
- 新用量操作台仍复用现有本地 `usageSummary` 数据，不读取 prompt body、完整 API Key 或 OAuth token，也不改变告警确认、阈值配置、账号和号池配置。
- 收紧“清除统计”语义为“清运行态”：管理端 telemetry reset 不再删除持久化 Token 用量事件和访问告警事件，只清路由命中、会话活动、号池运行态与熔断状态；成员、Key、Policy、账号配置和历史用量在开发重启、重新构建、打包重装以及运行态清理后都应保留。

### 测试

- 新增 gateway 持久化回归测试，覆盖同一数据目录下 telemetry reset + runtime restart 后，成员信息、成员 Key、AccessPolicy、Token 用量汇总和访问告警事件不会丢失。
- 扩展 desktop build 回归测试，覆盖新增消息通知导航、未读徽标、用量告警弹窗入口、扩展图表 hook、原生通知 IPC、通知中心渲染 hook，以及系统诊断重构后的大弹窗和分组配置布局。

## [2026-05-20 12:40 CST]

### 新增

- 启动三期公网共享代码落地第一段：`security.publicAccess` 新增 `cloudflare-tunnel / tailscale-funnel / manual-reverse-proxy` 公网入口配置模型，支持保存启用状态、Public Base URL、Tunnel 名称和 Hostname；启用公网共享时强制要求 API Key 鉴权与 HTTPS Public Base URL，管理面仍标记为不对外暴露。
- 系统与诊断页新增“公网共享入口”配置区，可填写 Cloudflare Tunnel 相关入口信息并随“保存本页配置”写入网关；运行诊断新增公网 Base URL、public-ready 号池、公网成员 Key、管理面本机隔离和公网入口就绪判断。
- 三期公网执行边界落地第二段：`public-user` 仅在公网共享显式启用且 Public Base URL 为 HTTPS 时放行，且只能访问 `public-ready` 动态号池；系统与诊断页新增可复制的公网成员接入模板，包含 `/v1/models` 和 `stream: true` 验收命令。
- 系统与诊断页新增“公网外部验收清单”：覆盖 `/v1/models`、非流式对话和 `stream: true` 三项外部验收，支持逐项复制 cURL 命令并人工标记通过状态，标记状态保存在本机浏览器 localStorage。
- 用量与告警页新增三期公网成员告警维度：访问告警事件会持久化 `consumerType`，公网成员拒绝 / 异常可按“公网成员”筛选并在事件卡展示类型徽标，便于 Cloudflare 公网试运行时区分 LAN 与公网风险。
- 三期公网号池安全边界继续收紧：`public-ready` 号池现在必须由 `public-user` 成员 AccessKey 命中，默认 Gateway Key、客户端映射 Key、本机自用成员或系统客户端都不能直接路由到公网号池。

### 修复

- 修复“保存本页配置”会携带桌面端内存中的完整 `accessControl` 并可能用旧窗口 / 旧状态覆盖访问成员、AccessKey 和策略的问题；普通安全 / LAN / 公网入口保存现在只保存鉴权与共享入口设置，访问成员、Key 和策略继续走专用访问控制保存入口。

### 测试

- 新增 gateway、runtime diagnostics 和 desktop build 回归测试，覆盖公网入口配置保存、HTTPS / Key 前置拒绝、Cloudflare 公网诊断缺项与就绪态、桌面端配置控件接线。
- 新增桌面端回归测试，确保普通安全配置保存 payload 不再包含 `accessControl`，避免后续再次误覆盖访问用户数据。
- 新增 gateway 回归测试，覆盖公网总开关未启用时拒绝 `public-user`、显式启用后允许 `public-user` 命中 `public-ready` 号池，以及公网成员误命中非 `public-ready` 号池时拒绝。
- 新增桌面端构建回归测试，覆盖公网验收清单、验收命令复制和人工标记入口。
- 新增 gateway 与桌面端构建回归测试，覆盖公网成员告警 `consumerType` 持久化、推理拒绝告警归因和用量告警页成员类型筛选入口。
- 新增 gateway 回归测试，覆盖默认 Gateway Key 误路由到 `public-ready` 号池时返回 `access_policy_public_pool_requires_member_key`，防止公网试运行误分发管理员自用 Key。

## [2026-05-20 00:20 CST]

### 优化

- 访问成员弹窗的“API Key 管理”改为“新增 Key 在前、现有 Key 列表在后”的单列列表布局；每把 Key 独占一行展示名称、前后缀、状态、创建 / 最近使用 / 到期 / 轮换时间，并补充单 Key 删除操作，删除后该 Key 立即失去网关调用能力。
- “模型与 Provider”页的已注册 Provider 清单由卡片式摘要改为紧凑行列表，每个 Provider 独占一行展示状态、默认路由、配置来源、认证方式和暴露模型别名。
- 扩展《最低可行公网共享方案 A / B 记录》为三期 Cloudflare 公网 MVP 主方案版：记录 `Cloudflare Tunnel + 自有域名 + 当前本机网关 + 成员 Key` 的准备项、域名 / 付款建议、网络切换影响、实施步骤、验收命令、成本工期和安全边界；同步更新项目答疑与开发进度清单，当前仍只记录方案，不实施公网开放。

## [2026-05-19 23:35 CST]

### 调整

- Codex 并行暴露模型口径对齐当前 Codex 侧可选模型：`GPT-5.5 / GPT-5.4 / GPT-5.4-Mini / GPT-5.3-Codex / GPT-5.2`，同步更新 shared 常量、桌面端模型镜像、Provider bootstrap、测试和文档中的别名列表。
- Codex 模型配置兼容历史本地值：旧配置中的 `gpt-5.2-codex` 会归一化为当前 `gpt-5.2`，避免真实桌面数据在“已注册 Provider 清单”里继续暴露旧上游模型名。
- “号池与路由”页将号池列表改为紧凑表格展示，新增 / 编辑号池改为全局弹窗；弹窗内按基础信息、调度保护、池成员分区排布，池成员账号卡片压缩展示 ID、额度、重置时间和进度条，滚动统一由弹窗主体承载。
- 号池新增 / 编辑弹窗进一步加宽，并将保存语义收口为“弹窗保存即直接写入网关”；页面顶部不再提供重复的“保存号池配置”，仅在调度开关面板保留“保存调度开关”。
- 号池弹窗表单改为更稳定的 12 栅格布局，基础信息、调度保护、开关项和成员区块统一对齐，去除成员卡片列表内嵌纵向滚动条。
- “模型与 Provider”页重构为 Codex 主卡 + 扩展 Provider 双列卡片布局，已注册 Provider 清单改为卡片式摘要，展示状态、默认路由、配置来源、活动会话 / 认证方式、模型数量和暴露模型别名。

## [2026-05-19 13:55 CST]

### 新增

- 新增《最低可行公网共享方案 A / B 记录》，沉淀 Cloudflare Tunnel 与 Tailscale Funnel 两条“本机开机即服务”的极小范围公网试用方案；当前仅记录方案，不实施部署。
- 访问成员额度模式调整为“周期包：x 天共 xx M Token”“总量包：不限天数直到耗尽”“不限制 Token 额度”，并保留 QPS、并发和策略到期作为独立硬限制。
- 推理面新增成员周期包、总量包执行层拦截：周期包过期返回 `access_policy_period_expired`，周期额度耗尽返回 `access_policy_period_quota_exceeded`，总量耗尽返回 `access_policy_total_quota_exceeded`。

### 优化

- “访问与密钥”页策略摘要改为共享入口、成员额度、运行限流、硬截止、模型 / 号池授权和成员 Key 六个高价值维度，补充 LAN URL 随健康检查刷新、配置保存后热生效等状态说明。
- 访问成员表格补齐创建时间、更新时间展示，支持横向滚动时固定最右侧操作列；操作按钮精简为“编辑 / 禁用或启用 / 删除”。
- 成员弹窗的成员信息区压缩为紧凑身份栏；额度与限制区域重排为短选项“周期包 / 总量包 / 不限制”加稳定级联配置带，并将 QPS、并发、策略到期整理为独立限制行。
- 成员弹窗的“API Key 管理”区域拆成“现有 Key”和“新增 Key”两列管理布局，提升新增 Key 面板宽度并改为两列输入 + 底部按钮；“一次性 API Key”卡片改为“本次生成的 Key 明文”，明确完整 Key 只在本次创建或轮换后可复制。

### 文档

- 更新桌面控制台使用说明和文档总览，明确 LAN Base URL 会随健康检查读取本机局域网 IP，换网后通常无需重启；访问成员、Key、额度、号池授权等配置保存后影响后续请求。

## [2026-05-18 13:20 CST]

### 新增

- “访问与密钥”页访问成员列表改为宽表格展示，行内补充成员信息、Key 可用数、脱敏 Key 前后缀、额度、QPS / 并发、模型 / 号池、标签和状态操作；点击成员行或“编辑”可打开成员弹窗继续修改。
- 新增 / 编辑成员共用全局弹窗，表单调整为多列分区布局；Token 额度输入改为数值 + 单位形式，当前单位为 `M`，保存时换算为实际 token 数。
- 访问成员弹窗的“允许模型别名”改为“已暴露模型勾选 + 自定义别名补充”组合：可直接选择当前 `/admin/providers` 暴露的模型别名，也可手动补充未出现在列表里的自定义别名。
- 访问成员操作列新增删除入口，删除前二次确认；确认后会删除本项目访问控制配置中的成员、关联 AccessKey 和成员策略，旧 API Key 无法继续通过本地网关鉴权，不影响 Cockpit / OpenClaw 原始账号配置。
- “系统与诊断”页顶部保存按钮改为“保存本页配置”，会同时保存系统运行参数、第三方接入鉴权和局域网共享开关，避免 LAN 开关被误以为已保存但实际仍未写入鉴权配置。

### 修复

- 账号配置导入新增对两类 Codex OAuth JSON 的兼容：顶层 `access_token / refresh_token` 数组导出，以及 sub2api 风格 `accounts[].credentials` 导出。
- sub2api 导入会读取 `credentials.email / plan_type / chatgpt_account_id / expires_at` 等元数据；导入账号仍标记为 `external-readonly`，不会由本项目主动 OAuth refresh。
- 账号资产操作栏将“刷新额度”调整为“同步额度”，外部只读账号 tooltip 明确提示不会刷新 `refresh_token`；同时修复操作栏 icon tooltip 被表格容器裁切的问题。
- 修复后台自动同步 / 会话活动轮询重绘“访问与密钥”页导致新增成员、成员 Key 和策略配置表单草稿被清空的问题；访问页存在编辑草稿时会暂缓 live refresh 重绘，并把静默活动轮询从 15 秒放宽到 30 秒。
- 修复 LAN 非本机请求前置检查只认可默认 Gateway API Key / 旧客户端映射 Key、未认可访问成员 AccessKey 的问题；现在只创建成员专属 Key 也可作为局域网共享鉴权条件。
- 修复总览页、访问与密钥页和 LAN 接入模板仍按默认 Gateway API Key 判断 LAN 状态的问题；现在会统一识别 Gateway Key、客户端映射 Key 和访问成员 Key，并动态显示 LAN Base URL、二期可用 / 缺少 Key / 默认关闭状态。
- 修复编辑访问成员保存后弹窗重新渲染并强制聚焦“成员名称”输入框的问题；保存后会保留弹窗滚动位置与当前可见配置，并在弹窗底部显示保存成功 / 失败状态。
- 修复“复制接入片段”和 LAN 成员接入模板中的模型与 API Key 占位说明不够准确的问题：模板会优先使用当前默认模型 / Provider 注册表中的真实模型别名，并明确 `apiKey` 可填写 Gateway API Key 或成员 API Key。
- 优化访问成员弹窗保存交互：编辑已有成员保存成功后直接关闭弹窗；从成员表格点击行或“编辑”打开已有成员时不再默认聚焦“成员名称”输入框。新建成员仍会保留弹窗展示一次性 API Key，避免错过复制窗口。
- 修复访问成员 `AccessPolicy.expiresAt` 仅保存不拦截的问题：推理面现在会在 `/v1/models` 与 `/v1/chat/completions` 统一校验策略到期时间，过期策略返回 `403 access_policy_expired`。

## [2026-05-17 21:05 CST]

### 新增

- 访问成员详情新增“成员基础信息”编辑区，支持保存成员名称、`clientTag`、备注和标签；仅写入本项目 `security/accessControl` 配置，不修改 Cockpit / OpenClaw 原始账号配置。
- 访问成员详情新增“新增成员 Key”表单，可为同一成员创建多把独立 Key，并在创建后一次性展示 API Key 明文；持久化仍只保留 hash、前缀、后缀、状态和到期时间等脱敏元数据。
- AccessPolicy 编辑区补充月 Token 限额、总 Token 限额和策略到期时间字段，可与现有日 Token 限额、QPS、并发、模型权限和号池授权一起保存。

### 文档

- 同步更新二期 / 三期开发进度清单、重构技术方案、桌面控制台说明和项目答疑清单，清理成员编辑、多 Key、月 / 总额度与过期策略的过时待办口径。

### 修复

- 修复 dev desktop 运行时实际加载的 `static/preload.cjs` 未暴露访问告警 IPC 方法，导致启动后报 `api.getAccessAlerts is not a function` 的问题；补充桌面构建测试覆盖运行时 static preload。
- 修复重启或告警接口短暂失败时，旧版 / 不完整 usage summary 缺少新归因数组会触发 `Cannot read properties of undefined (reading 'map')` 的问题；渲染层现在会在写入 state 前归一化 usage 与访问告警事件结构。
- 修复“访问与密钥 -> 新增成员”仍按页面卡片流式渲染的问题；新增成员已改为全局 modal overlay，并支持点击遮罩、页脚取消和 Esc 关闭。

## [2026-05-17 20:25 CST]

### 新增

- P3 前置公网边界第一段：`public-user` 访问者类型在二期推理面返回 `403 access_policy_public_user_disabled`，路由预演同步展示拒绝原因。
- LAN 成员命中 `public-ready` 等非 `shared-lan` 动态号池时，拒绝详情新增 `requiredVisibility: shared-lan` 与 `phase: phase-two`，明确该号池仅为三期预留。
- 系统诊断的 `public-ready` 提示补充二期不会开放公网入口、不会分配给 LAN 成员使用，以及 `public-user` 当前处于拒绝态。
- 用量趋势区新增统一空态说明：当前窗口无 Token，或所选成员 / 模型 / Key / 号池维度暂无最近 24 小时趋势桶时，会展示明确原因和下一步提示。
- 趋势柱体和排行条新增 `data-usage-tooltip` hook，并保留原生 `title` 提示，便于后续接入更完整的 tooltip 浮层。
- 用量趋势区新增真实全局 tooltip 浮层，支持悬停、指针移动、键盘 focus 与 Esc 关闭；窄窗口下成员 24h 趋势压缩为 12 列两行，减少移动端挤压。

### 文档

- 同步更新二期 / 三期开发进度清单、重构技术方案、桌面控制台说明和项目答疑清单，清理 `public-ready / public-user` 边界状态的过时表述，并记录 P2-A 趋势空态、tooltip 与窄窗口收口进度。

## [2026-05-17 19:24 CST]

### 新增

- 用量摘要新增 Access Key 与号池 24h 小时趋势：`usageSummary.daily.accessKeyTimeline / poolTimeline` 按小时聚合 Token、请求、失败、缓存和思考 Token。
- 用量与告警页日窗口新增“Key / 号池 24h 趋势”面板，展示 Top Access Key 与 Top 号池的 Token、请求数和失败率。
- 用量与告警页新增趋势维度选择：支持在全部、成员、模型、Key / 号池之间切换日窗口趋势视图。

## [2026-05-17 19:07 CST]

### 新增

- 用量摘要新增模型 24h 小时趋势：`usageSummary.daily.modelTimeline` 按小时和模型别名聚合 Token、请求、失败、缓存和思考 Token。
- 用量与告警页日窗口新增“模型 24h 趋势”面板，展示 Top 模型的 Token、请求数、失败率和峰值小时。

## [2026-05-17 18:48 CST]

### 新增

- 系统与诊断页新增“常见失败原因”说明卡：覆盖 LAN 成员设备访问不通、401 / 403 鉴权失败、403 号池或模型拒绝、429 额度 / QPS / 并发限制、管理员主机睡眠或网络切换等排查入口。

## [2026-05-17 18:38 CST]

### 新增

- 用量与告警页新增告警阈值配置：支持管理员设置日限额预警、QPS / 并发预警和失败率预警百分比。
- 告警阈值写入本项目 security/accessControl 配置，并用于成员额度、运行压力和失败率摘要判断；默认仍保持日限额 90%、运行压力 90%、失败率 10%。

## [2026-05-17 18:12 CST]

### 新增

- 告警事件列表新增状态与级别筛选：支持按全部 / 未确认 / 已确认，以及全部 / 严重 / 警告 / 提示过滤最近告警事件。
- 告警事件列表按未确认、已确认分组展示，未确认事件优先，便于管理员先处理仍需关注的访问策略风险。

## [2026-05-17 17:57 CST]

### 新增

- 用量与告警页新增正式告警事件列表第一段：展示最近访问策略告警的严重级别、确认状态、成员 / Key 归因、首次发生时间、重复次数和最近发生时间。
- 告警事件列表支持对未确认事件逐条确认，并继续复用“全部确认”和“清理已确认”治理入口。

### 边界

- 告警列表只读取本项目本地 `access_alert_events` 观测数据，不展示 prompt body、完整 API key 或 OAuth token，不修改 Cockpit / OpenClaw 原始配置。

## [2026-05-17 17:41 CST]

### 新增

- 系统与诊断页新增 LAN 成员接入模板卡：展示可分发的 LAN Base URL、适用工具说明、`cc_switch / Codex / 自定义 Provider` 配置提示和 `/models` cURL 验证命令。
- 新增“复制 LAN 模板”操作，只复制占位 API Key 的接入模板，不回显或导出真实成员 API Key。

### 测试

- 更新桌面构建回归测试，覆盖 LAN 接入模板容器、复制 action、`cc_switch` 与自定义 Provider 说明。

## [2026-05-17 17:25 CST]

### 新增

- P2-B 系统与诊断补强：运行诊断新增 LAN 绑定地址、局域网 IP 枚举、端口 / 防火墙人工验证、管理员主机睡眠风险和 `public-ready` 外网预留提示。
- 桌面端会把网关监听 host / port、本机局域网地址数量和 `public-ready` 号池数量传入诊断构建器，用于判断 LAN 共享是否真的具备可分发条件。

### 边界

- 本次诊断只提供本机配置与可达性检查建议，不自动修改 macOS 防火墙、路由器、系统睡眠设置，也不会开放公网入口。

## [2026-05-17 17:12 CST]

### 新增

- 新增正式访问告警已确认事件清理：管理端新增 `POST /admin/access/alerts/clear-acknowledged`，只删除本项目本地 SQLite `access_alert_events` 中 `acknowledged_at IS NOT NULL` 的告警事件；桌面端“用量与告警”在存在已确认告警时展示“清理已确认”入口，并刷新告警摘要。
- 新增 gateway 与桌面构建回归测试，覆盖清理已确认告警不会删除未确认告警、桌面 API / IPC / UI action 接线完整。

### 边界

- 已确认告警清理不会清空 Token 用量、不会删除未确认告警、不会修改账号、号池、API key，也不会读取或改写 Cockpit / OpenClaw 原始配置和外部导入账号 token。

## [2026-05-17 04:53 CST]

### 新增

- P1-C 号池可见性进入配置模型：`GatewaySessionPoolDefinition` 新增 `visibility` 字段，支持 `private / shared-lan / public-ready`，管理接口保存号池时会把非法或缺失值归一为 `private`。
- 桌面端本地 `PoolDefinition` 类型同步补充 `visibility` 字段，并在号池卡片新增可见性下拉与标题 badge；新建号池默认 `private`，保存单卡或全量号池配置时会随卡片写回可见性。
- 新增 gateway 回归测试，覆盖号池 visibility 保存与非法值归一化。
- 新增桌面构建回归测试，覆盖号池可见性 UI 入口与新建默认 `private`，明确这只是配置面口子，不代表 LAN 或公网共享已自动开放。
- 启动 P1-C 号池授权执行层第一段：访问成员配置 `allowedPoolIds` 后，策略路由命中的动态号池必须在授权列表内，否则推理面返回 `403 access_policy_pool_denied`，并在进入上游调用前停止请求。
- 访问成员详情新增“允许号池”配置第一段：可在桌面端勾选当前号池并保存到该成员 `allowedPoolIds`，用于配合后端动态号池授权拒绝能力。
- 新增 gateway 回归测试，覆盖访问成员被路由到未授权动态号池时的拒绝行为。
- 补齐 P1-C LAN 号池可见性执行层第一段：`lan-member` 被策略路由到 `private` 或非 `shared-lan` 动态号池时，即使 `allowedPoolIds` 误配置包含该号池，也会返回 `403 access_policy_pool_visibility_denied` 并在进入上游调用前停止请求。
- 新增 gateway 回归测试，覆盖 LAN 成员访问 private 动态号池被拒绝，以及访问已授权 `shared-lan` 动态号池可正常通过。
- 路由预演新增访问成员策略判定：`/admin/config/routing/preview` 支持传入 `accessConsumerId` 并返回 `accessDecision`，覆盖模型权限、号池授权、LAN `shared-lan` 可见性约束和成员基础状态。
- 桌面端“路由预演”面板新增访问成员下拉与策略判定结果展示，可提前看到某成员请求某模型 / 号池时的允许、拒绝和错误原因。
- 新增 gateway 与桌面构建回归测试，覆盖 consumer 路由预演的 private 号池拒绝结果和桌面端访问成员预演控件。
- 访问成员详情新增 AccessPolicy 编辑第一段：可编辑日 Token 限额、每分钟请求数、最大并发请求、允许模型别名和允许号池，并统一保存到该成员策略。
- 新增桌面构建回归测试，覆盖访问成员策略编辑字段与保存动作绑定。
- 访问成员详情新增日额度余量展示第一段：按成员聚合近 24 小时 Token 用量，展示已用 / 剩余、进度条、重置参考和统计更新时间。
- 访问成员详情新增 QPS / 并发运行态解释第一段：`/admin/health` 的 `inferenceObservability` 按访问成员暴露近 60 秒请求数、当前并发数和策略上限，桌面端展示限流窗口、剩余请求 / 并发容量和状态进度条。
- 用量与告警页新增成员策略告警摘要第一段：基于成员日额度余量、近 60 秒请求窗口和当前并发状态，展示“成员日限额余量低”与“QPS / 并发接近上限”的真实状态。
- 用量与告警页新增访问策略拒绝聚合第一段：网关 recent errors 会记录 `GatewayError` 的 `errorCode / statusCode / details`，桌面端按 `access_policy_* / access_key_* / access_consumer_*` 汇总最近拒绝原因。
- 用量明细弹窗新增访问成员与 Access Key 排行：在原账号、客户端、模型维度之外，直接展示 `consumerId / accessKeyId` 归因后的 Token、请求数、成功率和延迟。
- 新增号池用量归因第一段：`inference_usage_events` 兼容新增 `pool_id`，动态号池命中的推理请求会写入 pool 维度；用量摘要新增 `pools` 排行，桌面端维度洞察和用量明细弹窗展示号池 Token 消耗。
- 新增正式访问告警事件第一段：SQLite 新增 `access_alert_events`，访问 key / 成员 / 策略类拒绝会写入持久化事件；管理端新增 `/admin/access/alerts`，桌面端“用量与告警”展示最近正式告警事件，并按 90 天 / 5 万行做轻量清理。
- 新增正式访问告警确认状态第一段：`access_alert_events` 兼容新增 `acknowledged_at / acknowledged_by`，管理端新增 `/admin/access/alerts/:id/acknowledge` 和 `/admin/access/alerts/acknowledge-all`，桌面端“用量与告警”可确认最近未确认告警或一次确认全部未确认告警；确认只作用于本项目本地告警事件，不影响账号、号池或 Cockpit / OpenClaw 原始配置。
- 新增正式访问告警事件去重第一段：`access_alert_events` 兼容新增 `dedupe_key / occurrence_count / last_seen_at`，同一访问策略拒绝类告警会合并未确认事件，保留首次发生时间、更新最近发生时间和重复次数；桌面端“用量与告警”展示重复次数和最近发生时间。
- 新增 P2-B LAN 共享诊断第一段：桌面主进程会向健康状态补充本机局域网地址和 LAN Base URL，运行诊断会检查 LAN 开关、Gateway API Key、`shared-lan` 号池、启用中的 LAN 成员和成员 API Key，并在条件齐全时展示可分发的 LAN Base URL。
- 新增成员 24h 用量趋势第一段：`usageSummary.daily` 输出按小时聚合的 `consumerTimeline`，桌面端“用量与告警”日窗口优先展示访问成员 24 小时 Token 趋势。
- 新增 `desktop-access-policy-usage` 纯函数回归测试，覆盖成员多 key 用量聚合、超额状态、未配置日限额、QPS 余量、并发余量、成员策略告警摘要和访问策略错误聚合场景。
- 新增 gateway 回归测试，覆盖动态号池请求写入 `usageSummary.daily.pools` 的号池维度统计。
- 新增 gateway 回归测试，覆盖成员日额度拒绝写入 `access_alert_events`、通过 `/admin/access/alerts` 查询、告警事件按行数裁剪、管理员确认单条告警，以及批量确认所有未确认告警。
- 新增 gateway 与桌面构建回归测试，覆盖成员小时趋势聚合、用量页趋势图 hook、桌面端单条告警确认入口、全部确认入口、重复告警合并、重复次数展示和 LAN 共享诊断卡片接线。
- 新增运行诊断纯函数回归测试，覆盖 LAN 共享缺少 `shared-lan` 号池 / 成员 Key 时的 warning，以及条件齐全时展示 LAN Base URL 的 ready 状态。
- 新增 gateway 回归测试，覆盖 `access_policy_daily_quota_exceeded` 被写入结构化 recent errors，便于桌面端后续聚合策略拒绝。
- 新增 gateway 回归测试，覆盖管理端 health 输出按访问成员归因的 QPS / 并发运行态数据。
- 新增桌面构建回归测试，覆盖访问成员号池授权 UI hook 与保存动作绑定。
- 继续推进 P1-B AccessPolicy 执行层：访问成员配置 `limits.requestsPerMinute` 后，网关会按该成员近 60 秒已记录请求数做前置限流，超额返回 `429 access_policy_rate_limit_exceeded` 并设置 `Retry-After: 60`。
- 访问成员配置 `limits.maxConcurrentRequests` 后，网关会按成员维度统计进行中的推理请求，达到并发上限时返回 `429 access_policy_concurrency_exceeded`；运行态 in-flight 记录同步补充 `consumerId / accessKeyId`。
- 新增 gateway 回归测试，覆盖成员 QPS 与并发上限两条 AccessPolicy 执行路径。
- 推进 P1-B AccessPolicy 执行层第一段：访问成员配置 `quota.dailyTokenLimit` 后，网关会在 `/v1/chat/completions` 推理前按成员当天已记录 Token 用量做前置拦截，超额返回 `429 access_policy_daily_quota_exceeded`，并带回成员、key、限额、已用量、剩余量、重置时间和 `Retry-After`。
- `GatewayDatabase` 新增按 `consumerId` 聚合用量的内部方法，为成员额度、后续 QPS / 并发和告警联动提供更稳定的执行层查询入口；旧 `clientMappings` 兼容路径不受影响。
- 新增 gateway 回归测试，覆盖访问成员当天 Token 已达限额后被拒绝的行为。

### 调整

- 校准二期 / 三期共享网关开发进度清单：P1-B / P1-C 从笼统“进行中”调整为“已完成（二期核心闭环）”，P2-A 调整为“进行中（增强收口）”，并清理 QPS / 并发状态解释、策略余量展示、告警事件去重等已过时待办口径。
- 推进 UI/UX Phase 9 精修：用量与告警页从静态占位线升级为基于当前 `usage summary` 渲染的 Token 结构图、成员/账号/模型/失败维度洞察和治理告警摘要，不引入新图表库。
- 访问与密钥页策略摘要同步到最新 AccessPolicy 能力：成员详情展示日 Token 限额、QPS、并发、模型与号池授权，策略摘要按当前 policy 统计真实配置状态，并清理旧的“预留”说明。
- 用量与告警页标题从固定“24 小时趋势”调整为“窗口用量结构”，与日 / 周 / 月 / 总统计窗口保持一致。
- 推进 UI/UX Phase 10 响应式与密度精修：统一 Figma table 单元格换行与行高，优化访问成员表最小列宽，补齐策略摘要、用量告警、号池卡片在窄窗口下的折叠形态。
- 推进 UI/UX Phase 11 抽屉与密钥区精修：一次性 API key 输入行改为自适应宽度，成员 key 卡片、策略面板和号池卡片标题补齐长文本换行与窄窗口纵向排列。
- 推进 UI/UX Phase 12 全局弹窗精修：账号导入、确认、号池事件和用量明细弹窗统一最大高度、滚动体、移动端内边距、页签横向滚动和底部按钮折叠规则。
- UI/UX Phase 1-12 标记为阶段性暂停，后续 UI 精修改为跟随功能闭环、真实数据态和 Electron 真实窗口验收推进。
- 新增桌面构建回归测试，防止用量页真实统计容器、趋势渲染函数、AccessPolicy 摘要字段和响应式密度规则从桌面端脱落。

## [2026-05-17 01:55 CST]

### 调整

- 推进 UI/UX Phase 7 系统与诊断页重构：系统页接入 `system-diagnostics-workbench / system-config-panel / system-config-form-grid`，运行诊断区接入 `diagnostics-shell / diagnostic-card / diagnostic-fact-grid`，保留鉴权、LAN 共享、端口、自动刷新、数据迁移恢复和诊断日志原有行为。
- 推进 UI/UX Phase 8 用量与告警页重构：用量页接入 `usage-alerts-workbench / usage-chart-panel / usage-dimension-grid / usage-alert-rule-list`，新增 24 小时趋势占位、成员/账号/模型/失败维度卡和告警规则预留位；当前不引入新图表库，不改变既有 Token 用量统计口径和告警执行状态。

## [2026-05-16 13:30 CST]

### 文档

- 新增《二期 / 三期共享网关重构技术方案》，整合最新局域网共享、外网共享预留、UI/UX 重构、访问成员、API key、额度策略、号池授权、用量图表、告警与 Cockpit / OpenClaw 账号边界要求。
- 新增《二期 / 三期共享网关开发进度清单》，把 Figma 设计基线采纳范围、P0/P1/P2 开发切片、验收命令、提交检查和进入代码前需要确认的主题 / 图表 / LAN 策略整理为正式执行清单。
- 启动 P0-A 桌面端 UI/UX 代码切片：采用二期默认深色主题、7 个共享网关导航入口和 Figma token 兼容映射；新增 `访问与密钥`、`用量与告警` 预留视图，并将 Provider / 系统入口收敛为新版命名。
- 完成 P0-B Dashboard 视觉骨架与状态映射：总览页新增本机自用 / 局域网共享 / 外网共享三种运行模式卡、轻量 Token 图表容器、共享摘要与告警摘要，并复用现有 health / usage / diagnostic 数据。
- 完成 P0-C Access & Keys 页面骨架：访问与密钥页新增本机 / LAN / 外网接入 surface、兼容成员列表、策略预览、成员详情抽屉和新增成员弹窗预留，并继续兼容现有 `inferenceAuth.clientMappings`。
- 完成 P0-D Accounts 页面重构：账号资产页新增来源与刷新所有权说明、账号列表 shell、账号详情抽屉预留，并在账号卡片展示 `managed / external-readonly` 刷新所有权 badge；删除动作继续表述为删除本项目本地副本。
- 完成 P1-A LAN 共享基础能力首轮落地：新增 `lanAccess.enabled` 安全配置、非本机推理默认拒绝、LAN API key 强制校验、`/admin/*` loopback guard、按配置切换监听地址，以及桌面端局域网共享开关与状态展示。
- 完成 P1-B AccessConsumer / AccessKey / AccessPolicy 第一段后端内核：新增访问者、访问者 key 和策略数据结构；访问者 key 只持久化 hash / 前缀 / 后缀 / 状态，管理接口脱敏返回；推理面支持 hash 匹配访问者、暂停 / 过期校验和模型权限拒绝，并继续兼容旧 `clientMappings`。
- 用量事件新增稳定成员归因：`inference_usage_events` 增加 `consumer_id / access_key_id`，并在用量摘要中输出 `consumers / accessKeys` 统计维度，为后续成员用量图表、额度和告警提供数据底座。
- 访问与密钥页新增 LAN 成员创建第一版：可创建访问成员、生成一次性 API Key 明文并复制；保存后仍由后端只持久化 key hash、前缀、后缀和状态。
- 访问与密钥页补齐成员详情与 Key 管理第一版：点击成员可查看成员摘要和 Key 列表，支持暂停 / 启用单个 Key、编辑到期时间、轮换 Key 并一次性展示新明文；旧 Key 轮换后立即失效，持久化仍不保存明文。
- 《二期 / 三期共享网关开发进度清单》新增功能开发暂停点，记录 P0 / P1-A / P1-B 已完成范围，以及后续恢复功能开发时优先推进的额度、QPS、并发、号池授权和用量告警任务。
- 启动 UI/UX Phase 1 重构：桌面端默认主题切换为浅色，按 Figma 重构方案调整应用壳层、紧凑侧边栏、页面头、卡片、按钮、输入框、badge、设置组和基础页面背景，并改用 Electron 开发环境做真实界面观测。
- 推进 UI/UX Phase 2 组件化细化：侧边栏文字占位图标替换为一致 SVG 图标系统，并为账号列表容器、成员详情抽屉、新增成员卡片、账号导入弹窗和 tab 接入 Figma 风格组件 hook。
- 推进 UI/UX Phase 3 统计卡片统一：运行总览指标卡接入 `stat-card`，顶部 Token 用量总览接入 `usage-overview-card / card-header / stat-card-grid`，并保留原有统计口径、筛选、窗口切换和明细操作。
- 推进 UI/UX Phase 4 列表 table 化：访问成员 / 兼容客户端密钥列表接入 `figma-table` 并在桌面宽度保持真实表格列；账号资产动态行拆成账号、刷新所有权 / 来源、调用与额度、操作 4 个稳定 cell；不改变账号删除边界、外部只读账号刷新边界或 Cockpit / OpenClaw 原始配置。
- 推进 UI/UX Phase 5 号池与路由页重构：号池页接入 `pool-route-workbench / pool-control-panel / pool-list-shell`，动态号池卡片接入 `detail-drawer-panel / card-header / pool-config-form-grid / pool-member-table-shell`，保留现有号池保存、批量删除、成员搜索排序、调度事件和兼容策略路由入口。
- 推进 UI/UX Phase 6 模型与 Provider 页重构：静态配置区接入 `model-provider-workbench / provider-config-panel / provider-config-form-grid`，已注册 Provider 清单切换为 `figma-table provider-registry-table`，保留 Codex / OpenAI-compatible / Ollama 表单 ID、保存重启行为和 Provider 注册展示语义。
- 评审当前 Figma Make 的 UI/UX 输出：早期版本只能作为视觉方向和局部配置页参考；最新导出的「figma UI/UX重构方案」已解压到 `/Users/henery/code/local-ai-gateway-design-system`，可作为二期桌面端设计基线，但根目录 React / Vite / shadcn 脚手架不能整包照搬。
- 更新《二期 / 三期共享网关重构技术方案》的 Figma 设计评审章节，补充 `design-system/` 目录交付物、可复用范围、适配边界和阶段 A 的集成映射任务。
- 文档总览与项目答疑清单同步补充二期 / 三期共享网关重构入口和后续高优先级开发项。

## [2026-05-12 10:02 CST]

### 文档

- 新增《局域网小范围共享中转站技术实施方案》，记录基于公网可演进内核的 LAN 共享网关落地路径、核心对象、服务端与桌面端改造点、风险边界、测试验收与阶段计划。
- 文档总览与项目答疑清单同步补充局域网共享中转站专题入口和预研项。
- 补充自用网关与共享网关的系统形态判断：LAN 阶段复用同一桌面系统并通过模式与资源隔离保障自用质量，远期公网方向预留独立 server edition。

## [2026-05-12 00:37 CST]

### 调整

- 清理 `packages/core/src` 下误生成的 TypeScript 编译产物，并新增窄范围忽略规则，避免 `.js / .d.ts / .map` 生成物反复出现在 Git 状态中。

## [2026-05-11 23:30 CST]

### 新增

- 账号资产页新增批量管理工具条：支持选择当前账号、逐卡片勾选、清空选择与批量删除选中的本地 Codex 账号。
- 号池调度页新增批量管理工具条：支持选择全部号池、清空选择、按卡片逐个勾选与批量删除已选号池。
- 账号卡片标题左侧新增选择框，已选卡片会以高亮边框呈现，便于大量账号场景下快速定位批量操作对象。
- 号池卡片标题左侧新增选择框，已选卡片会以高亮边框呈现，便于大量号池场景下快速定位批量操作对象。

### 调整

- 账号批量删除会真正删除 `local-ai-gateway` 本地 `codex-auth-profiles.json` 中的账号副本，并同步清理所有号池里匹配的 `sessionId / profileId / accountId` 成员引用；该操作不会删除或改写 Cockpit / OpenClaw 原始配置文件。
- 批量删除号池沿用现有单个删除语义：先从当前编辑态移除，经过二次确认后执行，保存号池配置后才正式生效，并同步刷新策略路由下拉与路由预演状态。

### 文档

- 桌面控制台说明、动态号池设计方案与项目答疑清单同步补充账号批量删除、号池引用清理和号池批量管理口径。

### 测试

- 新增 `desktop-account-bulk-actions` 回归测试，覆盖账号批量选择目标收集，以及删除账号后清理存量号池成员引用。
- 新增 `desktop-pool-bulk-actions` 回归测试，覆盖按选中 ID 删除号池、忽略过期选择和保持剩余号池顺序。

## [2026-05-11 23:10 CST]

### 修复

- Codex 导入账号新增凭据刷新所有权标记：本项目 OAuth 授权创建的账号标记为 `managed`，JSON / Cockpit / OpenClaw 文件导入账号标记为 `external-readonly`。
- 外部只读账号不再触发 OAuth refresh：当 access token 过期或 usage 接口返回鉴权失败时，网关不再使用其 refresh token 主动换新凭据，避免破坏 Cockpit / OpenClaw 侧同一批账号的授权状态。
- 从 OpenClaw 可复用授权一键导入为桌面端账号时，也默认按外部只读凭据处理，避免本项目与外部工具争抢同一 refresh token。

### 文档

- 桌面控制台说明补充“本项目托管账号”和“外部只读导入账号”的刷新边界，明确 Cockpit 侧重新授权后需要重新导出导入或后续接入外部源同步机制。

### 测试

- 新增 `openclaw-session` 回归测试，覆盖外部只读导入账号在 usage 401 与会话解析过期场景下均不会调用 OAuth refresh。

## [2026-05-07 21:31 CST]

### 文档

- 新增 `docs/architecture/shared-gateway/` 共享中转站专题目录，用于集中记录公网共享、多租户中转、账号池运营与风险评估相关讨论。
- 迁入《公网共享中转站技术可行性分析》，记录将本地网关外发为共享中转站的可行性、必要能力、难度分级、风险边界与路线建议。
- 新增《API 中转站生态与风险评析》，记录市面低价中转站的常见类型、盈利模式、账号池风险、模型真伪风险与对本项目的启发。
- 文档总览新增共享中转站专题入口，便于后续继续回溯和追加讨论记录。

## [2026-05-01 01:30 CST]

### 新增

- 网关接入鉴权新增“客户端密钥映射”能力：在 `api-key` 模式下可为不同客户端配置独立 key，并按 key 自动解析 `clientTag`（例如 `hermes` / `openclaw`）。
- 新增映射策略开关 `resolveClientTagByApiKey`：开启后可按映射稳定识别来源标签，不再强依赖上游显式传 `x-client-tag`。
- 新增映射级行为控制 `allowHeaderOverride`：可按客户端决定是否允许请求头中的 `x-client-tag` 覆盖映射标签。
- 桌面端“系统配置 -> 第三方客户端接入鉴权”新增客户端密钥映射 UI（新增/删除映射、启用状态、header 覆盖开关）。
- 桌面端鉴权配置新增密钥自动生成功能：
  - 支持一键生成默认 `Gateway API Key`
  - 支持按映射项一键生成“客户端专属 API Key”
  - 生成后直接填充输入框，便于立即保存并分发到客户端。

### 调整

- 打包前 `smoke:gateway` 脚本现会自动读取本地 `inferenceAuthSettings.apiKey`，在启用第三方接入鉴权时也能正常完成 `/v1/models` 与 `/v1/chat/completions` 冒烟校验，避免正式发包链路被当前网关安全配置误阻断。
- 网关鉴权逻辑升级为“双通道兼容”：
  - 兼容原有单一 `Gateway API Key`；
  - 同时支持映射中的客户端专属 key；
  - 未命中映射时保持原有 `x-local-ai-client-tag / x-client-tag / x-source-app / User-Agent` 解析行为。
- `inferenceAuth` 管理接口返回增强：补充映射统计与映射列表（脱敏后，仅暴露 `hasApiKey` 标记，不回传密钥明文）。
- 鉴权配置 UI / 交互重构：
  - `Gateway API Key` 与“客户端专属 API Key”均升级为统一密钥字段组件；
  - 输入框右侧新增显隐与复制图标按钮；
  - “生成密钥 / 生成专属密钥”按钮改为与输入框水平对齐的蓝色主按钮；
  - 客户端映射删除操作改为二次确认弹窗后执行。
- 鉴权配置页草稿态修复：
  - 新增客户端映射前，会先同步当前表单草稿回本地 state；
  - 修复“点击新增映射导致已填写映射表单被重置”的问题；
  - 映射项的未保存专属密钥草稿现可跨局部重渲染保留。
- macOS 菜单栏托盘菜单重构：
  - 移除低价值入口：`打开主界面`、`打开日志目录`、`打开数据目录`
  - 左键点击托盘图标改为直接打开主界面，避免删除入口后失去恢复窗口能力
  - 菜单状态区重组为更精简的高价值观测项：状态、最近活动、客户端标签、当前模型、当前账号、当前号池、近 30 分钟 Token 消耗、剩余额度、重置时间
  - 新增本地主进程对 `gateway.db` 的近 30 分钟 Token 聚合读取，用于托盘菜单短窗口消耗展示
- 桌面端滚动与静默刷新性能二次优化：
  - 后台静默轮询会根据当前活跃视图按需拉取 `usage summary / sessions`，减少非当前页面无意义数据刷新；
  - 在用户滚动中以及滚动停止后的短窗口内暂停静默同步，降低滚动期间的大块 DOM 重绘概率；
  - `refresh()` 现只重绘当前活跃页面与必要模态层，不再在一次刷新中无差别重绘所有隐藏视图；
  - 账号页卡片列表改为分批追加渲染，减轻账号量较多时的一次性主线程阻塞；
  - 号池成员面板改为统一的局部调度刷新：搜索、排序、折叠、全选/反选和单项勾选不再散落地直接覆盖整段 `innerHTML`；
  - 纯 UI 状态（搜索词、排序键、排序方向、折叠状态）更新时，不再做无必要的整池配置同步，减少高频输入时的表单扫描成本；
  - 目标是减轻各模块页纵向滚动时的卡顿与“滚到一半被后台刷新打断”的体感问题。

### 测试

- 新增 gateway 回归测试：
  - 映射 key 可独立通过鉴权并写入对应 `clientTag`；
  - `allowHeaderOverride=false/true` 两种策略下标签解析行为正确。
- 全量测试通过：`npm test`（68 tests passed）。
- 冒烟验证通过：`npm run smoke:gateway`（健康检查、模型列表、非流式对话、工具调用、admin 接口均通过）。

### 调试记录

- 本地测试初次失败原因并非业务逻辑，而是 `better-sqlite3` Node ABI 不匹配；
- 已通过 `npm rebuild better-sqlite3` 修复后完成全量回归。

## [2026-04-29 13:47 CST]

### 优化

- 网关自动切号稳定性增强：`provider-codex` 上游失败信息新增状态标签透传（`[status:xxx]`）与 `retry-after` 提示（`[retry-after:xxx]`），为网关侧故障分级和冷却策略提供更精确信号。
- 失败分类增强：网关现可直接识别 `GatewayError` 状态码（401/403、429）与上游透传的 `[status:xxx]` 标签，降低鉴权失效与限流误判为普通错误的概率。
- 号池冷却策略增强：成员冷却时长改为“按连续失败次数递增（带上限）”，并可吸收上游 `retry-after` 作为最短冷却窗口，减少短周期反复命中异常账号。
- 号池故障恢复增强：在动态号池自动切号链路中，失败成员会记录更准确的 `lastFailureClass` 与冷却截止时间，提升后续候选过滤与重试连续性。

### 测试

- 新增回归测试：验证上游 `retry-after` 提示会被网关转化为成员冷却窗口。
- 新增回归测试：验证上游 `[status:403]` 会被归类为 `auth_invalid`，并驱动成员进入鉴权失效冷却流程。

### 调整

- 总览顶部固定区继续瘦身：移除“当前路由 / 路由命中 / 活动授权 / 接入鉴权”摘要带，并把相关信息下放合并到“运行总览”，让顶部更聚焦 Token 用量观测。
- 运行总览字段同步重组：补齐当前路由模型、活动授权、接入鉴权与路由命中概览，并移除与顶部同义或重复的信息项。
- Token 用量卡片视觉优化：四张卡片的标题与大数字颜色现跟随各自顶部边框色系，提升总请求数、总 Token、缓存/思考与平均延迟之间的快速辨识度。

## [2026-04-28 16:55 CST]

### 调整

- README 首屏重构：移除标题区表格边线，改为无边框图标 + 标题组合，并新增“桌面控制台预览”说明文案后再展示界面截图。
- 修正文档中的当前口径：README、桌面控制台说明、安装与升级检查清单、概念地图、Codex 风险说明、动态号池设计方案已同步到 `OpenClaw / Hermes` 主接入对象、Token 用量总览与账号级排行、以及“历史导入仅来自本项目本地旧请求事件”的当前实现语义。
- 更新桌面控制台说明中的页面结构与功能边界，补齐独立“策略路由”入口、统计清理范围，以及账号导入弹窗真实页签顺序与名称。

## [2026-04-27 12:22 CST]

### 新增

- 新增网关级 Token 用量统计：每次请求现会持久化记录请求数、成功/失败、平均延迟、输入/输出/总 Token、缓存 Token，并支持历史累计与近 24 小时 / 7 天 / 30 天滚动聚合。
- 新增 `GET /admin/usage/summary` 管理接口，支持按 `all / openclaw / hermes / other` 视角读取 Token 用量总览。
- 桌面端总览页新增“Token 用量总览”常驻卡片，支持 `日 / 周 / 月 / 总` 视图切换与 `OpenClaw / Hermes / 其他客户端` 过滤，便于持续观测本地网关消耗情况。
- 新增网关本地历史回填：网关启动时会从 `local-ai-gateway` 自身历史请求事件中回补 usage 记录（仅本项目数据），并按事件级去重，补齐统计功能上线前的历史请求维度数据。
- 新增账号页“账号级 Token 用量排行”面板，支持按 `日 / 周 / 月 / 总` 切换查看桌面端 Codex 账号的 Token 消耗排行。
- 新增 Token 用量明细弹窗：可查看当前窗口下的账号、客户端与模型排行明细。

### 调整

- 桌面端第三方接入模板主位调整为 `OpenClaw / Hermes / 通用 cURL`，`localRagHub` 降级为次要对象，不再占据总览主模板位。
- 网关客户端识别补充 `Hermes`，其请求现可像 `OpenClaw` 一样进入来源观测、路由命中统计与 Token 用量统计。
- 顶部总头区重构：`Token 用量总览` 已迁移到顶部主信息区，并按卡片化视觉重做，保留原有服务状态、当前路由、活动授权、Provider / 授权数与接入鉴权信息。
- Token 用量总览补充“缓存 / 思考已接入状态”与“历史导入条数”展示，便于区分真实字段覆盖与待接入状态。

### 测试

- 新增 gateway 回归测试，覆盖 Token 用量 summary 聚合与 `Hermes` 客户端识别。
- 新增历史回填回归测试，覆盖本地网关历史请求事件回补与幂等去重。

## [2026-04-16 15:31 CST]

### 优化

- 优化桌面端各模块纵向滚动流畅度：静默刷新改为优先只重绘当前可见视图，不再在后台无差别重建隐藏模块 DOM。
- 新增滚动期间的后台刷新延后机制：当用户正在滚动主内容区时，账号活动与额度静默刷新会先合并为待处理刷新，待滚动停止后再统一补渲染。
- 切换左侧导航时改为即时重绘当前页内容，避免隐藏视图长期不更新，又避免为了“保鲜”而持续重绘全部模块。
- 样式层移除多处 `transition: all`，改为更精确的颜色、边框、阴影与变换过渡，减少滚动过程中的额外 layout/paint 开销。
- 为主要区块与高密度卡片启用 `content-visibility` 离屏渲染优化，降低长页面滚动时的无效绘制成本。

## [2026-04-10 14:20 CST]

### 修复

- 修复桌面端额度刷新对无 `expires` 的 Codex 导入账号强制走 OAuth 刷新导致整批同步失败的问题；现改为优先复用现有 access token 拉取 usage，仅在明确鉴权失效时才回退刷新凭据。
- 修复额度刷新在 `401/鉴权失效` 场景下不会自动换用新 token 重试的问题；同步链路现支持 OAuth 凭据刷新后重试一次，并将新凭据持久化回桌面端账号存储。
- 修复账号卡片在额度同步失败时仍继续展示过期额度快照的误导问题；当快照过旧且最近同步失败时，卡片会回退为“待同步/额度已过期”展示，不再把旧快照当成实时额度。
- 修复桌面端 `重启服务` 请求在无 body 场景仍强制携带 `Content-Type: application/json` 导致上游拒绝的问题；`callAdmin` 现仅在存在 body 时附加 JSON 头，空 body 请求可正常重启。
- 修复会话解析在 `expires` 缺失场景错误强制触发 OAuth 刷新的问题；推理链路改为优先使用现有 access token，避免因无意义刷新触发 `unsupported_country_region_territory` 连续失败。
- 修复号池失败分类对 OAuth 刷新失败识别不准确的问题；`Failed to refresh OAuth token` 现归类为 `auth_invalid`，会进入更长冷却而非短周期网络重试。
- 优化额度刷新失败提示语义：当全部失败来自网络不可达或 OAuth 被上游拒绝时，前端 banner 直接给出可诊断文案，减少“只有失败结论没有原因”的排障成本。

### 测试

- 新增 `openclaw-session` 回归测试，覆盖“无 expires 账号直接读 usage”与“401 后自动刷新 OAuth 再重试”两条额度刷新链路。
- 新增 `resolveSession` 回归测试，覆盖“无 expires 时不强制刷新 OAuth”与“OAuth 刷新被上游拒绝时映射为 `gateway_auth_required`”两条推理会话链路。

## [2026-04-03 11:20 CST]

### 调整

- 号池调度卡片补齐标题栏交互：支持点击标题栏展开/收起，交互行为与策略路由卡片保持一致。
- 号池调度卡片标题区域升级：新增左侧序号头像并放大标题字号，提升多号池配置场景下的识别效率。
- 号池调度新增“单卡保存”按钮，支持仅保存当前卡片配置，减少全量保存操作成本。
- 状态栏下拉菜单刷新频率提升，并在菜单打开后进入短时高频刷新窗口，降低“面板打开后信息滞后”问题。
- 状态栏账号信息改为优先保留最近一次真实中转命中的账号上下文，请求结束后不再立即回落到默认活动账号展示。

## [2026-04-02 19:40 CST]

### 修复

- 修复 `codex-default` 通过本地网关接入 OpenClaw 时透传 `temperature` 导致 Codex 上游返回 `Unsupported parameter: temperature` 的兼容性问题；Codex provider 现忽略该参数，仅保留可兼容字段。
- 新增 `provider-codex` 回归测试，验证 OpenClaw 风格请求进入网关后不会再向 Codex 上游透传 `temperature`。

## [2026-04-01 17:43 CST]

### 调整

- 系统性统一升级项目整体文字字号：确保最小字号不低于 14px，侧边栏及大部分子标题字号放大，提升整体协调性与阅读体验。
- 扩大页面主区域最大宽度：适配更大的屏幕空间。
- 紧凑化号池账号卡片（`.pool-member-option`）：减小垂直内边距与间距，提升单屏信息密度。
- 重构策略路由项与号池项卡片：引入展开/收起交互，加入按序号计算的浅色随机背景色，并显著放大卡片标题与序号标识，便于整体把控规则信息。
- 优化账号资产管理页布局：将搜索工具栏与筛选项移动至账号卡片正上方。
- 简化 Provider 配置页按钮样式：将“启用 Provider”的厚重卡片式复选框改为普通无边框单行样式，降低视觉噪音。
- 新增策略路由与动态号池独立保存能力：为每个路由规则和号池单独设置“保存独立配置”按钮，提升交互便捷性。

## [2026-03-31 15:45 CST]

### 重构

- 完成桌面端第二版重大 UI/UX 样式重构：将 `index.html` 从内联大样式改为结构骨架，新增独立 `styles.css` 承载统一视觉系统与布局规范。
- 适配渲染层对新静态模板与样式文件的加载链路，保持现有功能交互在新样式体系下可用。
- 新增 `extract_html.js` 模板抽取脚本，用于把内联样式迁移为外链样式文件，降低后续前端维护成本。

### 修复

- 网关流式链路新增“首字节前自动切号重试”：当首包前出现网络抖动/上游可重试错误时，会先在同策略下尝试下一账号，避免客户端陷入高频重试风暴。
- 固定账号路由新增“失败降级到号池”能力：固定目标账号失败时，若规则同时配置了 `poolId`，会优先从号池挑选下一可用账号而不是直接失败。
- 新增客户端级熔断与 `Retry-After`：同一 `clientTag` 在短窗口内连续失败会被短时熔断并返回 `429`，降低第三方客户端失控重试对网关与账号的冲击。
- 错误响应链路支持在可重试失败场景回传 `Retry-After` 头，便于第三方应用按服务端节奏退避重试。
- 优化敏感信息脱敏策略：不再对 `access/refresh` 普通字样过度脱敏，改为按真正凭据形态与敏感字段名精准脱敏，保留必要诊断可读性。
- 健康检查的推理观测补充“熔断中的客户端列表”，可直接看到当前被熔断的 `clientTag`、剩余冷却时间与最近失败分类。
- 新增 `POST /admin/telemetry/circuit/reset`，支持按 `clientTag` 或全量清理客户端熔断状态，便于联调与故障恢复。

### 测试

- 新增固定账号失败降级号池回归测试，验证 `fixed-session + poolId` 的自动降级链路。
- 新增流式首字节前失败切号回归测试，验证动态号池在 SSE 首包前可自动切换到下一账号并继续输出。
- 新增客户端熔断回归测试，验证连续失败后返回 `429 + Retry-After`，且不会继续消耗上游调用。
- 新增日志脱敏回归测试，验证普通诊断文本不被过度脱敏，敏感凭据字段仍会被精准掩码。

### 文档

- 更新《OpenClaw 联调验收清单》：补充“流式首字节前切号、固定账号失败降级号池、客户端熔断与 Retry-After”的验收口径与专项检查步骤。

## [2026-03-30 11:55 CST]

### 调整

- 根 `package.json` 现显式补齐 `better-sqlite3 / zod` 运行时依赖，修复安装版因 workspace 子包依赖未被打包而报错“Cannot find package `zod` / `better-sqlite3`”。
- 新增 `npm run check:runtime-deps`，会在发布前校验根包是否完整覆盖各 workspace 的第三方运行时依赖，避免安装包再次缺包。
- 安装版 smoke 校验新增 `zod/package.json` in-asar 断言，进一步收紧桌面包依赖完整性验证。
- 安装版打包调整为仅解包 `*.node` 原生模块，保留 `better-sqlite3` 的 `package.json / lib` 在 `app.asar` 内，修复安装后报错“Cannot find package `better-sqlite3`”。
- 安装版 smoke 校验新增 `better-sqlite3/package.json` in-asar 断言，避免再次出现“二进制文件存在但包元数据缺失”的漏检。
- 安装版桌面主进程在打包环境下改为优先写入 `Application Support/local-ai-gateway/logs/desktop-main.log`，不再依赖系统标准输出，进一步降低 `write EIO` 触发主进程异常窗的概率。
- `packages/core` 中的 SQLite 驱动加载逻辑改为优先正常加载 `better-sqlite3`，在安装版解析失败时自动回退到 `app.asar.unpacked/node_modules/better-sqlite3`，进一步兼容 Electron Builder 对原生依赖的不同布局。

- 网关健康信息新增“正在处理中的请求”观测，状态栏图标改为依据真实在途请求切换，不再依赖较长的最近命中窗口推断 `Active`。
- 状态栏图标三种状态统一改为 macOS 模板图风格，使用亮白层级与形态变化区分空闲、桥接中与异常，并保留 `Active` 环绕动画。
- 状态栏菜单重构为运行态摘要：现可直接查看当前来源、当前号池、当前账号、剩余额度、重置时间、阈值策略，并提供打开主界面、数据目录、日志目录与重启网关入口。
- 诊断页应用数据概况补充说明：开发环境与安装版默认共用同一应用数据目录，仅删除 `.app` 不会清空账号、配置与统计数据。
- macOS 安装版启用开机自启后现会以隐藏方式随系统登录启动；主窗口关闭或 `Command + Q` 默认只隐藏到状态栏，只有“退出并停止网关”才会真正结束应用与本地网关。
- 桌面主进程新增后台额度刷新定时器；即使主窗口已关闭，状态栏菜单中的当前账号额度也会按系统设置的自动刷新间隔持续更新。
- 点击状态栏图标展开菜单时会强制刷新一次当前账号额度，减少菜单内额度值滞后的情况。
- 安装版桌面主进程新增标准输出容错护栏，遇到 `EIO / EPIPE` 这类不可写输出时不再反复弹出 JavaScript 异常窗。
- 进一步为安装版桌面主进程补充 `stdout/stderr.write` 级别容错与 `uncaughtException` 过滤，仅吞掉 `EIO / EPIPE / ENXIO` 这类输出流异常，避免 OAuth 刷新日志再次触发成批系统弹窗。

### 文档

- 桌面控制台使用说明补充状态栏图标与下拉菜单的当前能力说明，并明确开发环境与安装版默认复用同一应用数据目录。
- 项目答疑与开发清单补充“安装重装自动复用 Application Support 数据目录”与“状态栏模板图风格”结论，便于后续回溯。

## [2026-03-29 19:45 CST]

### 调整

- 左侧栏品牌位改为直接展示正式应用图标资源，统一桌面端内外视觉识别。
- App / Dock 图标改为带透明留白的 macOS 风格圆角应用图标，状态栏图标改为无背景的模板图标样式，避免出现生硬方角与实底色块。
- 图标生成链路从 `qlmanage` 切换为 `@resvg/resvg-js`，修复 SVG 转 PNG 时透明背景被错误烘焙成白底的问题。
- 状态栏图标改为真正的透明背景语义图标，并恢复状态色差异；Dock / Finder 图标则保留透明外边距与 macOS 风格圆角底板，避免做成生硬的透明方形资源。
- 左侧栏品牌位改为独立透明背景图标，并适度放大尺寸，提升控制台内的品牌识别度。
- 状态栏 `Active` 图标补齐多帧环绕动画，当前会通过轮播帧图标表现“流量桥接与号池轮询中”的动态状态。
- 修复安装版托管网关重启时的 `spawn ENOTDIR`：打包环境现会使用应用自身可执行文件的 Node 模式启动网关，并改用 `process.resourcesPath` 作为工作目录。
- 左侧栏顶部品牌位重新居中排版，图标放大到 `80px`，品牌标题与副标题字号同步提升，改善整体平衡感。
- 桌面端统一锁定到同一套 UI 缩放级别，并禁止后续缩放漂移，避免开发态与安装版因为 Chromium 持久化缩放值不同而出现界面尺寸不一致。
- 审计并收口本机运行期文件：保留 `dist / release / 图标生成目录` 这类预期产物，清理仓库内 `.DS_Store` 遗留，并补充运行期日志与自动安全备份的保留策略。

### 文档

- 项目答疑与开发清单补充“运行资源与安装体验”说明，记录缩放根因、日志/备份自动清理策略与外部 `.tmp` 目录边界。
- 打包与发布说明补充 App / Dock 图标与状态栏模板图标约定，并记录桌面端 UI 缩放现已统一锁定。

### 新增

- 新增 `apps/desktop/assets/icons/source/` 图标源文件，基于已确认的设计稿 SVG 正式落地图标资源来源。
- 新增 `npm run generate:icons`，可自动生成应用 `.icns`、Dock 图标与状态栏图标资源。

### 调整

- `dev:desktop / package:desktop / dist:desktop` 现都会在启动或打包前自动生成图标资源，避免开发态和安装包使用旧图标或缺失图标。
- 打包配置与 smoke 校验链路已纳入应用图标、Dock 图标和状态栏图标资源检查。
- 打包与发布文档补充图标资源来源、生成命令和图标进入安装包的验收说明。
- 仓库忽略规则新增 `.tmp / cache / plugins`，避免本地 Codex 插件缓存与临时目录被误加入 Git 并持续占满 CPU。
- 安装版 gateway 托管改为主进程内直接启动 `apps/gateway/dist/server.js`，不再依赖 `ELECTRON_RUN_AS_NODE` 子进程模式，规避原生依赖 ABI 不匹配导致的无窗口假死。
- 打包脚本现会先把 `better-sqlite3` 预编译到 Electron ABI，再在打包完成后恢复回当前 Node ABI，确保安装版与开发态都能正常运行。

## [2026-03-28 15:22 CST]

### 新增

- 总览页新增“账号活动观测”摘要卡，可汇总近 1 小时 / 近 24 小时请求量、活跃账号数、近 5 分钟主要来源与近 1 小时最忙账号。
- 账号模块新增“账号资产摘要”，可从额度充足度分布与近 5 分钟 / 1 小时 / 24 小时来源窗口观察账号资产状态。
- 诊断页新增高频接入问题识别：可提示“尚未观测到第三方请求”“策略已启用但尚未命中”“接入鉴权缺少密钥或客户端密钥错误”等场景。
- 新增 `npm run smoke:desktop-package` 与 `npm run preflight:release`，用于发布前自动验证桌面目录包产物、`Info.plist` 与 `app.asar` 是否齐全。
- 诊断与系统页新增“首次启动检查 / 升级与发布前建议”动态面板，并新增《安装与升级检查清单》文档用于长期维护。
- 新增《动态号池设计方案》文档，正式记录三期“请求级自动切号”能力的边界、数据模型、冷却/阈值策略和桌面端交互方案。
- 动态号池后端第一阶段开始接入：路由目标新增 `dynamic-pool` 模式，Admin API 新增号池配置读写，路由预演开始支持返回命中号池、选择原因、候选数和被过滤候选。
- 桌面端开始接入独立“号池调度”模块，用于把多个桌面端 Codex 账号配置为可自动挑号的动态号池。
- 动态号池成员选择改为桌面端账号多选面板，并保留“额外成员标识（高级）”补充输入，降低手填 ID 的配置门槛。
- 动态号池成员多选面板补充搜索、排序、全选、反选与展开/收起，并改为高密度四列账号卡片展示，适配大量账号场景。
- 动态号池新增运行时观测第一版：可在号池卡片内直接查看当前首选成员、可选成员数、冷却成员数、最近失败与最近选中时间。
- 动态号池补充“最近调度事件”面板，可回看最近一次选号与自动切号的原因、来源客户端与失败分类。
- 修复号池成员多选面板的补漏问题：长字符串截断与悬浮标题生效，勾选成员后“已选 X”统计会实时更新。
- 桌面端左侧导航新增独立“策略路由”入口，并把路由规则、默认路由与路由预演从 Provider 配置页中拆出，理清“Provider 配置 / 策略路由 / 号池调度”三条控制链路。
- 号池成员运行时状态新增本地持久化快照，现可跨网关重启恢复最近选中、最近成功、最近失败、连续失败与冷却截止时间。
- 号池调度新增“最近调度事件”弹窗入口，避免事件列表长时间占用页面空间。
- README 头部重构为更贴近 GitHub 常见热门项目的居中展示样式，统一项目标题、徽章与导航快捷链接。
- 号池成员卡片新增成员级调度解释，可直接显示“本轮已选中 / 当前未轮到 / 当前已跳过”的原因说明，降低理解号池调度结果的门槛。
- 诊断页新增“数据迁移与恢复”入口，可导出单文件应用数据备份，并支持导入恢复本地配置、账号、统计与日志。
- 号池最近调度事件的账号标题改为优先显示账号名/邮箱，并在副标题补充识别信息，避免直接暴露晦涩的底层会话标识。
- 号池调度页新增“当前调度摘要”，可直接汇总当前首选账号、被跳过成员的原因分布与最近切号次数。
- 数据迁移与恢复补充“本地数据概况”“打开备份目录”与“导入前备份摘要确认”，进一步完善重装迁移体验。
- 打包与发布链路补充 `release-manifest.json` 生成能力，并新增一键预检后构建桌面包的命令，便于后续核对发布物。
- 实测 `dist:desktop:ready` 已能成功产出 `zip / dmg / blockmap / latest-mac.yml`，发布物主链路现已跑通。

### 测试

- 新增桌面端账号活动汇总纯函数测试，覆盖多会话聚合、主要来源识别与最忙账号判定。
- 新增运行诊断测试，覆盖“无第三方流量”“策略未命中”“接入鉴权配置异常”等提示分支。
- 新增号池运行时观测回归断言，覆盖额度耗尽后自动切到下一成员时的冷却与首选状态展示。
- 新增重复导入同一 Cockpit Tools 账号时复用原有 `profileId` 的断言，明确保证导入更新不会把同一账号拆成新对象。
- 新增动态号池流式请求运行态回归测试，覆盖“最近选中 / 最近成功”时间戳更新。
- 新增动态号池运行时快照恢复测试，覆盖网关重启后成员运行态恢复。
- 新增桌面端应用数据备份工具测试，覆盖备份导出、排除内部 backups 目录，以及恢复后配置 / 账号 / 数据库文件回写。

### 调整

- 补齐 `package.json` 发布元数据，新增 `author` 与 `repository`，减少 Electron 打包时的元数据告警。

### 文档

- 根目录 README 按 GitHub 常见开源项目首页风格重构，新增项目定位、核心能力、快速开始、架构概览、阶段状态与文档入口。
- 桌面控制台说明与项目答疑清单补充“账号活动观测摘要”的能力说明与当前完成状态。
- README、架构总览、概念地图、桌面控制台使用说明第二轮去 OpenClaw 强绑定，统一回到“第三方客户端 / 本地可复用授权 / 网关入口”的主叙事。
- 打包与发布说明、README 同步补充发布前 smoke / preflight 命令与目录包验收说明。
- 桌面控制台说明同步校准 Codex 上游模型列表与并行暴露别名说明，避免文档停留在旧能力边界。
- 概念地图、文档总览、项目答疑与开发清单同步补充“动态号池 / 号池调度”概念、边界和三期推进状态。
- 正式把“真正额度池化”与“直接把原始本地可复用授权纳入正式池成员”标记为长期不做项，后续不再作为产品讨论范围。
- 桌面控制台说明、动态号池方案与项目答疑清单同步补充号池成员多选面板、长期边界和当前三期推进状态。
- 项目答疑清单补充“重复导入账号的无感增量更新”“系统配置暂不继续拆侧边栏”“后续复杂度控制原则”等长期结论。
- 项目答疑清单补充“其他账号型平台适配度评估”“当前一期/二期/三期完成度与高优先级后续项”等长期结论。
- 文档总览、桌面控制台说明与项目答疑清单同步补充“数据导出与迁移恢复”的入口、边界和恢复范围说明。

### 修复

- 修复安装包启动时报 `ERR_MODULE_NOT_FOUND` 的问题：根运行时依赖现已显式声明，打包配置会携带 `node_modules`、工作区 `package.json` 与 `better-sqlite3` 原生模块。
- `smoke:desktop-package` 新增安装包运行时依赖校验，防止 `pi-ai / fastify / better-sqlite3` 漏打包后仍误判为可发布。
- 桌面打包链路新增 `run-electron-builder.mjs`，构建后会自动把 `better-sqlite3` 恢复到当前 Node ABI，避免打包后本地测试与预检被 Electron ABI 污染。
- 修复旧 gateway 进程缺少 `/admin/config/pools` 时号池页面加载与保存返回 `404` 的问题：桌面端现在会尝试识别并接管旧版本地 gateway 进程，再自动重试号池配置请求。
- 修复号池成员卡片的状态色与额度语义不足问题：补齐状态标签、额度数值颜色、进度条与长字符串省略悬浮展示。
- 调整桌面构建回归测试的超时阈值，避免随着桌面端代码体量增长出现构建已成功但测试假超时的情况。
- 诊断页“保存鉴权配置”按钮改为主色样式，和其他配置保存入口保持一致。
- OpenAI-Compatible / Ollama Provider 面板改为默认折叠，并补强启用开关的按钮化样式、对齐和可点击面积，弱化其相对 Codex 主链路的存在感。
- 修复号池成员卡片静默刷新不跟随健康信息重绘的问题，运行时观测现在会在自动刷新周期内同步更新到号池页面。
- 修复号池成员“最近选中”在首个实际请求开始后未及时更新的问题，现已在请求级选号时立刻写入运行态并持久化。
- 优化号池成员卡片的状态呈现：低于阈值、不可选、已跳过等成员会自动降低视觉权重，并移除重复的跳过原因文案。
- 修复安装版打开后程序坞闪动但无窗口的问题：桌面主进程现会捕获启动失败并提示原因，且 `smoke:desktop-package` 已升级为真实拉起目录包并等待 `/healthz` 的强校验。

## [2026-03-27 10:20 CST]

### 新增

- 桌面端“总览 -> 第三方接入模板”新增三套可一键复制模板：`OpenClaw`、`localRagHub`、`通用 cURL`，并自动按当前鉴权模式附带 `apiKey` 提示。
- 新增桌面桥接 `gateway:copy-text`，用于通用文本复制，避免模板复制逻辑分散在渲染层。
- 新增统计持久化能力：路由命中事件与账号会话活动快照落盘到本机 `gateway.db`，重启后自动恢复。
- 新增统计清理接口：`POST /admin/telemetry/reset`，用于一键清空路由命中与会话活动统计。
- 新增会话活动事件明细表：账号卡片可显示“近 5 分钟来源分布/占比”，用于区分累计来源与当前活跃来源。
- 新增 OpenClaw 配置审计脚本 `npm run audit:openclaw`，用于在不重启 OpenClaw 的前提下检查本地网关 Provider、`codex-default` 与 `x-client-tag=openclaw` 是否已经写入。
- 新增 `docs/operations/openclaw-联调验收清单.md`，沉淀“灵活切号版 / 固定专用账号版”的低扰动联调模板与回滚步骤。

### 调整

- 同步完善 `preload` 桥接 API：补齐 `refreshSessionUsage`、`deleteCodexAccount`、`copyText`，降低主进程与渲染层接口漂移风险。
- 第三方接入文档与桌面说明补充“一键复制模板”入口和 `clientTag` 透传/回退说明。
- 第三方接入文档补充 OpenClaw 静态请求头写法与策略路由 demo，便于将 `clientTag=openclaw` 真正落到配置文件。
- OpenClaw `builder / sentry` agent 也已补齐本地网关 provider 头配置，避免不同 agent 命中来源统计不一致。
- 路由命中观测面板新增“按客户端筛选”能力，可快速聚焦指定第三方来源的命中事件。
- 账号卡片“来源分布”改为彩色 Tag 展示，并将计数文案由裸数字改为“X次”以避免歧义。
- 路由统计新增基础清理策略：默认仅保留最近 30 天并限制总量上限；会话活动快照按当前有效会话裁剪。
- 路由观测统计新增 `1 小时 / 24 小时` 窗口计数，并支持桌面端窗口切换显示与“清空统计”操作。
- 收紧账号卡片头部布局：状态标签区域支持自动换行与收缩，避免右上角 Tag 溢出卡片边框。
- 账号页新增“置顶账号”能力：被 pin 的卡片固定显示在首位且不参与排序，并持久化到本机桌面设置。
- 策略路由目标会话支持以 `sessionId / profileId / accountId` 三种标识输入，降低配置 OpenClaw 固定账号时的使用门槛。
- 账号卡片底部操作改为 icon 按钮并移除重复的“复制片段”入口，减少卡片纵向和横向占用。
- 强化“置顶且活跃”账号卡片的视觉状态，提升高优先级活动账号的辨识度。
- 策略路由表单补充字段语义提示，明确必填项、目标会话留空时的行为，以及固定账号与灵活切号的区别。
- 重做账号卡片 icon 操作区的尺寸、配色与悬浮提示，统一激活 / 置顶 / 刷新 / 删除的语义样式，并强化“置顶且活跃”卡片的边框、光晕与状态层级。
- 强化策略路由规则卡片与路由预演结果的视觉反馈，新增配置说明块、规则说明块与分色结果卡片，降低策略分流的理解门槛。
- 复检并抬高桌面端新增/存量辅助文字字号，补齐账号页、Provider 配置页、系统配置页等关键区域的规则性说明文案。
- Codex 上游模型列表与当前可用模型对齐，补齐 `GPT-5.2 / GPT-5.1-Codex-Max / GPT-5.1-Codex-Mini`，并为新模型分配稳定别名 `codex-5.2-core / codex-5.1-max / codex-5.1-mini`。
- 调整手动刷新、账号刷新与后台自动刷新的顶部提示口径：只要存在成功同步即按成功态展示，失败细节下沉到账号卡片和单项状态。
- 固定账号策略路由新增第一次失败回退：当目标账号在请求开始前出现认证失效、刷新失败或明显额度上限报错时，会自动回退到当前活动账号或下一个可用账号，并把回退写入路由告警。
- 账号活动观测补充长窗口统计：账号卡片除近 5 分钟来源外，新增近 1 小时 / 近 24 小时请求数，便于区分瞬时命中与持续占用。
- 调整桌面端开机自启动注册逻辑：开发态不再尝试写入系统登录项，避免 `npm run dev:desktop` 因 macOS 权限限制报错；打包版仍保留真实注册能力。
- 修复路由命中观测更新滞后的问题：静默轮询现会同时刷新 `sessions + health`，第三方请求命中后不再依赖手动刷新才能看到最新路由统计。

### 修复

- 修复旧版桌面主进程未注册 `gateway:copy-text` 时模板复制报错的问题：渲染层新增复制兜底（IPC 失败自动回退到浏览器剪贴板复制）。
- 修复旧版桌面主进程未注册 `gateway:reset-telemetry` 时“清空统计”提示过于生硬的问题，现改为明确提示需完全重启桌面端。
- 修复危险操作缺少二次确认的问题：清空统计、删除账号、删除路由规则现统一经过确认弹窗再执行。

## [2026-03-26 11:58 CST]

### 文档

- 新增 `docs/operations/桌面端-ui-交互开发规范.md`：总结并提炼了本次桌面端 UI/UX 重构的核心设计原则、CSS 变量体系、字号约束（全局最小 14px）以及组件复用指南。此文档将作为后续 Codex (gpt5.4) 及人类开发者进行前端增量开发的强制约束基准。

### 修复

- 收口桌面端颜色实现：将账号头像改为基于 CSS 变量的色板方案，移除 `renderer.ts` 中的硬编码颜色与行内色值。
- 清理桌面端静态样式中的零散直写颜色，统一回归现有变量体系，便于后续继续在规范下增量开发。
- 新增 `.history/` 忽略规则，避免本地历史目录持续污染工作区与提交记录。
- 修复桌面端初始化任一接口失败就整页异常的问题，改为分项加载并输出分层诊断信息。
- 修复额度刷新统计口径与账号页展示对象不一致的问题：刷新接口现仅统计桌面端账号，不再计入仅作为导入来源的可复用授权会话。
- 修复“额度同步失败”与“账号可用”语义混淆：账号卡片新增失败标签和失败原因提示，banner 文案明确“同步失败不等于账号不可用”。

### 测试

- 抽离桌面端账号展示逻辑为纯函数模块，补充账号搜索、排序、额度语义和头像色板索引的回归测试。
- 新增运行诊断纯函数测试，覆盖端口冲突、活动账号过期与健康状态判定。
- 新增网关路由配置接口回归测试，覆盖路由规则保存与预演命中结果。

### 新增

- 新增网关端口可配置能力：系统配置栏支持设置本地网关端口，保存后托管网关可按新端口自动重启。
- 新增端口占用诊断：托管网关启动超时后会检测端口状态，并在端口被占用时返回明确的中文提示。
- 新增网关端口回归测试：覆盖默认端口与自定义端口在健康信息及 OpenClaw 片段中的一致性。
- 新增会话活动快照：网关会记录每个活动会话的请求次数、最近请求时间与成功/失败统计，并透传到桌面端账号卡片。
- 新增账号卡片活跃提示：最近 90 秒内有第三方请求命中某账号时，卡片会显示“活跃调用”标识并强化边框样式。
- 新增服务分层诊断面板：可区分端口冲突、网关未响应、管理令牌异常、活动账号异常等状态。
- 新增二期路由策略层第一步：`/admin/config/routing` 配置读写与 `/admin/config/routing/preview` 预演接口。
- 新增路由策略可视化控制面：Provider 配置页支持启用开关、规则增删、规则保存与路由预演结果展示，并与 Admin 路由配置接口统一同源。
- 新增二期路由策略层第二步：`/v1/chat/completions` 已接入策略命中，可按 `clientTag + requestedModelAlias` 解析并应用目标模型与目标会话（带缺省回退）。
- 新增路由命中观测第一版：`/admin/health` 返回路由命中统计与最近命中事件，桌面端总览新增高亮观测面板（5 分钟命中、累计命中、Top 规则、Top 客户端、最近事件）。
- 新增第三方接入可选鉴权：支持 `none / api-key` 两种模式，推理接口可按 `Authorization: Bearer` 或 `x-api-key` 校验访问。
- 新增鉴权配置接口：`GET/PUT /admin/config/security`，仅回传 `mode/enabled/hasApiKey`，不回传明文密钥。
- 新增第三方接入模板文档：提供 OpenClaw/localRagHub 两套配置模板与 `401/403/503` 错误排查速查表。
- 新增 Codex 多别名并存能力：`codex-default` 之外可并行暴露 `codex-5.4 / codex-5.4-mini / codex-5.3 / codex-5.2`。
- 新增会话活动来源细分：网关按 `clientTag` 记录每个会话的来源请求分布，便于定位第三方调用来源。
- 新增 `clientTag` 自动识别回退：当接入方未显式传 `clientTag` 时，会尝试从 `User-Agent` 推断常见客户端（如 `localraghub` / `openclaw`）。

### 调整

- 账号页默认排序改为“按剩余额度降序”。
- 账号页默认仅展示“桌面端 Codex 账号”，本地可复用授权改为导入来源，不再默认单独出卡。
- 桌面端主文案去 OpenClaw 强绑定：总览、账号页与导入弹窗统一改为更通用的“本地可复用授权/接入片段”表达。
- 刷新状态文案补充分支：当当前无可刷新桌面端账号时，改为显示明确提示，避免误解为刷新失败。
- 账号卡片内部字号下限收口为 `13px`，降低多账号视图下的阅读负担并保持一致性。
- 账号列表网格改为“最大 4 列”自适应布局，并进一步拉大卡片间距，提升多账号场景下的可读性与扫描效率。
- 桌面端 `refresh` 数据链路新增路由策略配置加载，避免“页面已渲染但路由配置未落地”的状态不一致问题。
- 桌面端系统配置页新增“第三方客户端接入鉴权”配置区，并在顶部摘要展示当前鉴权模式。
- 复制接入片段在启用 API Key 鉴权时会提示 `apiKey` 字段，降低第三方接入遗漏风险。
- 总览“快速指引”升级为双模板展示（OpenClaw/localRagHub）并内置错误码速查，提升接入与排障效率。
- Provider 配置页新增 Codex“并行暴露模型别名”勾选区，可视化控制多别名输出。
- 账号卡片新增“来源分布”展示，可直接看到当前账号主要由哪些客户端在调用。
- 全局文字可读性提升：统一抬高模块文本最小字号（账号卡片 ID 字号保持不变），降低小字阅读负担。
- Provider 配置等设置模块新增“头部点击收起/展开”交互，便于快速聚焦当前配置段落。
- 全局卡片边框与阴影对比度增强，提升模块分区辨识度。

## [2026-03-26 11:51 CST]

### 调整

- 优化左侧边栏比例：将左侧边栏宽度缩小至 `180px`（原宽度的2/3），并将导航菜单的字号从 `20px` 调整回更协调的 `15px`，以匹配应用整体视觉平衡。
- 全面清查最小字号：更新了 `renderer.ts` 中「已注册 Provider 清单」、「运行诊断与日志」、「快速指引」等模块的动态渲染代码，确保整个系统内的所有辅助文本和标签字号均不小于 `14px`。

## [2026-03-26 11:45 CST]

### 调整

- 优化整体字号规范：左侧栏字号放大至 `20px`，系统全局最小字号收束至 `14px`，并同步放大了各级标题与文本。
- 限制表单输入框宽度：为 `.input-field` 增加 `max-width: 480px`，避免大屏下输入框过度横向拉伸。
- 强化卡片设计感：加深了全局边框颜色 (`--border-light` / `--border-strong`) 与卡片阴影 (`box-shadow`) 的透明度，使所有模块的卡片层级更清晰。
- 账号卡片头像优化：基于账号 ID 计算固定哈希值，为左上角头像框赋予随机的淡雅背景色与高对比度文字色。

## [2026-03-26 11:30 CST]

### 调整

- 桌面端整体 UI 重构，引入 macOS Native / 专业工作台设计风格。
- 重构页面布局结构，去除冗余的渐变背景，采用干净的白/灰配色体系，强化层级与模块重心。
- 账号模块界面升级为“账号资产管理台”，优化账号卡片展示形式、配额进度条以及操作按钮的专业度。
- 顶部摘要区和侧边导航视觉重构，减少工程后台感，提升控制面应用气质。
- 配置页与诊断页信息展示优化，引入更清晰的分组排版和状态反馈机制。

## [2026-03-26 10:39 CST]

### 新增

- 新增《桌面端 UI 与交互重构交接说明》，用于将桌面端视觉与交互重构任务移交给外部协作者。

### 调整

- 账号卡片网格改为宽屏最多单行 4 列，并增大卡片间距。
- 账号卡片内部信息改为单列纵向排布，减少横向挤压。
- 账号模块新增工具栏，支持搜索、排序切换、全量刷新、导入账号配置和添加 Codex 账号。
- “添加 Codex 账号”按钮已从总览移入账号模块。
- 卡片类元素补充统一阴影与悬浮动效，账号卡片间距进一步拉开。
- 控制台初始化改为“先渲染界面、再后台同步实时额度”，减少首屏阻塞等待。
- 新增系统配置栏，支持开机自启和自动刷新时间间隔设置。
- 额度进度条改为语义化配色，额度充足显示绿色、偏低显示橙色、临近耗尽显示红色。
- 左侧栏改为固定定位，右侧主内容区支持独立纵向滚动。
- 账号卡片中的额度与重置时间改为双栏紧凑布局，并将额度百分比移到进度条右侧。

### 新增

- 新增“导入账号配置信息”入口，支持直接导入 Cockpit Tools 多平台导出文件中的 Codex 账号。

### 修复

- 修复账号配置导入只能简单追加、无法按 `accountId / email` 无感更新的问题。
- 修复账号排序在降序时空额度会被排到前面的边界问题。
- 修复桌面端并发初始化时重复拉起 gateway 的启动竞争问题。
- 修复多账号场景下实时额度串行刷新过慢的问题，改为限流并发刷新。
- 修复会话缓存不会随账号删改及时裁剪的潜在内存滞留问题。

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
- 新增《概念地图》和《项目答疑与开发清单》，用于长期维护概念边界、关键答疑与开发路线。
- 新增 cockpit 风格 Codex JSON 导入解析，支持读取邮箱、套餐、额度百分比与重置时间快照。
- 新增 Codex 上游模型可视化切换第一版，当前可在桌面端切换 `codex-default` 背后的 `gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.2-codex`。
- 新增 Codex 实时额度刷新第一版，提供 `POST /admin/sessions/refresh` 并支持桌面端主动刷新账号额度与重置时间快照。
- 新增会话层实时额度测试与 Admin 刷新接口测试，覆盖使用量快照回填与持久化。
- 新增《Codex 接入风险与限流说明》，明确第三方客户端接入边界、高消耗任务风险和推荐使用策略。

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
- 桌面端 Codex 账号卡片增强为优先展示结构化元数据：邮箱、套餐、额度百分比、重置时间与快照时间。
- 桌面端“刷新状态”现在会同步刷新 Codex 实时额度，并将账号卡片的额度文案调整为窗口化剩余额度展示。
- 桌面端实时额度刷新已改为直接读取本地 OAuth 会话，不再依赖 gateway 是否已升级到带 `/admin/sessions/refresh` 路由的版本。
- 桌面端账号卡片已改为直接使用主进程本地会话数据，避免旧版 gateway 会话接口丢失额度元数据。
- 桌面端账号卡片标题现优先显示邮箱账号名，并改为更紧凑的多列布局以适配多账号场景。
- 桌面端刷新按钮统一补充 loading 状态，并进一步收敛账号卡片中的次要信息展示。
- 桌面端账号卡片继续精简，移除标题下方 ID，并补充更明确的最近同步语义。
- 桌面端整体 UI 基础样式已重构为统一的 sidebar / topbar / view stack 设计体系。
- 桌面端当前视图已支持本地持久化，并补充了顶部状态摘要与配置页分组布局。
- Git 提交规范补充为统一使用中文 commit 注释。
- smoke 脚本调整为区分“本地链路失败”和“上游额度限制”，降低真实上游限额带来的误报。
- 构建忽略规则补充 `release/` 与 `*.tsbuildinfo`，避免产物和缓存污染工作树。

### 修复

- 修复 `chat/completions` 请求在连接关闭事件上被过早中断的问题，避免本地请求被误判为已取消。
- 修复 Codex Responses 上游要求 `instructions` 必填导致的 400 错误，补充默认 system prompt。
- 修复工具调用与流式 SSE 在 OpenAI-compatible 输出过程中的兼容性细节。
- 修复测试层对编译产物的隐式依赖，改为直接验证源码入口。
- 修复桌面端 OAuth 登录在浏览器回调成功后仍可能因主进程 `fetch failed` 报错的问题，改为优先使用 Electron 网络栈完成令牌交换。
- 修复 OpenClaw 已登录授权与桌面端导入账号在产品语义上的混淆，改由 UI 与文档显式区分“授权源”和“账号”。
- 修复测试运行时对 workspace 共享包旧 `dist` 产物的隐式依赖，Vitest 现直接解析到源码入口。
- 修复 Electron 桌面端 `renderer` 直接引用 workspace 共享包导致浏览器环境模块解析失败的问题，恢复左侧导航、统计卡片、账号区与 Codex 上游模型下拉的初始化。
- 新增桌面端构建回归测试，防止 `apps/desktop/dist/renderer.js` 再次产出未解析的 `@local-ai-gateway/*` 裸模块引用。
- 修复桌面端账号额度长期停留在导入快照的问题，当前会优先从 Codex 上游实时拉取最新剩余额度与重置时间。
- 修复桌面端在旧主进程尚未注册 `gateway:refresh-session-usage` IPC 时整页初始化失败的问题，现会自动回退到普通状态刷新。
- 修复桌面端连接旧版 gateway 且缺少 `/admin/sessions/refresh` 路由时的 `404` 初始化报错，现会自动降级为普通状态刷新。
- 修复桌面端实时额度刷新对 gateway Admin 新路由的版本依赖，改为主进程直接读取本地 OAuth 会话并刷新额度快照。
- 修复实时额度已刷新但账号卡片仍显示“待接入 / 待同步”的问题，当前账号区与额度刷新共用同一套本地会话数据源。
- 修复额度刷新失败时只有 banner 无法定位具体账号的问题，当前“最近错误”区会显示失败会话和失败原因。
- 修复桌面端导入账号卡片标题仍显示内部 ID 的问题，当前会优先展示邮箱账号名。
- 修复桌面端缺少单账号删除与单账号刷新入口的问题，并为删除动作增加二次确认。
- 修复刷新操作缺少执行中反馈的问题，当前顶部刷新和单卡刷新都会显示 loading 状态。
- 修复左侧导航仅通过锚点滚动定位的问题，当前已切换为真正的单页视图切换。
- 修复刷新后视图容易回到默认页的问题，当前会保留上一次激活视图。
