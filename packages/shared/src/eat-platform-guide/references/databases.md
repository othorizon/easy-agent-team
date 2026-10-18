# 数据库账号与凭证

只读地取别人的业务库数据时，按[环境变量流程](environment.md)获取已授权的连接信息。**需要自己写数据**（建表、存跑批结果、落任务状态）时才申请一个自己的库——别往只读账号的库里写，也别把结果塞进别人的业务表。

1. 先看名下有没有现成的：`eat db list`（MCP: `list_db_assignments`）。`status=active` 的那条带 `environmentSlug`，凭证就在那个环境里，按环境变量流程取值（`eat env pull <环境>`）。
2. 没有就自己提：`eat db instances`（MCP: `list_db_instances`）挑一台实例，再 `eat db request <库名> --instance <实例> --purpose "<用途>"`（MCP: `request_db`）。库名是小写字母开头、小写字母/数字/下划线、3–31 位；用途写清楚，审批人看的就是这句。
3. 提交后是 `pending`，等管理员批准——**告诉用户已经提交、需要谁去批，不要反复申请**。批准时平台会在实例上真实建库建号，状态转 `active` 并生成一组凭证环境变量。用 `eat db list`（MCP: `list_db_assignments`）查进度，`failed` 时 `error` 里是原因。
