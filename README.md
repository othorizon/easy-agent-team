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

**P0–P3 全部路线图已实现并通过全链路验证**（server 73 个 e2e 用例 + CLI/浏览器真实冒烟）：

- 环境变量：两级可见性、授权（含有效期）、申请审批、信封加密、读取审计
- Skill：`eat skill push` 纳管、版本、订阅、`eat sync` 落地、经验沉淀
- 求助系统：Helper 登记 + webhook（HMAC）、双入口求助、多轮对话、平台 AI 整理经验
- 角色模板、MCP 配置分发（`${env:slug/KEY}` 按权限渲染）、数据库账号分配（真实建库建号）
- 部署托管：Dokploy 挂载、CLI 端密钥扫描（含平台密钥指纹匹配）、部署门禁与状态透传
- 用户管理：管理员建号 / 改角色 / 禁用启用 / 重置密码（禁用与改密即时吊销 Token）
- CLI 平台自托管分发：`curl -fsSL <平台>/install.sh | sh` 一条命令安装；控制台安装页提供「给 AI Agent 的一键复制安装指令」
- 内置「平台使用指南」Skill：`eat sync` 对每个成员自动落地 `eat-platform-guide`，让本地 AI 认识平台能力与正确用法；Skill 统一落 `~/.agents/skills/` 并软链到 `~/.claude/skills/`
- 三端齐备：Web 控制台（11 个页面）、eat CLI、MCP server（12 个工具）

## 快速开始

```bash
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed      # 初始管理员 admin@example.com / admin12345
node apps/server/dist/main.js        # http://localhost:3000
node apps/cli/dist/index.js login    # CLI 设备码登录
```

团队成员安装 CLI（平台自托管分发，无需 npm registry；也可打开控制台「安装 CLI」页，把 Agent 安装指令一键复制给自己的 AI）：

```bash
curl -fsSL http://<平台地址>/install.sh | sh
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
