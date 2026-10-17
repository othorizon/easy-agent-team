# Folio 使用指南 · 设计记录

## 定位

面向 eat 使用者的场景指南。回答什么时候使用 Folio、能分享什么、为什么选择 Folio；不把发布操作作为主线。

Design Read：新建阅读型网页，延续 eat 的中性视觉；布局变化 5、动效 2、信息密度 5、素材依赖 3、品牌一致性 8。

叙事：先建立用途，再探索六个场景，比较媒介，最后给出内容起草入口。电脑近距离阅读与手机阅读；语气友好、直接、可信。每个场景使用渐进披露控制信息量。

## 真实品牌素材

- `site/assets/eat-brand/icon.svg`：复制自 `apps/web/src/assets/icon.svg`，页头标识与 favicon。
- `site/assets/eat-brand/logo.svg`：复制自 `docs/assets/logo.svg`，保留原始 SVG，未重绘。
- 以仓库内的品牌资源和样式令牌为依据，不收录具体部署实例的截图。

## 视觉系统

- 主色 `#171717`，背景 `#ffffff`，次级面 `#f7f7f7`，次级字 `#626262`，边界 `#e5e5e5`，反白字 `#fafafa`。均来自 eat 中性主题或其灰阶变化。
- 字体：`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`；代码与索引使用 SFMono-Regular / Menlo。继承 eat 原生字体选择。
- 正文 17px，标题 clamp(48px, 6.2vw, 88px)；中文行距 1.8。8px 间距基准。
- 容器 1200px，桌面 48px / 手机 24px 边距；内容行长受限。
- 主要表面 8px 圆角，分隔线与留白负责分组；仅浮层使用阴影。
- 160ms 状态反馈，ease-out；尊重 reduced-motion；无入场遮挡、无滚动劫持。
- 模式为 greenfield，复用品牌，不修改 eat 控制台的任何界面或路由。

## 内容与能力依据

内容依据为本仓库 `docs/folios.md`、`packages/shared/src/site.ts`、`apps/cli/src/commands/folio.ts`。

事实边界：Folio 托管静态网页、演示与报告；固定入口显示当前版本，版本地址固定发布快照；历史版本可恢复；自动加入页面/元素/区域评论；每条评论关联实际浏览版本；可选择登录/公开/密码访问，发表评论仍需 eat 登录。不会自动保存源工程，不提供服务端业务能力，也不是正文实时共编工具。

比较共享文档时承认其链接分享、评论、版本能力；Folio 的选择理由是自定义网页呈现、可交互的静态内容和发布后的阅读体验，而非夸大文档的缺点。示例与演示参数均明确标注，不构造真实业务指标。

## 发布

- 指南可用于任意启用 Folio 的 eat 实例，不绑定具体部署域名或账号。
- 页面使用通用的控制台入口说明，不包含个人部署链接。
- 仅发布 `site/`，不上传设计记录或工程资料。
