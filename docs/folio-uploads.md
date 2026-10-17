# Folio 上传协议与运维

本版本交付代码和增量 SQL；不执行生产迁移、部署或真实数据清理。CLI 分发版本为 0.8.0，平台指南为 34。以 `docs/folios.md` 为用户入口。

## 状态与提交

每个 Folio 是独立去重/权限/删除边界。对象布局：

- `sites/<siteId>/staging/<uploadId>/<sha256>`：客户端短期 PUT 签名，只能写这一对象。
- `sites/<siteId>/snapshots/<随机 UUID>`：服务端独占快照，从不向客户端签发写权限。
- `sites/<siteId>/blobs/<sha256>`：服务端验证后写入，禁止覆盖。

`site_upload` 持久化完整目标清单、发布者、唯一 requestId、状态、24 小时有效期、签名截止时间、验证租约和最终返回结果。`site_blob` 记录验证过的 hash/size。版本只支持显式 `blobs-v1` 标记，保存完整 path → hash/size/type 清单，每条 hash 为必填。清单没有的路径不会从上版继承。不同路径可以引用同一内容并返回不同 MIME，逻辑容量和文件数包含所有路径。

| 操作 | 行为 |
| --- | --- |
| prepare | 校验完整清单；同 Folio/requestId 幂等，相同 requestId 的不同内容/消息被拒绝；只给缺失的唯一哈希签名 |
| status | 返回清单、缺失内容、uploading/verifying/completed/expired、持久化结果；不返回签名 |
| renew | 重新校验管理权限和启用状态；有效会话给缺失内容续签，签名最长 600 秒且不超过会话截止时间 |
| complete | CAS 取得十分钟验证租约；逐对象续租；外部操作完成后进入短数据库事务 |

准备、查询、续签、完成都要求当前登录者拥有管理权限，并且是会话创建者。查询完成结果也需要权限。completed 结果不受原上传期限影响，重试返回原版本。expired 会话不可继续发布，重新准备新会话可复用已验证内容。verifying 在进程崩溃后可在租约到期后重新取得；旧工作者受 lease UUID 栅栏约束，不能释放新租约或提交重复版本。

完成事务锁定启用配置、Folio 行和会话行，重新读取用户角色/状态、原 Token 的吊销/到期状态及所有者，分配唯一版本号，保存完整清单、更新当前版本、保存会话结果及发布审计。所有这些写入原子提交。OSS 网络操作不持有站点行锁；数据库失败或任意验证失败不切换在线版本。并发完成收到 `UPLOAD_BUSY` 时查询/退避后重试。客户端从准备响应丢失恢复时复用 requestId，从完成响应丢失恢复时查询/完成同一 uploadId。

CLI 与 Web 共用最多四个并发 PUT 的上传器。CLI 将扫描取得的字节快照保留到上传，哈希及上传均来自相同字节；后续磁盘变化不会替换已扫描内容。Web 选文件后也取得内存快照。原始逻辑内容最多 50 MiB；ZIP 压缩数据、解压结果、Blob/散列和浏览器实现会产生额外内存开销，并非零缓冲客户端。客户端不将整版转成 Base64 JSON。小型 `publish_folio` 内联输入作为 MCP 便利入口保留，Base64 使用线性字符校验和规范编码回比，非法填充/字符返回 400，不使用重复分组正则。

## SHA-256 和封存竞态

OSS V4 URL 默认 `UNSIGNED-PAYLOAD`，签名有效并不证明字节的 SHA-256。流程是：

1. 客户端以 `Content-Type: application/octet-stream` PUT 原始二进制到 staging，不发送 EAT Authorization、Cookie 或页面 Referer，也不跟随重定向。
2. 服务端对该 staging 对象执行单对象 CopyObject，得到随机、客户端无写权限的快照。OSS 原子对象复制得到一个确定的完整对象；临时对象之后即使被旧签名重放也不影响快照。
3. EAT `getStream` 读取快照，边读取边计数并计算 SHA-256，大小过大立即中止；核验真实大小与声明哈希一致。对象名、客户端 metadata、HEAD 和签名均不作为哈希证据。
4. 将已验证快照复制到 blob 键，使用 `x-oss-forbid-overwrite: true`。遇到并发同键已存在时再读取既有正式对象验证大小和 SHA-256，通过后安全复用；不覆盖不同字节。最后删除快照。
5. 验证记录存在且 HEAD 大小正确的正式内容可以复用，无需每次重复读取散列；缺失正式对象会安排重传并再次验证。

**上传字节从客户端直接到 OSS；首次新增内容的验证会从 OSS 流经 EAT 一次。** OSS 单对象内部复制用于快照/封存，绝不为每版复制完整目录。访问仍经 EAT 网关鉴权，按该版本清单读取 hash 对象；没有清单跨版本缓存，沿用 private/no-store、SPA 回退、分享、评论注入和评论版本归属。

需要私有 Bucket、标准 OSS 对象原子性及 CopyObject 禁止覆盖支持；此版本未加入 IMM、FC、ZIP 云端解压或 OSS 版本化对象管理。Bucket 如启用版本控制，删除标记和历史对象版本需按下述额外清理。

## 最小 CORS 与 RAM 权限

在现有 Bucket CORS 规则中**追加**规则，保留其他应用规则。AllowedOrigin 使用 EAT 控制台的精确 HTTPS origin（不带路径或末尾斜杠）；本地联调另加对应 localhost origin。不要使用 Folio 访问域名替代控制台域名。

```xml
<CORSRule>
  <AllowedOrigin>https://eat.example.com</AllowedOrigin>
  <AllowedMethod>PUT</AllowedMethod>
  <AllowedHeader>Content-Type</AllowedHeader>
  <MaxAgeSeconds>300</MaxAgeSeconds>
</CORSRule>
```

由 OSS 响应 OPTIONS 预检，不需要将 OPTIONS 写成 AllowedMethod。当前协议只签名并发送 `Content-Type: application/octet-stream`；不额外发送 x-oss metadata、Content-MD5、EAT 令牌或 Cookie，不要求 ExposeHeader。响应 MIME 从版本清单取得。若配置自定义 OSS 域名/前置代理，须保留 query 和 Content-Type，确保 OPTIONS 到 OSS；本实现由 SDK 生成 Bucket 标准 HTTPS 地址。

服务端 RAM 需要 Bucket 的 `oss:GetBucketAcl`、`oss:ListObjects`（可用 `oss:Prefix` 限制到 `sites/`）及 `sites/*` 对象的 `oss:GetObject`、`oss:PutObject`、`oss:DeleteObject`。CopyObject 使用源 GetObject、目标 PutObject 权限，不发放 Bucket 凭据给客户端。启用探针仍使用 `sites/_checks/`；CORS 的实际浏览器验证需按下面步骤另做，启用探针不代替浏览器。

禁止 Bucket Policy/ACL 公开资源。不要给 blobs 配生命周期自动过期，历史版本和当前版本都可能引用；不要用其他客户端覆盖正式键。签名 URL 属于短期写凭据，不进入日志/截图/错误正文。存储边界统一屏蔽 OSS SDK 原始异常，浏览器也不展示 OSS XML。

## 清理边界与恢复

第一版不自动回收活跃 Folio 的无引用 blobs、上传会话或 staging。失败封存/提交可能留下已验证未引用内容，之后相同哈希可以复用；快照成功/失败都会尝试删除，进程突然退出可能留快照。这些保留资源不会激活版本。客户端 `--fresh` 或 Web“开始新的发布”仅放弃本地恢复记录，不删除共享文件。

如要手工清理过期 staging，仅限 `site_upload.expires_at < now()` 且 `lease_until IS NULL OR lease_until < now()`、`signed_until IS NULL OR signed_until < now()` 的会话，逐会话清理 `sites/<siteId>/staging/<uploadId>/`，不要碰 blobs 或活跃会话。不要按路径被新版删除来删除 blob；任意历史清单仍可引用。快照及无引用 blob 的自动 GC 暂缓，需要单独设计并与验证租约协调。

删除整个 Folio：数据库先撤销全部访问并级联删除版本/会话/内容记录，保存无 FK 的 `site_cleanup` 记录；然后清扫整个该 Folio 的 OSS 前缀。清理失败仅设置 cleanupFailed，不恢复 Folio。有效旧签名或验证租约带来 cleanupPending。服务每分钟检查清理任务，成功后每小时继续清扫，失败五分钟后再试；永久保留清理记录，以覆盖被任意延迟的旧请求。重复清理只处理已删除的 siteId，不影响同 slug 新建 Folio（新 UUID）或其他 Folio。单次清扫最多 100 批，无法前进/达到上限按待重试处理。

存在 Folio 或清理记录时禁止切换 Bucket/地域，可轮换凭据。否则旧会话和待清理资源可能失去存储定位。清理当前配置中的 Bucket 不会自动追溯管理员此前手工换掉的 Bucket。

## 本次升级与旧 Folio 清空方案（由运维执行）

当前代码已移除旧版本目录及本地历史文件的读取、写入和清理分支。用户已确认旧布局清理和新协议验收条件满足；本次只交付代码和增量迁移，不连接生产数据库，也不清理真实 OSS 对象。

迁移 `0019_folio_blobs_only.sql` 先检查全部历史版本的 layout：仍有非 `blobs-v1` 记录就抛出明确错误，整个迁移事务回滚，数据库和当前版本保持不变。检查通过后，将 layout 默认值改为 `blobs-v1`、添加只允许该布局的数据库约束，并将 `storage` 固定为 `oss` 元数据及默认值（保留列以支持回滚到上一版新协议服务）。已有新布局版本的 ID、完整清单、当前指针、评论和回滚能力保留；不重新上传或复制文件。旧迁移及其快照留作数据库迁移历史，不修改已发布的 0018。

已运行 0018 的数据库，可在维护窗口只读确认：

```sql
SELECT count(*) AS legacy_versions
FROM site_version
WHERE layout <> 'blobs-v1';
```

结果须为 0，包括不再作为当前版本的历史记录。仅给同一 Folio 发布新版不会清除旧布局历史版本。当前控制台删除整个 Folio，不提供单独删除历史版本的入口；仍需保留旧历史的环境应先使用支持旧布局的版本完成迁移，再升级本版本。

部署顺序：备份 → 暂停发布并排空旧实例 → 构建部署完整镜像 → 容器启动脚本自动执行迁移（非容器部署手工 `pnpm db:migrate`）→ 验证新布局访问/发布/回滚 → 恢复发布。保留原来的 EAT_KEK 和 OSS 配置；本次没有新增环境变量。MCP `publish_folio` 和 `/releases` 内联入口保留，utf8/base64 内容仍经新会话、快照验证和 blob 封存流程，整版解码后上限仍为 50 MiB。CLI/Web 协议和平台指南内容未变，无需为此次服务端布局移除单独升级客户端。

若选择彻底清空旧 Folio：

1. 在旧平台仍启用时暂停所有发布；保存 `GET /api/sites` 返回的每个 Folio UUID、当前 Bucket/地域及本地持久卷位置。备份数据库和必要产物。
2. 在 EAT 控制台逐个删除旧 Folio，记录 cleanupFailed；确认列表为空。只在删除后停用 Folio，因为删除接口本身要求启用。
3. 停止并排空所有旧版本 EAT 实例和上传客户端，再迁移/部署 0019。不要让旧实例在清理后继续写对象。新协议若已使用，还应等待记录中所有签名/租约截止（签名最长十分钟，会话续签需已被撤销）并排空在途请求。
4. 对保存的**每个已删除 UUID**，在 OSS 控制台预览/列出 `sites/<UUID>/`，确认准确后删除整个前缀。CLI 等效操作：先 `ossutil ls oss://<bucket>/sites/<UUID>/ -r`，核对后 `ossutil rm oss://<bucket>/sites/<UUID>/ -r -f`。不要删除全 Bucket 或所有 `sites/*`，不要碰 `sites/_checks/` 或其他 Folio 的 UUID。旧平台按版本清理可能遗漏失败发布的无数据库对象；前缀清理覆盖这些残留。
5. 如 Bucket 启用了版本控制，普通删除只增加删除标记；需额外列出这些已删除 UUID 前缀下的**全部对象历史版本和删除标记**，逐版本永久删除。对象保留策略/WORM 可能阻止清理，需待保留到期；自动 cleanupFailed 不表示历史对象版本已永久删除。
6. 若曾使用本地持久化，应用已不再管理本地历史文件，需运维核对挂载卷实际根路径后，仅删除 `data/static-sites/sites/<已删除 UUID>/`。旧 Bucket/旧卷若曾切换，分别按保存的 UUID 清理。
7. 再次列出各前缀确认为空；数据库中应无旧 `site`、`site_version`、`site_thread`、`site_upload`、`site_blob` 关联记录。`audit_log` 是审计，保留。新系统的 `site_cleanup` 可保留；仅在全部旧进程排空、签名失效、资源确认清空且确实需要切换 Bucket 时，运维才可按这些已删除 UUID 移除清理记录。

## 真实 OSS 联调验收步骤（运维执行）

使用专用私有测试 Bucket、独立测试数据库和测试 Folio。不要把 TEST_DATABASE_URL 指向业务库，服务端测试会重建 schema。

1. 给测试 RAM 配置上述权限；追加精确控制台 origin 的 CORS；通过管理页检查并启用，保留标准 HTTPS 源站。
2. 创建含 index.html、PNG、同内容 txt 的测试目录；先 CLI push，再只改 index.html 推送。观察第二次新增上传仅 1，OSS `blobs/` 内容并集保留，版本无完整复制目录。
3. 再推相同目录，确认 0 上传且新版本产生；删除一个路径发布，新版 404、固定旧版正常，回滚后该路径恢复，核对 MIME 和评论归属。
4. 用浏览器控制台选择目录/ZIP，Network 中确认 OPTIONS 成功、PUT 的真实 Content-Type 与签名一致，PUT 不含 Authorization/Cookie；不要把签名 URL 导出到共享日志。临时移除该测试 origin 的 CORS，确认错误提示及恢复 CORS 后重试成功，关闭/重开页面重新选相同文件恢复会话。
5. 准备会话并上传后，用有效 staging 签名改写对象：在快照前写入错误内容必须无法完成；完成后重放 staging 写入不能改变固定版本。并发完成同一会话、丢弃完成响应后再完成，均只得到原版本。
6. 核对 OSS CopyObject `x-oss-forbid-overwrite` 在实际 Bucket 配置上拒绝覆盖；中断 server 后在租约到期重试。故意上传错误哈希/大小、删临时对象、停用 Folio、撤销发布权限、删除 Folio，确认当前版本不被错误切换。删除后旧签名写入的残留应被后续清理清除。
7. 对至少 350 个小文件发布，观察最多四个客户端 PUT 并发、断网/续签恢复和服务内存。验证端是逐个流式哈希；客户端保留受 50 MiB 限制的内容快照。

本地验证记录见最终交付说明。可控 OSS 替身和真实浏览器 HTTP/CORS 均不能证明阿里云 RAM、Bucket 策略、地域、TLS、V4 验签、CopyObject 禁止覆盖和实际网络性能已通过；这些项目需完成以上云端验收。

## 2026-10-17 初次增量上传交付记录（0018）

- 基线先 `git pull --ff-only origin main`，同步到 `58ec84c`。没有生产操作。
- 使用新建的本机 PostgreSQL 17 集群、独立 `postgres://dev@127.0.0.1:5433/eat_test`，未加载业务 `.env`。全部 Drizzle 迁移（含 0018）在测试库重建过程中执行成功。
- 全量 server：330 个测试通过；CLI 最终全量：217 个通过。覆盖 REST、HTTP MCP 服务入口、stdio 共用映射、目录/ZIP 的原始 HTTP PUT、增量与无变化发布、逻辑容量/MIME、路径删除、固定版本/回滚、混合布局、错误对象、签名重放、并发封存/完成、租约恢复、数据库失败、权限变化、删除后清扫、351 文件有界并发/退避及本地同进程 RSS 增长小于 128 MiB 的资源边界检查（本次专项观测约 24.2 MiB，实际同时处理 PUT 峰值 2，不代表云端性能承诺）、2000 个长 Unicode 路径清单和 5 MiB Base64。
- `scripts/test-site-ui.mjs` 全部通过：Chromium 目录/ZIP 上传、SDK V4 URL/请求头、原生 OPTIONS/CORS（错误预检确实阻止 PUT）、刷新恢复同一会话、失败重试、无 EAT Authorization/Cookie、原有评论/访问/移动布局回归。使用真实本地 HTTP API/OSS 替身而非 DevTools API 路由拦截，避免拦截改变预检行为。
- 根目录 `pnpm typecheck`、`pnpm build` 通过。Vite 仍有单包超过 500 kB 的体积提示。
- 顺带更新了已有安装文案测试的过严断言：同步说明可以提及 MCP，CLI 安装文档仍不得包含 MCP 接入命令/配置。
- 尚未验证：真实阿里云凭据/RAM、线上 Bucket CORS 与 V4 验签、OSS CopyObject 实际禁止覆盖、OSS 版本控制/WORM 及公网吞吐/延迟。测试中的服务实例重建和租约过期验证持久化恢复逻辑，不代表已做生产实例故障演练。按上一节步骤验收后再生产启用。

## 旧布局移除交付记录（0019）

用户确认移除条件满足后，服务端仅保留 OSS `blobs-v1` 读取；已删除本地历史文件分支及旧目录 put/get/discard/kind 方法，清单类型要求每条路径都有 hash。`storage` 列仅保留固定 `oss` 值和默认值，避免上一版已支持新协议的服务在回滚时查询缺列；该字段不再决定文件读取方式。

独立本机 `eat_test` 数据库中，全量服务端 333 个测试、CLI 217 个测试通过，根目录 typecheck/build 通过，Drizzle 生成器确认 schema 与快照一致。升级测试实际从 0018 schema 开始：有旧布局时 0019 明确拒绝并回滚，旧记录及当前指针不变；归零后成功迁移，保留新版本清单和当前指针，并拒绝再次写入旧布局或 local 存储。网关测试只按 hash 读取，保留新布局历史版本回滚；MCP 内联发布及 5 MiB Base64 回归通过。

本轮未操作生产数据库、部署或真实 OSS 资源，也未重新执行真实 OSS 联调；沿用用户确认的前置验收结果。0018 的原始交付记录保留于上节，不代表当前仍支持混合布局。
