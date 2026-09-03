# CLAUDE.md

本文件面向在本仓库工作的 Claude 会话，提供跨会话的工程上下文。

## 项目是什么

easy-agent-team：面向团队的 AI 能力集中管理与分发平台（Skill / MCP 配置 / 环境变量 / 数据库账号 / 部署托管 / 人机求助与经验沉淀）。

**当前状态：P0–P3 全部路线图完成并全链路验证**——P0：环境变量 + Skill 管理 + 认证；P1：求助系统 + 平台 AI 接入 + 经验沉淀；P2：角色模板 + MCP 配置分发 + 数据库账号分配（真实建库建号）；P3：部署托管（Dokploy 挂载、CLI 端密钥扫描含平台指纹匹配、部署门禁携带报告、状态按需刷新）。server 146 个 e2e 用例全过（含 mock Dokploy 与 mock WebSocket 日志端点、mock OpenAI、mock 飞书机器人验签、真实 PG 建库）。环境变量支持**非敏感明文存储**（决策 23：`secret` 标记只改存储与展示、**授权模型不变**——非敏感值存 `value_plain`、有读取权限者清单/控制台直接明文可见，无权限者仍需申请；读取不落审计、不进指纹清单；数据库分配凭证仅 `DB_PASSWORD` 敏感、整组默认仅授权申请人；数据库分配删除后不再出现在列表；控制台补齐环境编辑/删除与部署项目编辑/删除入口）。求助通知已改为**只支持飞书群自定义机器人** webhook（决策 16：加签密钥由用户粘贴、平台不再生成 HMAC 密钥；决策 17：消息升级为飞书卡片——含「查看请求」按钮与「发送给 Agent」代码块，卡片构建在 `packages/shared/src/feishu-card.ts`、`scripts/test-feishu-card.mjs` 可实测；helper 登记含接收求助/接收回复两开关、能力描述可空），CLI 12 命令组 + MCP 19 工具 + 控制台 11 页面均做过真实冒烟。内置「平台使用指南」Skill（`eat-platform-guide`，决策 11：内容在 `packages/shared/src/platform-guide.ts`，改内容须递增 `PLATFORM_GUIDE_VERSION`；sync-bundle 对所有用户注入首位，slug 保留）与 `eat sync` 新落地布局（决策 12：实际文件 `~/.agents/skills/` + 逐个软链 `~/.claude/skills/`，旧目录自动迁移；决策 14：安装范围参数，默认/`--global` 全局、`--project` 落当前项目 `./.agents/skills/` + 相对软链 `./.claude/skills/`、与 `--dir` 三者互斥）已实现，并用真实设备码登录 + sync 冒烟验证过（安装范围参数用 stub 平台端点做过全流程冒烟）。用户管理（建号/改角色/禁用/重置密码，管理员改密已完成；决策 19：开放注册——管理员开关 + 邮箱后缀限制，注册即登录）与 CLI 平台自托管分发（`/install.sh`+`/install/eat.js`+`/install/AGENT.md`+`/install/MCP.md`，不发 npm；控制台 `/install` 安装页含给 Agent 的一键复制指令，文案单一来源在 `packages/shared/src/install.ts`；决策 20：Agent 安装流程只装 CLI 不提 MCP，MCP 配置独立板块、面向无 shell 环境客户端）已落地——安装脚本在容器内真实执行验证过。**Windows 全链路已兼容**（决策 24：新增 `GET /install.ps1` + shim `eat.cmd`/`eat`（**决策 29：刻意不生成 `eat.ps1`**——PowerShell 里 `.ps1` 优先级高于 `.cmd`，撞上默认 `ExecutionPolicy=Restricted` 会让 `eat` 直接报「禁止运行脚本」，就是 npm.ps1 那个著名报错；不落 `.ps1` 则自然回落到不受执行策略约束的 `eat.cmd`，用户零操作）、PATH 写用户级环境变量不用 setx、两个安装脚本都把逻辑包进 `main()`/`Install-EatCli` 防管道截断；`eat sync` 在 Windows 上把 `.claude/skills` 的软链换成复制实文件；AGENT.md 给双平台命令并要求 Agent 先判断系统、安装页按 UA 嗅探分页签、MCP 指引补 `cmd /c eat mcp`；凭证文案统一为 `~/.eat/credentials.json`）——install.ps1 用容器内下载的 pwsh 7.4 真实执行+语法校验过，Windows 复制路径用伪装 `process.platform=win32` 跑通首次复制/软链迁移/版本刷新/清理全流程，安装页双 UA 双视口 Playwright 验证过。**建项目支持从 Dokploy 搜索选应用**（决策 27：`GET /api/dokploy/applications` 展平 `project.all`、防御式解析、与建项目同权限；应用可能挂在 `project.applications`（老版本）或 `project.environments[].applications`（新版本，真机实测），两种都认；控制台弹窗里 Popover + cmdk 按项目分组，搜索同时匹配应用名/容器名/id，Dokploy 停用时就地降级为手填；**2026-09-02 用容器内自建的 Dokploy v0.30.4 复验：该版本 `project.all` 只回 `applicationId`/`name`/`applicationStatus`，不含 `appName` 与 `description`**，防御式回落让清单照常可用，但「按容器名搜」在这个版本上等于失效，详见决策 27）。**部署失败能在平台里看到真实报错、并新增构建/运行日志命令**（决策 28：状态改以 Dokploy 构建记录为准并懒绑定到 `deployment.dokploy_deployment_id`，失败时把构建日志末尾 12 行写进 `error`；新增 `GET /api/projects/:slug/build-logs`（REST）与 `/run-logs`（**Dokploy 只有 WebSocket 一条路**，平台侧收敛成带 `tail=N` 的一次性读取，为此 server 引入 `ws`）；日志权限收紧到项目成员并落审计；CLI 把 `projects`/`deploy-status`/`deploy-list` 收进 `eat project` 名词组、新增 `build-logs`/`run-logs`，`eat deploy` 保持顶层，旧命令曾留隐藏别名，**决策 30 已直接删除**（平台尚无存量用户，不背兼容包袱）；MCP 补 `get_build_logs`/`get_run_logs`——此前文档与内置指南宣称的 `get_deploy_logs` 从未实现过。**已对容器内自建的 Dokploy v0.30.4 真机全链路验证**：触发部署→绑定构建记录→构建失败时 `eat project status` 直接打印 Docker 拉镜像报错→`build-logs`/`run-logs` 读到真实日志，控制台弹窗 Playwright 桌面/移动双视口验证过）。**部署记录已改为以 Dokploy 为唯一事实源**（决策 30：`deployment` 表删掉 `status`/`error`，只存业务元数据——谁触发的、带了什么检查报告；触发时把 `eat:<元数据id>` 写进 Dokploy 构建记录的 `description` 做精确认领（`application.deploy` 的 `title`/`description` **v0.25.0 起支持**，更老的版本静默丢弃、自动降级为按时间推断并标 `inferred`）；**Dokploy 每个应用只保留最近 10 条构建记录**（`removeLastTenDeployments` 硬编码不可配、连日志一起删），所以默认视图就是它还留着的那些、`--all` 才从平台元数据看完整历史（被清理的显示 `archived`）；**在 Dokploy 侧直接触发的部署也会列出来并标「未经平台密钥扫描」**，绕过门禁从此可见；排队中的部署读 `deployment.queueList`。两条踩过坑的铁律：**已认领过的元数据既不参与时间推断、也不因「刚触发不久」退回 queued**，否则会把别人在 Dokploy 侧点的部署冒认成平台部署。API 破坏性变更：`GET /api/deployments/:id` 删除，改项目内 `GET /api/projects/:slug/deployments/:id`）。**部署托管的实体已从「项目」改为「应用」（决策 31，2026-09-03）**：与 Dokploy 的 application 一一对应；成员自助创建（Web / `eat app create` / MCP `create_app`）——填 Git 地址与构建方式，服务端按 `application.create` → `saveGitProvider`（绑管理员配置的 SSH key）→ `saveBuildType` 三步走、任一步失败即删掉刚建的 application 回滚；构建方式只开放 `dockerfile`（Dockerfile 路径 + 构建上下文）与 `static`（发布目录 + SPA；**不跑构建命令**，仓库里需直接有产物）；管理员在「系统设置 → Dokploy」选自助建应用的落点（Dokploy 项目 / 环境 / SSH key，从 Dokploy 现拉下拉清单），用户侧不再感知 Dokploy 的项目概念；管理员仍可挂载既有 application（`POST /api/apps/mount`，`managed=false`，构建配置归 Dokploy、删除只解绑）。**部署授权**：成员自建的应用首次部署被拒（`DEPLOY_NOT_APPROVED`）并留痕，管理员在控制台授权一次后永久有效。**应用 env**：`eat app env pull|push [--build]` / MCP `get_app_env`/`set_app_env` / 控制台详情页直接读写 Dokploy 上的运行时 env 与构建时 buildArgs，推送整体覆盖、只回 key 级差异（解析在 `packages/shared/src/dotenv.ts`）。控制台应用详情页有「部署」按钮：不做本地扫描，请求显式 `source=console`，记录标「控制台 ⚠ 未做密钥扫描」。**客户端不做兼容、数据库存量数据原地搬迁**：`/api/projects`→`/api/apps`、`eat project`→`eat app`、`list_projects`→`list_apps`（各工具 `project` 参数改 `app`）、表 `project`/`project_member`→`app`/`app_member`；迁移 `0010_app_entity` 把 `project`→`app`（保留 id）、`project_member`→`app_member`、`deployment.project_id`→`app_id` 搬完再删旧表（平台已在线上使用，不能删数据），存量项目按「管理员挂载的既有应用」处理（`managed=false`、`build_type=NULL`、`deploy_approved=true`）；`eat sync --project` 指本地代码目录，不动。server 模块拆成 `DokploySettingsService`（接入配置 + client 工厂）/ `AppsService`（应用 CRUD、授权、env）/ `DeployService`（部署记录、日志、指纹），路由分 `apps.controller.ts` 与 `deploy.controller.ts`。CLI 升 0.5.0、平台指南升 8。**已对容器内自建的 Dokploy v0.30.5 真机全链路验证**（自助建两种应用 → 授权门禁 → `eat deploy` 构建成功起容器 → env 推拉 → 控制台双视口冒烟）。**v0.30.5 的坑**：Git 来源的构建一结束就把构建记录 title/description 覆盖成提交信息，`eat:<id>` 认领标记只在排队/构建期间存在——`deployment.claim` 列记下首次认领的方式，靠回写 id 再认时沿用，别把精确认过的显示成「按时间推断」。**建应用时自动分配域名（决策 32）**：管理员在「系统设置 → Dokploy」配 `domain_suffix`（标准化：去协议 / `*.` / 大小写，只认 RFC 1123 主机名）+ `domain_https`，成员建应用时第四步 `domain.create` 绑 `<slug>.<后缀>`（请求体最小集对 v0.30.5 真机验证；失败同样整体回滚），`app` 表记 `domain` / `domain_https` / `dokploy_domain_id`；**域名流量转发到容器端口**——`app.port` 由 dockerfile 应用的创建者声明（默认 3000，`--port` / MCP `port` / 控制台字段），static 固定 80，端口变化时 `domain.update` 回写（它的 `host` 必填）；配了后缀时 slug 必须能当 DNS label（不以连字符结尾、≤63）；`AppInfo` 加 `port` / `domain` / `url`。只影响新建应用，存量与挂载的不动。CLI 升 0.5.1、指南升 9、迁移 `0011_app_domain`。**Dokploy 不出现在面向 AI 的输出里（决策 33）**：CLI 帮助 / 输出、MCP 工具描述 / 返回、内置指南、服务端透传的报错一律说「部署后台」或直接说事，CLI 不打印 `dokployApplicationId`、MCP 返回前剥掉它；部署来源枚举改 `platform | external`，错误码改 `DEPLOY_BACKEND_UNAVAILABLE` / `DEPLOY_BACKEND_UNCONFIGURED`；控制台管理员板块标题改「部署后台接入（Dokploy）」，Dokploy 这个词只留在那里和人看的文档里。CLI 升 0.5.2、指南升 10。**`eat skill export <slug>` 可把平台上任一可见 skill（含未订阅的、含内置指南）下载成普通目录**：复用既有的 `GET /api/skills/:slug`、不动服务端；与 sync 落地的区别是不写 `.eat-meta.json`（导出的是可自由编辑再 push 的工作副本，别让 sync 接管），目标目录非空必须 `--force` 且只覆盖同名文件、不清空目录。CLI 升 0.5.3、指南升 11。**推送不再自动订阅（决策 34）**：`SkillsService.push()`（CLI push / 网页创建 / 经验沉淀共用）不再把推送者订阅上去——旧行为会让「退订自己的 skill → 推个新版本 → 又被订回来」，退订意愿留不住；经验沉淀改为按 `grantedToRequester` / `grantedToHelper` 各自显式插订阅、且不再删未勾选那方的既有订阅；可见性与编辑权不受影响（`canSee`/`canManage` 按 ownerId 判），变的只是进不进 `eat sync` 范围；CLI push 后按返回的 `subscribed` 提示订阅命令。顺带修掉更新检测用例里的空串自比（指纹用例打的是 @Public 的 `/api/health`，per-user 指纹在无 authUser 时根本不下发）。CLI 升 0.5.4、指南升 12。**CLI / Skill 更新提示已就位**（决策 26：检测走响应头搭车——服务端对带 `x-eat-client` 的请求回 `x-eat-cli-version` + `x-eat-skill-version`，零额外请求；Skill 指纹是 per-user 的 sorted(`slug@version`) FNV-1a 哈希，覆盖出新版本/新增订阅/退订三类变化；提示只走 stderr、不做 TTY 判断、按版本去重、显式声明不影响本次结果；新增 `eat self-update` 与 `GET /install/version.json`；MCP 侧改挂工具返回的独立内容块；`EAT_NO_UPDATE_NOTIFIER=1` 可关。CLI 版本唯一事实源在 `packages/shared/src/version.ts`，package.json 由单测断言同步；平台指南 Skill 版本升到 5）。**控制台 UI 已从 Ant Design 全量迁移为 Tailwind CSS v4 + shadcn 风格组件**（决策 21：组件源码内置 `apps/web/src/components/ui/`，表单栈 react-hook-form、消息 sonner、搜索选择 cmdk，移除 antd/dayjs；桌面左侧分组侧边栏 + 移动端抽屉导航，表格按断点隐藏次要列做手机适配；全部 16 页面经 Playwright 桌面/移动双视口截图与交互冒烟验证。注意：项目是 React 18，ui 组件必须用 forwardRef，不能学 shadcn 官方 React 19 的 ref-as-prop 写法。决策 22：多板块页面——求助/数据库/权限申请——改页内 tabs 布局，`components/ui/tabs.tsx` + `lib/use-tab-param.ts` 同步 URL `?tab=`；低频配置收进页头按钮弹窗——求助页「可求助登记」、用户页「注册设置」，按钮带状态圆点）。剩余待办：真实联调（**Dokploy 已可在云端会话内用 `scripts/dev-dokploy.sh` 自建真机实例验证，`DokployClient` 的连通性/清单/状态/部署四条路径与错误路径都对着 v0.30.4 跑通**；只剩 AI 三参数待用户提供）、正式部署（Dockerfile 与 docs/deployment.md 已就绪，镜像布局在容器内做过等效验证——pnpm deploy --legacy 产物 + 迁移/种子编译入口 + SPA 托管 + CLI 产物 `/app/cli/dist` 全通，真实 docker build 需在有 Docker 的机器上做）、MySQL 自动建库（暂缓）。

**开源许可证：Apache License 2.0**（决策 35，署名 `Copyright 2026 othorizon`）。只有 `LICENSE` 文件与各 `package.json` 的 `license` 字段，没碰运行时代码。`LICENSE` 是官方原文，**不要往里加任何内容**——加了 GitHub 的 licensee 就识别不出许可证，补充说明放 README。已知缺口：CLI 单文件产物内联了 9 个依赖的代码却不含任何版权声明（它们的许可证在各自的 LICENSE 文件里，打包器读不到），第三方署名当前未随产物分发，是有意接受的取舍。依赖全为宽松许可证，无 GPL/AGPL/SSPL。

**已知环境行为**：云端容器会不定期回收后台进程（postgres、node server 都可能消失，无 OOM、日志无 shutdown 记录）——重跑 `scripts/dev-db.sh start` 和重启 server 即可，不必排查。

## 常用命令

```bash
scripts/dev-db.sh start        # 本地 PostgreSQL（仅云端会话；端口 5433）
pnpm install && pnpm build     # 安装 + 全量构建（shared → server/cli/web 拓扑序）
pnpm db:migrate && pnpm db:seed  # 迁移 + 初始管理员（admin@example.com / admin12345）
pnpm --filter @eat/server test   # server e2e（连 eat_test 库，需先起数据库）
node apps/server/dist/main.js    # 启动平台（http://localhost:3000，含控制台静态托管）
node apps/cli/dist/index.js      # eat CLI（login/env list/env pull/project build-logs/mcp 等）
scripts/dev-dokploy.sh start     # 【仅云端会话】容器内起真机 Dokploy 做 API 联调（见下）
```

- **版本号约定（手改常量，最容易漏，改代码时务必对照）**：
  - 改了 CLI（`apps/cli/**`，或 CLI 依赖的 shared 代码）→ 递增 `packages/shared/src/version.ts` 的 `CLI_VERSION`，并同步 `apps/cli/package.json` 的 `version`（CLI 单测断言两者一致，但**不检查你该升没升**）。漏升的后果：已安装的客户端收不到「有新版 CLI」提示，会一直跑旧产物且无任何报错（决策 26）。
  - 改了内置平台指南的内容（`packages/shared/src/platform-guide.ts` 的 `CONTENT`）→ 递增同文件的 `PLATFORM_GUIDE_VERSION`。漏升的后果：`eat sync` 判定本地已是最新，用户永远拿不到新内容（决策 11）。
  - 团队 Skill 的版本**不用管**：`eat skill push` 时服务端自动 `currentVersion + 1`；用户侧的「Skill 有更新」指纹也由服务端实时算出（决策 26）。
- Dokploy 联调：`scripts/dev-dokploy.sh start` 起真机（Dokploy 占 3000，平台 server 用 `PORT=3001`），控制台「系统设置 → Dokploy」填 `http://127.0.0.1:3000/api` + `scripts/dev-dokploy.sh key` 的 token。**出站代理端口每个会话都会变**，脚本会按当前环境重写 `/etc/docker/daemon.json` 并在变化时重启 dockerd，否则镜像拉取报 `proxyconnect connection refused`。
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

**本节及「容器内直接起 PostgreSQL」的方案仅适用于 Claude Code 云端会话**。用户本地开发时不采用此方案：按上一节「本地开发（用户本机）」优先用 `.env` 配置。

- **Docker 守护进程默认没起，但可以自己拉起来**（2026-09-02 实测；此前「云端容器跑不了 Docker」的结论已作废）：容器以 root 运行、内核允许，`sysctl -w net.ipv4.ip_forward=1` + `nohup dockerd &` 即可，镜像拉取要在 `/etc/docker/daemon.json` 里配 `proxies`（代理 CA 已在系统信任库，不用额外装）。swarm、overlay 网络、容器出站全部可用。两点坑：**内核没有 IPVS**（`/proc/net/ip_vs` 不存在），swarm service 默认的 VIP 端点模式解析出的地址不通，必须 `--endpoint-mode dnsrr`；**没有 `ss` / `ip` 命令**，依赖它们做探测的第三方安装脚本会挂。
- 平台自己的业务库仍用 `scripts/dev-db.sh`（裸 PostgreSQL 更快，不必为它起 Docker）。
- **PostgreSQL 16 服务端已装**（/usr/lib/postgresql/16/bin），本地起库即可开发测试，不依赖外部数据库。已验证可用。
- 容器以 root 运行，而 Postgres 拒绝 root：需 `runuser -u postgres --` 执行，且数据目录放 postgres 用户可访问的路径（如 /var/lib/postgresql；scratchpad 的父目录是 root 700，postgres 穿不过去）。
- 云端会话统一用 `scripts/dev-db.sh start` 启动本地库（端口 5433，trust 认证，自动创建 eat_dev / eat_test），连接串：`postgres://dev@127.0.0.1:5433/eat_dev`。
- 容器是临时的：数据库数据不跨会话保留，schema 靠 Drizzle 迁移 + seed 脚本随时重建，这是预期行为。
- 出站网络走代理；用户自己的内网服务（团队数据库等）在这里不可达，那部分仍由用户本地联调。
- **Dokploy 不用等用户给地址了：`scripts/dev-dokploy.sh start` 在容器内起一台真机 Dokploy**（官方镜像 + swarm，约 3 分钟），跑完打印控制台地址、管理员账号与 API token，直接填进平台的「系统设置 → Dokploy」即可做真实联调。子命令 `status|key|logs|stop|clean`。两个必须知道的点：**不能直接用官方 install.sh**（它依赖 `ss`/`ip`，且默认 VIP 端点模式在无 IPVS 的内核上会让 dokploy 永远卡在 "Waiting for postgres"）；**API key 必须带 `metadata.organizationId`**，Dokploy 的 `validateRequest` 拿不到它就一律回 401，控制台建的 key 自带、用 better-auth 端点自己建的不带（脚本已处理，另外 better-auth 默认给 key 加 10 次/天限流，脚本直接改库关掉）。Dokploy 与平台 server 默认都占 3000，同时跑给 server 传 `PORT=3001`。

## 与用户的外部依赖约定

以下资源在需要时由用户提供，开发期一律用本地实例 / mock 先行：

| 时机 | 用户提供 |
|---|---|
| 正式部署 | Dokploy 环境 + 持久化 PostgreSQL |
| P1 联调平台 AI | api_base_url / api_key / model（OpenAI 范式） |
| P2 联调数据库账号分配 | 团队测试用 MySQL/PG 实例 |
| P3 联调 Dokploy | ~~Dokploy API 地址与 token~~ 云端会话可用 `scripts/dev-dokploy.sh` 自建真机实例，不必等用户提供；只有要对**用户那套** Dokploy 验证时才需要 |
