# 身份与登录

## 选择接入方式

- CLI 和本机 stdio MCP：使用 `eat login` 授权后的个人凭证，保存在 `~/.eat/credentials.json`。stdio MCP 复用同一身份。
- 云端 HTTP MCP：连接平台的 `/mcp`，以控制台“安装与接入”中生成的个人平台 API Key 鉴权；权限属于该 Key 的主人。
- 模型调用：使用“LLM API 网关”中的个人模型 API Key，调用 New API 接入地址。它与前两类凭证不同，不能混用。

## 非阻塞登录

1. 用 `eat whoami` 确认当前身份；未登录或凭证失效时执行 `eat login --no-wait`。
2. 把命令打印的授权链接和代码转告用户，等待用户在浏览器确认。
3. 执行 `eat login --status` 领取凭证。`状态：pending` 和退出码 2 表示尚未确认，不是失败；等待后再查询，不重复发起登录。

不要直接执行会阻塞等待浏览器授权的裸 `eat login`，它可能占用当前会话直到授权或 10 分钟过期。首次连接不同平台时按 `eat login --help` 指定服务地址。

只把凭证配进可信客户端或当前进程，不复制到对话、源码或日志。MCP 接入地址中的个人随机串同样是凭证。

## 统一申请与驳回原因

环境变量、MCP 配置订阅、数据库、OSS 空间和应用部署的申请都可在控制台「权限申请」中查询。默认查看待办；处理完的申请进入历史，同一事项可展开查看历次申请。

- `eat requests list`：分页查看我发起的各类申请。
- `eat requests list --status rejected`：只看驳回结果，列表直接显示原因；用 `--type env|mcp|db|oss|app` 筛选类型。
- `eat requests show <申请ID>`：完整理由、审批人、处理时间与历史轮次；两种查询都支持 `--json`。
- MCP：`list_requests` / `get_request_status`，本机与远程接入一致，只能读取本人或已有权限范围内的数据。
- 不再需要的待审批申请可以 `eat requests withdraw <申请ID>`；根据驳回理由修改说明后可用 `eat requests resubmit <申请ID> --reason "修改后的用途"` 重新申请。不得自动循环提交。

“已批准 · 开通失败”表示审批通过但资源执行失败，应查看资源详情修复，不重新申请。旧数据未保存的理由与处理时间显示“未记录”。
