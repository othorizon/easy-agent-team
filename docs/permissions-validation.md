# 权限功能的本地浏览器验收

`scripts/test-permissions-ui.mjs` 驱动真实 Web 构建产物；`apps/server/scripts/permissions-ui-qa.ts` 启动真实 Nest HTTP，覆盖同一份 `TestRamCloud` / `TestOssCloud`，仅监听 `127.0.0.1`。脚本不读取真实云 profile，不使用真实云管理凭证，也不启动生产入口。

需要本地 PostgreSQL 16 的 dev 管理连接 `127.0.0.1:5433`，预先创建独立的 `eat_ui_19` 库。脚本会重建该库 schema；全量测试请使用另一独立且以 `_test` 结尾的库。目标库、普通管理角色和 owner 使用本轮随机 UUID，结束按本轮名单清理，清理记录保存在 `/tmp/eat-ticket19-ui/pg-*.json`。普通角色保留 SCRAM 密码认证。

先构建并启动桌面可见浏览器，再在仓库根目录运行：

```sh
pnpm build
agent-browser --session eat-ticket19 --headed open about:blank
pnpm --filter @eat/server exec tsc --noEmit -p tsconfig.ui-qa.json
EAT_PERMISSIONS_UI_QA=1 \
  BROWSER_CDP_URL="$(agent-browser --session eat-ticket19 get cdp-url)" \
  pnpm --filter @eat/server exec vitest run --config vitest.ui-qa.config.ts
```

专用配置只包含此脚本，不属于默认 `pnpm test`。显式开关和回环 CDP 校验通过后才执行；所有浏览器请求限制到本地 origin。Worker 在 harness 中显式驱动，便于稳定制造和验证失败、重试。

1440×1000 和 390×844 分别使用独立的管理员、Owner、成员上下文，重新创建一轮本地数据。覆盖数据库开放、schema、外部库和 DBA SQL、申请和审批、个人密码、直接授予和改级别、漂移修复、撤销与删除；阿里云接入、目录、策略原文、暂停、授权执行失败、凭证和共享 Key、停用、清理与重试；OSS 预演、冲突、部分失败、409 写屏障及重试完成。保存每项截图和 `report.json`，检查页面与弹窗边界及弹窗内容宽度，并收集运行错误。截图在 `/tmp/eat-ticket19-ui/<视口宽度>/`。

这是 Chromium 的本地视觉与交互验收；真实云适配层契约由[独立显式脚本](aliyun-permissions.md#独立真实云契约验证)验证，真实手机设备和其他浏览器需另行验收。

PG16 成员选项修复的针对性走查使用相同 harness，独立平台库 `eat_ui_review`，指定 `EAT_PERMISSIONS_UI_QA_SCENARIO=membership-options`。它只走数据库选项详情、确认修复、成功状态、其他授予者导致的回滚提示和 DBA 处理后的重试；不会重复上述 156 个既有场景，也不调用云适配层。先创建该本地 QA 库，然后使用独立浏览器会话运行：

```sh
AGENT_BROWSER_SESSION=eat-review-fix agent-browser --headed open about:blank
EAT_PERMISSIONS_UI_QA=1 EAT_PERMISSIONS_UI_QA_SCENARIO=membership-options \
  BROWSER_CDP_URL="$(AGENT_BROWSER_SESSION=eat-review-fix agent-browser get cdp-url)" \
  pnpm --filter @eat/server exec vitest run --config vitest.ui-qa.config.ts
```

2026-11-09 实测：1440×1000、390×844 各 9 个状态，18 张截图。按授予者展示三个选项的预期/实际值；核对前后实际成员选项完全相同；修复后不一致标记消失；无权修改 `dev` 的关系时返回预期 409、保留原成员选项并展示 DBA SQL，DBA 精确处理后重试成功。页面、dialog、alertdialog 均无横向溢出，pageerror、意外 HTTP/console 错误、warning、请求失败均为 0。证据保存在 `/tmp/eat-review-ui/{1440,390}/report.json` 及同目录截图，`pg-*.json` 两轮资源清理均为 `cleaned:true`。

最终修复源代码的根 `pnpm build`、`pnpm typecheck`、QA 专用 `tsc --noEmit -p tsconfig.ui-qa.json` 全部通过。独立 `eat_review_test` 上根 `pnpm test`：CLI 22 文件 / 302 项、Server 52 文件 / 883 项全部通过，无跳过；其中新增 6 项普通 PG16 管理账号的完整 HTTP 成员选项回归，保留原有来源校验、删除、停用、隔离与降级测试。日志 `/tmp/eat-review-{build,typecheck,test,ui-typecheck,ui}.log`，UI 报告 `/tmp/eat-review-ui/QA.md`，新用例资源清理名单 `/tmp/eat-review-pg-*.json` 均为零残留。未新增迁移，CLI 0.16.0 / 指南 48 保持同一未发布版本。
