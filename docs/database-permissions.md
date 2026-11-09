# 数据库权限

数据库页的「数据库权限」页签用于访问团队已有的数据。EAT 用户拿到个人凭证后，按只读或读写级别访问获批 schema 下的表和视图；个人凭证只供本人临时使用，不要配进线上服务。需要给应用存数据时，仍通过「申请数据库」取得库及其 owner 账号。

## 开放与直接授予

EAT 建的 PostgreSQL 库，由分配申请人担任 Owner。Owner 和管理员能在数据库权限目录看到尚未开放的库，并选择覆盖的 schema（默认 `public`）后开放申请。成员只看到开放的库。MySQL 库不支持开放。

首次开放会建立两个 NOLOGIN 组角色，收回 PUBLIC 对库的 CONNECT 和 public schema 的 CREATE，并给组角色授予 CONNECT、获批 schema 的 USAGE 与表和视图的 SELECT。读写组另有表的 INSERT、UPDATE、DELETE 以及序列的 USAGE、SELECT，不授予 CREATE、ALTER 或 TRUNCATE。owner 账号仍然可以连接、建表和读写；它以后新建的表、视图和序列也通过默认权限按级别向组开放。未获批 schema 不开放。

可以直接授予只读或读写。Owner 或管理员选择启用中的 EAT 用户，授权生效后，持有人在「我的授权」中按需查看个人凭证。关闭申请保留已有授权，也仍允许直接授予。

每人在每个实例只有一个个人登录角色 `eat-<用户 UUID>` 和一套密码；每个库各有一条授权。重复授予和失败重试复用原记录、角色与密码。对已有授权选择新级别会修改同一条授权；从读写降为只读时，先加入只读组再退出读写组，提交后终止这个人在该库的会话，同实例其他库不受影响。升级则先加入读写组再退出只读组。角色有 EAT 来源标记，来源不明的同名角色会让执行失败，平台不会接管。

## 申请与 Owner 审批

成员在目录选择库、只读或读写级别并填写用途，也可执行 `eat db access request <库名>[@实例名] --level read|write --reason "用途"`。同人同库最多一条待审批申请，重复提交需要先撤回。只读持有人可从「我的授权」申请升级，待审批期间仍按原只读级别访问，批准后升级原授权；读写持有人不能申请降级为只读。Owner 或管理员自己申请时直接授予并记审计，不创建待审批记录。

申请进入统一申请中心的「数据库权限」类型（`db-access`）。库的当前 Owner 和管理员可以审批，飞书卡片展示申请人、用途、库、实例和级别，快捷同意使用相同的授权执行路径。Owner 停用时，详情提示「Owner 已停用」，由管理员审批。关闭申请仅拒绝新申请，原待办仍可审批；资源删除或申请人停用使待办失效。驳回、撤回和重新提交保留各轮历史。

批准与数据库执行分别显示。批准时把决策与待执行授权一起保存，再执行目标 PostgreSQL 操作；目标失败显示「已批准、执行失败」。Owner 或管理员在数据库权限页重试原授权，复用身份和授权、不新建审批轮次；启动及每 30 秒恢复时同步申请中心的执行状态。`eat requests list --type db-access`、`eat requests show <申请ID>` 和既有 MCP `list_requests` / `get_request_status` 可查进度；本期没有数据库权限申请 MCP 工具，`get_db_credentials` 仍只支持原 owner 分配凭证。

## 外部库登记

管理员在「数据库实例」的 PostgreSQL 实例行中选择「登记外部库」，填写实际库名、EAT Owner、schema 列表和可选的建表角色。登记前校验目标库连接、CREATEROLE、库 CONNECT 的授予能力，以及各 schema、表、视图和序列的实际授权能力。管理账号可以预先取得实际对象 owner 的 SET 权限，或持有相应权限的 GRANT OPTION；填写建表角色时还需能切换到该角色以维护默认权限。校验失败显示 DBA 可执行的修复 SQL，不会把 PostgreSQL 的 warning 当作授权成功。

登记结果与「权限检查」展示 PUBLIC 的 CONNECT、PUBLIC 在 public schema 上的 CREATE、PUBLIC 的有效表权限（含列授权），以及已有角色的有效 CONNECT、schema CREATE、表权限和继承链。报告提供供 DBA 评估的 REVOKE SQL，EAT 不执行它们，也不会自行添加外部 owner 的成员关系。对预定义全库读写角色或对象 owner 的继承路径，报告同时提示 DBA 处理相应成员关系。重新应用授权会刷新报告。若 PUBLIC 或其他角色仍提供访问路径，撤销 EAT 授权后这些已有权限仍然存在。

外部库在目录中标明「外部库」、实例和 Owner。登记时不开放申请，Owner 和管理员可以开放或关闭、直接授予、修改级别、撤销与重新应用授权，使用同一套个人角色和会话终止流程。外部库的开放和重新应用始终保留 PUBLIC 权限；需要隔离 CONNECT 或禁止 PUBLIC 建表时，由 DBA 自行确认并执行收紧 SQL。

填写建表角色后，该角色未来创建的表、视图和序列自动按级别向组开放；留空时仅授权已有对象，新建对象后需要重新应用。修改 schema 或建表角色后自动重新应用，并清除原建表角色留给 EAT 组的旧默认权限。库和原有 owner 账号不会被接管或删除。

## Schema 与重新应用

Owner 和管理员可修改覆盖的 schema 列表，保存后自动重新应用；关闭申请的库也能修改。省略 schema 字段只切换开放状态，保留原范围。EAT 建的库的建表角色固定为分配的 owner 账号。

「重新应用授权」把两级权限补到当前范围的全部表、视图与序列，并维护 owner 未来对象的默认权限。使用别的角色新建的表，需要手动重新应用；管理账号必须能 SET ROLE 到实际对象 owner，否则执行失败并给出 DBA 可执行的授权 SQL，不会只记录 PostgreSQL 的 warning 后假报成功。

移出列表时，EAT 同时撤掉两组在该 schema 上的权限、已有表和序列的权限，以及未来表和序列的默认权限。默认权限只影响对应建表角色以后创建的对象。重应用在目标库内使用事务；失败保留失败原因，可修正配置或再次重新应用。待执行配置保存在目录记录中，重启及每 30 秒恢复，范围清理依据目标端 ACL，进程中断后不会遗失旧范围。

## 撤销与个人凭证

Owner 和管理员可以撤销授权并填写原因。EAT 退出该库的组角色，提交后终止这个人在该库上的会话，再把授权标记为已撤销；同实例其他库不受影响。持有人收到飞书通知，包含撤销人与原因。本人也可放弃授权，放弃不发送通知。

个人凭证只有持有人本人能读取，管理员查看授权清单不会取得别人的密码。接口响应使用 `Cache-Control: no-store`，控制台只把凭证留在当前弹窗中，隐藏或关闭即清除。开放、关闭、授予、重新应用、撤销、放弃和每次凭证读取均记审计。

控制台的个人凭证弹窗可以「重置个人密码」。重置影响本人在同一实例上的全部库授权，原密码失效，分配出去的 owner 密码不变。新密码先加密保存为待应用状态，目标 PostgreSQL 修改成功后才替换当前密文；目标修改或平台完成写入失败时保留待应用密文，启动及每 30 秒幂等恢复。重置待完成时，凭证端点先恢复操作，未完成则拒绝返回可能已经失效的密码。

CLI 使用 `eat db run <库名>[@实例名] -- <命令>`，与 `eat db credentials run` 相同；`credentials pull` 也支持本人授权。名字同时匹配自己的有效分配与授权，同一实例同一库优先 owner；跨实例同名时报错并给出 `库名@实例名`，不会读取凭证或启动命令。完整分配 UUID 保留管理员原有读取入口。

`run` 将 `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 和 `DATABASE_URL` 注入子进程，不落盘、不修改父环境，透传退出码。管道与 shell 展开请显式使用 `-- sh -c '…'`。首次使用会自动生成缺少的个人凭证，创建失败后可以重试。

`eat db access list` 查看开放目录与自己的授权，`eat db access revoke <库>` 放弃本人授权，`eat db access reset-password <库>` 重置个人密码；重置前提示整个实例的影响。申请可通过控制台「数据库权限」页或 `eat db access request`。CLI 只查询 `scope=mine`，不会把可管理的他人授权当作本人凭证候选。

执行失败的授权会显示失败原因，可由 Owner 或管理员重试。未完成的开放、待执行授权和撤销中记录持久化保存，应用启动及每 30 秒恢复一次；执行失败的授予保留失败状态，等待明确重试。撤销未完成时不会显示已撤销。

## 管理角色与恢复

实例的管理账号需要 CREATEROLE；新建分配还需要 CREATEDB。EAT 借 owner 角色的成员身份授予目标对象权限。PostgreSQL 16 中，CREATEROLE 自动给予的 ADMIN OPTION 不含 SET 或 INHERIT，因此 EAT 显式给管理账号取得 owner 的 SET 权限。

收回 PUBLIC CONNECT 后，仅有 owner 的 SET 权限仍不能通过连接阶段的 CONNECT 检查。EAT 因此先在 `postgres` 维护库幂等创建组角色，并把只读组授给管理账号（PG16 使用 `WITH INHERIT TRUE, SET FALSE`）。CONNECT 仍只直接授予两个组角色。这样首次开放提交后进程中断、重启恢复、以后重新应用授权时，管理账号仍可连接目标库并 SET ROLE 到 owner。后续清理组角色时需同时处理这份管理成员关系。

同一实例的操作由独立连接池上的 PostgreSQL 会话 advisory lock 串行化，不占住业务连接池等待锁。持锁连接中断时，执行器在提交前检查锁状态，未完成记录等待恢复。目标实例的权限事务与 EAT 元数据事务分开执行，来源标记保证重试只复用本记录创建的角色。

## 接口

所有请求和响应契约在 `packages/shared/src/db-access.ts`。

| 接口 | 用途 |
| --- | --- |
| `GET /api/db/access/catalog` | 开放目录及自己负责的库 |
| `POST /api/db/instances/:id/access/catalog` | 管理员登记外部 PostgreSQL 库 |
| `POST /api/db/access/catalog/:id/access` | 外部库开放、关闭或修改 schema / 建表角色 |
| `POST /api/db/assignments/:id/access` | 开放或关闭申请，选择或修改 schema |
| `POST /api/db/access/catalog/:id/reapply` | 重新应用现有对象及默认权限，保留开放状态 |
| `GET /api/db/access/grants` | 本人持有及可管理的授权；`?scope=mine` 只返回本人持有 |
| `POST /api/db/access/catalog/:id/requests` | 成员申请只读/读写；Owner 或管理员自己申请直接授予 |
| `POST /api/db/access/catalog/:id/grants` | 直接授予只读/读写，或修改已有级别 |
| `POST /api/db/access/grants/:id/retry` | 重试未完成或失败的操作 |
| `POST /api/db/access/grants/:id/revoke` | 管理者撤销，原因选填 |
| `POST /api/db/access/grants/:id/relinquish` | 本人放弃授权 |
| `POST /api/db/access/catalog/:id/reset-password` | 本人重置该实例的个人密码，返回完成或待恢复状态 |
| `POST /api/db/access/catalog/:id/credentials` | 本人按需读取个人凭证 |

服务端 e2e 在本地 PostgreSQL 16 上用非超级管理角色验证查询、写入拒绝、schema 范围、未来对象默认权限、双库隔离、改级别、断会话、通知、失败重试、并发幂等及重启恢复；读写、未来表和序列、其他角色的新表、schema 增减与重应用另见 `db-access-levels.spec.ts`。

外部库登记、权限检查与 DBA 提示、GRANT OPTION 管理角色、未来表、只读/读写及撤销断会话见 `db-external.spec.ts`；测试只操作本轮唯一前缀的新建库与角色。
