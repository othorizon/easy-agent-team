# 数据库权限

数据库页的「数据库权限」页签用于访问团队已有的数据。EAT 用户拿到个人凭证后，可以查询获批 schema 下的表和视图；个人凭证只供本人临时使用，不要配进线上服务。需要给应用存数据时，仍通过「申请数据库」取得库及其 owner 账号。

## 开放与直接授予只读

EAT 建的 PostgreSQL 库，由分配申请人担任 Owner。Owner 和管理员能在数据库权限目录看到尚未开放的库，并选择覆盖的 schema（默认 `public`）后开放申请。成员只看到开放的库。MySQL 库不支持开放。

首次开放会建立两个 NOLOGIN 组角色，收回 PUBLIC 对库的 CONNECT 和 public schema 的 CREATE，并给组角色授予 CONNECT、获批 schema 的 USAGE 与表和视图的 SELECT。owner 账号仍然可以连接、建表和读写；它以后新建的表、视图也通过默认权限向组开放。未获批 schema 不开放。

本阶段可以直接授予只读。Owner 或管理员选择启用中的 EAT 用户，授权生效后，持有人在「我的授权」中按需查看个人凭证。关闭申请保留已有授权，也仍允许直接授予。

每人在每个实例只有一个个人登录角色 `eat-<用户 UUID>` 和一套密码；每个库各有一条授权。重复授予和失败重试复用原记录、角色与密码。角色有 EAT 来源标记，来源不明的同名角色会让执行失败，平台不会接管。

## 撤销与个人凭证

Owner 和管理员可以撤销授权并填写原因。EAT 退出该库的组角色，提交后终止这个人在该库上的会话，再把授权标记为已撤销；同实例其他库不受影响。持有人收到飞书通知，包含撤销人与原因。本人也可放弃授权，放弃不发送通知。

个人凭证只有持有人本人能读取，管理员查看授权清单不会取得别人的密码。接口响应使用 `Cache-Control: no-store`，控制台只把凭证留在当前弹窗中，隐藏或关闭即清除。开放、关闭、授予、撤销、放弃和每次凭证读取均记审计。

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
| `POST /api/db/assignments/:id/access` | 开放或关闭申请，首次选择 schema |
| `GET /api/db/access/grants` | 本人持有及可管理的授权 |
| `POST /api/db/access/catalog/:id/grants` | 直接授予只读 |
| `POST /api/db/access/grants/:id/retry` | 重试未完成或失败的操作 |
| `POST /api/db/access/grants/:id/revoke` | 管理者撤销，原因选填 |
| `POST /api/db/access/grants/:id/relinquish` | 本人放弃授权 |
| `POST /api/db/access/catalog/:id/credentials` | 本人按需读取个人凭证 |

服务端 e2e 在本地 PostgreSQL 16 上用非超级管理角色验证查询、写入拒绝、schema 范围、未来对象默认权限、双库隔离、断会话、通知、失败重试、并发幂等及重启恢复。
