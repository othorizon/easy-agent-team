# 页面发布与评论

页面使用共享访问网关与文件存储，不创建 Dokploy 应用、容器或部署审批。每个 EAT 成员都可以创建并更新自己的页面，所有者和平台管理员可修改设置、发布及回滚。三端共用 `packages/shared/src/site.ts` 契约。

## 在系统设置中启用

页面默认关闭。平台管理员进入「系统设置 → 页面发布」，完成配置并点击「检查并启用」。页面不再读取 `EAT_SITES_*` 环境变量，OSS 与 DNS 凭证加密存入 PostgreSQL。无需改部署环境或重启 EAT。

| 管理员准备 | EAT 自动处理 |
| --- | --- |
| 已在「部署后台接入」配置 Dokploy 地址和 API Token | 验证连接和 Traefik 配置读写权限 |
| 选择 Dokploy 中运行 EAT 的应用，填写容器端口（默认 3000） | 识别应用所在服务器，生成内部转发地址；可手动覆盖为 Traefik 可达的 EAT 根地址 |
| EAT 控制台的 HTTPS 地址（默认当前控制台地址） | 验证请求到达当前 EAT，并用于页面登录、评论和通知链接 |
| 独立页面域名后缀、Dokploy 入口 IP 或主机名 | 验证域名隔离和随机子域名的通配解析 |
| 私有 OSS Bucket、地域、AccessKey ID / Secret | 检查 Bucket ACL、实际上传/读回/删除测试对象及删除后不可读取；确认匿名访问被拒绝 |
| 证书接入方式，见下表 | 配置共享 HTTP → HTTPS 跳转和页面转发，再验证 HTTPS 信任链、主机名、有效期和 EAT 探针 |

OSS 凭证需要目标 Bucket 的 `oss:GetBucketAcl`，以及 `sites/*` 下的 `oss:PutObject`、`oss:GetObject`、`oss:DeleteObject` 权限。Bucket 必须为私有读写，不得通过 Bucket Policy 或 OSS 源站公开文件。EAT 在 `sites/_checks/` 下创建随机临时对象，并在失败时也尝试清理；缺少删除权限会明确阻止启用并提示残留对象路径。

### HTTPS 与 DNS

所有页面使用 `页面标识.sites.example.com`，不可变版本使用 `v版本号--页面标识.sites.example.com`，共用 `*.sites.example.com` 证书。该证书不覆盖 `sites.example.com` 本身或更深层域名。

| 证书方式 | 管理员填写 | 签发和续期 |
| --- | --- | --- |
| 阿里云 DNS（AliDNS） | 证书联系邮箱、DNS AccessKey ID / Secret | EAT 配置 Dokploy Traefik 的 DNS resolver，Traefik 自动签发和续期 |
| Cloudflare | 证书联系邮箱、目标区域的 API Token | 同上；Token 需要目标区域的 Zone Read 和 DNS Edit 权限 |
| 已有泛域名证书 | 从 Dokploy 中选择同服务器的证书 | EAT 检查域名、有效期和私钥匹配；证书更新由原有流程负责 |
| 已有 DNS 证书解析器 | 从目标服务器中选择已配置 DNS challenge 的 resolver | 复用已有凭证和自动续期流程，无需在 EAT 再填 DNS 凭证 |

DNS 凭证与 OSS 凭证独立。AliDNS 需要 `DescribeDomains`、`DescribeDomainRecords`、`AddDomainRecord`、`DeleteDomainRecord` 权限；启用时用随机 TXT 记录实测创建、读取和删除。默认由管理员在 DNS 控制台添加 `*.sites.example.com → Dokploy 入口` 的 A / AAAA / CNAME。选择 AliDNS 或 Cloudflare 时可勾选「自动添加解析」，EAT 仅在通配记录不存在时创建；发现不同的现有记录会报错，绝不覆盖。自动创建后最多等待两分钟解析生效，失败时清理本次新增记录。Cloudflare 应使用 DNS only，关闭代理。

流量走 Dokploy 已有的 Traefik，不为每个页面创建容器或申请证书。EAT 检查并复用正在运行的共享 Traefik；已安装但停止时自动请求启动并等待就绪。目标服务器需先完成 Dokploy 的标准初始化。EAT 写入单独的 `dynamic/eat-sites-<随机标识>.yml`，保留原始 Host，将所有路径交给 EAT 访问网关，包括资源、API 形状的路径与评论脚本。其他应用的配置不变。支持 Dokploy 标准生产 Traefik 布局（`/etc/dokploy/traefik/traefik.yml`、`dynamic` 文件 provider、`web`/`websecure` 入口）及本机/远程应用服务器；依赖配置读写、证书读取、Traefik 环境与重载 API 权限。

首次设置自动证书时，EAT 自动将凭证写入 Traefik 的运行配置并重载共享 Traefik，可能短暂影响同入口的其他应用；管理员无需手改 env。后续相同配置启用不会重复重载。如果其他 resolver 已使用同一 DNS 服务商的不同凭证，EAT 拒绝覆盖，提示复用已有 resolver。已有 HTTP challenge resolver 不能用于申请泛域名证书。

### 启用、停用与失败恢复

启用按「连接与内部地址 → 专用入口写入权限 → OSS → 证书/DNS 权限 → 通配 DNS → 配置路由 → HTTPS 实际访问」执行。最后一步最多五分钟，检查证书受信任、主机名匹配、剩余有效期超过七天，页面域名和平台域名都返回当前 EAT 实例的随机探针，并确认 HTTP 正确跳转 HTTPS。只有全部通过才开放发布和访问。

控制台逐项展示进度和失败原因。CLI、MCP、REST 与控制台共用能力开关；关闭或检查中不能绕过。启用失败撤下专用页面路由，保留诊断，可修正配置重试；如果入口清理失败，必须先点击停用重试清理，才能修改配置。证书文件、专用 ACME resolver 和续期凭证保留，便于恢复，不删除其他服务资源。

停用立即关闭 EAT 网关访问，再撤下专用路由，保留页面、OSS 文件、历史版本、评论和证书。修改配置需先停用。存在页面后不能改变域名后缀，存在 OSS 历史版本后不能切换 Bucket 或地域，防止历史链接和文件失效；访问凭证可以轮换。进程重启时会识别并标记中断任务，管理员清理后重试，多实例用 PostgreSQL 锁避免重复启停。

### 升级与访问边界

运行数据库迁移、构建并启动 EAT 后，在系统设置重新保存原有域名和 OSS Bucket，再检查启用。旧环境变量不会自动导入数据库。旧 OSS 文件与版本记录不变；过去的本地历史文件仍从持久卷 `./data/static-sites` 读取，若曾使用自定义本地目录，需先搬到此路径。新发布统一写入 OSS。

前置代理需允许至少 72 MiB 的 JSON 请求体；服务端仅发布路由放宽到 72 MiB，解码后的文件总量仍最多 50 MiB。所有页面响应使用 `private, no-store`，每次文件访问重新校验页面策略。前置 CDN 不得绕过鉴权缓存私有文件。访问模式、密码变更对全部历史版本生效；Service Worker 注册被阻止，避免离线缓存越过后续访问策略。

## 发布与版本

```bash
eat site create demo --name "项目演示"
eat site push demo ./dist -m "第一版"
eat site push demo ./site.zip -m "更新页面"
eat site versions demo
eat site activate demo <version-id>
```

控制台「资源 → 页面」提供创建、目录或 ZIP 上传、访问设置、分享链接和发布记录。详情页默认进入「评论」，「发布记录」用于预览历史内容与恢复发布，「设置」用于管理页面信息与访问方式；「发布更新」始终位于页头。CLI 目录上传跳过 `.git`、`node_modules`、`.env*`，并拒绝软链接；ZIP 根目录须包含 `index.html`，拒绝目录穿越和保留的 `__eat/` 路由。每次最多 2000 个文件、50 MiB。只上传构建好的产物，不执行构建命令。

固定入口 `https://demo.eat-sites.example` 每次访问会跳转到当时的当前版本，例如 `https://v3--demo.eat-sites.example`。版本域名固定，页面、绝对路径资源、多页导航与 SPA 路由都保留在同一快照内；已打开的版本不会因其他人发布而变化。重新访问固定入口可打开最新版本。

所有历史版本文件默认保留。发布先写入新快照，再在数据库事务内分配单调版本号并切换当前版本；并发发布不会产生重复版本号。上传失败不改变线上版本。回滚只修改当前版本指针，评论保持原样。保存的是 HTML/CSS/JS/图片等发布产物，不自动保存 React/Vue 源工程。

## 访问方式

| 模式 | 查看页面与评论 | 发表评论或回复 |
| --- | --- | --- |
| authenticated，默认 | EAT 登录用户 | EAT 登录用户 |
| public | 任何访问者 | 仍需 EAT 登录 |
| password | 正确密码或有效分享凭据 | EAT 登录且已通过页面访问校验 |

页面所有者与管理员可直接管理和访问自己管理的页面。其他登录用户仍需验证密码页面。登录访问通过 EAT 页签跳转，使用绑定页面域名、60 秒过期且只能消费一次的兑换码建立 HttpOnly 页面 Cookie，不把平台令牌交给页面脚本。平台原始 Token 吊销、到期或用户停用后，由它产生的页面登录会话和评论会话立即失效。

```bash
eat site update demo --access public
eat site update demo --access password --password '<访问密码>'
eat site share demo
eat site unlock demo '<访问密码>'
eat site comments demo --access-token '<返回的 accessToken>'
```

「复制链接」不带凭据，「复制免输密码链接」带随机签名访问凭据，打开后自动建立页面访问会话并从地址栏移除凭据。分享凭据有效期 90 天，只允许访问该页面，不代表分享者身份，也不能代其发表评论。修改密码或访问模式会使旧分享凭据、密码访问会话和评论访问凭据失效。

## 评论、批注与 @

HTML 访问时自动插入 `/__eat/embed.js`，显示轻量的圆形评论图标入口，不显示文字或版本号；当前路径有评论时，右上角显示一个小蓝点。蓝点表示已有评论，打开后再收起仍保留，最后一条评论删除后消失；不展示数字、不闪烁。悬停可查看操作提示，键盘聚焦有清晰边框，触屏保留至少 44px 点击区域。入口样式与页面样式隔离；面板的评论列表独立滚动，输入区固定在底部。评论表单位于平台源的 iframe 内；支持整页评论、点击元素、在元素内拖选区域，Esc 可取消选取。页面自带 CSP 时，应允许本站 `/__eat/embed.js` 与 EAT 平台 iframe；不兼容的 CSP 会阻止自动批注界面，评论仍可通过 EAT、CLI 和 MCP 操作。

控制台默认汇总页面全部评论，网页面板默认汇总当前页面的评论，更新发布后旧反馈仍可见。日常查看、评论、回复均无需选择版本；版本信息和原页面链接收在「评论上下文」中，需要时展开。「发布记录 → 相关评论」可按指定发布记录筛选，并可一键返回全部评论。

讨论串记录发起版本、页面标识和锚点；每条评论与回复记录实际浏览的版本。SDK 从所打开的不可变版本取得版本 ID，不在提交评论时读取当前版本指针。默认按 `pathname` 识别页面，hash 路由保留 `#/...` 或 `#!...`；不把访问凭据和其他查询参数写入页面标识。

锚点同时记录稳定的 `data-eat-id` / DOM ID、CSS 路径、文字与相邻文字；区域使用元素内的相对坐标。新版定位按稳定标识、经过文字校验的路径、唯一文字匹配依次尝试。无法确定时显示位置已变化，用户可打开评论原版本，不会把评论静默移动到别的元素。建议页面为重要元素设置稳定的 `data-eat-id`。

网页内登录评论使用弹窗取得仅限该页面的评论会话，适用于浏览器隔离第三方存储的场景。平台全局登录令牌始终留在平台源，不通过 `postMessage` 发送给页面。

```bash
eat site comments demo --page / --status open
eat site comment demo '这里需要调整' --version-id '<浏览版本 ID>' --page /
eat site mention-users demo
eat site comment demo '@张三 请查看新版' --version-id '<浏览版本 ID>' \
  --thread '<讨论 ID>' --mention '<用户 ID>'
eat site resolve demo '<讨论 ID>'
eat site resolve demo '<讨论 ID>' --reopen
eat site delete-comment demo '<评论或回复 ID>'
```

发起人、页面所有者、管理员可解决和重新打开讨论。版本更新、回复、回滚均不自动改变解决状态。评论正文不支持编辑。作者可删除自己的评论或回复，页面所有者和管理员可删除页面内任意评论。删除前需确认；删除会清除正文与提及并记录审计，不连带删除其他人的回复。有后续回复时保留“评论已删除”占位，整串都已删除时从列表隐藏。此操作无法恢复。

输入 `@` 可搜索并选择活跃用户。被提及用户配置过个人飞书 webhook（现有「求助」页的个人通知配置）时，复用签名、投递记录与最多五次退避重试。重复用户 ID 在一条评论内去重，自己 @ 自己不推送。通知为事件与讨论链接，不携带评论正文、密码或分享凭据；打开后仍校验页面访问权限。重试沿用现有进程内机制，进程在重试中途重启时不会自动恢复投递。

## MCP 与 API

本机 stdio MCP 和平台 HTTP MCP 都提供：`list_sites`、`create_site`、`update_site`、`publish_site`、`list_site_versions`、`activate_site_version`、`create_site_share_link`、`unlock_site`、`list_site_comments`、`create_site_comment`、`reply_site_comment`、`delete_site_comment`、`set_site_thread_status`、`list_site_mention_users`。

主要 REST 入口为 `/api/sites`、`/:slug/releases`、`/:slug/versions`、`/:slug/activate`、`/:slug/access`、`/:slug/share`、`/:slug/threads`、`/:slug/threads/:id/replies`；删除评论使用 `DELETE /api/sites/:slug/comments/:id`。密码页面可先调用 access 端点，再通过 `x-eat-site-access` 携带返回的访问凭据；它不代替发表评论所需的 EAT 身份。按版本筛选讨论使用发起版本，回复保留各自的浏览版本。

## 界面回归验证

先启动 Web 开发服务，再执行 `node scripts/test-site-ui.mjs`（默认地址 `http://127.0.0.1:5173`，可通过 `EAT_UI_URL` 修改）。脚本使用 Chromium 和 API 测试替身，不写入真实业务数据；覆盖详情页分区、草稿保留、提及、回复、解决状态、发布重试、历史筛选、权限、错误恢复，以及真实跨源 iframe 内的元素/区域标注、页面切换和手机布局。截图默认写入 `/tmp/eat-site-ui`，可通过 `EAT_UI_SHOTS` 修改；Chromium 路径可通过 `CHROMIUM_PATH` 指定。

## 本次验证范围

自动化覆盖系统配置加密与脱敏、默认关闭、成员权限、CLI/MCP 开关一致性、并发启停、OSS/DNS 权限探测、共享配置保留、失败回滚、停用与重启恢复；包含真实本地 HTTPS 服务对证书信任、主机名和 HTTP 跳转的检查。

浏览器验证使用真实 Traefik v3.6.7、PostgreSQL 和 EAT，验证控制台保存/启用/停用、HTTPS 精确探针、静态版本与资源、登录、密码分享、评论登录、元素/区域批注、@ 与跨版本回复，并检查桌面和手机布局。该场景的 Dokploy 控制 API、OSS 和 DNS 使用测试替身，后端信任仅限测试证书；不能替代真实账号的云服务验收。

本次未使用真实 OSS / AliDNS / Cloudflare 凭证申请公网证书。尝试启动完整 Dokploy v0.30.5 时，镜像解包受到测试环境磁盘限制，完整 Dokploy API 真机联调未完成；接口按其源码校对并通过 HTTP 模拟端点验证。生产启用会再次执行真实凭证和 HTTPS 检查，失败时保持能力关闭。
