# Folio 阿里云 CDN

管理员在「系统设置 → Folio 发布 → 阿里云 CDN」配置一次。成员继续按原方式发布、回滚、设置权限和发表评论。CDN 默认关闭；数据库只保留 CDN 配置与运行状态，不改旧 Folio 设置、域名、版本指针、DNS 或 Traefik 路由。

迁移 `0020_folio_cdn` 新增 CDN 状态表。已执行历史迁移 `0021_folio_cdn_purge` 的环境通过 `0022_folio_cdn_no_purge` 删除刷新触发器、函数及队列，丢弃尚未提交或等待重试的维护任务，保留 Folio 和 CDN 接入状态。历史迁移保持不变，全新安装与旧环境升级都运行完整迁移链。

## 首次准备与开启

1. 阿里云账号完成实名认证并开通 CDN。中国内地、全球范围需要域名具备有效 ICP 备案；`overseas` 表示全球但不含中国内地。服务开通、备案、额度及账单由账号所有者处理，EAT 不代为购买服务。
2. 按 [Folio 使用说明](folios.md) 先检查并启用 Folio，保证独立域名、私有 OSS、Traefik 的免费 ACME 泛域名证书和控制台 HTTPS 已可用。证书模式也支持已有证书和已有 DNS resolver，续期责任仍归原管理流程。
3. 准备下文 RAM 权限。独立 CDN AccessKey 与 OSS 凭证分离；选择「复用 AliDNS」必须明确勾选，后台仍实际调用 CDN API 检查权限。使用 Cloudflare DNS 时，CDN 仍使用独立阿里云 RAM 凭证。
4. 选择范围、凭证来源及是否自动管理 DNS，勾选启用后保存。AccessKey 留空保留旧值，Secret 只接受写入，不会读回。配置已保存不代表接入成功。后台每 30 秒检查可执行任务；正在处理云操作时保存可能返回冲突，稍后重试即可。
5. 自动管理复用 Folio 的 AliDNS / Cloudflare 凭证，验证 TXT 并迁移预期的直连通配记录。未授权自动管理时，控制台按阶段给出完整 TXT / CNAME 名称和值，手动完成后点击「重新检查 / 恢复」。验证使用注册主域名的 `verification` TXT，不是 `_acme-challenge`。TXT 与 ACME 的 DNS-01 是两个独立用途。
6. 只有 HTTPS 证书指纹、Host/SNI、实际缓存 HIT、携带会话访问旧缓存被拒绝以及切换后的访问检查全部通过，状态才变为「已接入」。缺少相关 CDN 功能、权限不足或规则仍在配置中时保留诊断，不跳过安全检查。

源站复用 Folio 的部署入口 IP / 主机名，端口固定 HTTPS 443，不使用容器内部 upstream 地址作为 CDN 公网源站。入口必须独立于 Folio 域名空间；推荐固定入口 IP 或直接指向该 IP 的独立源站域名。HTTP Host 保留真实固定 / 版本 Folio 域名；TLS SNI 使用同一泛域名证书覆盖的实例专用精确名称 `eat-origin-<实例标识前八位>.<Folio 后缀>`。连接地址仍是独立源站，不需要把该 SNI 名称解析到 CDN。开启回源证书校验，不配置跳过校验或 Common Name 宽泛白名单。

EAT 控制台地址承担 `/api/sites/cdn-auth` 鉴权接口，必须独立可达，不能再次回到 Folio CDN。该接口固定返回 `private, no-store`，每次查询 PostgreSQL，不缓存允许结果。已有控制台代理也必须保留它的 no-store。

## 最小权限

下面使用保留示例域名。替换账号 ID、Folio 域名和实际 DNS 区域；不要将真实凭证提交到仓库。CDN 动作集对应实现实际调用，不需要 `AliyunCDNFullAccess`、购买证书、删除 CDN 域名、修改其他应用或公开 OSS Bucket 的权限。

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
        "cdn:DescribeCdnDomainConfigs", "cdn:BatchSetCdnDomainConfig",
        "cdn:SetCdnDomainSSLCertificate", "cdn:StartCdnDomain", "cdn:StopCdnDomain"
      ],
      "Resource": "acs:cdn:*:1234567890123456:domain/.sites.example.com"
    }
  ]
}
```

API 中泛域名写作 `.sites.example.com`（前导点），证书 SAN 写作 `*.sites.example.com`，二者不能混用。前一组账号级接口不支持按 CDN 域名资源授权。EAT 不调用缓存刷新 API，已有 RAM 策略可移除 `cdn:RefreshObjectCaches` 权限及仅为刷新具体 Folio / 版本主机添加的资源范围。[CDN RAM 操作与资源参考](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-ram)。

AliDNS 现有 Folio / Traefik DNS-01 使用下列权限；自动迁移 CDN 解析还需要 `UpdateDomainRecord`。`DescribeDomains` 为账号级，其余限制到相应 DNS 区域。主域名与独立委派子域名分属不同区域时，需要涵盖证书挑战和 `verification` 所在的实际区域。

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

关闭自动管理 DNS 可从 **EAT DNS 自动迁移** 权限中去掉 `UpdateDomainRecord`；Traefik 自动证书仍需要 TXT 的读取、新增、删除权限。若完全使用外部证书 / resolver 且手动管理 TXT/CNAME，EAT 本身无需 DNS 凭证。Cloudflare Token 需要对应区域的 **Zone Read + DNS Edit**，记录使用 DNS only；不会开通或复用 Cloudflare 代理。DNS API 权限参考：[DescribeDomainRecords](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-describedomainrecords)、[UpdateDomainRecord](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-updatedomainrecord)。

## 四种关键操作的资源与状态

| 操作 | 资源变化 | 状态与安全边界 |
| --- | --- | --- |
| 开启 | 验证 TXT；创建带 `eat-instance=<resourceKey>` 标签的泛域名 CDN；上传源站证书；配置固定 SNI、回源密钥、鉴权及缓存；验证后迁移通配 DNS | checking → provisioning → verifying → enabled。手动 DNS 阶段为 awaiting_dns；故障为 failed，外部变更为 conflict。只有实际检查通过后 `connected=true` |
| 关闭 | 恢复并验证原始 A/AAAA/CNAME 与 TTL；保留 CDN 在线及证书至少 24 小时或原 TTL 的两倍（较大者）；再次检查源站后停止带本实例标签的 CDN | enabled=false 表示停止发出新缓存重定向。draining 期间旧节点继续鉴权；确认 CDN 实际 offline 后才 disabled。Folio 服务、源站证书、OSS、版本及评论保留 |
| 续期 | Traefik 执行 DNS-01 签发 / 续期并写 ACME 存储；EAT 读取匹配证书、核对 SAN/有效期/私钥，指纹变化后重新上传 CDN，并验证边缘证书指纹 | 源站证书检查时间 / 到期时间、CDN 实际验证时间和同步错误独立记录。正常每小时检查；失败持久化退避重试，退出等待期仍维护证书。21 天内到期在控制台提醒；不发送外部通知 |
| 权限变更 | 数据库提交访问策略及 `accessRevision`，不调用 CDN API | 下一次缓存命中前实时检查最新策略。旧缓存路径包含旧修订号，立即被拒绝；旧在途回源完成也不能重新授权。所有历史版本同样受限 |

`SiteCdnService` 与 Folio 启停共用 PostgreSQL 会话 advisory lock，配置保存使用同一锁的事务版本及设置行锁。云 API/DNS 操作前写归属、预期值及原始解析；进程重启会继续对账。创建超时可通过标签重新认领；DNS 修改使用原记录 ID，按前后状态恢复；后台失败从 30 秒起退避，最长一小时，管理员可立即重新检查。后台定时器停止后不再创建新任务，正常关闭等待当前任务结束。

CDN 域名已有但没有本实例标签时，不接管、不删除。DNS 类型、值、记录 ID、TTL 或 CDN 配置（包括规则绑定条件）与记录不符时暂停覆盖。自动 DNS 只支持单条预期的直连通配记录；多条、代理、分线路或暂停记录应先人工整理。精确 Folio 域名记录优先于通配记录。自动模式从数据库中的现有 Folio 及历史版本生成允许名单，逐条检查；仅迁移预期的单条直连记录，并保存原值与扫描进度，关闭时恢复。其他应用的精确记录不会被枚举或修改。手动模式需按 CNAME 指引核对这些精确记录。已有 CDN 资源的加速区域不支持在线变更。凭证轮换必须先用新凭证验证同一资源的归属，否则保留旧凭证。

首次 DNS 切换后实际访问失败时，自动管理模式尝试恢复原始解析并保留 CDN，恢复失败单独提示。手动模式显示原站解析指引，不擅自写 DNS。外部冲突需要先核对并恢复原记录 / 原规则，再点击恢复；“恢复”不会强制认领外部改动。停止 CDN 后仍保留带标签的域名配置，便于再次开启，不自动删除云资源。

传播等待时间是对遵守 DNS TTL 的客户端的保护，不是对所有不遵守 TTL 的递归解析器的全网保证。等待期间浏览器曾收到的缓存资源路径也可在源站直接访问，但源站每次重新鉴权且返回 no-store。

## 缓存与访问权限

缓存范围是 **匿名公开静态资源**：CSS、JS/MJS、图片及字体，且 MIME 必须匹配允许的静态类型。HTML（含评论配置与访问证明）、任意查询参数、Cookie、Authorization、Service Worker、登录跳转、解锁、分享凭据兑换、评论及管理接口不进入共享缓存。公开资源带 `?v=...` 等参数或文件名含百分号字面量时保留原有访问，使用 no-store；不会忽略参数后错误合并缓存。

匿名原始资源请求经已验证 CDN 回源时，网关临时重定向到同 Host 的 `/__eat/cdn/<Folio ID>/<版本 ID>/<访问修订号>/<文件路径>`。缓存键保留真实 Host 和完整路径；版本清单不可变，因此不同 Folio、固定 / 历史版本和删除后重建的同名 Folio不会复用身份。CSS 相对资源地址仍保留目录层次。固定主机的缓存路径必须与当前版本一致；历史版本主机必须与指定版本一致。

源站仅在 CDN 规则成功、接入已验证、请求不带会话或凭据时，向 CDN 返回可共享的静态响应。CDN 出站统一改回 `private, no-store`，浏览器不保留离线副本；不覆盖源站的 no-store 来强制缓存。直接访问源站的同一资源路径仍返回 no-store。带会话的访问使用原始路径回源；不能把匿名缓存 URL 当作访问凭据或长期公共下载地址。

远程鉴权使用官方 `cdn_remote_auth`：全部类型、请求透传原 Host/URI/方法及 Cookie/Authorization，成功仅允许 200，其他状态和超时均 reject。鉴权接口不在 Folio CDN 内，允许结果不缓存。对正常非缓存路径放行到原网关继续完整鉴权；缓存路径只允许仍为 public、修订号及版本匹配的匿名 GET/HEAD。编码分隔符、点路径等可能产生缓存别名的请求也被拒绝。

权限收紧不修改 CDN 规则，因此不存在“新权限等待边缘规则传播”的窗口。初次接入要求全部规则 `Status=success`、域名 online，并用真实请求检查缓存 HIT 和在相同旧缓存 URL 上携带会话被拒绝；这些检查完成前不开放 Folio 内容缓存。缓存回源读完 OSS 后还会复查一次权限；即使更早的在途结果仍被填入缓存，后续请求仍须通过当前数据库鉴权。

公开静态资源的 CDN 有效期为 **30 天（2592000 秒）**，缓存规则和源站公开响应使用同一时长；浏览器仍收到 `private, no-store`。发布、回滚、权限变化、SPA 变化及删除均不主动刷新 CDN，没有刷新队列、数据库触发器、刷新调用或刷新重试；接入、DNS 与证书维护的后台检查和重试继续运行。

发布新版后，固定域名解析当前版本指针并生成新版本 ID 的资源路径；旧版本路径在固定域名下被实时鉴权拒绝。显式历史版本域名可继续命中对应的旧缓存，回滚也可复用仍有效的目标版本缓存，均受最新访问策略约束。权限收紧或删除后，即使旧字节仍留在 CDN，后续请求也无法通过实时鉴权获取；不等待 TTL 到期或云 API 传播。仍允许访问的内容过期后按需重新回源，实际缓存空间回收由 CDN 管理，不保证字节即时物理删除。

## 官方能力依据与实际验收边界

本次环境没有可调用的 ctx7 工具 / CLI，按要求回退到当前产品官方文档。实现依据：

- [API 概览](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-overview/) 与 [域名功能参数](https://help.aliyun.com/zh/cdn/developer-reference/parameters-for-configuring-features-for-domain-names)：`cdn_remote_auth`、`forward_scheme`、`https_origin_sni`、`origin_certificate_verification`、`origin_request_header`、`path_based_ttl_set`、`self_defined_cachekey`、`set_resp_header`。
- [远程鉴权](https://help.aliyun.com/zh/cdn/user-guide/configure-remote-authentication)：每次请求先鉴权，再访问缓存；异常默认可能放行，故显式配置 reject。最多 3000ms，故障时缓存路径也拒绝访问，不使用陈旧允许结果。[规则引擎](https://help.aliyun.com/zh/cdn/user-guide/rules-engine) 不支持按条件绑定远程鉴权，因此在 EAT 内区分正常路径和缓存路径。
- [添加域名](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-addcdndomain)：泛域名为前导点，创建及配置下发是异步的。[查询配置](https://help.aliyun.com/zh/cdn/developer-reference/api-cdn-2018-05-10-describecdndomainconfigs) 提供 success / configuring / failed 状态；HTTP API 成功不能代替下发完成。
- [HTTPS 配置](https://help.aliyun.com/zh/cdn/user-guide/configure-an-ssl-certificate/) 与 [泛域名证书限制](https://help.aliyun.com/zh/cdn/support/configure-an-ssl-certificate-for-a-wildcard-domain-name)：CDN 控制台免费证书不支持泛域名，因此上传现有 Traefik / Let's Encrypt 证书，不调用 CDN 免费证书申请，也不购买证书。[Let's Encrypt FAQ](https://letsencrypt.org/docs/faq/) 明确泛域名需 DNS-01；[Traefik ACME](https://doc.traefik.io/traefik/v3.5/reference/install-configuration/tls/certificate-resolvers/acme/) 负责存储与续期。

`origin_certificate_verification` 的官方参数表使用 `enabled`，同页示例使用 `enable`，二者有文档不一致。当前按参数表发送 `enabled`，实际账号若拒绝该参数会停留失败，不会切 DNS；必须纳入真实云验收。已有 resolver 的 ACME 文件目前要求标准 `/etc/dokploy/traefik/` 范围内的 JSON 路径，其他路径会明确拒绝。ACME JSON 仅读取目标 resolver 下匹配 SAN 的证书，不写入账户私钥，也不修改 ACME 存储。

本地测试使用真实 PostgreSQL、测试证书、可注入云/DNS/链路替身和浏览器 API 替身。真实账号验证了 CDN 服务、域名验证接口及隔离 DNS 记录的创建、读取、更新、切换、恢复与删除，测试记录已清理；未创建 CDN、签发公网证书、切换实际 Folio 解析或验证公网 HIT。替身测试不能证明该账号的泛域名功能组合、配额、全网规则下发、所有加速区域、TLS 回源和跨运营商 DNS 传播均已通过。

首次真实云验收需在隔离域名和可公网访问的 EAT/Traefik 上执行完整开启 → 两次静态资源访问观察 HIT → 权限收紧 / 会话撤销 / 删除后旧缓存拒绝 → 测试证书更新并核对指纹 → 关闭并跨 TTL 检查。控制面保存、配置状态成功与抽样访问均不是供应商提供的全网原子性证明；本实现依赖供应商成功状态及已部署远程鉴权的契约，公网跨节点传播仍需实测。没有确认安全功能时应保持 CDN 未接入，不能用全部关闭缓存宣称缓存加速已完成。

免费指 ACME 证书签发不收证书费；CDN 流量、HTTPS 请求（含被拒绝的请求）、可能的资源包及超额费用仍按阿里云账单计费。鉴权请求增加 EAT 请求量与可用性依赖。额度、备案、产品功能授权、计费方式和余额需在云账号首次配置及验收时确认。

## 本次开发验证记录（2026-10-17）

| 验证 | 结果与范围 |
| --- | --- |
| `pnpm test` | 合并 main 最新 Folio 更新后，服务端 361 项、CLI 222 项通过；Web 使用下列浏览器脚本另行验证 |
| CDN / 网关回归（包含于全量测试） | 33 项通过，覆盖 30 天 TTL、无主动刷新时的版本隔离 / 历史缓存命中 / 权限收紧 / 删除、签名、证书读取、缓存别名、重启和 DNS 恢复 |
| `pnpm typecheck`、`pnpm build` | 最终变更全工作区通过 |
| `pnpm db:migrate` | 在独立本地 PostgreSQL 测试库执行两次均成功；另有旧配置升级保持不变、已有刷新任务和触发器清除且 Folio / CDN 状态保留的真实迁移测试 |
| `node scripts/test-folio-cdn-ui.mjs` | 浏览器 API 替身；桌面及手机配置、等待、失败恢复、DNS 指引、密钥输入清空、无横向溢出通过 |
| `node scripts/test-site-ui.mjs` | 原 Folio 发布、上传恢复、评论、登录/密码提示、删除及手机布局回归通过 |
| 真实云 API 与隔离 DNS | 生产适配器验证 CDN 服务及域名验证接口；AliDNS 随机测试记录的 TXT 创建 / 读取 / 更新 / TTL 恢复 / 删除、A → CNAME → A 切换及记录 ID 保持通过。全部临时记录已清理，未创建 CDN |
| 仓库隐私检查 | 检查全部改动及新增文件，没有发现真实 AccessKey、Secret 或个人域名 |

公网测试因缺少隔离公网部署入口及环境网络访问条件，按要求暂缓。尚未完成公网 CDN 接入、真实 ACME 续期、证书全网下发、跨节点权限竞态、多区域及跨运营商 DNS 传播验收。当前结果不能替代这些真实云服务验收。生产部署及生产 DNS 变更未执行。
