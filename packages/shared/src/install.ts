/**
 * CLI 安装指令文案（平台自托管分发，不发 npm）。
 * server 的 GET /install/AGENT.md 与控制台安装页共用这一份，避免文案漂移。
 *
 * 给 Agent 的安装流程只装 CLI（决策 20）：有终端环境时 CLI 覆盖全部能力；
 * MCP 是给没有 shell 的 AI 客户端的接入方式，配置指引独立在 buildMcpSetupGuide。
 * 安装入口按平台成对提供（决策 24）：install.sh 与 install.ps1，指令里要求 Agent 先判断平台再选。
 * Windows 上只有 eat.cmd / eat 两个 shim（决策 29），指令里要写清楚「不要自己造 eat.ps1」。
 */
export function buildAgentInstallGuide(publicUrl: string): string {
  return `# 安装 easy-agent-team CLI（eat）—— 给 AI Agent 的指令

你在帮用户安装团队 AI 能力平台 easy-agent-team 的 CLI（命令名 \`eat\`）。平台地址：${publicUrl}

请按顺序执行：

1. **先判断操作系统，再选对应的安装命令**（都需要 Node.js >= 18）：

   - macOS / Linux / WSL / Git Bash：
     \`\`\`sh
     curl -fsSL ${publicUrl}/install.sh | sh
     \`\`\`
   - Windows 原生终端（PowerShell / cmd，非 WSL）：
     \`\`\`powershell
     powershell -ExecutionPolicy ByPass -c "irm ${publicUrl}/install.ps1 | iex"
     \`\`\`

   判断方法：Node 里看 \`process.platform === 'win32'\`，shell 里 \`uname\` 能跑就是类 Unix 环境。
   **不要在 Windows 原生终端执行 \`curl ... | sh\`**（Windows 没有 \`sh\`，且 PowerShell 5.1 的 \`curl\` 是 Invoke-WebRequest 的别名），也不要在 WSL 里执行 PowerShell 那条。

   两个脚本等价：把 CLI 装到 \`~/.eat/bin\`（Windows 为 \`%USERPROFILE%\\.eat\\bin\`）并自动配置 PATH——
   类 Unix 上软链到 \`~/.local/bin\`（以及可写时的 \`/usr/local/bin\`）并幂等写入 shell 配置（zsh 的 \`~/.zshenv\`、bash 的 \`~/.bashrc\` 等）；
   Windows 上生成 \`eat.cmd\`（cmd / PowerShell / 子进程通用）与 \`eat\`（Git Bash）两个入口并写入用户级 PATH（新开终端生效）。
   **Windows 上没有也不要自己造 \`eat.ps1\`**：PowerShell 选命令时 \`.ps1\` 优先于 \`.cmd\`，而它默认的 ExecutionPolicy 是 Restricted，
   落了 \`.ps1\` 只会让 \`eat\` 报「无法加载文件……因为在此系统上禁止运行脚本」；\`.cmd\` 不受执行策略约束，PowerShell 里直接敲 \`eat\` 即可。
   当前会话如找不到命令：类 Unix 执行 \`export PATH="$HOME/.eat/bin:$PATH"\`，PowerShell 执行 \`$env:Path = "$HOME\\.eat\\bin;$env:Path"\`，或直接用完整路径调用
   （Windows 兜底：\`cmd /c eat <子命令>\` 或 \`node "%USERPROFILE%\\.eat\\bin\\eat.js" <子命令>\`）。
   注意：安装写的是**用户级** PATH，只对新进程生效——如果你（AI 客户端）在安装前就已启动，你拉起的终端继承的仍是旧 PATH，
   这不是安装失败：本次会话用上面的临时 PATH 或完整路径继续，并告诉用户重启客户端后即可直接用 \`eat\`。

2. **登录**（设备码授权，需要用户参与）。**你（AI）执行时用非阻塞的两步，不要用会阻塞的 \`eat login\`**：

   \`\`\`sh
   eat login --server ${publicUrl} --no-wait
   \`\`\`
   命令输出一个链接和一个短码后**立即返回**。把链接和短码原样转告用户，请用户在浏览器打开链接、登录平台并输入短码确认（链接自带短码，点开确认即可）。

   \`\`\`sh
   eat login --status
   \`\`\`
   用户说确认好了，就执行这条领取凭证（同样立即返回）：打印 \`状态：approved\` 表示成功，凭证保存在 \`~/.eat/credentials.json\`；打印 \`状态：pending\` 表示用户还没确认，命令以**退出码 2** 结束——这不是失败，等一会儿再查一次即可（要等的是用户，反复重跑第一步没有意义：它会沿用同一个未完成的授权，转告过的短码不会因此作废）。授权码有效期 10 分钟，过期（\`状态：expired\`）才回到第一步重来。

   不带 \`--no-wait\` 的 \`eat login\` 会一直阻塞到用户确认或授权码过期，适合用户自己在终端里敲，不适合你代为执行。

3. **同步团队能力**。**先确认你（这个 AI 客户端）的 skill 该放在哪，再决定用哪条命令**：

   - 你遵循 \`.agents\` / \`.claude\` 目录规范（Claude Code 等）：
     \`\`\`sh
     eat sync
     \`\`\`
     Skill 落地到 \`~/.agents/skills/\`，并同步一份到 \`~/.claude/skills/\`（类 Unix 用软链，Windows 因为建软链需要管理员权限，改为复制实文件，行为等价）。只想装进当前项目时用 \`eat sync --project\`（落 \`./.agents/skills/\` 并同步到 \`./.claude/skills/\`）。
   - **你不用这套目录规范**（自己有 skill / 提示词目录，或跑在容器、自建 Agent 框架里）：
     \`\`\`sh
     eat sync --dir <你的 skill 目录>
     \`\`\`
     Skill 直接落在这个目录下（每个 skill 一个子目录），**不创建 \`.agents\`，也不碰 \`.claude\`**。

   不管用哪条，落地内容里始终包含平台内置的 \`eat-platform-guide\`——之后的 AI 会话读它就知道 eat 平台有哪些能力、该怎么用（先查经验再求助、无权限走申请等）。

   **显式指定过的落点会被记住**：带 \`--dir\` / \`--project\` / \`--global\` 跑过一次之后，以后裸跑 \`eat sync\` 就继续落到同一个地方，不必每次都带参数（\`eat config list\` 可以查当前落点）。这一点很重要——后面收到「团队 Skill 有变更」的提示时，照着提示执行的就是裸的 \`eat sync\`。
   拿不准会装到哪，先跑 \`eat sync --dry-run\` 看一眼：它只打印落点和将要新增/更新/移除的内容，不写任何文件。

4. **验证**：\`eat whoami\` 应输出用户身份；失败则回到第 2 步重试。

之后 CLI 或团队 Skill 有更新时，\`eat\` 命令会在 stderr 附一行提示（不影响命令结果，同一版本只提示一次）：CLI 更新执行 \`eat self-update\`（跨平台同一条命令，不用重跑本安装脚本），Skill 更新执行 \`eat sync\`——提示里会写明落点，裸跑即可，**不要自作主张加 \`--global\` / \`--project\`**，那会把 skill 装到和当初不同的地方。

装好后你就可以直接执行 \`eat\` 命令使用平台全部能力（env / skill / ask / db / app / deploy 等），无需其他配置。

注意：全程不要向用户索要密码，也不要试图绕过设备码授权；所有凭证只存放在 \`~/.eat/credentials.json\`。
`;
}

/**
 * MCP 配置指引（独立板块，决策 55 后分两条路）：
 * - 云端 AI 服务：平台自己的 Streamable HTTP 端点 `<平台>/mcp` + 请求头里的 API Key；
 * - 本机没有 shell 的客户端：仍走 `eat mcp`（stdio），复用 CLI 凭证。
 * 有终端的 Agent 装 CLI 即可，两条都不需要。
 */
export function buildMcpSetupGuide(publicUrl: string): string {
  return `# eat MCP 接入

eat 的全部能力都可以通过 \`eat\` CLI 使用——**AI Agent 有 shell 环境时，装好 CLI 即可，无需配置 MCP**。
装不了 CLI 的客户端按下面两种方式之一接入。

## 一、云端 AI 服务（标准 HTTP MCP，推荐）

跑在别人机器上的 AI 服务（各家云端 Agent 平台、工作流编排、团队里的自建服务）装不了 CLI、也读不到你本地的凭证文件，用平台自己的 MCP 端点接入：

- **接入地址**：\`${publicUrl}/mcp\`（Streamable HTTP，无状态）
- **鉴权**：请求头 \`Authorization: Bearer <API Key>\`；客户端不支持自定义 Authorization 时用 \`X-API-Key: <API Key>\` 也认。
  **不要把密钥放进 URL**——URL 会被各级日志记下来。
- **API Key 从哪来**：登录平台控制台 → 「安装与接入」页 → 「我的 API 密钥」→ 生成。明文只显示一次；密钥代表**你本人**的权限，平台按你的身份审计，给每个接入的服务单独生成一把，不用了随时吊销。

多数客户端通用的 JSON 配置：

\`\`\`json
{
  "mcpServers": {
    "eat": {
      "type": "http",
      "url": "${publicUrl}/mcp",
      "headers": { "Authorization": "Bearer <你的 API Key>" }
    }
  }
}
\`\`\`

Claude Code 一条命令即可：

\`\`\`sh
claude mcp add --transport http eat ${publicUrl}/mcp --header "Authorization: Bearer <你的 API Key>"
\`\`\`

接入后客户端会拿到平台全套工具（环境变量清单与取值、权限申请、经验搜索、求助、应用创建与 env、部署与日志）。
让 AI 先调一次 \`get_platform_guide\` 读平台使用指南——云端客户端没有 \`eat sync\` 那条路，行为规范只能靠这个工具取回去。

## 二、本机客户端（stdio）

本机上不能执行 shell 命令的 AI 客户端，把 CLI 注册成 stdio MCP server。
前提：本机已完成 CLI 安装与登录（macOS/Linux 用 \`curl -fsSL ${publicUrl}/install.sh | sh\`，Windows 用 \`powershell -ExecutionPolicy ByPass -c "irm ${publicUrl}/install.ps1 | iex"\`，随后 \`eat login --server ${publicUrl}\`）。stdio 方式复用 CLI 凭证（\`~/.eat/credentials.json\`），不需要 API Key。

- Claude Code（macOS / Linux）：\`claude mcp add --scope user eat -- eat mcp\`
- Claude Code（Windows）：\`claude mcp add --scope user eat -- cmd /c eat mcp\`
  Windows 上 \`eat\` 实际是 \`eat.cmd\`，而 Node 出于安全不允许不经 shell 直接拉起 \`.cmd\`，所以要加 \`cmd /c\`。
- 其他 MCP 客户端：配置一个 stdio server，命令 \`eat\`、参数 \`mcp\`（Windows 为命令 \`cmd\`、参数 \`/c eat mcp\`）。
- 兜底写法（\`eat\` 不在 PATH，或客户端不走 shell）：命令 \`node\`、参数 \`<CLI 路径>/eat.js mcp\`——
  类 Unix 是 \`~/.eat/bin/eat.js\`，Windows 是 \`%USERPROFILE%\\.eat\\bin\\eat.js\`（配置里请写展开后的绝对路径）。

两条路的工具集一致，只有一处差别：本地 stdio 的 \`trigger_deploy\` 会先扫描本地代码再部署，HTTP 端点没有本地代码可扫，触发的部署会被标成「未做密钥扫描」。
`;
}
