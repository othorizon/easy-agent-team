# LLM API 网关

EAT 使用一个 New API 公共账户。管理员和成员都可以申请自己的模型 API Key，每人最多保留一把有效 Key；所有 Key 均归公共账户所有，不为每位 EAT 用户创建 New API 账户。

## 管理员配置

1. 在 New API 准备专用普通账户，配置好可用模型、渠道和钱包余额。
2. 在该账户的“安全与访问”中生成**系统访问令牌**。它用于 EAT 管理 Key，与调用模型的 API Key 不同。
3. 打开 EAT“系统设置 → LLM API 网关设置”，填写 New API 站点根 URL 和系统访问令牌，测试连接后保存。不需要填写 New API 用户 ID。
4. 首次保存后按识别到的币种配置默认赠送金额，默认 0。公共账户余额仅管理员可见，每 30 秒刷新；“成员与额度”中可以配置个人首次赠送、调整已申请成员的剩余额度、禁用或恢复网关权限。

令牌由 EAT 的 `EAT_KEK` 加密存储，页面不返回明文；留空保存保留原令牌。已有 Key 后，只允许同实例同账户轮换令牌，不能直接更换实例或账户。生产环境必须妥善保管 `EAT_KEK`。

公共账户的钱包与个人 Key 的消费限制分别管理。增加某个 Key 的额度不会充值公共账户钱包；公共钱包不足会影响所有成员。New API 默认限制一个账户最多 1000 把 Key（可在 New API 调整）；停用的历史记录同样计入数量。

在 New API 开启 `DisplayTokenStatEnabled`（按令牌展示统计），使兼容 billing 查询返回个人 Key 的统计，而非公共账户的汇总。EAT 新建 Key 同时设置 `allow_user_quota_query=false`，在支持该字段的 New API 版本中关闭 Key 对公共钱包统计的查询。

## 个人使用

在“LLM API 网关 → 我的 API Key”申请 Key，查看总额度、已用额度、剩余额度，复制 Key 和 OpenAI 兼容接入地址，在模型客户端中使用。模型请求直接发送到 New API，不经过 EAT 转发。

个人只能查看、取用和管理自己的 Key，不能修改额度。管理员也可以申请自己的 Key；管理员管理成员时只看到状态和额度，看不到成员密钥明文。

编写模型调用代码或配置 SDK 前，先阅读 [New API 官方 API 文档](https://docs.newapi.pro/zh/docs/api)，按所选协议确认请求路径、鉴权、参数和流式响应处理。通过 `eat llm models` 获取实际可用的模型 ID，通过 `eat llm key export --out <新文件>` 导出 `apiBaseUrl` 与 `apiKey`。将文档示例中的服务地址替换为 EAT 返回的接入地址，按协议组合路径，避免重复拼接 `/v1`；使用个人模型 Key，不能混用 EAT 登录凭证或 New API 系统访问令牌。

未申请成员的个人赠送配置为空时，使用**首次申请时**的全局配置；明确填写 0 表示不赠送。赠送只领取一次。删除后重新申请，保留剩余额度及历史消耗，不会重新发放赠送。

删除会先停用 Key，移除 EAT 当前 Key 的绑定，并保留一条不可再取用的停用上游记录，以继续接收在途扣费或退款。历史消耗可以在页面的 Key 历史选择器或 CLI 中查询。后台每 30 秒核对历史记录并调整当前 Key 的余额；此时页面可能短暂显示上次同步的余额。不要在 New API 中手工删除或修改 EAT 管理的 Key，否则历史核对可能无法完成。

禁用网关权限会停用对应 Key 并阻止重新申请。禁用 EAT 账户也会同步停用 Key；同步失败有持久化记录并自动重试。恢复权限不会覆盖用户自己主动停用 Key 的选择。操作处理中不表示上游已经撤销，控制台会显示同步状态和错误；已经在途的请求仍由 New API 结算。

## 额度与一致性

金额按 New API 返回的 `quota_per_unit`、展示币种及汇率换算，内部使用安全整数 quota，数据库使用 bigint。管理员可以增加、减少或设置剩余额度；不允许将剩余额度设置为负数。

EAT **直接调用原版 `PUT /api/token/` 配置接口**，保留名称、过期时间等原有配置。它是覆盖剩余额度，不是 New API 提供的原子加款接口。EAT 用持久化操作标识和用户锁防止重复点击、重试造成重复分配；发生响应丢失时，根据已经记录的目标总额度及上游最新消耗重新确认结果。

本期接受 New API 原生接口在保存配置与模型扣费并发时可能产生的余额覆盖偏差，调额与启停均直接使用现有接口，不修改 New API，也不将严格并发一致性作为上线条件。申请、启用和调额在配置完成后直接可用，无须额外预览开关。行为依据见 [原生额度配置说明](llm-gateway-consistency.md)。同步失败时应重试原操作或等待后台同步，避免另建请求重复加额。

首次创建响应不确定时，EAT 按稳定名称查询原请求结果，不盲目重发创建。若请求一直没有产生可查询记录，会保持“正在确认”，需要管理员检查 New API 请求结果；这是为了避免生成重复 Key。

## CLI

```bash
eat llm status
eat llm models
eat llm usage --page 1
eat llm key create
eat llm key show
eat llm key disable
eat llm key enable
eat llm key delete
eat llm key history
eat llm usage --key <历史Key的EAT-ID>
eat llm retry
eat llm key export --out ./model-client.json
```

`show` 只输出掩码。`export` 向一个新文件写入 `{ apiBaseUrl, apiKey }`，在 Unix 上设为 0600，不输出密钥明文，不覆盖已有文件或软链接。管理员配置及调额能力不加入 CLI。网络中断时 CLI 会提供操作标识，可用 `--request-id <UUID>` 重试同一个创建、启停或删除操作。写操作返回“正在同步”时退出码为 2，可运行 `eat llm retry` 恢复。

## 升级与验收

执行 `pnpm db:migrate` 应用 `0026_llm_gateway.sql`，升级 Web 和服务端，并更新 CLI 到 0.10.0。现有用户不会自动产生 Key 或消耗赠送额度。

后端测试使用普通账户语义的 New API 模拟服务和真实 PostgreSQL，覆盖权限、加密、单 Key、赠送、丢失响应、额度变化、停用历史、账户禁用及重启恢复。CLI 测试覆盖金额换算、个人命令范围和密钥文件权限。实际连接前应确认网关日志记录已开启，账户允许的 Key 数量足够，并通过小额度调用核对实例上的扣费行为。
