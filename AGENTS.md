# 仓库协作约定

本文件用于约束在本仓库内进行开发、调试和文档维护时的基础规则。

## 核心要求

- 所有项目文档类 Markdown 文件统一使用中文。
- 每一次代码改动、需求变更、结构调整、bug 修复、调试结论或优化项，都必须同步更新根目录的 [CHANGELOG.md](./CHANGELOG.md)。
- 更新 `CHANGELOG.md` 时遵循现有格式：按日期降序排列、同一天收敛到同一个时间戳条目下、每条记录尽量简短。
- 不得把 access token、refresh token、cookie、Authorization 等敏感信息写入仓库、日志或文档。

## 文档目录约定

- `README.md`：仓库入口说明
- `CHANGELOG.md`：变更回溯记录
- `docs/prd/`：产品需求文档
- `docs/architecture/`：架构与接口设计
- `docs/operations/`：运行、调试、维护流程

