# Folio 控制台 UI 重构

基线：main / 00e4f15；特性分支 feat/folio-ui-redesign。
模式：Redesign · Preserve。对象为团队成员和管理员使用的 Folio 工作台，电脑近距离工作、手机查看与反馈；语气安静、清晰，首屏优先展示作品和待处理反馈。

## Design Read

布局变化 4、动效 2、信息密度 7、素材依赖 2、品牌一致性 9。稳定网格和任务优先的分栏提高扫读效率；只使用悬停、焦点和加载反馈；不增加展示性动画。所有数量来自 API 返回的数据。

## 视觉系统

沿用 eat 的 shadcn Neutral 令牌：background/card 白、primary/foreground 近黑、muted 浅灰、border 中灰；success 仅表示发布/解决状态，destructive 仅表示删除和错误。保留平台原生中文字体及等宽 URL，不引入外部字体。4/8px 间距基准，主要分区间距 24–32px；面板 12px、控件 8px 圆角，浮层沿用现有阴影，日常内容用分隔线。状态反馈 150ms，尊重 reduced-motion。

列表承担发现与进入作品的角色，展示真实发布状态、权限与更新时间；详情头承担识别作品、打开和发布；评论区承担反馈处理，桌面反馈列表与输入并列；发布记录承担历史比较与恢复，使用语义化表格；设置按基本信息、访问权限和路由分组，删除独立。创建/发布浮层围绕单一任务。嵌入评论保留固定底部输入和独立滚动。

## 真实品牌与基线

- 平台图标：apps/web/src/assets/icon.svg（沿用现有 Shell 中的品牌资产）。
- 平台标志：docs/assets/logo.svg（不重绘）。
- 当前界面截图：/tmp/folio-ui-before/comments-desktop.png、settings-desktop.png、embedded-desktop.png。
- 原有令牌：apps/web/src/index.css。

## 受保护的行为

保留全部 URL、slug、表单字段、权限、分享协议、评论版本归属、DOM 锚点、草稿保存和删除/恢复确认；不改变服务端、CLI 或 MCP 契约。评论详情的上下文保持渐进披露。保留 ARIA 名称与语义化表格，方便键盘使用和现有浏览器回归。

## 验证与截图

使用仓库现有 Playwright + Chromium，运行真实 React 页面，以明确的 API 测试替身提供截图数据，不操作真实业务数据。验证评论、回复、@、发布、恢复、删除、权限、错误、嵌入批注及手机布局。截图使用 Asia/Shanghai 时区；测试替身不是生产业务记录。
