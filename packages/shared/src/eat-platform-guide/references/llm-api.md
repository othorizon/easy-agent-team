# LLM API 网关与模型调用

团队管理员配置 New API 公共账户后，每位成员（包括管理员）可以在控制台“LLM API 网关”或通过 `eat llm key create` 申请一把自己的模型 API Key，不需要单独注册 New API。用 `eat llm status` 查看总额度、已用和剩余额度，`eat llm models` 查模型，`eat llm usage` 查消耗。此模型 Key 与 EAT 登录凭证、HTTP MCP 的平台 API Key 是三种不同凭证，不能混用。

`eat llm key show` 默认显示状态与掩码；显式加 `--reveal`（`eat llm key show --reveal`）时仅向标准输出打印完整 Key 一行，便于终端查看或脚本读取。需要配置客户端时仍可用 `eat llm key export --out <新文件>`，将连接地址和 Key 写入文件。AI 默认使用导出方式，不要未经用户要求将密钥写进对话。`eat llm key enable/disable/delete` 管理自己的 Key，`eat llm key history` 查历史，`eat llm usage --key <历史ID>` 查旧记录，`eat llm retry` 恢复待确认操作。删除重建保留剩余额度和消耗，不重复赠送。金额只由管理员在控制台分配，CLI 不提供管理员调额或系统配置功能。模型请求直接发往返回的 New API 接入地址；禁用或额度耗尽时联系管理员。

**编写模型调用代码或配置 SDK 前，先阅读 [New API 官方 API 文档](https://docs.newapi.pro/zh/docs/api)**，从中确认所用协议的请求路径、鉴权方式、参数和流式响应处理。用 `eat llm models` 查询实际可用的模型 ID；从导出文件读取 `apiBaseUrl` 和 `apiKey` 供客户端使用。将文档示例中的服务地址替换为 EAT 返回的接入地址，按所选协议组合路径，避免重复拼接 `/v1`。调用使用个人模型 API Key，不使用 EAT 登录凭证或 New API 系统访问令牌；密钥只在进程或可信客户端中读取，不写入源码、日志或对话。
