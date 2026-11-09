# OSS 对象存储

EAT 为成员在同一个阿里云 OSS Bucket 下分配空间。管理员先配置并启用功能，成员通过控制台、`eat oss`、stdio MCP 或 HTTP MCP 提交申请；管理员批准后开通。

## 控制台空间与审批

成员在「我的空间」中申请和查看自己的存储空间。管理员另有「全部空间」和「审批」两个页签：前者查看全部空间并进入详情管理，后者仅展示待审批申请，显示申请人、完整用途和申请时间，可直接批准或填写原因后拒绝。处理后申请从待审批列表移除，结果可在空间列表查看。审批页签不提供申请空间或空间管理操作，空间详情中的待审批记录通过「前往审批」跳转到此页签。

页签同步到 URL，`/oss?tab=approvals` 可直接打开审批列表；审批入口仅管理员可见，批准和拒绝仍由服务端校验管理员权限及待审批状态。OSS 未启用或申请已有未完成操作时，审批按钮不可用。

## 配置和边界

系统设置 → OSS 存储，填写管理 AK/SK、Bucket、地域，保存后检查并启用。管理凭证以平台 EAT_KEK 信封加密保存，设置读取仅返回掩码。部署前备份数据库与 EAT_KEK；迁移为 `0027_oss_storage.sql`。功能默认未配置、未启用，不自动使用服务器或开发机器上的阿里云凭证。

管理凭证必须与 Bucket 同属一个阿里云账号。Bucket ACL 必须为 private。启用检查会创建独立测试对象和 RAM 用户，测试权限、隔离、对象 ACL、分片、公开读开关、密钥停用恢复，并清理测试资源（包括版本控制产生的历史版本、删除标记和未完成分片）。密钥开关检查通过 RAM 状态回读确认权限，不代表 OSS 数据面的即时失效；实测 V4 的 Key 停用传播可超过两分钟。检查失败不会启用；清理失败会保留恢复记录并重试。创建云资源后锁定 Bucket、地域和账号，更换管理凭证须先停用；同账号凭证可用于修复失败任务。

读取 Bucket 已绑定并启用的域名，可多选并手动标记 CDN。官方 OSS 域名始终返回。EAT 不调用 CDN 管理 API，不配置私有回源、访客鉴权或刷新缓存。域名/CDN 标记是管理员提供的信息。

目录公开读通过 Bucket Policy 的一个受管语句管理，只允许 GetObject。每次合并保留其他语句，写入前持久化待写语句，写后回读；响应丢失时可识别已生效语句。不要同时在云控制台改动 EAT 受管语句；OSS Bucket Policy 没有条件更新机制，遇到外部修改或回读差异会报冲突，需管理员核对后重试。

用户可自行设置空间内对象 ACL。关闭目录公开读只移除 EAT 授权，不重写对象 ACL，也不清理 CDN 缓存。私有 Bucket 回源不代表 CDN 访客需要鉴权。

RAM 用户、策略、AccessKey 和 STS 身份读取统一经过独立的 `RamCloud` 适配层，OSS 的 Bucket、对象和 Bucket Policy 调用保留在 `OssCloud`。每次 RAM 调用都显式传入 OSS 的管理凭证；适配层不保存全局凭证。测试的 RAM 状态由 `TestRamCloud` 管理，对象存储替身从同一份 RAM 状态判断用户 Key 与策略授权。接口与错误分类见 [RAM 适配层](ram.md)。

## 个人身份迁移预演

管理员可在系统设置 → OSS 存储点击「迁移预演」。报告以全部 OSS 个人身份为起点，包含空间已全部回收及用户已停用的记录，展示旧 RAM 用户名、目标 `eat-<用户 UUID 去掉连字符>`、云端 UserId、有效空间前缀与操作、当前 Key 状态和聚合策略变更意图。预演使用 OSS 保存的管理凭证，只读取云端与平台数据，不创建或刷新个人身份，不修改 Key、策略、空间及迁移结果。

没有有效空间时，报告标明迁移将解绑聚合策略（包括旧的 `Deny oss:*`），保留策略本身。停用用户仍按有效空间计算未来的 Allow 聚合授权；报告会如实显示仍为 Active 的手工 Key，并说明执行时必须先停用全部 Key、删除控制台登录配置，再调整策略。

目标同名用户只有在旧 OSS 来源标记、已保存的统一身份云端 UserId 和身份标记能够验证归属时才可能继续；仅有 `eat-` 用户名或 `EAT:` 备注前缀不能确认归属。两份独立 RAM 身份不能通过预演合并；归属冲突、读取失败和未完成的 OSS 操作会在报告中列出，交管理员处理后重新预演。预演报告只保存在当前窗口；确认后可执行迁移，逐人的执行阶段、结果与错误持久保存。生产迁移需管理员在实际环境明确发起。

执行先保存旧 UserId 和目标身份，核对归属后将旧 RAM 用户改名，Key 不换；再持久保存统一个人身份和 OSS 的 `identityId` 引用，按有效空间维护 Allow 聚合策略，无空间则解绑，保留策略和文件。旧路径前缀与聚合策略名可以保留。停用用户先停全部 Key、删除登录配置，再调整策略；恢复只启当前 EAT managed Key。

迁移期间 OSS 写操作返回409，读取仍可用。中断或部分失败可重试，已完成的人不重复执行；不会接管冲突身份。完成后同云账号才能接入阿里云权限，后续 OSS 同步按精确 `identityId` 使用统一身份，不会重新创建旧名用户。

## 管理凭证权限

建议使用专用 RAM 管理身份。所需操作以实际启用检查为准，至少包括：

- OSS Bucket：GetBucketInfo、ListCname、GetBucketPolicy、PutBucketPolicy、DeleteBucketPolicy、ListObjects、ListObjectVersions、ListMultipartUploads。
- OSS 测试路径：GetObject、PutObject、DeleteObject、DeleteObjectVersion、GetObjectAcl、PutObjectAcl、ListParts、AbortMultipartUpload。
- RAM：GetUser、CreateUser、UpdateUser、DeleteUser、DeleteLoginProfile；ListAccessKeys、CreateAccessKey、UpdateAccessKey、DeleteAccessKey；GetPolicy、CreatePolicy、CreatePolicyVersion、ListPolicyVersions、DeletePolicyVersion、DeletePolicy；ListPoliciesForUser、AttachPolicyToUser、DetachPolicyFromUser。
- STS GetCallerIdentity 用于确认管理身份所属账号。

Bucket 操作限定目标 Bucket；对象检查限定 `eat-storage/<instance-id>/_checks/`，RAM 用户覆盖统一名称 `eat-<用户 UUID 去连字符>`、迁移前的 `eat-oss-<instance-id 前 12 位>-*` 和本实例检查用户；聚合策略仍覆盖保留的旧名称。RAM 创建及列表类动作的 Resource 支持情况需按阿里云授权文档配置。不要把管理 AK/SK 下发给用户。

## 授权模型

固定路径为 `eat-storage/<instance UUID>/<user UUID>/<space UUID>/`，名称修改不改变路径。每位用户在同一云账号共用一个统一个人身份，OSS 保留一个聚合自定义策略，多个已批准空间合并授权；ListObjects 限定完整前缀，对象读写、删除、ACL 和分片操作限定对应资源。策略达到阿里云容量上限时拒绝新增授权，已有授权保留。

用户只可显式读取本人的共享 AK/SK，响应 no-store，读取行为审计。管理员可管理空间，但不能读取他人 SK。个人凭证只供本人临时使用，不配置到线上服务。同一 AK/SK 覆盖该用户所有已批准及以后新增的空间和同云账号的阿里云权限，不能作为单个空间的独立凭证分发；重置前说明两处共同影响。重置为持久化后台操作：新 Key 保存成功后停用并删除旧 Key；响应丢失时按创建前 Key 清单识别并回收孤立 Key。

空间状态：pending → provisioning → active；失败显示错误并自动重试。管理员可拒绝 pending 申请，或回收 active 空间（revoking → revoked）。回收只撤销 RAM 路径授权和 EAT 公开读，不删除文件。公开读修改有 desired/applied 状态，未同步时显示处理中。

操作由 PostgreSQL session advisory lock 串行化，云 API 不在数据库事务内。多副本共享锁，重启从持久化操作表恢复。后台每 30 秒检查，失败退避最多 5 分钟；新 RAM Key 首次使用前等待 45 秒传播；权限变化另有最长约两分钟探测重试。运行云操作期间新的写请求可能返回 409，客户端可稍后重试；读取状态不需要此锁。

平台停用后停止申请、批准、更新公开读和读取/重置凭证，已有资料可读，已发出的 AK/SK 仍有效。回收、启用清理、用户停用安全同步继续运行。迁移后停用用户会停用全部 RAM Key（含手工 Key）并删除控制台登录配置，策略保持不动，失败显示同步待完成并重试；恢复只启当前 EAT managed Key。迁移前保留旧路径的策略停用行为，迁移时会按有效空间重算 Allow，避免保留旧 Deny。全部空间回收后解绑聚合策略，不写 Deny，保留策略与文件。云端权限传播不是瞬时的。

## 客户端

```sh
eat oss status
eat oss request "项目附件" --purpose "项目文档和图片"
eat oss list
eat oss show <space-id>
eat oss update <space-id> --name "新名称"
eat oss public-read <space-id> on
eat oss credentials
eat oss credentials reset --yes
eat oss operation <operation-id>
```

CLI 申请会在 stderr 输出 requestId；网络失败可 `--request-id <uuid>` 重试。同一请求 ID 对应同一内容；MCP 支持传入 requestId。9 个 OSS MCP 工具见共享 `oss-tools.ts`，两种传输复用同一服务权限，凭证操作属于敏感工具。审批、拒绝、回收及管理设置目前位于控制台。

## 验证

自动测试包括：策略边界、其他 Bucket Policy 保留、响应丢失恢复、幂等申请、审批权限、共享账号、凭证加密与读取权限、公开读/ACL 独立、密钥轮换、用户停用、停用后回收、启用检查及清理恢复。使用独立 PostgreSQL 测试库，测试会重建该测试库 schema。

真实云测试必须使用显式授权的测试 Bucket，并限定全新 UUID 前缀和专用 RAM 测试账号；不修改既有对象、Bucket ACL 或 CDN。生产启用仍执行实际部署环境的权限检查。

官方参考：[对象 ACL](https://help.aliyun.com/en/oss/developer-reference/putobjectacl)、[列出绑定域名](https://help.aliyun.com/zh/oss/developer-reference/listcname)、[阿里云 TypeScript SDK](https://github.com/aliyun/alibabacloud-typescript-sdk)。

身份迁移、失败重试与共享 Key 提示的桌面/手机验收见[权限功能验证](permissions-validation.md)。
