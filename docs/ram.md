# RAM 适配层

`apps/server/src/ram/ram.module.ts` 提供并导出 `RamCloud`，OSS 与阿里云权限流程共用这一层。RAM 和 STS SDK 只在 `ram-cloud.ts` 中使用。每个调用的首参都是 `RamCredentials`（管理 AccessKey ID/Secret），不读环境变量、不持有某个云账号的全局凭证。

## 接口

- `callerAccount`：通过 STS 读取调用者所属云账号 ID。
- `getUser` / `createUser` / `updateUser` / `deleteUser`：用户信息统一返回 `id`、`name`、`displayName` 和 `comments`。改名不重建用户，UserId 和 Key 保持不变。
- `listPolicies`：只列自定义策略；传入可选 `marker` / `maxItems`，返回 `policies` 和下一页 `nextMarker`。策略信息含 `name`、`type`、`description`。
- `getPolicy`：现取默认版本的 `document` 文本，保留 JSON 原文；兼容云端返回 URI 编码文本。
- `createPolicy` / `deletePolicy`：创建自定义策略、清理非默认版本后删除策略。删除前须先解绑全部实体。
- `userPolicies` / `attachPolicy` / `detachPolicy`：读取和调整用户的策略绑定，类型默认为 `Custom`。
- `deleteLoginProfile`：删除控制台登录配置，缺失视为已完成；平台从不创建登录配置。
- `keys` / `createKey` / `keyStatus` / `deleteKey`：管理 AccessKey。只有创建时返回 Secret；重复删除不存在的 Key 视为完成。

`ensureUser`、`applyUserPolicy`、`deleteProbeUser` 保留 OSS 现有的归属检查和幂等操作：用户备注或策略说明的 marker 不匹配时拒绝接管；策略内容不变时不创建新版本；测试资源清理只解绑指定策略，不移除其他绑定。统一身份的新 Key 加密保存并持久化 `readyAt`，默认等待45秒，重启不跳过；旧 OSS 检查仍由 `OssCloud.waitForNewKey` 等待。

## 错误与测试

SDK 错误统一变为 `RamCloudError`，带机器可读的 `code` 和 `kind`：`quota`、`missing`、`forbidden`、`network`、`conflict`、`other`。错误信息只包含本地操作名与清洗后的错误码，不转发可能包含凭证的 SDK 原文。`ramMissing` 用于需要容忍资源已不存在的恢复流程。

内存实现 `apps/server/test/ram-fixture.ts` 使用同一公共接口，按管理凭证隔离云账号；`registerAccount` 可登记测试凭证与云账号的对应关系。它强制每人最多两把 Key（含停用 Key）、测试契约的十条自定义策略（真实账号可调整配额），删除策略前必须解绑，删除用户前必须清空 Key 与绑定。改名保持 UserId 与 Key 不变。OSS e2e 同时注入 RAM 内存实现和 OSS 数据面替身，不再在 OSS 替身中模拟 RAM 操作。

使用独立测试库运行 `pnpm --filter @eat/server exec vitest run test/oss.spec.ts test/ram.spec.ts`。这些用例不访问真实阿里云；真实云契约验证另行显式运行。
