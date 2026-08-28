# easy-agent-team

面向团队的 **AI 能力集中管理与分发平台**。

少数「能力建设者」负责开发 Skill、配置 MCP、维护环境与基础设施，平台负责把这些能力在**权限管控**下分发给团队里的其他成员——包括不懂技术的同事。同时提供一套「人机求助」机制：AI 遇到搞不定的问题可以向团队里的人求助，求助的答案还能沉淀为可复用的 Skill 经验。

## 解决的问题

1. **集中管理**：Skill、MCP 配置、环境变量、数据库账号、部署能力，统一收口，不再散落在各人本地。
2. **权限管控**：资源级授权、元数据可见 + 取值受控、申请审批流、审计日志。
3. **能力分发**：角色模板一键套用，CLI / MCP 自动同步到本地 AI 工作环境。
4. **人机协作求助**：AI 主动求助真人、答案沉淀为经验 Skill，知识在团队内滚雪球。

## 文档

- [产品设计文档](docs/product-design.md) —— 完整的产品设计：角色、功能模块、权限模型、数据模型、API / CLI / MCP 设计、技术架构与路线图（含全部决策记录）。
- [部署文档](docs/deployment.md) —— Dockerfile 构建、Dokploy 部署步骤、环境变量、备份、CLI 分发与自举。

## 当前状态

**P0–P3 全部路线图已实现并通过全链路验证**（server 62 个 e2e 用例 + CLI/浏览器真实冒烟）：

- 环境变量：两级可见性、授权（含有效期）、申请审批、信封加密、读取审计
- Skill：`eat skill push` 纳管、版本、订阅、`eat sync` 落地、经验沉淀
- 求助系统：Helper 登记 + webhook（HMAC）、双入口求助、多轮对话、平台 AI 整理经验
- 角色模板、MCP 配置分发（`${env:slug/KEY}` 按权限渲染）、数据库账号分配（真实建库建号）
- 部署托管：Dokploy 挂载、CLI 端密钥扫描（含平台密钥指纹匹配）、部署门禁与状态透传
- 三端齐备：Web 控制台（9 个页面）、eat CLI、MCP server（12 个工具）

## 快速开始

```bash
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed      # 初始管理员 admin@example.com / admin12345
node apps/server/dist/main.js        # http://localhost:3000
node apps/cli/dist/index.js login    # CLI 设备码登录
```

数据库连接串通过 `DATABASE_URL` 配置（默认 `postgres://dev@127.0.0.1:5433/eat_dev`）；生产部署需配置 `EAT_KEK`（base64 的 32 字节主密钥）与 `EAT_PUBLIC_URL`。
