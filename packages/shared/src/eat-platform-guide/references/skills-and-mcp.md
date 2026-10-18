# Skill 与 MCP 配置

## 团队 Skill

- `eat skill list` 查看团队 Skill；默认 100 条，`--search <词>`、`--scope subscribed|unsubscribed|mine`、`--kind bundled|private|experience` 筛选，`--limit <n>` 最多 1000。
- `eat skill export <slug> --out <目录>` 下载完整 Skill，适合阅读附属文件或以它为基础另建 Skill。
- `eat skill push <目录>` 上传本地 Skill。修改别人的 Skill 时，使用自己的新 slug；只有原作者可以更新原 Skill。
- 推送不会自动订阅。运行 `eat skill subscribe <slug>` 后才会随 `eat sync` 分发；`unsubscribe` 取消订阅。标记 `◆` 的捆绑 Skill 由管理员强制分发，成员不能单独退订。
- `eat sync` 同步已授权的 Skill 和 MCP 配置；同步落点与更新提示的处理见[同步与更新](updates.md)。内置 `eat-platform-guide` 始终分发，不手工编辑本地副本。

## 团队 MCP 配置

`eat sync` 会把你有权限的 MCP 配置渲染到 `~/.eat/mcp.generated.json`，由用户合并进自己的客户端配置。**大部分条目里是一条只属于当前用户的接入地址**（形如 `<平台>/mcp/<名称>/<一长串随机串>`）：平台在服务端代理到真实服务并注入凭证，所以配置里看不到、也不需要上游地址与 token。

- 这条地址**等同于密钥**：不要提交进仓库（尤其是项目里的 `.mcp.json`）、不要贴进对话记录、日志或工单。
- 它只对当前用户有效；退订后立即作废，重新拿到权限会换成新的一条，届时重跑一次 `eat sync` 即可。
- 连不上时报 `MCP_GATEWAY_URL_INVALID` 说明地址已失效（多半是订阅被取消或重新授权过）——重跑 `eat sync` 取新地址，别反复重试旧的。
