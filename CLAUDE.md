# CLAUDE.md

本文件面向在本仓库工作的 Claude 会话，提供跨会话的工程上下文。

## 项目是什么

easy-agent-team：面向团队的 AI 能力集中管理与分发平台（Skill / MCP 配置 / 环境变量 / 数据库账号 / 部署托管 / 人机求助与经验沉淀）。

**当前状态：P0–P3 全部路线图完成并全链路验证**——P0：环境变量 + Skill 管理 + 认证；P1：求助系统 + 平台 AI 接入 + 经验沉淀；P2：角色模板 + MCP 配置分发 + 数据库账号分配（真实建库建号）；P3：部署托管（Dokploy 挂载、CLI 端密钥扫描含平台指纹匹配、部署门禁携带报告、状态按需刷新）。server 71 个 e2e 用例全过（含 mock Dokploy、mock OpenAI、本地 webhook 验签、真实 PG 建库），CLI 12 命令组 + MCP 12 工具 + 控制台 11 页面均做过真实冒烟。用户管理（建号/改角色/禁用/重置密码，管理员改密已完成）与 CLI 平台自托管分发（`/install.sh`+`/install/eat.js`+`/install/AGENT.md`，不发 npm；控制台 `/install` 安装页含给 Agent 的一键复制指令，文案单一来源在 `packages/shared/src/install.ts`）已落地——安装脚本在容器内真实执行验证过。剩余待办：真实联调（用户提供 Dokploy 地址/token 与 AI 三参数后在控制台配置即可）、正式部署（Dockerfile 与 docs/deployment.md 已就绪，镜像布局在容器内做过等效验证——pnpm deploy --legacy 产物 + 迁移/种子编译入口 + SPA 托管 + CLI 产物 `/app/cli/dist` 全通，真实 docker build 需在有 Docker 的机器上做）、MySQL 自动建库（暂缓）。

**已知环境行为**：云端容器会不定期回收后台进程（postgres、node server 都可能消失，无 OOM、日志无 shutdown 记录）——重跑 `scripts/dev-db.sh start` 和重启 server 即可，不必排查。

## 常用命令

```bash
scripts/dev-db.sh start        # 本地 PostgreSQL（仅云端会话；端口 5433）
pnpm install && pnpm build     # 安装 + 全量构建（shared → server/cli/web 拓扑序）
pnpm db:migrate && pnpm db:seed  # 迁移 + 初始管理员（admin@example.com / admin12345）
pnpm --filter @eat/server test   # server e2e（连 eat_test 库，需先起数据库）
node apps/server/dist/main.js    # 启动平台（http://localhost:3000，含控制台静态托管）
node apps/cli/dist/index.js      # eat CLI（login/env list/env pull/mcp 等）
```

- schema 改动流程：改 `apps/server/src/db/schema.ts` → `pnpm --filter @eat/server db:generate` 生成迁移 SQL（提交进库）→ `pnpm db:migrate`。
- server 测试用 vitest + unplugin-swc（es6 模块，tsup/esbuild 不产 decorator metadata 所以必须 swc）；CLI 是 ESM + tsup 单文件（banner 里有 createRequire 垫片，勿删）。

## 唯一事实源

`docs/product-design.md` 是产品与技术设计的唯一事实源：

- §10 决策记录：所有已拍板的决策（管理员可见求助内容、CLI 定名 eat、AI 接入 OpenAI 范式、`eat skill push`、框架选型等）。新决策产生时必须追加到这张表并同步正文。
- §7 技术选型（已定）：NestJS(Fastify) 单体 + React/Vite/Ant Design SPA + pnpm monorepo；任务队列 pg-boss（不引入 Redis）；ORM 首选 Drizzle；CLI/MCP 为 TS 单包、tsup 打包、npm 分发；平台 AI 调用采用 OpenAI 接口范式（api_base_url / api_key / model 可配）。
- §7.4 Monorepo 结构：apps/server、apps/web、apps/cli + packages/shared（zod 契约三端共用）。

## 远程开发环境须知（Claude Code on the web 容器）

**本节及「容器内直接起 PostgreSQL」的方案仅适用于 Claude Code 云端会话**——因为云端容器没有 Docker 守护进程，只能这样起库。用户本地开发时不采用此方案：直接用 Docker 起 PostgreSQL 或连自有实例即可。

- **没有 Docker 守护进程**（docker CLI 存在但连不上 daemon），不要尝试 docker run / testcontainers。
- **PostgreSQL 16 服务端已装**（/usr/lib/postgresql/16/bin），本地起库即可开发测试，不依赖外部数据库。已验证可用。
- 容器以 root 运行，而 Postgres 拒绝 root：需 `runuser -u postgres --` 执行，且数据目录放 postgres 用户可访问的路径（如 /var/lib/postgresql；scratchpad 的父目录是 root 700，postgres 穿不过去）。
- 云端会话统一用 `scripts/dev-db.sh start` 启动本地库（端口 5433，trust 认证，自动创建 eat_dev / eat_test），连接串：`postgres://dev@127.0.0.1:5433/eat_dev`。
- 容器是临时的：数据库数据不跨会话保留，schema 靠 Drizzle 迁移 + seed 脚本随时重建，这是预期行为。
- 出站网络走代理；将来联调内网服务（Dokploy、团队数据库）可能不可达，届时由用户本地联调，这里负责开发与 mock 测试。

## 与用户的外部依赖约定

以下资源在需要时由用户提供，开发期一律用本地实例 / mock 先行：

| 时机 | 用户提供 |
|---|---|
| 正式部署 | Dokploy 环境 + 持久化 PostgreSQL |
| P1 联调平台 AI | api_base_url / api_key / model（OpenAI 范式） |
| P2 联调数据库账号分配 | 团队测试用 MySQL/PG 实例 |
| P3 联调 Dokploy | Dokploy API 地址与 token |
