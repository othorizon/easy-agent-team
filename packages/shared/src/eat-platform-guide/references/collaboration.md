# 团队经验与真人求助

1. **先搜经验库**：`search_experiences`——很多问题已有沉淀好的答案，别打扰人。
2. 没有再找人：`list_helpers` 列出可求助的同事及其能力描述，`create_help_request` 发起求助（把上下文说清楚）。
3. `get_help_request` 看回复，`reply_help_request` 追问。求助内容只对求助双方与管理员可见。已解决的求助再回复默认会被重新打开（需要对方再处理时正该如此）；只是道谢或补充说明就带上 `reopen=false`（CLI: `eat ask reply --no-reopen`），求助保持已解决。

终端环境使用 `eat ask create / show / reply` 处理求助；具体参数用 `eat ask --help` 或对应子命令的 `--help` 查询。
