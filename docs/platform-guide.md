# 内置平台指南的组织与分发

`eat-platform-guide` v37 使用精简入口与按任务加载的参考文件。设计依据是 [OpenAI Skill Creator](https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md) 和 [Claude Skill Creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md) 对渐进披露、明确触发描述和主题组织的建议。

## 源文件

```text
packages/shared/src/eat-platform-guide/
├── SKILL.md
├── agents/openai.yaml
└── references/
    ├── access.md
    ├── environment.md
    ├── databases.md
    ├── llm-api.md
    ├── applications.md
    ├── folio.md
    ├── skills-and-mcp.md
    ├── collaboration.md
    └── updates.md
```

`SKILL.md` 的 frontmatter 描述触发场景，正文提供任务导航、读取方法及通用行为规则。每个参考文件对应一个平台主题，全部直接链接在入口中；复合任务逐步读取相关主题。LLM 参考文件保留 New API 官方调用文档与接入地址、个人 Key 的使用指引。

源码使用真实 Markdown/YAML 文件，`platform-guide.ts` 只维护文件清单和版本。shared 构建将文本嵌入 ESM/CJS 产物，运行时无需读文件或依赖额外部署目录，Web、服务端与 CLI 仍共用相同的内容。`agents/openai.yaml` 提供 Codex 展示元数据；其他客户端继续读取标准的 `SKILL.md` 与参考文件。

## 本地与远程读取

`eat sync` 通过原有 `SyncSkill.content` 与 `files` 协议分发完整目录。v36 的单文件受管目录会在升级时被替换为入口及参考文件，原有 `.agents` 落点、`.claude` 软链或 Windows 副本继续工作；`--dry-run` 不创建文件。

远程 MCP 的 `get_platform_guide` 不传参数时返回入口与文件路径清单，不返回各主题正文；传 `path` 时只返回一个文件：

```json
{ "path": "references/llm-api.md" }
```

`path: "SKILL.md"` 同样读取入口。路径只能匹配内置清单，不访问运行机器的文件系统。无 shell 的客户端按入口选择主题，有本地 Skill 的客户端直接读取相对路径。

## 维护与验证

内容只维护在 Markdown 中，平台展示的触发描述从入口 frontmatter 读取。添加主题时，同时更新入口导航和 `platform-guide.ts` 文件清单；修改入口、参考文件或元数据后，递增 `PLATFORM_GUIDE_VERSION`，让既有指纹机制提示用户同步。同步前仍遵循用户授权与已配置落点，不自动执行客户端更新。

结构检查覆盖实际构建产物与源文件一致、链接可达、入口保持精简。集成检查覆盖 v36 升级、多文件落盘、软链和副本、重复同步与预演，以及远程按主题读取和非法路径。

用于检查任务导航和关键流程的场景：

| 用户任务 | 应读取的主题 | 需要保留的行为 |
|---|---|---|
| 使用团队模型写调用代码 | LLM API | 查询实际模型，导出个人 Key，先阅读官方 API 文档 |
| 获取已有业务库的只读连接串 | 环境变量 | 先查清单，取值无权限时申请 |
| 给自己的应用申请数据库 | 数据库 | 先查已有分配，按需申请独立账号 |
| 发布带密码的静态报告 | Folio | 遵循已确认的访问选择，交付分享链接及有效期 |
| 部署后接口报错 | 应用与部署 | 区分部署状态、构建日志与运行日志 |
| 同步 Skill 或处理更新提示 | 同步与更新 | 沿用已配置落点，按用户授权更新 |
