# 文档总览

本目录用于存放 `Local AI Gateway` 的产品、架构与实施文档。

## 当前文档

- [v1 产品需求文档（PRD）](./prd/local-ai-gateway-v1.md)
- [架构总览](./architecture/overview.md)
- [OpenClaw 接入与运行说明](./operations/openclaw-%E6%8E%A5%E5%85%A5%E4%B8%8E%E8%BF%90%E8%A1%8C.md)
- [Provider 扩展配置](./operations/provider-%E6%89%A9%E5%B1%95%E9%85%8D%E7%BD%AE.md)
- [桌面控制台使用说明](./operations/%E6%A1%8C%E9%9D%A2%E6%8E%A7%E5%88%B6%E5%8F%B0%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md)
- [开发与变更流程](./operations/%E5%BC%80%E5%8F%91%E4%B8%8E%E5%8F%98%E6%9B%B4%E6%B5%81%E7%A8%8B.md)
- [打包与发布说明](./operations/%E6%89%93%E5%8C%85%E4%B8%8E%E5%8F%91%E5%B8%83.md)
- [架构决策记录（ADR）0001](./decisions/0001-%E6%9C%8D%E5%8A%A1%E4%BC%98%E5%85%88%E4%BA%8E%E6%A1%8C%E9%9D%A2%E5%A3%B3.md)
- [架构决策记录（ADR）0002](./decisions/0002-%E5%A4%8D%E7%94%A8-openclaw-%E4%BC%9A%E8%AF%9D%E4%BD%9C%E4%B8%BA%E9%A6%96%E7%89%88%E8%AE%A4%E8%AF%81%E6%9D%A5%E6%BA%90.md)
- [架构决策记录（ADR）0003](./decisions/0003-%E5%AF%B9%E5%A4%96%E7%BB%9F%E4%B8%80%E9%87%87%E7%94%A8-openai-compatible-%E6%8E%A5%E5%8F%A3.md)

## 目录约定

- `prd/`：产品需求文档、范围定义、阶段目标
- `architecture/`：架构设计、接口设计、数据流说明
- `operations/`：运行、部署、调试、维护文档
- `decisions/`：关键技术决策与变更记录

## 说明

- 本仓库内由项目维护的 Markdown 文档统一使用中文。
- 所有后续改动必须同步更新仓库根目录的 `CHANGELOG.md`。
- `node_modules/`、`vendor_imports/` 等第三方目录中的 Markdown 不属于项目文档范围，不做翻译或改写。
