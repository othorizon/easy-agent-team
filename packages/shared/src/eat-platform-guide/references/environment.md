# 环境变量与权限申请

1. 先看清单认路：MCP 工具 `list_env_variables`（或 `eat env list`）。每个变量都带备注说明用途，先确认目标再取值，不要盲目拉全量。
2. 取值：`get_env_values`（或 `eat env pull <环境> --keys KEY1,KEY2`）。**`eat env pull` 会往本地写 `.env`**：同名文件不是 eat 写的时会直接中止报错——那是用户自己维护的文件，覆盖了就没了。按报错里的出路走：`--out <别的文件>` 写到别处、`--print` 只打印不落盘；**不要习惯性加 `--force`**，确实该覆盖再加（会先自动备份）。
3. 无权限会返回结构化 `PERMISSION_REQUIRED`：**不要重试、不要猜值、不要向用户索要**。用 `request_access`（或 `eat env request <环境> <KEY> --reason "<用途>"`）附真实理由发起申请，告诉用户已申请、需等资源 Owner 审批；之后用 `get_access_request_status` 查进度，批准后重新取值。

统一查询：`eat requests list --type env` / `eat requests show <申请ID>`（MCP：`list_requests` / `get_request_status`），可查看驳回原因和历次申请。原有 `eat env requests` 也显示当前轮次的驳回理由。
