# 阿里云接入、权限点与个人授权

管理员在「系统设置 → 阿里云接入」新建接入，填写名称、管理 AccessKey 和可选的默认地域。名称只允许小写字母、数字和连字符。保存时通过 STS 读取云账号 ID，并检查 RAM 策略读取能力；云账号 ID 和接入名称都不能重复。

管理 AK 和 SK 分别使用平台的信封加密保存。任何接入接口都不返回明文，编辑表单中的两项凭证留空时保留原值，更换时需同时填写。编辑不能把原接入切换到另一云账号。

至少存在一个接入时，导航显示「阿里云权限」。管理员打开该页面的「管理」页签时，页面自动刷新一次目录，也可反复点击「刷新目录」。没有后台定时发现任务。目录按云账号分组，仅发现 `eat-perm-` 开头的自定义策略，不纳入系统策略或 OSS 聚合策略。

刷新读取全部分页后再更新本地记录。RAM 说明会同步更新；策略从云端消失后，权限点保留为「云端已删除」并关闭申请。云端重新建立同名策略时，复用原权限点，但不会自动重新开放申请。分页中途失败时不更改既有目录，可手动重试。

接入可暂停和恢复，暂停不影响管理员查询、校验管理凭证和刷新目录。只有管理员能创建、编辑、暂停、恢复、删除和刷新接入。接入变更写入审计，审计中不包含管理凭证。

OSS 所在的云账号在身份迁移完成前不能接入，关闭 OSS 功能也不能绕过此限制。OSS 尚未首次启用、尚无持久化云账号 ID 时，使用已保存的 OSS 管理凭证识别所属云账号。

管理员可在「管理」页把任一已发现且仍存在的权限点直接授予 EAT 用户，不要求开放申请；停用的用户不能被授予。已开放的权限点也允许 Owner 管理授权，未开放或没有 Owner 时仅管理员可管理。管理员或当前 Owner 可在管理目录补充用途、数据范围与 Owner，并开放或关闭申请。关闭后只有管理员可以审批和授予，已有授权保持，待审批申请也保留。Owner 被停用时由管理员接手，界面会显示「Owner 已停用」。

同一个 EAT 用户在同一云账号始终复用一个 `eat-<去掉连字符的用户 UUID>` RAM 个人身份。显示名同步姓名，备注格式为 `EAT:<身份标记>:<邮箱>`，身份标记保持原有随机标识，不再重复用户 UUID。RAM 备注最多 128 字符，只有超长邮箱会截断加 `…`，平台内保留完整邮箱；见 ADR 0005。归属校验精确匹配 `EAT:<身份标记>:` 前缀，并核对已持久化的云端 UserId，任一不符时执行失败并拒绝接管；邮箱不参与归属判断。姓名或邮箱变化在下次授予时同步，带相同身份标记的旧备注也会更新为新格式。

一个用户对一个权限点只有一条授权。授权显示「待执行 / 已生效 / 执行失败 / 撤销中 / 已撤销」；失败保留原因，可手动重试，也会随后台操作恢复。RAM 用户绑定自定义策略达到配额时，提示「已达到该 RAM 用户可绑定的自定义策略上限，请在阿里云配额中心调高」。授予时只确保身份并绑定策略；成员首次领取个人凭证时才创建 AccessKey。

「我的权限」按云账号显示授权和实际已绑定自定义策略数；数量无法读取时显示错误，不把未知数量当作零。迁移后的 OSS 空间以只读行展示并可跳转空间详情，不作为权限点申请或撤销。Owner 或管理员可撤销，原因选填；持有人可放弃。撤销前核对云端身份和实际绑定，只解绑该权限点的策略，不修复其他绑定。撤销通过统一通知服务告知持有人，包含撤销人与原因；放弃不通知。授予、撤销、放弃及手动重试记审计。接入暂停拒绝新授予和授予重试，撤销、放弃及其失败恢复继续执行。

统一身份模块独立于阿里云功能设置，按次接收管理凭证，OSS 使用自己的管理凭证调用。每个云账号和用户共用 PostgreSQL 会话 advisory lock，锁使用独立连接池；丢锁后不发布执行结果。授权与持久操作表一起提交，云 API 调用在平台事务之外。后台每 30 秒检查未完成操作，失败按 30 秒递增退避至最多 5 分钟，重启后恢复。身份创建响应丢失时，凭随机标记确认本轮来源后复用。

本地迁移 `0041_aliyun_discovery` 新增接入和权限点，`0044_aliyun_grants` 新增个人身份、授权和操作表。个人凭证、停用、漂移与清理见下节；OSS 改名迁移流程见 [OSS 对象存储](oss-storage.md)。

验证入口：`apps/server/test/aliyun.spec.ts` 与 `aliyun-grants.spec.ts` 通过完整 HTTP 应用，仅以 `TestRamCloud` 替换云边界，通知送到测试回环接收器。覆盖多账号、幂等、策略配额、归属冲突、资料更新、暂停、撤销与放弃、通知审计、重启和丢锁恢复。桌面和手机的真实本地 HTTP 验收见[权限功能验证](permissions-validation.md)。


## 管理凭证所需权限

使用专用管理身份，AK/SK 仅加密保存在服务端，不下发成员。策略目录读取管理员预先创建的 `eat-perm-` Custom 策略，EAT 不替管理员创建权限点策略。

| 用途 | 所需动作 |
| --- | --- |
| 识别云账号 | STS `GetCallerIdentity` |
| 发现、说明和实时策略原文 | RAM `ListPolicies`、`GetPolicy` |
| 个人身份、改名迁移和清理 | RAM `GetUser`、`CreateUser`、`UpdateUser`、`DeleteUser` |
| 授权与漂移核对 | RAM `ListPoliciesForUser`、`AttachPolicyToUser`、`DetachPolicyFromUser` |
| 领取、轮换和安全停用 | RAM `ListAccessKeys`、`CreateAccessKey`、`UpdateAccessKey`、`DeleteAccessKey`、`DeleteLoginProfile` |

OSS 聚合策略另需创建和版本维护权限，详见 [OSS 管理凭证权限](oss-storage.md#管理凭证权限)。资源范围应同时覆盖统一个人身份 `eat-<UUID 去连字符>` 与保留的旧 OSS 名称；按阿里云各动作支持的资源类型配置，列表类或不支持资源级限定的动作不能套单个用户 ARN。这里列的是调用清单，不是通用最小权限 JSON。先在专用测试资源上核验，再按组织边界收紧。

## 本人个人凭证与 CLI

「我的权限」的云账号卡片可以查看、再次读取或重置本人的 AccessKey，个人凭证只供本人临时使用，不要配进线上服务。同一云账号的 OSS 空间共用这把 Key，重置确认框和 CLI 会说明影响范围。管理员没有读取他人 SK 的入口；每次成功读取或重置都有审计，响应为 `Cache-Control: no-store`，审计不含 AK/SK。

至少持有一项有效阿里云授权或同云账号的有效 OSS 空间才能领取或重置。接入暂停后不能新领或重置，已有个人 Key 照常可读；停用用户不能读取。无授权和歧义均在获取 Key 与启动子进程前拒绝。

```sh
eat aliyun grants
eat aliyun revoke eat-perm-read --account team-cloud
eat aliyun credentials --account team-cloud
eat aliyun credentials reset --account team-cloud
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


## 删除接入与云端不一致

删除接入前必须把全部授权撤销完成：待执行、执行失败和撤销中也会阻止删除。控制台二次确认说明会清理个人身份、全部 Key 与受管策略绑定；API 必须提交对应接入名 `confirmName`。

删除先持久化接入与目标身份的清理屏障，再在统一身份锁下核实全部目标的云端 UserId 和 `EAT:<身份标记>:` 备注来源，全部核对通过后才开始清理。顺序为停用并删除所有 Key、删除登录配置、解绑 `eat-perm-` 自定义策略、删除 RAM 用户，最后删除本地接入。RAM 策略本身不会删除。若有无关自定义策略或系统策略绑定，停止并提示管理员到 RAM 控制台确认处理，EAT 不会借删除接入修改这些绑定。

每个阶段及失败原因持久保存。失败时设置页显示「清理失败」、阶段和重试入口，管理凭证保留；后台每 30 秒与进程启动时按原重试时间继续，失败从 30 秒递增退避至最多 5 分钟。清理期间拒绝新申请、批准、授予、修复、建 Key、重置和恢复目标身份的 Key，安全停用仍能切断全部 Key。轮换基线、待回收 Key 与生效期限在清理失败时保留。管理凭证可以编辑以排除权限故障，不能通过恢复接入绕过删除屏障。

OSS 仍引用的个人身份始终保留，包括已回收全部空间但仍保留账号生命周期记录的情况；Key、OSS 聚合策略和绑定不变；仍残留的额外 `eat-perm-` 自定义策略在来源核实后解绑。统一身份安全同步在接入删除后使用 OSS 自身管理凭证。迁移后按 OSS 账号持久保存的 `identityId` 精确核对引用，并验证云账号与身份一致；发现有效或在途 OSS 空间却缺少对应引用时，明确阻止删除并提示先修复引用。

管理员打开授权管理视图、以及撤销前，都会现取 RAM 绑定并与 EAT 记录比较，只核对 `eat-perm-` 自定义策略。管理页标出云端缺少、多出的绑定或核对失败原因；核对不会改云端。管理员明确点击「按 EAT 记录修复」后才补绑缺少项、解绑多余受管项；无关自定义策略、系统策略及策略原文都不修改。暂停和清理期间不能修复。删除开始、失败、完成与修复结果均写入审计。

验证入口：`aliyun-cleanup-drift.spec.ts` 使用完整 HTTP 应用、本地专用 PostgreSQL 与唯一内存 RAM 边界，覆盖删除屏障、确认、来源冲突、全目标预核、失败重启与重试、暂停、安全停用、OSS 保留，以及缺少/多余绑定和显式修复。

## 排查

| 现象 | 处理 |
| --- | --- |
| 保存或操作报管理权限不足 | 核对上表动作、管理凭证与云账号；编辑保留原云账号，修正后重试原操作 |
| 同云账号重复接入或 OSS 门禁 | 使用原接入；OSS 所在云账号先在设置完成预演和执行，关闭 OSS 不能绕过 |
| 目标身份归属冲突 | 核对 marker 与持久 UserId；来源不明的同名资源交管理员处理，不能接管 |
| 自定义策略配额不足 | OSS 聚合策略也占一条；内存契约为10条，本轮真实云也测得第11条拒绝，其他账号按实际配额中心为准 |
| 两把 Key 槽位已满 | 核对手工 Key 和旧轮换任务；平台不先删旧 Key 腾位，处理后重试 |
| 新 Key 刚创建不可用 | 等持久 `readyAt`（默认45秒），用 `run` 自动等待；仍失败核对地域、策略与子命令身份覆盖 |
| 暂停后旧 Key 仍有效 | 暂停只挡新增；切断个人使用应停用 EAT 用户，恢复只启当前 managed Key |
| 云端已删除或已批准但执行失败 | 前者需管理员核对策略后刷新；后者修原因并重试已有授权，不新建申请轮次 |
| 阿里云同步待完成 | 查看用户列表原因；平台继续切断其他 Key，修凭证后等后台重试 |
| 删除清理失败 | 查看持久阶段，修管理权限后重试；无关策略绑定由管理员在 RAM 确认，EAT 不顺手解绑 |
| 云端不一致 | 先读缺少/多出报告，确认后显式「按 EAT 记录修复」，只改受管绑定 |

## 独立真实云契约验证

`apps/server/scripts/run-ram-contract.ts` 直接调用 RAM 适配层，并用 OSS V4 数据面验证旧 Key 改名前后仍能读取同一私有对象。它不启动 Nest 服务、生产 OSS 迁移器或数据库迁移，也不属于默认 `pnpm test`。没有显式 `EAT_REAL_RAM_CONTRACT=1` 时只输出 `{"skipped":true}`，不读本机凭证配置、不创建云客户端。

在仓库根目录运行：

```sh
pnpm --filter @eat/server exec tsc --noEmit -p tsconfig.ram-contract.json
pnpm --filter @eat/server exec vitest run test/ram-contract-safety.spec.ts
EAT_REAL_RAM_CONTRACT=1 pnpm --filter @eat/server exec tsx scripts/run-ram-contract.ts
```

管理凭证仅在内存读取本机 `~/.aliyun/config.json` 当前选中的 AK profile；可通过 `EAT_REAL_RAM_PROFILE` 选择另一条已配置的 AK profile。脚本拒绝非 AK 模式、缺少凭证或地域的配置，不修改配置，不运行会打印完整凭证的 `aliyun configure get`。终端只输出资源名、步骤、脱敏错误码、耗时、尝试次数和最终核对结果；私有 manifest 不保存 SK，Key ID 仅用于恢复清理。

管理身份需有 STS GetCallerIdentity；RAM 的 Get/Create/Update/DeleteUser、Get/Create/DeletePolicy、ListPolicyVersions、DeletePolicyVersion、ListPoliciesForUser、AttachPolicyToUser、DetachPolicyFromUser、List/Create/Update/DeleteAccessKey；OSS 的 PutBucket、GetBucketInfo、GetBucketTagging、DeleteBucket、ListObjects/ListObjectVersions，以及本轮对象的 Put/Get/DeleteObject/DeleteObjectVersion。创建 Bucket 时必须支持 [PutBucket 原子标签头](https://help.aliyun.com/zh/oss/developer-reference/putbucket)。个人 Key 的策略仅允许本轮 Bucket 内两个预登记对象的 PutObject/GetObject。脚本不会授予个人 Key 列 Bucket、列对象或清理 Bucket 的管理权限。

每轮新 UUID 派生 `eat-ram-contract-<UUID 去连字符>-*` 的用户、11 条自定义策略与临时私有 Bucket。不会使用线上权限点的 `eat-perm-` 前缀。逐 action 默认拒绝的 RAM 安全层禁止账号扫描；所有写操作先核精确资源名单、marker 和稳定 UserId，改名目标必须不存在。Bucket 创建必须原子带本轮标签，后续写入和删除前复核标签、Owner、地域和私有 ACL；不补标记接管来源不明的 Bucket，不读取既有 `eat-oss-*` 身份或其他 Bucket。

验证包括：创建用户；原 Key 改名后实际读取；新 Key 的实际生效耗时（第一次即成功也有效）；第三把 Key 的 quota 分类；绑定前 10 条策略后尝试第 11 条并记录实际 quota 错误码；绑定中的策略删除失败，解绑后删除成功。首探针在精确策略原文与绑定回读后，允许 InvalidAccessKeyId/AccessDenied 在 120 秒内有界重试；第二把 Key 还以前一把 Key 已成功的读取为基线。签名、时钟、Bucket/对象不存在等错误直接失败。配额是当前账号的实测契约，不能从一次测试推出所有账号的固定值；[RAM 使用限制](https://help.aliyun.com/zh/ram/product-overview/limits) 也区分可调整的策略配额与不可调整的 Key 数量。若第 11 条策略或第三把 Key 意外成功，脚本先登记并清理全部本轮资源，再以非零退出码报告契约冲突，不继续扩建策略或修改账号配额。

manifest 默认位于 server 工作目录的 `.ram-contract/<runId>.json`（目录 0700、文件 0600），每个创建/改名/绑定/Key intent 都先原子写入并 fsync，再执行云操作；结果立即持久保存。可用 `EAT_RAM_CONTRACT_MANIFEST_DIR` 指定持久私有目录。清理时只接受完整且 UUID 派生名单一致的 manifest，并用 STS 核对同一云账号，不接受环境变量传入任意资源名。脚本使用独占 lease，拒绝同时运行同一份 manifest；显式清理可自动回收已死亡进程的 lease，仍存活的 PID 会被拒绝。

成功、失败以及 SIGINT/SIGTERM 都进入同一个 finally 清理流程：信号只设置停止标记，等待在途请求返回，再按 intent/精确 marker 恢复响应丢失的资源；逐项解绑、删本轮 Key、删用户、删策略，最后完整分页检查并清空临时 Bucket 的预登记对象、版本和删除标记，再删 Bucket。某项失败仍继续清理其他项。清理预算独立于探针 deadline；出现未登记对象或归属不符时拒绝删除。SIGKILL、断电或清理失败后保留 manifest，用原账号显式重试：

```sh
EAT_REAL_RAM_CONTRACT=1 pnpm --filter @eat/server exec tsx scripts/run-ram-contract.ts \
  --cleanup /absolute/private-directory/<runId>.json
```

最终 `cleanup.remaining`、`cleanup.unknown`、`cleanup.errors` 均为空且 `passed:true` 才算整轮成功。零残留核对逐个 Get manifest 中所有创建 intent 的精确名字，包含改名前后两端，不调用 ListUsers/ListPolicies/listBuckets。仅资源级精确 `NoSuchUser`/`EntityNotExist.User`、`NoSuchPolicy`/`EntityNotExist.Policy`、`NoSuchBucket` 被算作不存在；权限、网络及未知错误会留在 unknown/errors 并非零退出。此处的零只证明本轮登记名单已清理，不声称扫描整个账号。

2026-11-09 真实验证：最终完整轮次 `e028a8b5-c4bb-47dd-ad36-26667cf23b12` 用时 74.814 秒，`passed:true`，三个清理数组全部为空；改名前后用户、11 条策略和临时 Bucket 共 14 个精确名称均确认不存在。首把与第二把 Key 均首次 V4 探针即成功，创建到观测成功分别为 1819 / 1754 毫秒（含 RAM 创建、归属核对及请求开销，不是纯传播时延或 SLA）。旧 Key 改名后读取同一对象成功；第三把 Key 返回 `LimitExceeded.User.AccessKey`，第 11 条策略绑定返回 `LimitExceeded.User.Policy`，绑定中删除返回 `DeleteConflict.Policy.User`，解绑后删除成功。此前失败轮次也已通过持久 manifest 显式清理并逐名核零。

SDK 注意：ali-oss 6.x V4 的分页 query 必须彻底省略未设置的 `marker`、`keyMarker`、`versionIdMarker`，不能传值为 `undefined` 的键，否则可能签名不一致。离线安全测试覆盖这一故障及显式恢复路径；真实最终轮已验证正常 finally 清理成功。
