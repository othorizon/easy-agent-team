# 部署文档

平台形态：**一个容器 + 一个 PostgreSQL**。容器内是 NestJS 单体（API + 控制台静态托管），
启动时自动执行数据库迁移与种子（均幂等）。推荐部署在 Dokploy 上——平台自己也吃自己的狗粮。

## 1. 前置准备

| 项 | 说明 |
|---|---|
| Dokploy 环境 | 或任何能跑 Docker 镜像的地方 |
| PostgreSQL 14+ | **必须持久化**（Dokploy 的 Database 服务或自有实例均可） |
| 域名 + HTTPS | 可选但强烈建议（CLI Token 走 Bearer，明文 HTTP 有被嗅探风险） |

## 2. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | 如 `postgres://eat:密码@db-host:5432/eat` |
| `EAT_KEK` | ✅（生产） | 值加密主密钥，base64 的 32 字节。生成：`openssl rand -base64 32`。**丢失后所有密文（环境变量值、各类 token）不可恢复，务必在密码管理器中备份** |
| `EAT_PUBLIC_URL` | ✅ | 平台对外地址（如 `https://eat.example.com`），用于设备码授权页与 webhook 链接拼接 |
| `PORT` | | 默认 3000 |
| `EAT_ADMIN_EMAIL` / `EAT_ADMIN_PASSWORD` | 建议 | 首次种子创建的管理员账号（默认 `admin@example.com` / `admin12345`，生产务必显式设置） |
| `EAT_SKIP_SEED` | | 设为 `1` 跳过启动种子 |
| `EAT_HELP_RATE_LIMIT` | | 每用户每小时求助上限，默认 10 |
| `NODE_ENV` | | 镜像内已设为 `production`（生产模式下缺少 `EAT_KEK` 会拒绝启动） |

## 3. 在 Dokploy 上部署

1. **建数据库**：Dokploy → Databases → 创建 PostgreSQL（记下内部连接串），或使用自有实例；
2. **建应用**：Applications → Create → 来源选本仓库（Git Provider 或 Git URL），构建方式选 **Dockerfile**（仓库根目录已提供）；
3. **配置环境变量**：按上表填入（`DATABASE_URL` 用 Dokploy 数据库的内部地址）；
4. **域名**：Domains 里绑定域名并开启 HTTPS，容器端口填 `3000`；
5. **部署**：点击 Deploy。容器启动序：迁移 → 种子 → 服务；
6. **验证**：`curl https://你的域名/api/health` 返回 `{"ok":true}`（该端点同时校验数据库连通，也是容器 HEALTHCHECK 用的探针）。

## 4. 首次初始化

1. 用管理员账号登录控制台；若用了默认密码，**立即在数据库层面或重建种子改掉**（改密功能在待办清单上）；
2. 「系统设置」配置两项接入：**平台 AI**（OpenAI 范式三参数，用于经验沉淀整理）、**Dokploy**（API 地址 + Token，用于部署托管）；
3. 「用户」创建团队成员账号，发给各成员；
4. 成员本地 `eat login --server https://你的域名` 完成设备码登录。

## 5. 本地用 Docker 运行（试用/排障）

```bash
docker build -t easy-agent-team .
docker run -d --name eat -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@host:5432/eat' \
  -e EAT_KEK="$(openssl rand -base64 32)" \
  -e EAT_PUBLIC_URL='http://localhost:3000' \
  easy-agent-team
```

注意：随手生成的 `EAT_KEK` 只适合一次性试用——换 KEK 等于丢弃所有已加密数据。

## 6. 升级

推送代码 → Dokploy 重新构建镜像 → 容器重启时 entrypoint 自动执行新迁移（迁移文件随代码提交在 `apps/server/drizzle/`）。
无需手工操作数据库。回滚代码时**不要**回滚数据库（迁移只前进；向后兼容由 schema 演进纪律保证）。

## 7. 备份与恢复

- **数据库**：`pg_dump "$DATABASE_URL" > backup.sql`，按团队习惯定时执行（cron / Dokploy 备份功能）；
- **EAT_KEK**：与数据库备份同等重要，二者缺一不可恢复密文；存密码管理器；
- 恢复：新实例导入 SQL → 用**原 KEK** 启动容器即可。

## 8. 给团队分发 CLI

CLI 是独立 npm 包（`apps/cli`，构建产物为单文件）：

```bash
pnpm --filter @eat/cli build
```

分发方式任选：
- **内部 npm registry**：`cd apps/cli && npm publish --registry <内部源>`，成员 `npm i -g @eat/cli`；
- **直接分发**：把 `apps/cli/dist/index.js` 发给成员（单文件，Node ≥ 18 直接 `node index.js` 或加执行权限使用）；
- 成员首次使用：`eat login --server https://你的域名`（或设 `EAT_SERVER` 环境变量）。

MCP 接入 Claude Code：`claude mcp add eat -- eat mcp`（或把 `eat mcp` 写进 `.mcp.json`）。

## 9. 自举（用平台部署平台）

平台上线后，把它自己登记为一个项目（绑定 Dokploy 上的本应用），之后升级平台就是在仓库目录里：

```bash
eat deploy easy-agent-team
```

CLI 会先做密钥扫描（防止把平台自己的密钥提交进仓库），再触发 Dokploy 重新构建部署。

## 10. 故障排查

| 现象 | 排查 |
|---|---|
| `/api/health` 非 200 | 数据库连不通：检查 `DATABASE_URL`、数据库容器状态、网络 |
| 启动即退出，日志提示 EAT_KEK | 生产模式未配置主密钥 |
| 控制台白屏 / 404 | 镜像构建时 web 产物缺失——确认用仓库根 Dockerfile 构建（其中包含 `pnpm build`） |
| CLI 登录卡在轮询 | `EAT_PUBLIC_URL` 配错导致设备码页地址不对；确认成员能访问该地址 |
| Dokploy 部署触发失败 | 系统设置里的 Dokploy API 地址（注意带 `/api`）与 Token；平台容器需能访问 Dokploy |

> 云端开发会话的已知行为（Postgres/进程被回收）见 CLAUDE.md，与生产部署无关。
