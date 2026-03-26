# 桌面端 UI 与交互重构交接说明

本文档用于将 `Local AI Gateway` 当前 Electron 桌面端的 UI 设计与交互设计重构任务，临时交接给外部协作者（如 Trae 中的 Gemini 3 Pro）执行。

本次交接目标非常明确：

- 只做桌面端 `UI 设计 / 交互设计 / 视觉重构 / 结构重组`
- 不改动功能边界
- 不擅自重写业务逻辑
- 不改变现有数据来源和核心能力语义

如果需要为了 UI 重构做少量前端结构调整，可以做，但应尽量保持接口、事件和功能行为兼容。

## 1. 项目定位

本项目不是聊天应用，而是一个：

- 本地 AI Gateway
- 本地授权 / 账号管理台
- Provider 配置台
- OpenClaw 与其他本地客户端的接入控制面

桌面端不是消费面，而是控制面。

因此桌面端的核心定位应该更接近：

- 本地控制台
- 账号与授权操作台
- Provider 配置与诊断中心

而不是：

- 聊天窗口
- 简单状态面板
- 纯后台管理页面

## 2. 当前功能边界

当前功能已经基本可用，请不要在 UI 重构时破坏这些能力：

### 2.1 总览

- 展示服务状态
- 展示默认 Provider / 默认模型
- 展示 OpenClaw Base URL
- 展示当前活动授权
- 展示授权对象数量

### 2.2 账号模块

- 展示桌面端导入的 Codex 账号
- 展示 OpenClaw 可复用授权
- 添加 Codex 账号
- 导入账号配置文件
- 搜索账号
- 账号排序
- 全量刷新账号额度
- 单账号刷新
- 切换当前活动账号
- 删除本地导入账号
- 将 OpenClaw 授权导入为桌面端账号
- 复制接入片段

### 2.3 Provider 配置

- 配置 Codex 上游模型
- 配置 OpenAI-compatible
- 配置 Ollama
- 保存后自动重启服务
- 展示已注册 Provider

### 2.4 诊断页

- 展示最近错误
- 展示 provider 诊断信息
- 展示系统配置
- 设置开机自启
- 设置自动刷新时间间隔

## 3. 当前桌面端存在的核心问题

请重点围绕这些问题做重构：

### 3.1 视觉风格不够成熟

- 整体更像工程调试面板，而不像正式桌面应用
- 模块气质不统一
- 层级感不足
- 视觉重心分布不够合理

### 3.2 信息密度与主次关系不理想

- 账号模块仍然较拥挤
- 某些说明信息重复
- 顶部摘要、账号工具栏、账号卡片之间的优先级不够清晰
- 配置页的信息分组仍然可以更强

### 3.3 交互反馈还不够产品化

- 某些状态反馈仍然偏工程化
- 页内模块切换虽然已是单页切换，但整体“应用感”仍然不够
- 列表操作、筛选、排序、状态展示仍可更成熟

### 3.4 设计规范不统一

- 卡片、按钮、标签、输入框虽然已有统一基础，但还不够精致
- 空状态、异常状态、不可用状态的表达不够系统
- 一些边距、留白、标题层级还可以继续收束

## 4. 本次重构目标

希望协作者输出一版更像成熟本地桌面工具的设计，风格可以参考：

- 现代桌面控制台
- AI 账号 / 模型管理工具
- 本地开发工具或运维工具

但请避免：

- 过度花哨
- 纯 Dribbble 风格而牺牲可用性
- 只换皮，不重构信息架构

预期效果：

- 看起来更像正式产品
- 模块职责更清晰
- 账号管理更顺手
- 配置与诊断更像“工具台”
- 保持中文语义与本项目已有概念体系一致

## 5. 强约束

以下约束请务必遵守。

### 5.1 不改功能语义

不要擅自改变这些核心概念：

- `桌面端 Codex 账号`
- `OpenClaw 可复用授权`
- `活动账号`
- `Codex Provider`
- `OpenAI-compatible`
- `Ollama`

不要把它们重新混淆。

### 5.2 不改现有核心数据来源

当前功能依赖的关键数据来源包括：

- `~/.openclaw/agents/*/agent/auth-profiles.json`
- `~/Library/Application Support/local-ai-gateway/config.json`
- `~/Library/Application Support/local-ai-gateway/codex-auth-profiles.json`

UI 重构不要擅自改这些来源。

### 5.3 不重写后端功能

本次交接重点是 UI / UX，不是功能重构。

尽量不要改动这些后端或运行时行为：

- gateway 启停逻辑
- OAuth 导入逻辑
- 账号额度刷新逻辑
- provider 注册逻辑
- OpenClaw 会话扫描逻辑

如确实为了 UI 结构必须做少量前端层改动，可以做，但应尽量局限在桌面端层面。

### 5.4 尽量保留现有交互挂点

桌面端当前存在较多前端事件绑定依赖这些 DOM id / data-action：

- `open-account-modal`
- `import-account-config`
- `refresh-accounts`
- `copy-snippet-toolbar`
- `save-provider-settings`
- `save-system-settings`
- `account-search`
- `account-sort-key`
- `account-sort-direction`
- 各类 `data-action`
- 各类 `data-nav-target`
- 各类 `data-view`

如果协作者要重构 DOM 结构，建议：

- 尽量保留这些已有 id / data 属性
- 或同步调整前端渲染与绑定逻辑，但不要改变功能行为

## 6. 推荐主要修改范围

优先修改：

- [apps/desktop/static/index.html](/Users/henery/code/local-ai-gateway/apps/desktop/static/index.html)
- [apps/desktop/src/renderer.ts](/Users/henery/code/local-ai-gateway/apps/desktop/src/renderer.ts)

如确有必要，可少量查看：

- [apps/desktop/src/main.ts](/Users/henery/code/local-ai-gateway/apps/desktop/src/main.ts)
- [apps/desktop/static/preload.cjs](/Users/henery/code/local-ai-gateway/apps/desktop/static/preload.cjs)
- [apps/desktop/src/preload.ts](/Users/henery/code/local-ai-gateway/apps/desktop/src/preload.ts)

但原则上：

- `main.ts` 不是本次重构重点
- `preload` 不是本次重构重点
- 不建议扩散到 gateway 端

## 7. 当前已落地的桌面端结构

当前桌面端已分为四个主视图：

- `总览`
- `账号`
- `配置`
- `诊断`

并具备以下结构基础：

- 左侧固定导航栏
- 顶部摘要区
- 主内容区独立滚动
- 账号模块工具栏
- 账号卡片网格
- 配置页分组
- 诊断页错误与系统配置

也就是说，本次不是从零设计，而是在已有信息架构基础上做系统级重构优化。

## 8. 建议重点重构方向

### 8.1 导航

- 优化左侧栏视觉层级
- 让当前选中态更清晰
- 让导航更像桌面工具，而不是网页后台

### 8.2 顶部摘要区

- 减少“工程后台”味道
- 更清晰地表达当前运行态
- 强化控制面气质

### 8.3 账号模块

账号模块是当前最重要的页面，应重点优化：

- 工具栏
- 搜索 / 排序区
- 卡片排布
- 卡片信息层级
- 卡片操作区
- 状态标签
- 额度展示方式

建议让账号模块更像“账号资产管理台”。

### 8.4 配置模块

- 增强配置块的分组感
- 降低表单噪音
- 强化主次层级
- 让 Provider 配置更像真正的“设置页”

### 8.5 诊断模块

- 增强错误块与系统设置块的区别
- 把“运行诊断”与“系统设置”视觉上明确分开
- 让诊断页不再只是杂项堆放区

## 9. 建议保留的产品语义

以下文案语义建议尽量保留，不要在 UI 重构时随意改名：

- 本地 AI 网关控制台
- Codex 账号与授权
- OpenClaw 可复用授权
- Provider 配置
- 诊断与错误
- 系统配置
- 开机自启动
- 自动刷新时间间隔
- 添加 Codex 账号
- 导入账号配置信息

## 10. 文档参考

在做 UI / UX 重构前，建议先阅读这些文档：

- [架构总览](/Users/henery/code/local-ai-gateway/docs/architecture/overview.md)
- [概念地图](/Users/henery/code/local-ai-gateway/docs/architecture/%E6%A6%82%E5%BF%B5%E5%9C%B0%E5%9B%BE.md)
- [桌面控制台使用说明](/Users/henery/code/local-ai-gateway/docs/operations/%E6%A1%8C%E9%9D%A2%E6%8E%A7%E5%88%B6%E5%8F%B0%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md)
- [项目答疑与开发清单](/Users/henery/code/local-ai-gateway/docs/operations/%E9%A1%B9%E7%9B%AE%E7%AD%94%E7%96%91%E4%B8%8E%E5%BC%80%E5%8F%91%E6%B8%85%E5%8D%95.md)

## 11. 希望协作者交付的结果

建议交付至少包含：

- 一版完整的桌面端 UI / UX 重构实现
- 不破坏现有功能的交互调整
- 统一后的设计语言
- 更成熟的卡片、工具栏、状态和表单系统
- 必要的 CSS / DOM 结构整理

如果协作者愿意进一步完善，最好还能补：

- 更好的空状态设计
- 更好的错误状态设计
- 更好的 loading 体验
- 更稳定的响应式适配

## 12. 当前交接时的仓库状态

截至本次交接时：

- 本地工作树已清理干净
- 当前代码已提交
- 当前桌面端功能可用，但 UI 仍不够成熟
- 本次交接的重点是“重构设计与交互”，不是补功能

## 13. 给协作者的一句话要求

请把它从“工程师能用的控制台”重构成“普通用户也觉得是正式桌面应用的本地 AI 控制台”，但不要破坏现有功能和概念体系。
