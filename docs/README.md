# 文档总览

本目录用于存放 `Local AI Gateway` 的产品、架构与实施文档。

## 当前文档

- [v1 产品需求文档（PRD）](./prd/local-ai-gateway-v1.md)
- [架构总览](./architecture/overview.md)
- [概念地图](./architecture/%E6%A6%82%E5%BF%B5%E5%9C%B0%E5%9B%BE.md)
- [动态号池设计方案](./architecture/%E5%8A%A8%E6%80%81%E5%8F%B7%E6%B1%A0%E8%AE%BE%E8%AE%A1%E6%96%B9%E6%A1%88.md)
- 共享中转站专题：
  - [二期 / 三期共享网关开发进度清单](./architecture/shared-gateway/%E4%BA%8C%E6%9C%9F%E4%B8%89%E6%9C%9F%E5%85%B1%E4%BA%AB%E7%BD%91%E5%85%B3%E5%BC%80%E5%8F%91%E8%BF%9B%E5%BA%A6%E6%B8%85%E5%8D%95.md)
  - [二期 / 三期共享网关重构技术方案](./architecture/shared-gateway/%E4%BA%8C%E6%9C%9F%E4%B8%89%E6%9C%9F%E5%85%B1%E4%BA%AB%E7%BD%91%E5%85%B3%E9%87%8D%E6%9E%84%E6%8A%80%E6%9C%AF%E6%96%B9%E6%A1%88.md)
  - [公网共享中转站技术可行性分析](./architecture/shared-gateway/%E5%85%AC%E7%BD%91%E5%85%B1%E4%BA%AB%E4%B8%AD%E8%BD%AC%E7%AB%99%E6%8A%80%E6%9C%AF%E5%8F%AF%E8%A1%8C%E6%80%A7%E5%88%86%E6%9E%90.md)
  - [最低可行公网共享方案 A / B 记录](./architecture/shared-gateway/%E6%9C%80%E4%BD%8E%E5%8F%AF%E8%A1%8C%E5%85%AC%E7%BD%91%E5%85%B1%E4%BA%AB%E6%96%B9%E6%A1%88A-B%E8%AE%B0%E5%BD%95.md)
  - [局域网小范围共享中转站技术实施方案](./architecture/shared-gateway/%E5%B1%80%E5%9F%9F%E7%BD%91%E5%B0%8F%E8%8C%83%E5%9B%B4%E5%85%B1%E4%BA%AB%E4%B8%AD%E8%BD%AC%E7%AB%99%E6%8A%80%E6%9C%AF%E5%AE%9E%E6%96%BD%E6%96%B9%E6%A1%88.md)
  - [API 中转站生态与风险评析](./architecture/shared-gateway/API%E4%B8%AD%E8%BD%AC%E7%AB%99%E7%94%9F%E6%80%81%E4%B8%8E%E9%A3%8E%E9%99%A9%E8%AF%84%E6%9E%90.md)
- [OpenClaw 接入与运行说明（专项）](./operations/openclaw-%E6%8E%A5%E5%85%A5%E4%B8%8E%E8%BF%90%E8%A1%8C.md)
- [第三方客户端接入模板与错误排查](./operations/%E7%AC%AC%E4%B8%89%E6%96%B9%E5%AE%A2%E6%88%B7%E7%AB%AF%E6%8E%A5%E5%85%A5%E6%A8%A1%E6%9D%BF%E4%B8%8E%E9%94%99%E8%AF%AF%E6%8E%92%E6%9F%A5.md)
- [Provider 扩展配置](./operations/provider-%E6%89%A9%E5%B1%95%E9%85%8D%E7%BD%AE.md)
- [桌面控制台使用说明](./operations/%E6%A1%8C%E9%9D%A2%E6%8E%A7%E5%88%B6%E5%8F%B0%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md)
- [数据导出与迁移恢复](./operations/%E6%95%B0%E6%8D%AE%E5%AF%BC%E5%87%BA%E4%B8%8E%E8%BF%81%E7%A7%BB%E6%81%A2%E5%A4%8D.md)
- [安装与升级检查清单](./operations/%E5%AE%89%E8%A3%85%E4%B8%8E%E5%8D%87%E7%BA%A7%E6%A3%80%E6%9F%A5%E6%B8%85%E5%8D%95.md)
- [桌面端 UI 与交互重构交接说明](./operations/%E6%A1%8C%E9%9D%A2%E7%AB%AF-ui-%E4%BA%A4%E4%BA%92%E9%87%8D%E6%9E%84%E4%BA%A4%E6%8E%A5%E8%AF%B4%E6%98%8E.md)
- [Codex 接入风险与限流说明](./operations/codex-%E6%8E%A5%E5%85%A5%E9%A3%8E%E9%99%A9%E4%B8%8E%E9%99%90%E6%B5%81%E8%AF%B4%E6%98%8E.md)
- [项目答疑与开发清单](./operations/%E9%A1%B9%E7%9B%AE%E7%AD%94%E7%96%91%E4%B8%8E%E5%BC%80%E5%8F%91%E6%B8%85%E5%8D%95.md)
- [开发与变更流程](./operations/%E5%BC%80%E5%8F%91%E4%B8%8E%E5%8F%98%E6%9B%B4%E6%B5%81%E7%A8%8B.md)
- [打包与发布说明](./operations/%E6%89%93%E5%8C%85%E4%B8%8E%E5%8F%91%E5%B8%83.md)
- [架构决策记录（ADR）0001](./decisions/0001-%E6%9C%8D%E5%8A%A1%E4%BC%98%E5%85%88%E4%BA%8E%E6%A1%8C%E9%9D%A2%E5%A3%B3.md)
- [架构决策记录（ADR）0002](./decisions/0002-%E5%A4%8D%E7%94%A8-openclaw-%E4%BC%9A%E8%AF%9D%E4%BD%9C%E4%B8%BA%E9%A6%96%E7%89%88%E8%AE%A4%E8%AF%81%E6%9D%A5%E6%BA%90.md)
- [架构决策记录（ADR）0003](./decisions/0003-%E5%AF%B9%E5%A4%96%E7%BB%9F%E4%B8%80%E9%87%87%E7%94%A8-openai-compatible-%E6%8E%A5%E5%8F%A3.md)

## 目录约定

- `prd/`：产品需求文档、范围定义、阶段目标
- `architecture/`：架构设计、接口设计、数据流说明
- `architecture/shared-gateway/`：公网共享、多租户中转站、账号池运营与风险评估专题记录
- `operations/`：运行、部署、调试、维护文档
- `decisions/`：关键技术决策与变更记录

## 说明

- 本仓库内由项目维护的 Markdown 文档统一使用中文。
- 所有后续改动必须同步更新仓库根目录的 `CHANGELOG.md`。
- 影响项目理解的关键答疑、边界说明、待优化项与预研项，应同步更新《项目答疑与开发清单》。
- `node_modules/`、`vendor_imports/` 等第三方目录中的 Markdown 不属于项目文档范围，不做翻译或改写。
