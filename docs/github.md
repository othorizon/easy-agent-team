# GitHub 组织协作接入

GitHub 关联是可选能力，不替代 EAT 登录，也不修改 Dokploy 的 Git 源或 SSH key。集成仅管理一个指定组织的仓库；个人仓库和其他组织不参与自动授权。

## 管理员接入向导（推荐）

先部署增量迁移与代码，并将 `EAT_PUBLIC_URL` 设为用户和 GitHub 可访问的 EAT HTTPS 地址。管理员需要同时具有目标 GitHub 组织的 Owner 权限。

1. 进入「系统设置 → GitHub 接入」，输入组织名称和 App 名称，点击「初始化 GitHub App」。
2. 浏览器使用 GitHub App Manifest 跳转到该组织的 App 创建页面，确认名称并创建。权限、回调地址由 EAT 自动填写，webhook 关闭；这是创建 GitHub 集成身份，不是创建 EAT 业务应用。
3. GitHub 返回 EAT 后，服务端交换一次性 code，将 App ID、Client ID、Client Secret 和私钥加密保存。此时接入仍关闭。
4. 点击「安装到组织」，在 GitHub 选择指定组织和 **All repositories**，确认权限。安装回调核验 App 身份、组织 ID、权限和仓库范围，通过后保存 Installation ID 并启用接入。
5. 普通 EAT 用户在个人中心关联自己的 GitHub 身份，不需要再安装 App。

创建与安装回调分别使用 30 分钟、一次性的 state 和 HttpOnly 浏览器随机值。服务端在回调前后检查发起管理员的角色、启用状态、原 EAT 会话和配置版本。EAT Token 和 App 密钥不会进入跳转 URL；私钥和 Client Secret 不会发送给浏览器。取消向导不改变已有配置。

如果安装需要组织 Owner 审批，先在 GitHub 完成审批，再回 EAT「检查连接」并启用。安装成功但回调丢失时，「检查连接」可根据 App 和指定组织重新发现并核验安装，不必创建新 App。

### 卸载、删除与重新初始化

- **从组织卸载 App**：保留 EAT 中的 App 配置和账户绑定。点击「重新安装到组织」，核验后自动更新 Installation ID；不会强制清除用户凭据。GitHub 如另行撤销用户授权，用户仍需重新授权。
- **删除 GitHub App 本身**：原 App 无法重新安装。在「App 已被删除？重新初始化」确认创建新 App，再安装到原组织。新 App 创建成功后，旧用户凭据清除、旧任务取消；保留 EAT 用户、应用、审批、成员关系、GitHub 身份映射及权限回收所需记录。用户需要重新授权，业务页面可重新核验并补操作。
- **私钥失效、安装暂停或网络异常**：显示连接错误并保留配置，不自动判断 App 已删除，不自动创建替代 App。先修复密钥或 GitHub 安装状态。

重新初始化只能使用原组织。不能借重新安装或初始化把现有账户和仓库授权关系转移到另一个组织。新 App 不会自动批量修改历史仓库权限。

## 高级设置：手动配置已有 App

1. 在 GitHub 创建 GitHub App。Organization permissions 设置 **Members: Read and write**；Repository permissions 设置 **Administration: Read and write**，保留 Metadata 读取权限。
2. 将 App 安装到指定组织，选择 **All repositories**。无需为每个 EAT 用户安装 App，也无需开启 webhook。
3. 将「高级设置」展示的 Authorization callback URL 配置到 GitHub App，路径为 `/api/github/callback`。Setup URL 设置为 `/api/github/setup/installation` 对应的完整地址；关闭安装时请求用户 OAuth 授权，开启安装更新后跳转 Setup URL。
4. 展开「高级设置：手动配置已有 GitHub App」，填写组织名称、App ID、Client ID、Installation ID、Client Secret 和 PEM 私钥。密钥加密保存，读取接口只返回是否配置；留空保留原密钥。
5. 先保持接入关闭，保存并执行「检查已保存的连接」，再启用。已有绑定或授权记录时，不允许在手动配置中更换组织或 App；可轮换密钥，同一 App 的新 Installation ID 必须通过组织核验。更换 App 使用上方的重新初始化流程。
6. 后端需要 HTTPS 访问 `github.com` 和 `api.github.com`。App 私钥、用户 token、refresh token 和浏览器授权随机值不得进入日志或代码仓库。

## 用户与组织

用户中心的「关联 GitHub」使用已登录 EAT 会话开始授权，回调使用一次性 state 和 HttpOnly 浏览器随机值确认关联。用户授权只用于识别账户和接受自己的组织邀请；邀请、仓库权限管理使用组织 installation token。

绑定成功后后台发送邀请并尝试接受。已存在邀请会复用，已加入的用户不会重复邀请。GitHub 异步接受返回处理中时继续查询；查询异常显示未知，不能解释为未加入。

用户可接受邀请、刷新状态、重新授权或前往 GitHub 手动处理。管理员在用户列表重新发送邀请、刷新状态，或明确移除组织成员／取消邀请。解绑清除用户凭据、取消关联身份的待执行任务，不自动退出组织。

## 应用与权限

应用 owner 和 EAT 管理员继续管理 EAT 成员，但新增成员要求当前仓库已有部署批准。更换仓库撤销批准；GitHub SSH/HTTPS 的等价地址不算更换，分支变更不重审。存量已批准应用由迁移保留批准和成员关系。

EAT 成员写入与 GitHub 任务同事务提交，GitHub 请求在后台执行。组织归属、操作者权限、目标组织成员状态或 GitHub 服务异常不会回滚 EAT 成员添加。

- 授予至少 Write：EAT 管理员，或仓库 Maintain/Admin。Maintain 通过 EAT 的组织 App 代理执行。
- 修改 Read/Triage/Write/Maintain/Admin：EAT 管理员或仓库 Admin。
- 新增应用成员授权时重新检查权限、当前仓库版本、部署批准和账户绑定。自动授予 Write 不降低已有高权限。
- 仓库角色是仓库全局权限；多个 EAT 应用使用同一仓库时共享实际权限。GitHub 团队和组织默认权限可能使实际角色高于设置的直接角色。
- 应用列表及详情展示组织归属、应用 owner 的 GitHub 角色、组织 owner 标识与最后核验时间。未知状态不是无权限。

成员页分为「应用成员」和「GitHub 仓库权限」。上方显示全部 EAT 应用成员，未添加到仓库的成员可在对应行操作；未关联 GitHub 时显示等待本人关联，不另设待添加列表。下方分页读取 GitHub 的完整协作者名单并按 GitHub 用户 ID 匹配 EAT 账户，区分应用所有者、应用成员、其他 EAT 用户和「非 EAT 成员」（当前未关联 EAT 账户，不等同于未注册）。

仓库列表中的直接授权支持「修改角色」和「从仓库移除」，需 EAT 管理员或实时核验的 GitHub 仓库 Admin 权限。这些操作针对现有仓库权限，不要求目标是 EAT 用户或应用成员，也不依赖应用部署批准；始终使用安装 token，校验组织、仓库 ID/版本、目标 GitHub ID、确认时的角色和操作者当前身份。组织 Owner 的访问不能通过此入口撤销。继承权限只读展示，需在权限来源处调整。

「从仓库移除」只删除直接授权，保留 EAT 成员关系，也不会退出组织；同一仓库的其他应用会受影响。已移出应用但仓库权限仍存在的用户继续显示实际角色及普通操作按钮，不显示撤权失败状态或专用重试按钮。操作错误在本次弹窗提示，随后重新读取 GitHub；读取失败不会当成空名单，旧数据会标为待刷新并禁止编辑。

手动操作与后台任务共享互斥锁，取消同一仓库、同一用户先前排队的授权任务，并刷新共享仓库的各应用。手动修改已不再被应用需要的授权后，该授权不再作为自动回收目标，避免旧清理任务覆盖管理员的新选择。

取消分享、删除应用或停用用户会安排撤权。仍被其他应用需要的访问不会撤销。只处理 EAT 管理的直接授权；不删除组织、团队或原有人工授权。

GitHub collaborator API 的 `role_name` 包含继承后的最高权限，即使查询 `affiliation=direct` 也不总能证明原直接角色。因此对已有且来源无法确认的授权，撤权进入人工处理，不能用推测的低角色覆盖它。外部修改后与 EAT 最后设置不同的授权同样暂停自动清理。管理员在「GitHub 接入 → 待处理的仓库撤权」核对并手动修复 GitHub，之后重新检查。

## 恢复与通知

PostgreSQL 保存当前操作目标、版本、最后错误、次数及下一次执行时间；进程每 30 秒恢复任务，通过 PostgreSQL advisory lock 避免多实例重复处理。无需 Redis，没有新增操作审计或历史流水。

自动操作遇网络或服务端错误最多尝试五次，限流遵循服务端返回的等待时间。授权失效、权限不足等错误停下来等待处理。手动重试只尝试一次，重复点击合并；旧角色任务不会覆盖较新的角色修改。待用户关联或入会的任务保持等待。

最终失败通知启用中、配置了已验证飞书 webhook 的 EAT 管理员，包含业务页面链接。页面显示无通知渠道或投递失败。关闭接入会停止 GitHub 工作，EAT 功能继续可用；重新启用后继续核验待执行任务。

## 验证

```sh
corepack pnpm --filter @eat/server exec vitest run test/github.spec.ts test/github-client.spec.ts test/p3.spec.ts test/account.spec.ts
corepack pnpm -r typecheck
corepack pnpm -r build
node scripts/test-github-ui.mjs
```

服务端测试使用真实 PostgreSQL 和模拟 GitHub，页面验证使用 Chromium 和模拟 API。正式启用前，在专用测试组织使用真实 App 验证 Manifest 创建、组织安装、卸载后重新安装、删除后重新初始化、用户重新授权，以及自动接受、Maintain 代理授权、角色变更及撤权。模拟测试不等同于真实 GitHub 联调。
