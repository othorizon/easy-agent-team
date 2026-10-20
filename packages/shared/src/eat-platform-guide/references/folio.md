# Folio 发布、分享与评论

Folio 用于发布和分享网页、演示与报告，支持版本管理和评论。发布无需审批，管理员需先在系统设置中配置并启用（私有 OSS、域名与 HTTPS；共享入口由部署后台自动配置）。未启用时 CLI、MCP 和控制台均无法发布。

**发布内容限制：Folio 只能发布静态网站。** 支持浏览器直接加载的 HTML、CSS、JavaScript、图片等资源，以及 React / Vue 等项目预先构建生成的静态产物（含 SPA）；前端交互和在浏览器中调用外部 API 均可。必须先在本地完成依赖安装和构建，再上传产物目录或 ZIP，不能直接上传未构建的源工程并期待平台运行。Folio 不执行依赖安装、构建命令或服务端代码，也不提供 Node.js / Python / PHP 后端、SSR 运行时或数据库服务。需要后端、SSR 或常驻进程时，使用平台「应用」的 dockerfile 构建与部署流程。

**发布前询问访问权限**：使用 Folio 发布时，先询问用户“这个 Folio 希望谁可以访问？”，并说明三种选择：

- `authenticated`：仅 EAT 登录用户可访问。
- `public`：任何人可访问，无需登录。
- `password`：凭访问密码或免输密码链接查看；用户未指定密码时，平台自动生成随机密码，无需额外追问密码。

用户尚未明确选择时，先等待答复，再创建 Folio、修改访问权限或执行发布；不要把平台默认的 `authenticated` 当作用户已经选择，也不要自行设为公开。用户已在本次任务中明确选择时，按其选择执行，无需重复询问。发布已有 Folio 的新版本时，先用 `eat folio list` / `list_folios` 查看并告知当前权限，再询问沿用还是调整；用户确认沿用时保留原设置，不重设已有密码。

明确访问权限后，用 `eat folio create <slug> --access <模式>` / `create_folio`（传 `access`）创建 Folio；已有 Folio 需要调整权限时用 `eat folio update <folio> --access <模式>` / `update_folio`。密码模式下，用户指定密码时传 `--password` / `password`；省略时保留已有密码，没有旧密码则由服务端生成随机密码，仅保存哈希。再用 `eat folio push <slug> <目录或 ZIP>` / `publish_folio` 上传构建好的静态文件，根目录需包含 index.html。每次最多 2000 个文件、50 MiB，历史发布产物完整保留；Folio 固定域名直接展示当前版本、地址栏不跳转，带版本域名用于固定快照，用 `activate_folio_version` 可回滚。

**密码访问发布后直接交付免输密码链接和有效期**：`eat folio push` 自动输出免输密码链接及其有效期；MCP `publish_folio` / `complete_folio_upload` 的发布结果中，`share.url` 为免输密码链接，`share.expiresInDays` 为有效天数（当前为 90 天）。恢复已完成的上传会话时，`result.share` 同样按当前访问设置生成。向用户返回该链接并明确说明“有效期 90 天，修改密码或访问方式后失效”，不要只返回仍需输入密码的普通版本地址。用户需重新生成时使用 `eat folio share <folio>` / `create_folio_share_link`。分享链接使用 Folio 固定域名，打开后显示当前版本；固定快照仍使用版本地址。

CLI/Web 每次提交完整文件清单，仅将缺失 SHA-256 内容以二进制直传私有 OSS；同一 Folio 的内容共享，版本仍保存完整清单。50 MiB/2000 文件按整版逻辑内容计算。CLI 中断后重跑同一命令可恢复，`--resume <upload-id>` 指定会话，`--fresh` 开始新的发布；会话有效 24 小时，短期签名可续签。浏览器刷新后需重新选择相同本地文件。服务端对新增对象的私有快照流式读取并核验 SHA-256 后封存，文件字节可能经过 EAT 验证一次。MCP 可用 `prepare_folio_upload` / `get_folio_upload` / `renew_folio_upload` / `complete_folio_upload`；只向返回的 OSS URL 发送原始二进制及签名头，绝不携带 EAT 令牌或 Cookie。远程 MCP 无法读取用户本地路径；小型内容也可用 `publish_folio` 的 utf8/base64 输入。

MCP 中通过 folio 参数指定 Folio 标识。读取密码访问的 Folio 时，先 `unlock_folio` 验证，后续调用携带返回的 accessToken；`create_folio_share_link` 返回免输密码链接，它只授予 Folio 访问能力，不代表用户身份。发表评论或回复始终需要 EAT 登录。

处理反馈用 `list_folio_comments`（支持 page / versionId / status），每条评论与回复均附实际浏览版本，讨论还附元素或区域锚点及原版本链接。创建或回复时必须传实际查看的 versionId，不要拿当前最新版代替旧 Folio 的版本。`list_folio_mention_users` 查询用户 ID，在 mentions 中指定即可 @；在用户中心配置并验证过飞书 Webhook、且开启评论提及通知的用户会收到事件通知。修复后发布新版、回复说明，再按需 `set_folio_thread_status` 标记解决；发布不会自动解决旧评论。删除评论用 `delete_folio_comment` / `eat folio delete-comment <folio> <comment-id>`，仅评论作者、Folio 所有者或管理员可操作；清除正文并保留其他人的回复。

删除整个 Folio 用 `eat folio delete <folio>` / `delete_folio`，仅所有者或管理员可操作。必须先取得用户明确的删除指令；这会永久清除全部历史版本、发布文件、评论与会话，固定链接和分享链接立即失效，无法恢复。返回 `cleanupFailed: true` 时 Folio 已删除，但部分私有文件清理失败，需通知管理员按审计记录检查清理；`cleanupPending: true` 表示旧上传签名仍有效，后台将继续清扫该 Folio 前缀。
