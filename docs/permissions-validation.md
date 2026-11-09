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
