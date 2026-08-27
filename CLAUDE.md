# CLAUDE.md

本文件面向在本仓库工作的 Claude 会话，提供跨会话的工程上下文。

## 项目是什么

easy-agent-team：面向团队的 AI 能力集中管理与分发平台（Skill / MCP 配置 / 环境变量 / 数据库账号 / 部署托管 / 人机求助与经验沉淀）。

**当前状态：P0 + P1 + P2 全部完成并全链路验证**——P0：环境变量 + Skill 管理 + 认证；P1：求助系统 + 平台 AI 接入 + 经验沉淀；P2：角色模板（选用/排除/sync 合并）+ MCP 配置分发（`${env:slug/KEY}` 引用按权限渲染，落 `~/.eat/mcp.generated.json`）+ 数据库账号分配（申请→批准→PostgreSQL 真实建库建号→凭证生成为环境，禁用/删除回收；MySQL 自动执行暂缓）。server 55 个 e2e 用例全过（数据库部分对本地 PG 真实建库连库验证），CLI（eat db/sync 扩展）与控制台（模板/MCP/数据库页）均做过真实冒烟。下一步：P3 部署托管（Dokploy API + 前置检查），见设计文档 §9。

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

## 网页版设计文档（Artifact）

设计文档有一份对外评审用的网页镜像（用户所有，链接保持不变）：

- URL：https://claude.ai/code/artifact/114704b4-203e-4147-acbf-b1759fe28c27
- 修改 `docs/product-design.md` 后需同步更新它：用 Artifact 工具 `action: "read"` 读回当前 HTML（新会话本地没有源文件），做同样内容修改后带 `url` 参数重新发布到同一链接。favicon 固定为 🎛️。

## 工作约定

- 开发分支：`claude/skill-mcp-env-platform-v8uhpv`，提交后推送到该分支；不经允许不推其他分支。
- 未经用户要求不创建 PR。
- 文档、注释、面向用户的文本使用中文。

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
