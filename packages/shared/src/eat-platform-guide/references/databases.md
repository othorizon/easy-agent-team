# 数据库账号与凭证

只读地取别人的业务库数据时，按[环境变量流程](environment.md)获取已授权的连接信息。**需要自己写数据**（建表、存跑批结果、落任务状态）时才申请一个自己的库——别往只读账号的库里写，也别把结果塞进别人的业务表。

1. 先看名下有没有现成的：`eat db list`（MCP: `list_db_assignments`）。`status=active` 的就能直接用。
2. 取连接凭证：`eat db pull <库名>`（MCP: `get_db_credentials`）。**申请来的库的凭证只在这里取，不在环境变量里**，`eat env pull db-xxx` 那条老路已经没有了。`eat db pull` 的落盘规则与 `eat env pull` 相同：默认写 `./.env`（DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD 和 DATABASE_URL），同名文件不是 eat 写的就中止——已有手写 `.env` 的项目用 `--merge`，只看不落盘用 `--print`，导出到当前 shell 用 `eval "$(eat db pull <库名> --print --format shell)"`；**不要习惯性加 `--force`**。同名库分在两台实例上时写 `<库名>@<实例名>`。每次读取都会审计，只有申请人和管理员能读，没有授权给别人这条路——同事要用，让申请人自己转交，或各自申请。
3. 没有就自己提：`eat db instances`（MCP: `list_db_instances`）挑一台实例，再 `eat db request <库名> --instance <实例> --purpose "<用途>"`（MCP: `request_db`）。库名是小写字母开头、小写字母/数字/下划线、3–31 位；用途写清楚，审批人看的就是这句。
4. 提交后是 `pending`，等管理员批准——**告诉用户已经提交、需要谁去批，不要反复申请**。批准时平台会在实例上真实建库建号，状态转 `active`，之后按第 2 步取凭证。用 `eat db list`（MCP: `list_db_assignments`）查进度，`failed` 时 `error` 里是原因。
5. `active` 但取凭证报 `DB_CREDENTIALS_MISSING`：平台上已没有这个账号的密码，告诉用户找管理员在实例上重置，不要自己去猜或重新申请同名库。
