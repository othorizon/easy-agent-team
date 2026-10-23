# 环境变量与权限申请

1. 先看清单认路：MCP 工具 `list_env_variables`（或 `eat env list`）。每个变量都带备注说明用途，先确认目标再取值，不要盲目拉全量。
2. 取值：`get_env_values`（或 `eat env pull <环境> --keys KEY1,KEY2`）。**`eat env pull` 会往本地写 `.env`**：同名文件不是 eat 写的时会直接中止报错——那是用户自己维护的文件，覆盖了就没了。按报错里的出路走：`--merge` 合并进去（只改同名 key、追加新 key，其余原样保留）、`--out <别的文件>` 写到别处、`--print` 只打印不落盘；**不要习惯性加 `--force`**，确实该覆盖再加（会先自动备份）。
   只是要让一条命令用上这些值时，优先 `eat env run <环境>[,<环境>...] -- <命令>`：值只注入子进程、不落盘。导出到当前 shell：`eval "$(eat env pull <环境> --print --format shell)"`。
3. 无权限会返回结构化 `PERMISSION_REQUIRED`：**不要重试、不要猜值、不要向用户索要**。用 `request_access`（或 `eat env request <环境> <KEY> --reason "<用途>"`）附真实理由发起申请，告诉用户已申请、需等资源 Owner 审批；之后用 `get_access_request_status` 查进度，批准后重新取值。

## 建环境与写入变量（只在用户要求时）

- 建环境：`eat env create <slug> --name "<名称>" --description "<这组变量是干嘛的>"`，`--private` 为私有。改名称 / 说明 / 可见性用 `eat env update`；删除 `eat env delete <slug> --yes`（连同全部变量与授权，不可恢复，须用户明确要求）。
- 写一个变量：`eat env set <环境> <KEY> --value-file <文件>`，管道传值用 `--value-file -`；`--value` 会留在 shell 历史里，只用于非敏感的短值。新增默认敏感，非敏感配置加 `--no-secret`；顺手用 `--description` 写清用途（别人和 AI 靠它认路）。只改值时其余元信息保持原样。删除：`eat env unset <环境> <KEY...>`。
- 整份推送：`eat env push <环境> --file <文件>`（dotenv 或 JSON），**默认只增改同名 key、不删除**。`--prune` 会删掉文件里没有的变量连同它们的读取授权——只有用户明确要「平台与文件完全一致」时才加，并先 `--dry-run` 把将删除的 key 给用户看。
- 只有环境 Owner 或管理员能写；无权限时告诉用户，不要换个环境自己建一份同名的。

Private 环境仅 Owner 可见和使用，不支持向其他成员授权或申请访问；变量不能单独开启未授权可见。环境详情只管理变量与读取授权，审批统一在「权限申请」页处理。

统一查询：`eat requests list --type env` / `eat requests show <申请ID>`（MCP：`list_requests` / `get_request_status`），可查看驳回原因和历次申请。原有 `eat env requests` 也显示当前轮次的驳回理由。
