# 静态网站发布与评论

静态网站使用共享访问网关与文件存储，不创建 Dokploy 应用、容器或部署审批。每个 EAT 成员都可以创建并更新自己的网站，所有者和平台管理员可修改设置、发布及回滚。三端共用 `packages/shared/src/site.ts` 契约。

## 配置

生产配置示例（凭据通过部署环境注入）：

```dotenv
EAT_PUBLIC_URL=https://eat.example.com
EAT_SITES_DOMAIN=eat-sites.example
EAT_SITES_HTTPS=1
EAT_SITES_STORAGE=oss
EAT_SITES_OSS_REGION=oss-cn-hangzhou
EAT_SITES_OSS_BUCKET=your-private-bucket
EAT_SITES_OSS_ACCESS_KEY_ID=...
EAT_SITES_OSS_ACCESS_KEY_SECRET=...
```

1. 使用与 EAT 平台不同的主域名承载用户 HTML。站点域名不允许与平台域名相同，避免网站脚本接触平台的 localStorage 和身份凭据。
2. 将通配 DNS `*.eat-sites.example` 指向 EAT 服务。前置代理配置该域名的通配证书、保留浏览器原始 `Host`，并将该域名下**所有路径**转到 EAT，包括 `/assets/`、`/api/` 和 `/__eat/`。站点网关会在控制台静态资源和平台 API 之前拦截此域名的流量。
3. OSS bucket 保持私有，使用仅允许该 bucket 下 `sites/` 前缀读写和删除的服务身份。禁止使用 bucket 公共读或直接公开 OSS 源站绕过网关。
4. 运行 `pnpm db:migrate`，构建并启动平台。前置代理需允许至少 72 MiB 的 JSON 请求体；服务端仅发布路由放宽到 72 MiB，解码后的文件总量仍最多 50 MiB。

开发默认使用 `EAT_SITES_DOMAIN=sites.localhost:3000`、HTTP 和本地存储。浏览器通常将 `*.localhost` 解析到回环地址；不支持时配置 hosts 或本地 DNS。本地存储默认 `./data/static-sites`，生产若选 local 必须指定并挂载持久化目录。版本记录保存存储类型；更换 bucket、region 或本地目录时，需要同步迁移历史文件。

目前所有站点响应都使用 `private, no-store`，网关对每次文件访问重新校验站点策略。前置 CDN 不得绕过鉴权缓存私有文件。访问模式、密码变更对所有历史版本生效；Service Worker 注册被阻止，避免离线缓存越过后续访问策略。

## 发布与版本

```bash
eat site create demo --name "项目演示"
eat site push demo ./dist -m "第一版"
eat site push demo ./site.zip -m "更新页面"
eat site versions demo
eat site activate demo <version-id>
```

控制台「资源 → 静态网站」提供创建、目录或 ZIP 上传、访问设置、分享链接和版本切换。CLI 目录上传跳过 `.git`、`node_modules`、`.env*`，并拒绝软链接；ZIP 根目录须包含 `index.html`，拒绝目录穿越和保留的 `__eat/` 路由。每次最多 2000 个文件、50 MiB。只上传构建好的产物，不执行构建命令。

固定入口 `https://demo.eat-sites.example` 每次访问会跳转到当时的当前版本，例如 `https://v3--demo.eat-sites.example`。版本域名固定，页面、绝对路径资源、多页导航与 SPA 路由都保留在同一快照内；已打开的版本不会因其他人发布而变化。重新访问固定入口可打开最新版本。

所有历史版本文件默认保留。发布先写入新快照，再在数据库事务内分配单调版本号并切换当前版本；并发发布不会产生重复版本号。上传失败不改变线上版本。回滚只修改当前版本指针，评论保持原样。保存的是 HTML/CSS/JS/图片等发布产物，不自动保存 React/Vue 源工程。

## 访问方式

| 模式 | 查看网站与评论 | 发表评论或回复 |
| --- | --- | --- |
| authenticated，默认 | EAT 登录用户 | EAT 登录用户 |
| public | 任何访问者 | 仍需 EAT 登录 |
| password | 正确密码或有效分享凭据 | EAT 登录且已通过网站访问校验 |

网站所有者与管理员可直接管理和访问自己管理的网站。其他登录用户仍需验证密码网站。登录访问通过 EAT 页签跳转，使用绑定站点域名、60 秒过期且只能消费一次的兑换码建立 HttpOnly 站点 Cookie，不把平台令牌交给网站脚本。平台原始 Token 吊销、到期或用户停用后，由它产生的站点登录会话和评论会话立即失效。

```bash
eat site update demo --access public
eat site update demo --access password --password '<访问密码>'
eat site share demo
eat site unlock demo '<访问密码>'
eat site comments demo --access-token '<返回的 accessToken>'
```

「复制链接」不带凭据，「复制免输密码链接」带随机签名访问凭据，打开后自动建立网站访问会话并从地址栏移除凭据。分享凭据有效期 90 天，只允许访问该网站，不代表分享者身份，也不能代其发表评论。修改密码或访问模式会使旧分享凭据、密码访问会话和评论访问凭据失效。

## 评论、批注与 @

HTML 访问时自动插入 `/__eat/embed.js`，显示浮动评论入口。评论表单位于平台源的 iframe 内；支持整页评论、点击元素、在元素内拖选区域，Esc 可取消选取。站点自带 CSP 时，应允许本站 `/__eat/embed.js` 与 EAT 平台 iframe；不兼容的 CSP 会阻止自动批注界面，评论仍可通过 EAT、CLI 和 MCP 操作。

讨论串记录发起版本、页面标识和锚点；每条评论与回复记录实际浏览的版本。SDK 从所打开的不可变版本取得版本 ID，不在提交评论时读取当前版本指针。默认按 `pathname` 识别页面，hash 路由保留 `#/...` 或 `#!...`；不把访问凭据和其他查询参数写入页面标识。

锚点同时记录稳定的 `data-eat-id` / DOM ID、CSS 路径、文字与相邻文字；区域使用元素内的相对坐标。新版定位按稳定标识、经过文字校验的路径、唯一文字匹配依次尝试。无法确定时显示位置已变化，用户可打开评论原版本，不会把评论静默移动到别的元素。建议站点为重要元素设置稳定的 `data-eat-id`。

网页内登录评论使用弹窗取得仅限该站点的评论会话，适用于浏览器隔离第三方存储的场景。平台全局登录令牌始终留在平台源，不通过 `postMessage` 发送给站点。

```bash
eat site comments demo --page / --status open
eat site comment demo '这里需要调整' --version-id '<浏览版本 ID>' --page /
eat site mention-users demo
eat site comment demo '@张三 请查看新版' --version-id '<浏览版本 ID>' \
  --thread '<讨论 ID>' --mention '<用户 ID>'
eat site resolve demo '<讨论 ID>'
eat site resolve demo '<讨论 ID>' --reopen
```

发起人、网站所有者、管理员可解决和重新打开讨论。版本更新、回复、回滚均不自动改变解决状态。评论目前为不可变消息，避免修改历史上下文。

输入 `@` 可搜索并选择活跃用户。被提及用户配置过个人飞书 webhook（现有「求助」页的个人通知配置）时，复用签名、投递记录与最多五次退避重试。重复用户 ID 在一条评论内去重，自己 @ 自己不推送。通知为事件与讨论链接，不携带评论正文、密码或分享凭据；打开后仍校验网站访问权限。重试沿用现有进程内机制，进程在重试中途重启时不会自动恢复投递。

## MCP 与 API

本机 stdio MCP 和平台 HTTP MCP 都提供：`list_sites`、`create_site`、`update_site`、`publish_site`、`list_site_versions`、`activate_site_version`、`create_site_share_link`、`unlock_site`、`list_site_comments`、`create_site_comment`、`reply_site_comment`、`set_site_thread_status`、`list_site_mention_users`。

主要 REST 入口为 `/api/sites`、`/:slug/releases`、`/:slug/versions`、`/:slug/activate`、`/:slug/access`、`/:slug/share`、`/:slug/threads`、`/:slug/threads/:id/replies`。密码网站可先调用 access 端点，再通过 `x-eat-site-access` 携带返回的访问凭据；它不代替发表评论所需的 EAT 身份。按版本筛选讨论使用发起版本，回复保留各自的浏览版本。
