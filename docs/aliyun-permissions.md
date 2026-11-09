# 阿里云接入、权限点与个人授权

管理员在「系统设置 → 阿里云接入」新建接入，填写名称、管理 AccessKey 和可选的默认地域。名称只允许小写字母、数字和连字符。保存时通过 STS 读取云账号 ID，并检查 RAM 策略读取能力；云账号 ID 和接入名称都不能重复。

管理 AK 和 SK 分别使用平台的信封加密保存。任何接入接口都不返回明文，编辑表单中的两项凭证留空时保留原值，更换时需同时填写。编辑不能把原接入切换到另一云账号。

至少存在一个接入时，导航显示「阿里云权限」。管理员打开该页面的「管理」页签时，页面自动刷新一次目录，也可反复点击「刷新目录」。没有后台定时发现任务。目录按云账号分组，仅发现 `eat-perm-` 开头的自定义策略，不纳入系统策略或 OSS 聚合策略。

刷新读取全部分页后再更新本地记录。RAM 说明会同步更新；策略从云端消失后，权限点保留为「云端已删除」并关闭申请。云端重新建立同名策略时，复用原权限点，但不会自动重新开放申请。分页中途失败时不更改既有目录，可手动重试。

接入可暂停和恢复，暂停不影响管理员查询、校验管理凭证和刷新目录。只有管理员能创建、编辑、暂停、恢复、删除和刷新接入。接入变更写入审计，审计中不包含管理凭证。

OSS 所在的云账号在身份迁移完成前不能接入，关闭 OSS 功能也不能绕过此限制。OSS 尚未首次启用、尚无持久化云账号 ID 时，使用已保存的 OSS 管理凭证识别所属云账号。

管理员可在「管理」页把任一已发现且仍存在的权限点直接授予 EAT 用户，不要求开放申请；停用的用户不能被授予。已开放的权限点也允许 Owner 管理授权，未开放或没有 Owner 时仅管理员可管理。管理员或当前 Owner 可在管理目录补充用途、数据范围与 Owner，并开放或关闭申请。关闭后只有管理员可以审批和授予，已有授权保持，待审批申请也保留。Owner 被停用时由管理员接手，界面会显示「Owner 已停用」。

同一个 EAT 用户在同一云账号始终复用一个 `eat-<去掉连字符的用户 UUID>` RAM 个人身份。显示名同步姓名，备注格式为 `EAT:<身份标记>:<邮箱>`，身份标记保持原有随机标识，不再重复用户 UUID。RAM 备注最多 128 字符，只有超长邮箱会截断加 `…`，平台内保留完整邮箱；见 ADR 0005。归属校验精确匹配 `EAT:<身份标记>:` 前缀，并核对已持久化的云端 UserId，任一不符时执行失败并拒绝接管；邮箱不参与归属判断。姓名或邮箱变化在下次授予时同步，带相同身份标记的旧备注也会更新为新格式。

一个用户对一个权限点只有一条授权。授权显示「待执行 / 已生效 / 执行失败 / 撤销中 / 已撤销」；失败保留原因，可手动重试，也会随后台操作恢复。RAM 用户绑定自定义策略达到配额时，提示「已达到该 RAM 用户可绑定的自定义策略上限，请在阿里云配额中心调高」。本阶段授予只确保身份并绑定策略，不创建个人 AccessKey。

「我的权限」显示各云账号的授权和实际已绑定自定义策略数；无法读取时显示错误，不把未知数量当作零。Owner 或管理员可撤销，原因选填；持有人可放弃。撤销前核对云端身份和实际绑定，只解绑该权限点的策略，不修复其他绑定。撤销通过统一通知服务告知持有人，包含撤销人与原因；放弃不通知。授予、撤销、放弃及手动重试记审计。接入暂停拒绝新授予和授予重试，撤销、放弃及其失败恢复继续执行。

统一身份模块独立于阿里云功能设置，按次接收管理凭证，后续 OSS 使用自己的凭证调用。每个云账号和用户共用 PostgreSQL 会话 advisory lock，锁使用独立连接池；丢锁后不发布执行结果。授权与持久操作表一起提交，云 API 调用在平台事务之外。后台每 30 秒检查未完成操作，失败按 30 秒递增退避至最多 5 分钟，重启后恢复。身份创建响应丢失时，凭随机标记确认本轮来源后复用。

本地迁移 `0041_aliyun_discovery` 新增接入和权限点，`0044_aliyun_grants` 新增个人身份、授权和操作表。个人凭证及停用用户见下节；云端不一致修复、接入清理和 OSS 身份迁移由后续工单接入。

验证入口：`apps/server/test/aliyun.spec.ts` 与 `aliyun-grants.spec.ts` 通过完整 HTTP 应用，仅以 `TestRamCloud` 替换云边界，通知送到测试回环接收器。覆盖多账号、幂等、策略配额、归属冲突、资料更新、暂停、撤销与放弃、通知审计、重启和丢锁恢复。`scripts/test-aliyun-ui.mjs` 使用构建后的控制台与本地 zod 夹具，覆盖桌面和手机交互。


## 本人个人凭证与 CLI

「我的权限」的云账号卡片可以查看、再次读取或重置本人的 AccessKey，个人凭证只供本人临时使用，不要配进线上服务。同一云账号的 OSS 空间共用这把 Key，重置确认框和 CLI 会说明影响范围。管理员没有读取他人 SK 的入口；每次成功读取或重置都有审计，响应为 `Cache-Control: no-store`，审计不含 AK/SK。

至少持有一项有效授权才能领取或重置。接入暂停后不能新领或重置，已有个人 Key 照常可读；停用用户不能读取。无授权和歧义均在获取 Key 与启动子进程前拒绝。

```sh
eat aliyun grants
eat aliyun revoke eat-perm-read --account team-cloud
eat aliyun credentials --account team-cloud
eat aliyun credentials --account team-cloud reset
eat aliyun run team-cloud -- aliyun sts GetCallerIdentity
eat aliyun run team-cloud -- ossutil ls
```

接入名称和云账号 ID 都能指定云账号。本人只有一个有权云账号时，`credentials` 的 `--account` 和 `run` 的云账号参数均可省略。`run` 需要 `--` 分隔命令，管道或 shell 展开显式写为 `-- sh -c '…'`。`credentials` 输出 JSON 到 stdout；用途与重置影响写到 stderr。

`run` 只为子进程注入凭证和默认地域，保留父环境与工作目录，不创建配置文件，透传退出码和信号。支持 `aliyun` 和 **ossutil 2**；显式传入的子命令凭证/profile 参数属于调用者主动覆盖。

| 子命令 | 子进程变量 |
| --- | --- |
| aliyun | `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`ALIBABA_CLOUD_REGION_ID`、`ALIBABA_CLOUD_IGNORE_PROFILE=TRUE` |
| ossutil 2 | `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_REGION` |

Aliyun CLI 默认优先读取 profile，所以必须设置 `ALIBABA_CLOUD_IGNORE_PROFILE=TRUE`。同时清除子进程继承的阿里云身份变量与 ossutil 的 STS、角色、profile 选择变量，避免旧身份覆盖新 AK；父环境保持原样。官方依据：[Aliyun 环境变量](https://help.aliyun.com/zh/cli/environment-variables)、[AK 凭证](https://help.aliyun.com/zh/cli/ak-credential)、[ossutil 2 文档](https://help.aliyun.com/zh/oss/developer-reference/ossutil-overview/)、[ossutil 2 环境变量新功能](https://help.aliyun.com/zh/oss/developer-reference/ossutil-2-0-new-features)。

新 Key 的传播等待由 `EAT_CLOUD_KEY_PROPAGATION_MS` 配置，默认 45000 毫秒。服务端创建并加密保存新 Key 及 `readyAt` 后返回，CLI 在 `readyAt` 前向 stderr 输出「正在等待新 Key 生效」，实际等到期限再启动命令。期限持久化，服务重启不会缩短既有等待。

Key 生命周期与授权共用每云账号/用户的会话锁。迁移 `0046_cloud_identity_keys` 增加加密 Key、创建基线、待回收 Key、当前/目标世代及生效时间。创建响应丢失时回收基线外的孤立 Key，基线内的手工 Key 和旧 EAT Key 均保留。重置先保存新 Key，待其生效再停用并删除旧 Key；旧 Key 清理失败自动重试，仍可读取已保存的新 Key。RAM 两把 Key 的槽位被手工 Key 占满时明确失败，绝不先删旧 EAT Key 腾位。后台每 30 秒及重启时恢复未完成操作；暂停时只恢复孤立/旧 Key 清理，不创建新 Key。

测试：`aliyun-credentials.spec.ts` 通过完整 HTTP 应用和唯一内存 RAM 边界覆盖本人读取、重置、失响应、重启、丢锁、配额、暂停与撤销；CLI `aliyun.spec.ts` 使用 API 桩和真实子进程验证名称/云账号解析、等待、变量、父环境、无文件、退出码与命令树。


## 停用与恢复 EAT 用户

管理员停用用户时，用户状态与全部统一个人身份的同步待完成标记在同一事务内保存，再逐个云账号执行安全切断：列出 RAM 用户下的全部 AccessKey（包括控制台手工创建的 Key），逐一设为 Inactive，并删除已有的控制台登录配置。不存在的登录配置视为已完成；EAT 从不创建控制台登录配置。策略绑定、授权记录和轮换中的 Key 世代、生效期限均保留。

恢复用户时，只把 EAT 保存的当前 managed Key 设为 Active；手工 Key 和轮换待回收的旧 Key 保持 Inactive，不会重新创建控制台登录。停用用户不能领取、读取或重置 Key。首次身份持久化后、云端身份及 Key 创建前后均复查用户状态，状态同步与 Key 生命周期共用同一个云账号/用户锁。

接入暂停、没有阿里云接入或 OSS 功能关闭都不会阻断统一身份的安全同步：后台按云账号 ID 使用已保存的接入管理凭证（包括暂停的接入）或 OSS 自身管理配置。某一步失败时仍尽量切断其他 Key 与控制台登录；用户列表显示「阿里云同步待完成」及脱敏错误，自动刷新直到完成。迁移 `0048_cloud_identity_status` 增加持久重试次数和下次重试时间。后台每 30 秒扫描，失败按 30、60、120 秒递增退避至最多 5 分钟，重启后按原期限恢复，并扫描实际用户状态与已应用状态不一致的身份兜底。

`aliyun-user-status.spec.ts` 通过完整 HTTP 应用与内存 RAM 覆盖全部 Key、手工 Key、控制台登录、暂停、多账号、失败退避与重启、首次身份及建 Key 竞态、轮换状态保留，以及只有 OSS 管理配置的统一身份。数据库停用由独立数据库同步流程执行；分配的 owner 账号保持可用。

## 开放申请与审批

成员在「目录」只看到仍在云端存在且开放申请的权限点，按云账号分组展示说明、用途、数据范围与 Owner。一个人对同一个权限点只能保留一条待审批申请；已持有授权（含执行中或失败）不能再次申请，应重试已有授权。当前 Owner 或管理员给自己申请时直接授予并审计，不产生自审待办。

统一申请中心使用 `aliyun` 类型，支持撤回、重新提交、提醒和历次记录。审批资格按当前权限点实时读取：开放且 Owner 启用时 Owner 与管理员可审批；未开放、没有 Owner 或 Owner 已停用时仅管理员可审批。关闭申请不让已有待审批申请失效。接入暂停会阻止新申请、同意和授予，但驳回、撤销继续；恢复后可以继续处理原申请。

详情保留申请人、用途、云账号、权限点说明与范围摘要。仅当前 Owner 或管理员可展开策略原文；每次展开通过 RAM 读取当前策略，不保存原文快照，也不把原文暴露给普通申请人。读取接口禁止缓存。云端策略删除后关闭申请，待审批申请失效，已有授权保留并标出「云端已删除」。

飞书审批通知只发当前有资格的审批人。自建应用卡片随暂停、恢复、Owner 变更和 Owner 停用回写；暂停时同意置灰，驳回仍可用。卡片和快捷链接的同意同样由统一申请中心核验当前资格与接入状态。批准先持久化审批结果并关联授权，再走与直接授予相同的执行路径；执行失败保留「已批准」，重试或后台恢复只更新执行结果，不生成新轮次。

```sh
eat aliyun list
eat aliyun list --account team-cloud --json
eat aliyun request eat-perm-report --reason '季度报表分析'
eat aliyun request eat-perm-report@team-cloud --reason '季度报表分析'
eat aliyun request eat-perm-report --account 123456789 --reason '季度报表分析'
eat requests list --type aliyun
```

跨账号同名权限点必须指定接入名称或云账号 ID，歧义时报出可选目标且不会发送申请。MCP 仅在统一申请查询的类型枚举中加入 `aliyun`，没有新增权限管理工具。

验证入口：`aliyun-requests.spec.ts` 覆盖完整 HTTP 申请、并发、Owner、关闭、暂停、实时原文、云删除和失败恢复；`feishu-app.spec.ts` 的阿里云场景复用现有飞书传输夹具，验证实际回调、通知收件人及卡片回写；CLI `aliyun-requests.spec.ts` 验证目录与共享名称解析。
