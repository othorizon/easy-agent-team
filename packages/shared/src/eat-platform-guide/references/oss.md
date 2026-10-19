# OSS 对象存储

用于申请文件存储空间、读取访问凭证、选择访问域名和修改目录公开读。

1. `eat oss status` / `get_oss_status` 确认功能已启用；未启用时联系管理员配置系统设置。
2. `eat oss list` / `list_oss_spaces` 检查已有空间。需要新空间时，用 `eat oss request <名称> --purpose <用途>` / `request_oss_space` 提交申请，告知用户等待管理员批准。网络失败重试时复用原 `requestId`，避免重复申请。
3. `eat oss show <id>` / `get_oss_space` 获取状态、Bucket、地域、SDK Endpoint、目录前缀、官方及自定义域名、人工 CDN 标记和 EAT 公开目录。仅 `active` 状态可用；开通或修改处理中时查询详情确认结果。
4. 在明确需要使用 OSS 时，调用 `eat oss credentials` / `get_oss_credentials` 领取本人 AK/SK，安全交给当前应用。**同一用户所有已批准空间共用此 AK/SK，包括未来新开的空间**；它不是可分享给单个项目的隔离密钥。凭证不写进源码、日志或对话。
5. OSS 客户端每个 Object Key 必须以返回的完整 `prefix` 开头，列举也必须指定该前缀；没有 Bucket 根目录、其他用户目录或 Bucket 管理权限。使用 SDK Endpoint 和 Bucket 初始化客户端；域名 URL 用于构造对象访问地址。

## 可见性和域名

`eat oss public-read <id> on|off` / `set_oss_space_public_read` 只控制整个空间的 EAT Bucket Policy 公开读授权。默认关闭。开启公开读前按用户需求确认可公开的范围。

用户可以自行设置目录内对象 ACL。关闭 EAT 公开读不会重写独立对象 ACL，也不会修改 CDN 访客鉴权或清理 CDN 缓存。CDN 标记由管理员手动维护；私有 Bucket 回源与 CDN 访客鉴权是两个独立设置，应按业务选择访问域名。

## 凭证重置与回收

只有用户明确要求时，执行 `eat oss credentials reset --yes` / `reset_oss_credentials`；用 `eat oss operation <id>` / `get_oss_operation` 查询完成后重新领取凭证。旧凭证失效会影响该用户的所有空间，所有使用它的应用都需更新。

管理员在控制台审批、拒绝、重试或回收空间。回收撤销该路径 RAM 权限和 EAT 公开读授权，保留云端文件。停用平台 OSS 功能不会使已发出的 AK/SK 自动失效；停用用户会触发其 RAM Key 停用并在失败时重试。
