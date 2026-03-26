# 桌面端 UI / UX 增量开发规范 (致 Codex)

**文档定位：**
本文件用于约束 Local AI Gateway 桌面端控制台 (`apps/desktop/static/index.html` 及相关前端脚本) 的 UI 与 UX 设计。
在此前的重构中，我们已经将该界面确立为**“macOS Native / 专业控制台”**风格。后续任何由 AI (如 Codex) 或人类开发者介入的增量功能开发，**必须**严格遵守以下规范，禁止退化为普通网页或随意的控制台风格。

---

## 1. 核心设计原则

- **工具感与克制**：我们是专业的本地运行环境控制台。不要添加多余的视觉噪音（如大面积的渐变色背景、花哨的毛玻璃效果、深色高亮大阴影）。
- **统一的层级表达**：界面通过明确的灰白底色对比、柔和的阴影 (`box-shadow`) 和细边框 (`1px solid`) 来区分层级，不要随意引入新的卡片结构。
- **复用而非新建**：在开发新功能时，优先复用已有的 CSS 变量 (CSS Variables) 和组件类名 (CSS Classes)，**严禁**在行内样式中硬编码不符合现有体系的颜色和字号。

---

## 2. 颜色与变量体系 (CSS Variables)

所有的颜色调用必须使用 `:root` 下定义的变量。

### 基础背景与边框
- `--bg-window` (`#f3f3f6`)：应用最底层的窗口背景色（侧边栏区域）。
- `--bg-main` (`#ffffff`)：主视窗与卡片的纯白背景。
- `--bg-surface` (`#f9f9fb`)：用于次级区域，如卡片内部的列表项、表单标题栏、次要信息的背景。
- `--border-light` (`rgba(0, 0, 0, 0.12)`)：用于常规的分隔线和淡边框。
- `--border-strong` (`rgba(0, 0, 0, 0.20)`)：用于需要强化的边界，如表单输入框的边框、悬浮卡片的边框。

### 文本层级
- `--text-primary` (`#111827`)：正文、标题、强调文本。
- `--text-secondary` (`#4b5563`)：次要说明、表单描述。
- `--text-tertiary` (`#9ca3af`)：极弱的辅助信息、ID、占位符。

### 状态色 (Tone)
必须成对使用背景和文字颜色，保持视觉统一：
- 成功 (Success)：`--success` / `--success-bg`
- 警告 (Warning)：`--warning` / `--warning-bg`
- 危险/错误 (Danger)：`--danger` / `--danger-bg`
- 信息/活动 (Info/Active)：`--accent-color` (`#2563eb`) / `--accent-soft`

---

## 3. 排版与字号约束

经过优化，当前的字号体系已经稳定，**系统全局最小字号严禁低于 14px**。

- **全局基准**：`body` 字号为 `15px`。
- **左侧导航栏**：菜单项字号 `15px`，Logo 区域标题 `15px`。
- **主标题 (H1)**：`28px`，字重 `600`。
- **次级标题 (H2/H3)**：`22px` / `18px`，字重 `600`。
- **卡片内标题/重要文本**：`15px` / `16px`，字重 `600`。
- **辅助说明/小字号文本**：统一使用 `14px`。严禁使用 `11px`, `12px`, `13px`。

---

## 4. 核心组件复用指南

开发新模块时，请直接复用以下结构，不要自己凭空手捏 HTML。

### 4.1 卡片 (Card)
所有内容块应被包裹在 `.card` 或 `.settings-group` 中。
```html
<div class="card">
  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <strong style="font-size: 15px; font-weight: 600;">标题</strong>
      <span style="font-size: 14px; color: var(--text-tertiary);">副标题或ID</span>
    </div>
    <!-- 状态标签复用 .badge -->
    <span class="badge active">运行中</span>
  </div>
  <!-- 卡片内容... -->
</div>
```

### 4.2 按钮 (Button)
- 主操作：`<button class="btn primary">保存</button>`
- 次要操作：`<button class="btn secondary">刷新</button>`
- 弱化操作 (无边框)：`<button class="btn ghost">复制</button>`
- 危险操作：`<button class="btn ghost danger-ghost">删除</button>`
- 卡片内的小按钮附加 `.mini` 类名：`<button class="btn secondary mini">操作</button>`

### 4.3 表单 (Form)
- 输入框请使用 `<input class="input-field" />`。
- `.input-field` 已设定 `max-width: 480px` 以防止宽屏下拉伸过长。如果需要占满网格，请考虑父级布局，但尽量保持紧凑。
- 表单布局请参考 `.settings-group` -> `.settings-body` -> `.form-row` -> `.form-field` 的标准嵌套。

### 4.4 状态胶囊 (Badge)
使用 `<span class="badge {tone}">标签文字</span>`
可选的 Tone 类名：`active` / `available` (绿), `expired` / `incomplete` (黄), `invalid` / `disabled` (红), `neutral` (灰)。

---

## 5. 动态渲染 (DOM 操作) 约束

由于本项目未使用 Vue/React 等框架，所有列表渲染均在 `renderer.ts` 中通过原生的 `innerHTML` 拼接完成。

1. **保留事件挂点**：所有的按钮点击、页面切换依赖于 `data-action` 和 `data-nav-target` 等属性。修改 DOM 结构时**绝不可移除**这些挂载点。
2. **XSS 防护**：拼接 HTML 字符串时，任何来自数据源的变量必须通过 `escapeHtml()` 函数进行转义。
3. **保持内联样式克制**：在 `renderer.ts` 中拼接 DOM 时，允许使用内联 `style` 进行布局微调（如 `display: flex; gap: 4px;`），但**严禁**在内联样式中写死颜色值（如 `color: #333`），必须使用 `var(--text-...)`。

---

## 6. 特殊视觉处理

- **账号头像**：如果你需要渲染新的用户实体，请复用 `renderer.ts` 中的 `getAvatarColor(id: string)` 方法，以获取基于哈希的稳定、低饱和度的随机背景色和对应文字色。

---
*致 Codex：当你阅读到这份文档时，请将自己的 UI 生成审美切换到“专业级 macOS 本地应用”模式。拒绝随意的网页风，保持克制、专业与高度一致性。*