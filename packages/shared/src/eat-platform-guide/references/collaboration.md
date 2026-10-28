# 团队经验与真人求助

1. **先搜经验库**：`search_experiences`——很多问题已有沉淀好的答案，别打扰人。
2. 没有再找人：`list_helpers` 列出可求助的同事及其个人简介，`create_help_request` 发起求助（把上下文说清楚）。
3. `get_help_request` 看回复，`reply_help_request` 追问。求助内容只对求助双方与管理员可见。已解决的求助再回复默认会被重新打开（需要对方再处理时正该如此）；只是道谢或补充说明就带上 `reopen=false`（CLI: `eat ask reply --no-reopen`），求助保持已解决。

终端环境使用 `eat ask create / show / reply` 处理求助；具体参数用 `eat ask --help` 或对应子命令的 `--help` 查询。

## 收到回复后回到 Agent 任务

发起求助时可以传 `replyCallbackUrl`（REST / MCP `create_help_request`），CLI 对应 `--reply-callback-url`。
值是原任务的 URL 模板，必须含 `{message}` 占位符（也接受 `%7Bmessage%7D`）。例如：

```sh
eat ask create --to '<helper-user-id>' --title '登录失败' \
  --description '接口返回未授权，需要确认鉴权约定' --tried '已搜索团队经验和接口文档' \
  --reply-callback-url 'codex://new?prompt={message}'
```

EAT 在求助发起人收到的回复通知中，将卡片的「发送给 Agent」完整文本做 URL 编码后替换占位符，
增加「回到任务处理回复」主按钮，通过 EAT 中转页尝试打开目标。模板可以使用 HTTPS/HTTP 或应用深链接；
占位符放在路径、查询参数或片段中，不要放在协议或主机名里。无需对消息预编码。

上例打开 Codex 新会话并预填文本，不保证自动发送；如要返回原会话，只使用当前客户端确认支持的链接，
不要猜测会话 ID 或假定已有会话支持 `prompt`。不知道有效链接时省略此参数，用户仍可复制卡片文本给 Agent。
没有回调 URL 的旧求助保持原通知行为；求助者发给对方的追问通知不会附带自己的任务链接。


## 查询用户与发送通知（CLI）

一级命令 `eat users` 查询接收人，输出完整用户 ID、姓名、邮箱、角色、状态和飞书通知就绪情况。
只返回正常账号，支持 `--search <姓名/邮箱/ID>` 和 `--json`；普通登录用户也可查询。禁用账号在 `/users` 管理页面查看，CLI 不提供状态筛选。

```sh
eat users --search 'lisi'
eat notify send --to 'lisi@example.com' --title '验收提醒' --body '**接口已完成联调**，请验收。'
eat notify send --all --title '维护通知' --body-file ./notice.md --dry-run
eat notify send --all --title '维护通知' --body-file ./notice.md
```

- `--to` 使用完整 ID 或邮箱，可重复指定；与 `--all` 二选一。相同用户的 ID/邮箱会去重。
- `--title` 必填且为纯文本；`--body` 与 `--body-file` 二选一，文件是 UTF-8，`--body-file -` 从标准输入读取。
- 正文采用飞书 Markdown 子集，支持加粗、链接、列表、代码块；不保证完整 GitHub Markdown 兼容。标题/表格等不在当前 JSON 1.0 卡片支持范围，图片需飞书 image_key。正文最多 10000 字符且不超过 20 KB；过长报错，不截断。
- 卡片底部一行「发送人：姓名 · MM-DD HH:mm · EAT」，时间为北京时间，身份来自当前认证账号，不能覆盖。
- `--all` 向所有正常账号的通知渠道广播，包括发送人；不是群内 @所有人，不接受正文中的飞书 `<at>` 标签。全员权限默认对所有账号关闭（包含管理员），管理员在「用户 → 操作菜单 → 权限设置」授权。发送前遵循用户授权的接收范围。
- `--dry-run` 检查内容、权限和接收范围，不调用飞书。未验证渠道或账号禁用明确列为无法投递；部分失败或没有接收人时退出码为 1，成功为 0。不要整批重发，确认后仅重试未成功的接收人。
- 单次投递并返回飞书接收结果，不代表用户已阅读；投递结果落库。此功能不复用求助/回复通知开关，已配置并验证飞书渠道即可接收。
