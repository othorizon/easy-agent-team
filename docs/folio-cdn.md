# Folio 阿里云 CDN

管理员在「系统设置 → Folio 发布 → 阿里云 CDN」配置一次后，成员继续按原方式发布、回滚、设置密码和发表评论。CDN 默认关闭；升级不会自动修改现有 Folio 的访问、DNS 或 Traefik 路由。配置意愿、实际接入、证书同步和缓存刷新状态分别展示，保存成功不表示已接入。

本方案以缓存体验为优先：公开和密码 Folio 的 CSS、JS、图片、字体缓存 30 天；HTML 保留入口鉴权，改密码、改权限和删除时异步清理 CDN。不使用缓存命中前远程鉴权、自定义回源请求头或出站响应头改写。密码用于页面入口，已缓存静态文件的链接可能直接访问；刷新有延迟，浏览器已有副本无法撤回。

## 首次准备

1. 阿里云账号完成实名认证并开通 CDN。选择中国内地或全球范围时，域名需要有效 ICP 备案；`overseas` 为全球但不含中国内地。服务开通、备案、计费与额度由账号所有者处理，EAT 不代为购买服务。
2. 按 [Folio 使用说明](folios.md) 先启用 Folio，确认私有 OSS、独立部署入口和 Traefik HTTPS 正常。CDN 源站必须是公网可达、独立于 Folio 域名的 IP 或主机名，避免切换 DNS 后循环回源。
3. 准备下文 RAM 权限。可使用独立 CDN AccessKey，或明确选择复用现有 AliDNS AccessKey；复用后也要具有 CDN 权限。Cloudflare DNS 使用自己的 Token，CDN 仍使用独立阿里云 RAM 凭证。
4. 选择加速区域、凭证来源和自动 DNS，勾选启用后保存。凭证加密存储、AccessKey 脱敏显示、Secret 不读回，留空保留原值。管理员 API 校验权限并记录不含凭证的审计。
5. 自动 DNS 复用 Folio 的 AliDNS / Cloudflare 凭证，完成 TXT 验证并迁移预期的直连通配记录。关闭自动 DNS 时，按控制台每阶段的 TXT / CNAME 指引手动配置，再点击「重新检查 / 恢复」。TXT 使用注册主域名的 `verification`，与 ACME 的 `_acme-challenge` 用途不同。
6. 后台验证源站 HTTPS、实际 Folio Host、SNI、实例标记、CDN 边缘证书和静态资源 HIT 后，才切 DNS 并检查实际访问。失败保留诊断与恢复入口，不能提前切 DNS 绕过检查。

源站端口为 HTTPS 443，不是容器内部 upstream 地址。HTTP Host 保留用户实际访问的固定或历史版本 Folio 域名；TLS SNI 使用源站泛域名证书覆盖的精确名称 `eat-origin-<实例标识前八位>.<Folio 后缀>`。连接地址仍为独立源站，该 SNI 名称无需指向 CDN。始终校验源站证书，不改 HTTP 回源，不跳过证书校验。

Folio 网关目前是 EAT 服务内的模块，Traefik 将 Folio 域名请求转发给该模块，不经过控制台前端。CDN 缓存命中时不访问 EAT；未命中、HTML 和动态接口回源。控制台域名不需要作为每次 CDN 访问的鉴权回调地址。

## 最小 RAM / DNS 权限

以下均为保留示例。替换账号 ID 和实际 Folio / DNS 域名，不提交真实凭证。无需 `AliyunCDNFullAccess`、购买证书、删除 CDN 域名或公开 OSS Bucket。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cdn:DescribeCdnService", "cdn:DescribeVerifyContent", "cdn:VerifyDomainOwner"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cdn:AddCdnDomain", "cdn:DescribeCdnDomainDetail", "cdn:ListTagResources",
        "cdn:DescribeCdnDomainConfigs", "cdn:BatchSetCdnDomainConfig", "cdn:DeleteSpecificConfig",
        "cdn:SetCdnDomainSSLCertificate", "cdn:StartCdnDomain", "cdn:StopCdnDomain"
      ],
      "Resource": "acs:cdn:*:1234567890123456:domain/.sites.example.com"
    },
    {
      "Effect": "Allow",
      "Action": ["cdn:RefreshObjectCaches", "cdn:DescribeRefreshTasks"],
      "Resource": [
        "acs:cdn:*:1234567890123456:domain/.sites.example.com",
        "acs:cdn:*:1234567890123456:domain/*.sites.example.com"
      ]
    }
  ]
}
```

CDN API 的泛域名写作 `.sites.example.com`，证书 SAN 为 `*.sites.example.com`。刷新提交具体 Folio / 版本主机 URL，RAM 中相应后缀范围仅用于刷新和查询；其他配置操作仍限制到本实例的泛域名资源。`DeleteSpecificConfig` 用于删除旧版 EAT 创建的三个规则，不能省略后用全量覆盖代替。服务和域名配置权限会在实际接入调用中验证；刷新权限在刷新任务执行时验证，权限不足会显示失败及重试，不能仅凭服务查询成功认定全部写权限可用。参见 [CDN RAM 参考](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-ram)、[刷新 API](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-refreshobjectcaches) 和 [任务查询](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-describerefreshtasks)。

AliDNS 自动 DNS / Traefik DNS-01 所需权限如下。`DescribeDomains` 为账号级，其余限定到对应 DNS 区域。独立委派子域名与注册主域名属于不同区域时，需要覆盖验证 TXT 和 ACME 挑战所在的区域。

```json
{
  "Version": "1",
  "Statement": [
    {"Effect": "Allow", "Action": ["alidns:DescribeDomains"], "Resource": "*"},
    {
      "Effect": "Allow",
      "Action": [
        "alidns:DescribeDomainRecords", "alidns:AddDomainRecord",
        "alidns:DeleteDomainRecord", "alidns:UpdateDomainRecord"
      ],
      "Resource": "acs:alidns::1234567890123456:domain/example.com"
    }
  ]
}
```

关闭自动 DNS 可从 EAT 的解析迁移权限中去掉 `UpdateDomainRecord`，Traefik DNS-01 仍需 TXT 读取、新增和删除权限。完全使用外部证书 / resolver 且手动管理 TXT/CNAME 时，EAT 无需 DNS 凭证。Cloudflare Token 需要对应区域的 **Zone Read + DNS Edit**，使用 DNS only，不启用 Cloudflare 代理。参考 [AliDNS 读取](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-describedomainrecords) 与 [修改记录](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-updatedomainrecord)。

## 开启、关闭、续期与权限变更

| 操作 | 资源与状态 |
| --- | --- |
| 开启 | 验证 TXT；创建或复用带 `eat-instance` 本实例标签的泛域名 CDN；上传源站证书；配置 HTTPS、SNI 和源站优先的缓存策略；验证链路后迁移通配及已知精确 DNS。checking → provisioning → verifying → enabled，实际检查成功后 connected=true |
| 关闭 | 先恢复原始 A/AAAA/CNAME 与 TTL 并验证源站；保留 CDN 在线至少 24 小时或原 TTL 两倍的较大者；继续维护证书，传播等待后再停用本实例 CDN。Folio、源站证书、OSS、版本和评论保留 |
| 续期 | Traefik ACME 是唯一的自动签发 / 续期方；EAT 只读取匹配证书，指纹变化时上传 CDN，再检查边缘指纹。源站检查时间 / 到期时间、CDN 同步时间和错误分别记录；通常每小时检查，失败持续退避重试，21 天内到期在控制台提醒 |
| 改密码 / 改权限 / 删除 | 数据库策略变更与刷新任务同一事务提交；删除前保存固定及全部历史版本域名的目录快照。后台提交强制目录刷新，查询完成状态；旧缓存允许持续到刷新生效，浏览器副本不撤回 |

已有 resolver 的 ACME 存储路径目前须为 `/etc/dokploy/traefik/` 范围内的 JSON 文件；EAT 只读目标 resolver 中匹配 SAN 的证书，不写 ACME 账户私钥。外部证书 / resolver 延续原有续期责任。

CDN 和 Folio 启停共用 PostgreSQL 会话 advisory lock；配置保存使用同一锁的事务版本和设置行锁。多实例只由持锁者处理云端任务，进程重启从数据库继续。云 API / DNS 操作前保存归属、原值和预期值；创建超时按标签认领，DNS 使用原记录 ID 恢复。失败从 30 秒起退避，最长一小时；管理员可立即重新检查。刷新失败独立显示，不把已接入 CDN 错报为未接入。

只管理本实例明确拥有的资源。CDN 标签不符、未知内容规则、绑定条件或 DNS 的 ID / 类型 / 值 / TTL 不符时暂停覆盖。自动 DNS 仅迁移预期的单条直连记录；多条、代理、分线路及暂停记录需先人工整理。精确域名优先于通配记录，EAT 只扫描数据库已知的固定及历史版本域名，记录原值与进度，不修改其他应用记录。已有 CDN 资源不支持直接变更区域；轮换凭证需先确认同一资源的归属，否则保留原凭证。

首次切换后访问失败，自动 DNS 模式尝试恢复原解析并保留 CDN，恢复失败单独提示；手动模式给出源站解析指引。关闭不会删除 CDN 配置，便于以后复用。DNS 传播等待保护遵守 TTL 的解析器，不承诺所有异常缓存同时更新。

阿里云的服务默认 TLS、IPv6、调度等无条件规则保留原样。内容规则按参数和条件计算指纹，`ParentId=0`、省略和 `-1` 视作无条件。旧版 EAT 的远程鉴权、自定义回源头及出站缓存头规则仅在归属、指纹和参数完全匹配时按 ConfigId 删除；先写迁移日志，删除响应丢失或重启后继续检查，不重建域名。旧鉴权回调只保留作规则传播期间兼容，新配置不调用它。

## 缓存行为

- **公开 / 密码 Folio 的静态文件**：允许的 CSS、JS/MJS、图片和字体，扩展名及 MIME 都匹配，响应为 `public, max-age=2592000`。允许携带 Cookie 的文件响应缓存，文件内容不按用户个性化。首次回源仍检查页面策略，密码模式需有效会话；缓存 HIT 不检查会话，链接持有者可能直接读取。
- **HTML、登录、解锁、分享凭据兑换、评论和管理接口**：`private, no-store`。HTML 包含访问证明和页面配置，始终回源；带 `Set-Cookie` 的响应不标记公共缓存。需要 EAT 登录的 Folio 保留原有私有响应语义，不纳入本次密码缓存放宽。
- **查询参数与特殊请求**：含任意查询参数的原始资源保持 no-store，不忽略参数后合并；缓存路径带参数直接拒绝。Service Worker 请求不缓存，注册仍被阻止。文件名含百分号字面量时保留原始私有响应。
- **缓存隔离**：原始资源通过不缓存的临时跳转，进入同 Host 的 `/__eat/cdn/<Folio ID>/<版本 ID>/<访问修订号>/<文件路径>`。Host、版本、修订号和文件路径隔离；固定域名提供当前版本，显式历史版本域名固定对应快照，删除后重建同名 Folio 也不会串缓存。
- **发布与回滚**：HTML 读取最新版本指针并产生对应版本的文件地址，不刷新 CDN。历史版本缓存可继续复用，回滚可命中之前的缓存；旧的已缓存文件链接允许继续访问。
- **改密码、改权限和删除**：源站立即使用最新策略，旧会话及旧修订地址失效；CDN 对旧缓存的清理由后台异步完成。不会通过每次 HIT 鉴权或规则传播实现即时撤销，不承诺浏览器缓存、在途响应或缓存重新填充的原子撤销。源站读取 OSS 后再次检查修订，减少过时填充，但不将其当作严格全网保证。

CDN 开启「优先遵循源站缓存策略」，不启用「忽略源站不缓存标头」，也不把 HTML / 错误 / 会话响应强制缓存。直连源站的合格静态响应也可被浏览器缓存，无需判断请求是否来自 CDN。新文件重定向只在实际接入验证完成后启用；关闭后停止产生新缓存地址，既有地址仍可回源并检查访问策略。

刷新使用 `RefreshObjectCaches(ObjectType=Directory, Force=true)`，按具体主机和该 Folio 的目录提交，不使用泛域名 URL，不清理其他 Folio。最多十个目录一批，重复目标合并后提交；收到任务 ID 后持久化并用 `DescribeRefreshTasks` 查询，只有 Complete 才显示完成。网络查询失败保留任务 ID，云端明确失败或超出查询窗口才重新提交。重复提交是幂等的缓存清理，不会改变 DNS 或版本。

官方刷新通常约 5～6 分钟生效，并非请求提交即完成。默认每账号每天 10000 条 URL / 100 个目录刷新，历史版本域名也消耗目录额度；合并请求不增加额度。额度不足会保留任务、显示原因并退避重试，需要时由账号所有者申请提高配额。控制台显示待处理目录数、最近完成时间、失败原因和下次检查；「重新检查 / 恢复」同时唤醒刷新重试。后续处理时清理超过七天的完成记录。

## 数据库迁移与升级

历史 `0020`～`0022` 保持不变。新增 `0023_folio_cdn_origin_cache` 建立精简的持久化刷新队列及事务触发器，仅在访问策略 / 修订变化或删除时入队，发布和回滚不入队。从未接入且关闭时不产生任务；已管理的 CDN 停用期间仍记录变更，重新开启后处理，避免复用旧缓存。队列不关联 Folio 外键，删除后仍可清理快照中的缓存；升级本身不产生云操作或修改 Folio / CDN 配置意愿。

先执行 `pnpm db:migrate` 再启动新服务。已有 CDN 点击「重新检查 / 恢复」会迁移旧规则；不要手动删掉归属标签或覆盖规则来绕过冲突。证书上传与边缘验证分别记录，尚未验证时显示「已上传，等待边缘验证」，不会误报为同步成功。

## 链路诊断

CNAME 是阿里云分配的解析目标；在自己的 DNS 区域配置 `*.sites.example.com CNAME <分配的完整目标>`，通常无需创建名为 `all` 的记录。接入检查先直接连接该目标的地址并保留 Folio Host / SNI，不依赖通配 DNS 已切换。每次探测建立独立 HTTPS 连接，避免连接池复用到错误目标。

502 应检查 HTTPS 回源、Host / SNI、完整证书链、443 监听、安全组 / 防火墙及源站日志，简化鉴权不会自动修复这些问题。404 且无 Via / EagleId 节点标记时，先核对实际连接地址和完整 CNAME；HTTP 200 也需核对实例标记。错误只展示阶段及安全分类，不回显上游正文、任意错误头或凭证。

部署服务器可执行只读诊断：

```sh
curl --connect-to '<Folio 探测主机>:443:<CDN CNAME>:443' -D - -o /dev/null \
  'https://<Folio 探测主机>/__eat/cdn-probe/<完整实例标识>'
```

探测主机为 `eat-cdn-<实例标识前八位>.<Folio 后缀>`，完整实例标识对应 `eat-instance` 标签。保留 TLS 校验，不携带密钥、不修改 DNS；不存在 Folio 的首页不能代替探测路径。

## 官方依据与验收边界

当前环境无可调用的 ctx7，按要求使用产品官方文档：

- [缓存时间与源站响应头](https://help.aliyun.com/zh/cdn/user-guide/configure-the-cdn-cache-expiration-time)：支持源站策略优先、no-store 和 30 天缓存；30 天为 TTL，不保证冷门文件一定驻留满 30 天。
- [泛域名刷新限制](https://help.aliyun.com/zh/cdn/user-guide/refresh-and-warm-up-related-faq)、[强制刷新 API](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-refreshobjectcaches)、[刷新状态查询](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-describerefreshtasks)：具体主机、配额、Force 和异步完成状态。
- [HTTPS](https://help.aliyun.com/zh/cdn/user-guide/configure-an-ssl-certificate/)、[回源 SNI](https://help.aliyun.com/zh/cdn/user-guide/configure-sni)、[回源 Host](https://help.aliyun.com/zh/cdn/user-guide/configure-the-default-origin-host)：使用上传证书、精确 SNI 和实际访问 Host，需与源站虚拟主机配置匹配。
- [Let's Encrypt FAQ](https://letsencrypt.org/docs/faq/) 与 [Traefik ACME](https://doc.traefik.io/traefik/v3.5/reference/install-configuration/tls/certificate-resolvers/acme/)：泛域名使用 DNS-01，Traefik 独立签发、存储及续期。外部证书 / resolver 延续原维护责任，EAT 不另起签发流程。
- [回源请求头限制](https://help.aliyun.com/zh/cdn/user-guide/configure-custom-request-headers/) 与 [出站响应头限制](https://help.aliyun.com/zh/cdn/user-guide/create-a-custom-http-response-header)：泛域名不支持，当前方案已不依赖；[删除指定配置](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-deletespecificconfig) 用于迁移旧规则。
- [域名功能 API 参数](https://help.aliyun.com/zh/cdn/developer-reference/parameters-for-configuring-features-for-domain-names)：回源证书校验优先使用示例 `enable=on`，仅遇明确不支持时尝试表格的 `enabled=on` 并记录，不关闭校验。配置逐功能按每秒不超过三次节流，中断后仅补缺失项。

证书签发免费不等于 CDN 免费。CDN 流量、HTTPS 请求及资源包 / 超额费用按阿里云账单计费。

本地验证使用隔离 PostgreSQL、云 / DNS / CDN 链路替身和浏览器 API 替身，不能代替真实公网验收。生产部署、生产 DNS 变更及完整真实云测试没有随代码交付执行。此前服务 / 域名验证 API 及隔离 AliDNS 记录 CRUD / 切换 / 恢复测试不能证明 CDN 回源或缓存 HIT 成功。

首次真实验收仍需隔离公网 EAT / Traefik 和测试域名：开启与 DNS 切换、Host / SNI / 边缘证书、公开及密码文件 MISS → HIT、HTML 每次入口验证、改密码后的旧会话失效与 CDN 异步刷新、删除与历史域名清理、证书更新 / 同步重试、关闭跨 TTL 检查，以及多区域实际访问。既有 502 的线上根因仍需部署端链路诊断，不能宣称已因代码调整自动解决。

## 本次验证记录（2026-10-17）

| 验证 | 实际结果 |
| --- | --- |
| 服务端全量测试 | 398 项通过；覆盖原有登录、密码、分享、历史版本、发布、回滚和评论流程 |
| CLI 全量测试 | 222 项通过 |
| CDN / 网关针对性测试 | 70 项通过（包含于服务端测试），使用云 / DNS / 缓存链路替身；覆盖密码资源 HIT、刷新前允许旧缓存、完成后拒绝旧修订、删除及历史域名清理、查询失败保留任务、重启恢复、多实例锁、停用后重新开启、旧规则迁移与外部冲突 |
| 类型检查、构建 | 全工作区通过；构建仍有既有前端大包提示 |
| 数据库迁移 | 在隔离本地 PostgreSQL 执行 `pnpm db:migrate` 两次成功；真实升级测试确认旧设置不变、触发器与权限事务一起回滚、删除快照保留、发布不入队；生成的 Drizzle 快照仅新增刷新队列 |
| CDN 控制台浏览器验证 | `node scripts/test-folio-cdn-ui.mjs` 通过；隔离 API 替身，桌面和手机配置、接入阶段、DNS 指引、证书上传 / 同步区分、刷新进度 / 失败 / 恢复、密钥清空、布局无横向溢出 |
| 原 Folio 浏览器回归 | `node scripts/test-site-ui.mjs` 通过；发布、上传恢复、评论、登录 / 密码提示、历史版本及手机布局 |
| 隐私检查 | 改动和新增文件未发现真实云凭证、个人域名、源站 IP 或实例标识 |
| 真实云公网验收 | 本次未执行，按要求暂缓；未部署生产、未修改生产 DNS，既有线上 502 仍需实际链路验证 |
