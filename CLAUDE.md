# CLAUDE.md

本文件面向在本仓库工作的 Claude 会话，提供跨会话的工程上下文。

## 项目是什么

easy-agent-team：面向团队的 AI 能力集中管理与分发平台（Skill / MCP 配置 / 环境变量 / 数据库账号 / 部署托管 / 人机求助与经验沉淀）。

**当前状态：P0–P3 全部路线图完成并全链路验证**——P0：环境变量 + Skill 管理 + 认证；P1：求助系统 + 平台 AI 接入 + 经验沉淀；P2：角色模板 + MCP 配置分发 + 数据库账号分配（真实建库建号）；P3：部署托管（Dokploy 挂载、CLI 端密钥扫描含平台指纹匹配、部署门禁携带报告、状态按需刷新）。server 91 个 e2e 用例全过（含 mock Dokploy、mock OpenAI、mock 飞书机器人验签、真实 PG 建库）。环境变量支持**非敏感明文存储**（决策 23：`secret` 标记只改存储与展示、**授权模型不变**——非敏感值存 `value_plain`、有读取权限者清单/控制台直接明文可见，无权限者仍需申请；读取不落审计、不进指纹清单；数据库分配凭证仅 `DB_PASSWORD` 敏感、整组默认仅授权申请人；数据库分配删除后不再出现在列表；控制台补齐环境编辑/删除与部署项目编辑/删除入口）。求助通知已改为**只支持飞书群自定义机器人** webhook（决策 16：加签密钥由用户粘贴、平台不再生成 HMAC 密钥；决策 17：消息升级为飞书卡片——含「查看请求」按钮与「发送给 Agent」代码块，卡片构建在 `packages/shared/src/feishu-card.ts`、`scripts/test-feishu-card.mjs` 可实测；helper 登记含接收求助/接收回复两开关、能力描述可空），CLI 12 命令组 + MCP 13 工具 + 控制台 11 页面均做过真实冒烟。内置「平台使用指南」Skill（`eat-platform-guide`，决策 11：内容在 `packages/shared/src/platform-guide.ts`，改内容须递增 `PLATFORM_GUIDE_VERSION`；sync-bundle 对所有用户注入首位，slug 保留）与 `eat sync` 新落地布局（决策 12：实际文件 `~/.agents/skills/` + 逐个软链 `~/.claude/skills/`，旧目录自动迁移；决策 14：安装范围参数，默认/`--global` 全局、`--project` 落当前项目 `./.agents/skills/` + 相对软链 `./.claude/skills/`、与 `--dir` 三者互斥）已实现，并用真实设备码登录 + sync 冒烟验证过（安装范围参数用 stub 平台端点做过全流程冒烟）。用户管理（建号/改角色/禁用/重置密码，管理员改密已完成；决策 19：开放注册——管理员开关 + 邮箱后缀限制，注册即登录）与 CLI 平台自托管分发（`/install.sh`+`/install/eat.js`+`/install/AGENT.md`+`/install/MCP.md`，不发 npm；控制台 `/install` 安装页含给 Agent 的一键复制指令，文案单一来源在 `packages/shared/src/install.ts`；决策 20：Agent 安装流程只装 CLI 不提 MCP，MCP 配置独立板块、面向无 shell 环境客户端）已落地——安装脚本在容器内真实执行验证过。**Windows 全链路已兼容**（决策 24：新增 `GET /install.ps1` + shim 三件套 `eat.cmd`/`eat.ps1`/`eat`、PATH 写用户级环境变量不用 setx、两个安装脚本都把逻辑包进 `main()`/`Install-EatCli` 防管道截断；`eat sync` 在 Windows 上把 `.claude/skills` 的软链换成复制实文件；AGENT.md 给双平台命令并要求 Agent 先判断系统、安装页按 UA 嗅探分页签、MCP 指引补 `cmd /c eat mcp`；凭证文案统一为 `~/.eat/credentials.json`）——install.ps1 用容器内下载的 pwsh 7.4 真实执行+语法校验过，Windows 复制路径用伪装 `process.platform=win32` 跑通首次复制/软链迁移/版本刷新/清理全流程，安装页双 UA 双视口 Playwright 验证过。**CLI / Skill 更新提示已就位**（决策 26：检测走响应头搭车——服务端对带 `x-eat-client` 的请求回 `x-eat-cli-version` + `x-eat-skill-version`，零额外请求；Skill 指纹是 per-user 的 sorted(`slug@version`) FNV-1a 哈希，覆盖出新版本/新增订阅/退订三类变化；提示只走 stderr、不做 TTY 判断、按版本去重、显式声明不影响本次结果；新增 `eat self-update` 与 `GET /install/version.json`；MCP 侧改挂工具返回的独立内容块；`EAT_NO_UPDATE_NOTIFIER=1` 可关。CLI 版本唯一事实源在 `packages/shared/src/version.ts`，package.json 由单测断言同步；平台指南 Skill 版本升到 5）。**控制台 UI 已从 Ant Design 全量迁移为 Tailwind CSS v4 + shadcn 风格组件**（决策 21：组件源码内置 `apps/web/src/components/ui/`，表单栈 react-hook-form、消息 sonner、搜索选择 cmdk，移除 antd/dayjs；桌面左侧分组侧边栏 + 移动端抽屉导航，表格按断点隐藏次要列做手机适配；全部 16 页面经 Playwright 桌面/移动双视口截图与交互冒烟验证。注意：项目是 React 18，ui 组件必须用 forwardRef，不能学 shadcn 官方 React 19 的 ref-as-prop 写法。决策 22：多板块页面——求助/数据库/权限申请——改页内 tabs 布局，`components/ui/tabs.tsx` + `lib/use-tab-param.ts` 同步 URL `?tab=`；低频配置收进页头按钮弹窗——求助页「可求助登记」、用户页「注册设置」，按钮带状态圆点）。剩余待办：真实联调（用户提供 Dokploy 地址/token 与 AI 三参数后在控制台配置即可）、正式部署（Dockerfile 与 docs/deployment.md 已就绪，镜像布局在容器内做过等效验证——pnpm deploy --legacy 产物 + 迁移/种子编译入口 + SPA 托管 + CLI 产物 `/app/cli/dist` 全通，真实 docker build 需在有 Docker 的机器上做）、MySQL 自动建库（暂缓）。

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

## 本地开发（用户本机）

**仓库根有 `.env` 且配置了 `DATABASE_URL` 时，一律优先使用 `.env` 里的配置**，不要起本地 Docker 库或假设 5433 端口：

- 启动 server：`node --env-file=.env apps/server/dist/main.js`（Node 20.6+ 原生支持）。
- 跑 server e2e：测试会 **drop schema 重建**，绝不能指向 `.env` 里的业务库；用同一实例上的独立 `eat_test` 库，通过 `TEST_DATABASE_URL` 注入：

  ```bash
  set -a; source .env; set +a
  TEST_DATABASE_URL="${DATABASE_URL%/*}/eat_test" pnpm --filter @eat/server test
  ```

  `eat_test` 库不存在时先在该实例上 `CREATE DATABASE eat_test` 一次。
- 已知限制：p2.spec.ts 的 5 个「真实建库」用例硬编码登记 `127.0.0.1:5433` 本地 PG 做真实建库建号（避免在远端实例残留测试库/账号），本机没起 5433 时这 5 个用例失败属预期，其余用例应全过。
- 没有 `.env` 时才回退到 Docker 起 PostgreSQL 或连自有实例。

## 唯一事实源

`docs/product-design.md` 是产品与技术设计的唯一事实源：

- §10 决策记录：所有已拍板的决策（管理员可见求助内容、CLI 定名 eat、AI 接入 OpenAI 范式、`eat skill push`、框架选型等）。新决策产生时必须追加到这张表并同步正文。
- §7 技术选型（已定）：NestJS(Fastify) 单体 + React/Vite/Tailwind CSS v4/shadcn 风格组件 SPA + pnpm monorepo；任务队列 pg-boss（不引入 Redis）；ORM 首选 Drizzle；CLI/MCP 为 TS 单包、tsup 打包、npm 分发；平台 AI 调用采用 OpenAI 接口范式（api_base_url / api_key / model 可配）。
- §7.4 Monorepo 结构：apps/server、apps/web、apps/cli + packages/shared（zod 契约三端共用）。

## 远程开发环境须知（Claude Code on the web 容器）

**本节及「容器内直接起 PostgreSQL」的方案仅适用于 Claude Code 云端会话**——因为云端容器没有 Docker 守护进程，只能这样起库。用户本地开发时不采用此方案：按上一节「本地开发（用户本机）」优先用 `.env` 配置。

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
