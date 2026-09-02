# easy-agent-team

面向团队的 **AI 能力集中管理与分发平台**。

少数「能力建设者」负责开发 Skill、配置 MCP、维护环境与基础设施，平台负责把这些能力在**权限管控**下分发给团队里的其他成员——包括不懂技术的同事。同时提供一套「人机求助」机制：AI 遇到搞不定的问题可以向团队里的人求助，求助的答案还能沉淀为可复用的 Skill 经验。

## 解决的问题

1. **人人都能靠 AI 把项目做出来并跑起来**（最核心的一点）：团队里的**任何**成员——包括完全不写代码的同事——都能借助自己的 AI 独立完成项目开发与上线运行。Skill、MCP 配置、环境变量、数据库账号、部署能力全部由平台按权限自动下发到本地 AI 手里，成员不必自己搭环境、不必满群找密钥、不必申请运维资源、不必等别人有空；卡住时 AI 还能直接向懂的人求助。
2. **集中管理**：Skill、MCP 配置、环境变量、数据库账号、部署能力，统一收口，不再散落在各人本地。
3. **权限管控**：资源级授权、元数据可见 + 取值受控、申请审批流、审计日志。
4. **能力分发**：角色模板一键套用，CLI / MCP 自动同步到本地 AI 工作环境。
5. **人机协作求助**：AI 主动求助真人、答案沉淀为经验 Skill，知识在团队内滚雪球。

## 架构图

```mermaid
flowchart TB
    subgraph U["使用侧：团队成员与他们的本地 AI"]
        direction LR
        P["团队成员<br/>开发 / 运营 / 新人"]
        AI["本地 AI<br/>Claude Code 等"]
        CLI["eat CLI<br/>13 个命令"]
        MCPS["MCP Server<br/>15 个工具 · eat mcp"]
        WEB["Web 控制台<br/>16 个页面"]
        P -->|"提需求"| AI
        P -->|"浏览器"| WEB
        AI -->|"跑命令"| CLI
        AI -->|"stdio"| MCPS
    end

    U ==>|"HTTPS REST · Token 鉴权"| S

    subgraph S["平台服务：NestJS + Fastify 单体（一个容器）"]
        M1["认证 · 设备码<br/>开放注册 · 用户管理"]
        M2["环境变量 · 资源级授权<br/>申请审批"]
        M3["Skill · 订阅<br/>角色模板 · MCP 配置分发"]
        M4["求助 · 经验沉淀<br/>平台 AI"]
        M5["数据库账号分配<br/>部署编排与门禁"]
        M6["审计日志 · Webhook<br/>CLI 自托管分发"]
        M1 ~~~ M4
        M2 ~~~ M5
        M3 ~~~ M6
    end

    S --> PG[("PostgreSQL<br/>业务数据 + 审计")]
    S --> DOK["Dokploy API<br/>触发部署 / 构建记录 / 日志"]
    S --> TDB[("团队数据库实例<br/>PostgreSQL / MySQL")]
    S --> IM["飞书群机器人<br/>求助卡片通知"]
    S --> LLM["OpenAI 范式 AI 网关<br/>把求助整理成经验"]
```

- **单体 + 单库**：REST API 与后台工作（webhook 带退避的重试投递、部署状态按需刷新）都在同一个 NestJS 进程里，业务数据与审计全落一个 PostgreSQL——不引入 Redis、不起独立 worker。控制台构建产物由后端静态托管，部署仍是一个容器。
- **三端一套契约**：请求/响应用 zod 定义在 `packages/shared`，server 校验、CLI 与前端复用同一份类型，三端类型一致由编译器保证。
- **AI 是一等用户**：所有面向人的能力（查配置、要权限、问问题、看日志、触发部署）都有对应的 MCP 工具，AI 可以自助完成，无需人转述。
- **元数据公开、取值受控**：AI 默认能看见「有哪些配置、各是干什么的」，但取值需要授权；无权限时返回可执行的申请引导，而不是无声失败。

## 功能清单

### 用户与认证

| 能力 | 说明 |
|---|---|
| 账号与角色 | 管理员 / 成员两级平台角色 + 资源级 Owner，不引入复杂 RBAC |
| 用户管理 | 建号、改角色、禁用/启用、重置密码；禁用与改密即时吊销该用户全部 Token |
| 开放注册 | 管理员开关 + 允许的邮箱后缀白名单，注册即登录、无审批流 |
| 设备码登录 | `eat login` 出码 → 浏览器授权页确认，CLI 凭证落 `~/.eat/credentials.json` |

### 环境变量

| 能力 | 说明 |
|---|---|
| 两级结构 | 环境（如 `internal-api`）+ 变量；变量元数据（key、用途备注）默认对全员可见，也可逐个变量关掉 |
| 敏感 / 非敏感 | 敏感值信封加密存储（AES-256-GCM + KEK）；非敏感值明文存储，有读取权限者清单/控制台直接可见 |
| 资源级授权 | 授权到「用户 × 单个变量」或「用户 × 整个环境」，可设有效期，Owner 与管理员可管 |
| 申请审批 | 无权限拉取时引导发起申请，Owner 审批；CLI / MCP / 控制台三端可查状态 |
| 取值下发 | `eat env pull <环境>` 按权限拉取并写入 `./.env` |
| 读取审计 | 敏感值的每次读取落审计日志 |

### Skill 管理与分发

| 能力 | 说明 |
|---|---|
| 纳管与版本 | `eat skill push <目录>` 上传，首次创建、再次推送服务端自动出新版本 |
| 可见性与订阅 | 三档可见性（团队可见 / 授权可见 / 私有）控制谁能看到；成员订阅后随同步落地 |
| 本地同步 | `eat sync` 实际文件落 `~/.agents/skills/`，逐个软链到 `~/.claude/skills/`（Windows 改为复制实文件） |
| 安装范围 | 默认 `--global`；`--project` 装到当前项目（`./.agents/skills/` + 相对软链），`--dir` 自定义目录，三者互斥 |
| 内置平台指南 | 每个成员自动注入 `eat-platform-guide` Skill 并排在首位，让本地 AI 认识平台能力与正确用法 |
| 更新提示 | 服务端在响应头搭车下发 CLI 版本与 per-user Skill 指纹，CLI/MCP 侧提示「有新版」；`eat self-update` 一条命令升级 |

### MCP 配置分发

| 能力 | 说明 |
|---|---|
| 集中维护 | 管理员统一维护 MCP server 配置，成员订阅后随 `eat sync` 落地 |
| 密钥占位符 | 配置里写 `${env:环境/KEY}`，下发时按该成员的权限渲染，无权限不下发明文 |

### 角色模板

| 能力 | 说明 |
|---|---|
| 能力套餐 | 管理员预定义「一组 Skill + MCP 配置 + 环境引用」 |
| 一键套用 | 成员选中模板即批量订阅，新人入职当天就能开工 |

### 求助系统（人机协作）

| 能力 | 说明 |
|---|---|
| 两类入口 | 向**具体的人**求助，或向某个 **Skill 的作者**求助（AI 按能力描述自己选） |
| 可求助登记 | 用户自助登记能力描述 + 接收求助 / 接收回复两个开关 |
| 飞书通知 | 飞书群自定义机器人 webhook（支持加签，密钥由用户粘贴），消息是卡片：含「查看请求」按钮与「发送给 Agent」代码块 |
| 多轮对话 | 求助 → 回复 → 追问 → 标记解决，CLI / MCP / 控制台三端都能读写 |
| 防骚扰 | 每用户每小时求助次数限流（`EAT_HELP_RATE_LIMIT`，默认 10） |

### 经验沉淀

| 能力 | 说明 |
|---|---|
| 经验即 Skill | 求助解决后由平台 AI 把对话整理成结构化经验，以 Skill 形式分发订阅 |
| 自助检索 | MCP `search_experiences` 让 AI 先翻经验库，同样的问题不问第二遍 |

### 数据库账号分配

| 能力 | 说明 |
|---|---|
| 实例登记 | 管理员登记团队数据库实例（PostgreSQL / MySQL），管理员凭证加密存储 |
| 真实建库建号 | 成员申请 → 审批 → 平台真实建库、建专属账号并授权（PostgreSQL 已支持自动化，MySQL 暂缓） |
| 凭证下发 | 凭证自动生成为一组环境变量，仅 `DB_PASSWORD` 敏感，整组默认只授权给申请人 |

### 部署托管（Dokploy）

| 能力 | 说明 |
|---|---|
| 项目挂载 | 建项目时可直接从 Dokploy 搜索选择已有应用（按项目分组、匹配应用名/容器名/id），Dokploy 未配置时降级为手填 |
| 成员管理 | 项目成员制，日志与部署权限收敛到成员并落审计 |
| 部署门禁 | `eat deploy` 先在本地做密钥扫描（通用规则 + **平台密钥指纹匹配** + `.env` 误提交），报告随部署请求上送，不通过不部署；`--check "pnpm build"` 可加一条本地预跑命令，非零退出即拦下 |
| 状态透传 | 部署状态以 Dokploy 构建记录为准并懒绑定；失败时把构建日志末尾直接写进错误，平台里就能看到真实报错 |
| 日志读取 | `eat project build-logs`（构建失败先看它）与 `eat project run-logs`（构建成功但服务不正常时看它），控制台同样可看 |

### 安全与审计

| 能力 | 说明 |
|---|---|
| 信封加密 | 敏感值 AES-256-GCM，KEK 走部署环境变量，不依赖外部 KMS |
| 明文不外泄 | 密钥永不下发给无权限方——包括错误消息、日志与 webhook payload（webhook 只带事件与链接） |
| 审计日志 | 敏感值读取、授权变更、审批决策、部署与日志读取全程留痕 |
| 本地扫描 | CLI 端扫描能识别出「这段字符串就是平台里的某个密钥」，防止密钥被提交进仓库 |

### 三端接入

| 入口 | 内容 |
|---|---|
| Web 控制台 | 16 个页面：环境变量 / Skill / MCP 配置 / 角色模板 / 求助 / 权限申请 / 数据库 / 部署项目 / 安装 CLI / 设备授权 / 用户 / 系统设置 等；桌面侧边栏 + 移动端抽屉，手机可用 |
| eat CLI | 13 个命令：`login` `logout` `whoami` `env` `skill` `ask` `sync` `db` `scan` `deploy` `project` `self-update` `mcp` |
| MCP Server | 15 个工具：`list_env_variables` `get_env_values` `request_access` `get_access_request_status` `search_experiences` `list_helpers` `create_help_request` `get_help_request` `reply_help_request` `delete_help_request` `list_projects` `trigger_deploy` `get_deploy_status` `get_build_logs` `get_run_logs` |
| CLI 分发 | 平台自托管、不发 npm：`/install.sh`（macOS/Linux）、`/install.ps1`（Windows）、`/install/eat.js`、`/install/AGENT.md`、`/install/MCP.md`；Windows 全链路兼容 |

## 快速开始

```bash
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed      # 初始管理员 admin@example.com / admin12345
node apps/server/dist/main.js        # http://localhost:3000
node apps/cli/dist/index.js login    # CLI 设备码登录
```

团队成员安装 CLI（平台自托管分发，无需 npm registry；也可打开控制台「安装 CLI」页，把 Agent 安装指令一键复制给自己的 AI）：

```bash
# macOS / Linux / WSL / Git Bash
curl -fsSL http://<平台地址>/install.sh | sh
# Windows PowerShell
powershell -ExecutionPolicy ByPass -c "irm http://<平台地址>/install.ps1 | iex"

eat login --server http://<平台地址>
```

## 环境变量配置

完整示例见 [.env.example](.env.example)（复制为 `.env` 填写；`.env` 不入库，被平台的密钥扫描拦截，`.env.example` 除外）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL 连接串（本地开发默认 `postgres://dev@127.0.0.1:5433/eat_dev`） |
| `EAT_KEK` | 生产 ✅ | 值加密主密钥，base64 的 32 字节：`openssl rand -base64 32`。**丢失即密文不可恢复，务必备份**；开发环境缺省用内置的不安全默认值 |
| `EAT_PUBLIC_URL` | 生产 ✅ | 平台对外地址（设备码授权页、webhook 链接以此拼接） |
| `PORT` | | 服务端口，默认 3000 |
| `EAT_ADMIN_EMAIL` / `EAT_ADMIN_PASSWORD` | 建议 | 种子创建的初始管理员（默认 `admin@example.com` / `admin12345`，生产务必显式设置） |
| `EAT_SKIP_SEED` | | 设为 `1` 跳过启动种子 |
| `EAT_HELP_RATE_LIMIT` | | 每用户每小时求助上限，默认 10 |

使用方式：Docker 用 `--env-file .env`；本地直跑用 `node --env-file=.env apps/server/dist/main.js`（Node 20.6+ 原生支持）。

## 部署

仓库根目录提供 `Dockerfile`（国内网络用 `Dockerfile_cn`，依赖走 npmmirror 源），详细步骤见[部署文档](docs/deployment.md)。

## 文档

- [产品设计文档](docs/product-design.md) —— 完整的产品设计：角色、功能模块、权限模型、数据模型、API / CLI / MCP 设计、技术架构与路线图（含全部决策记录）。
- [部署文档](docs/deployment.md) —— Dockerfile 构建、Dokploy 部署步骤、环境变量、备份、CLI 分发与自举。
