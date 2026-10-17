# Folio UI 验证记录

基于 main / 00e4f15，在 feat/folio-ui-redesign 分支完成。

## 范围与结果

- Folio 列表：搜索、管理范围筛选、空结果、空列表、创建表单提交通过。
- 详情：评论 / 发布记录 / 设置切换、评论草稿保留、跨版本回复、@、解决和重开、页面筛选与旧响应竞态通过。
- 发布：ZIP 失败后保留弹窗并可重试目录上传；历史发布预览、相关评论、恢复确认通过。
- 删除：确认 / 取消、失败重试、处理中保护、保留其他人的回复、权限、嵌入删除与 Escape 通过。
- 嵌入：原页面版本归属、元素 / 区域批注、取消选取、定位与位置变化回退、关闭、路径切换、评论状态蓝点通过；手机底部输入区可达。
- 管理员配置：首次读取已保存配置并回填；编辑域名后模拟网络重连触发重新读取，未保存输入仍保留。
- 浏览器未出现 pageerror；类型检查和生产构建通过。

使用 Chromium；桌面截图 1440 × 1000、手机 390 × 844，详情另外检查 768 × 1024、1280 × 1024。截图检查页面横向溢出；手机发布表格仅在自己的容器内横向滚动。

## 重现

使用仓库指定的 pnpm 10.33.0，先构建共享包，再启动 Web：

```bash
pnpm --filter @eat/shared build
pnpm --filter @eat/web dev --host 127.0.0.1
```

另一个终端执行：

```bash
EAT_UI_CAPTURE=1 EAT_UI_SHOTS=/tmp/folio-ui-review node scripts/test-site-ui.mjs
pnpm --filter @eat/web typecheck
pnpm --filter @eat/web build
```

浏览器默认地址为 http://127.0.0.1:5173，可通过 EAT_UI_URL 修改；默认 Chromium 为 /usr/bin/chromium，可通过 CHROMIUM_PATH 指定。EAT_UI_CAPTURE 额外生成编号 01–16 的桌面 / 手机截图和 18、19 两处评论区近景，并验证搜索、创建与配置草稿。脚本使用 API 测试替身及本地跨源静态页，不写入真实业务数据，不依赖外部账号。

本次完整截图和交互式索引位于 /workspace/folio-ui-review，源码中不收录二进制截图；重新执行上述命令可生成。

## 评论区视觉迭代

平台与发布网站的评论改为轻量讨论流后，重新执行完整浏览器回归、Web 类型检查与生产构建、Server 类型检查。新版截图位于 /workspace/folio-comments-v2；18-discussion-closeup.png 和 19-embedded-closeup.png 为两处近景，13-comments-mobile.png 和 16-embedded-mobile.png 为手机版。
