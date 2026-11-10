# 数据库权限与分配

只读取数先申请数据库权限；要为自己的应用或任务存数据、建表才申请建库「分配」。数据库权限支持 PostgreSQL。分配的 owner 凭证属于资源，可用于该应用连接；访问已有库可使用获批的个人凭证。

个人凭证绑定 EAT 用户。停用用户或撤销授权会中断相应连接，重置密码后需更新使用该凭证的连接配置。外部库目前没有独立的应用凭证申请入口。

## 访问团队数据

1. `eat db access list` 查看开放目录与自己的授权。指定范围是 schema 下的表和视图；只读可查询，读写增加增、改、删数据及序列使用，不含改表结构或 TRUNCATE。
2. `eat db access request <库名>[@实例名] --level read|write --reason "用途"` 申请。用途说明实际任务，只有要修改数据时才选读写。当前 Owner 或管理员自己申请会直接授予；其他申请等待 Owner 或管理员批准。
3. `eat requests list --type db-access` / `eat requests show <申请ID>` 查状态和驳回原因。批准与执行分开；执行失败让 Owner 或管理员重试原授权，不重复申请。已有只读授权申请升级时仍可按只读访问。
4. 批准生效后优先 `eat db run <库名>[@实例名] -- <命令>`，或 `eat db run <库名> -- sh -c 'psql "$DATABASE_URL" -c "select 1"'`。值只注入子进程，不落盘，不改父环境，透传退出码。需要环境配置时可嵌套 `eat env run <环境> -- eat db run <库名> -- <命令>`。
5. 不再需要时 `eat db access revoke <库名>[@实例名]` 放弃授权。撤销或降级会断开本人在该库的旧会话。

同一实例共用一个个人登录角色和密码。只有本人可读取个人凭证，管理员不能代取。`eat db access reset-password <库名>` 会使本人同实例全部授权改用新密码，先向用户说明影响。重置待恢复时先等待平台完成，再取凭证。`eat db credentials pull` 也可解析本人授权，临时任务优先用 `run`。

跨实例同名库使用 `<库名>@<实例名>`；同实例同库同时有本人分配与授权时优先 owner 分配。名称歧义会在读取密码和启动子进程前报错。无权或重复待办时按返回信息处理，不猜密码或循环提交。

本期没有数据库权限申请或个人凭证 MCP 工具。既有 `list_requests` / `get_request_status` 可查询申请；无 shell 时请用户在控制台「数据库 → 数据库权限」申请。

## 为应用申请独立数据库

1. `eat db list`（MCP: `list_db_assignments`）检查自己的分配。已有 `active` 库可直接使用。
2. `eat db instances`（MCP: `list_db_instances`）选实例，`eat db request <库名> --instance <实例> --purpose "用途"`（MCP: `request_db`）申请。库名小写字母开头，含小写字母、数字、下划线，3–31 位。
3. 告知用户已提交、需管理员批准。`eat db list` 查询；`failed` 查看原因，让管理员处理，不重复申请同名库。
4. owner 凭证从 `eat db credentials pull|run <库名>`（别名 `creds`；MCP: `get_db_credentials`）取得，不在环境变量中。`run` 可用于迁移和服务启动；应用确需落配置时用 `pull`，默认写 `./.env`，已有手写文件用 `--merge`、别处用 `--out`，只查看用 `--print --format shell|json|url`。依提示处理文件冲突，按明确授权使用 `--force`。
5. 同事要取数请 Owner 开放申请或直接授予数据库权限。owner 凭证留给应用，不转交代替个人授权。停用 Owner 不影响 owner 连接；页面会提示「Owner 已停用」，由管理员接手审批。

`DB_CREDENTIALS_MISSING` 表示分配密码已不可用，请管理员重置。外部库权限报告里的 PUBLIC 或其他角色旁路由 DBA 收紧；EAT 撤销仅清自己的组成员关系。
