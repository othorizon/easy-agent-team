# 阿里云权限

权限点是一条云账号内的 `eat-perm-` 自定义 RAM 策略。个人凭证只供本人临时使用，不配置到线上服务。

## 申请与查询

1. `eat aliyun list` 查看开放目录；`--account <接入名称或云账号ID>` 缩小范围。阅读权限点说明、用途、数据范围和 Owner，按任务选最小范围。
2. `eat aliyun request <权限点>[@接入名称或云账号ID] --reason "用途"` 发起申请，也可用 `--account` 指定云账号。跨云账号同名必须明确目标，歧义时不会发送申请。
3. `eat requests list --type aliyun` / `eat requests show <申请ID>` 查进度。Owner 或管理员自己申请直接授予；其他申请由当前 Owner 或管理员审批。关闭申请保留原待办，Owner 已停用时由管理员接手。
4. `eat aliyun grants` 查看本人授权。已批准、执行失败时查看错误并让管理者重试原授权，保持原审批轮次。`eat aliyun revoke <权限点> --account <目标>` 放弃本人授权。

本期权限申请和凭证没有新增 MCP 工具；已有 `list_requests` / `get_request_status` 可查询申请。无 shell 时请用户在控制台「阿里云权限」申请。

## 临时执行命令

优先 `eat aliyun run <接入名称或云账号ID> -- aliyun sts GetCallerIdentity`，或 `eat aliyun run <目标> -- ossutil ls`（支持 ossutil 2）。仅一个有权云账号时可省略目标。需要 shell 展开或管道时显式用 `-- sh -c '…'`。

`run` 只注入子进程，不落盘、不改父环境，透传退出码和信号；新 Key 首次使用会等到平台持久保存的生效期限，默认45秒。aliyun 使用标准 AK/SK/地域环境变量并设置 `ALIBABA_CLOUD_IGNORE_PROFILE=TRUE`；ossutil 2 使用 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_REGION`，继承的其他身份变量会清除。子命令显式传入凭证或 profile 参数会主动覆盖身份，按当前任务选择。

确需读取时 `eat aliyun credentials --account <目标>` 输出本人凭证 JSON；只传给当前可信进程，不写入源码、日志、对话或线上配置。管理员不能读取他人的 SK。

## 共享身份与重置

同一人在同一云账号只有一个个人身份和当前 EAT Key，阿里云权限与迁移后的 OSS 空间共用。`eat aliyun credentials reset --account <目标>` 会使两处旧 Key 失效，只有用户明确要求并了解全部影响时执行，完成后重新领取。两把 Key 槽位已满时联系管理员核对手工 Key，平台不会先删旧 Key 腾位。

接入暂停拒绝新申请、同意、授予、新领及重置；已有 Key 仍可读、可用，放弃和撤销继续。停用 EAT 用户会停用全部 Key 并删除控制台登录配置，策略与授权保留；恢复只启当前 EAT managed Key。云端不一致由管理员显式按 EAT 记录修复，读取报告不会改云端。
