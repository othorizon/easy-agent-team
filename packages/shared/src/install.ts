/**
 * CLI 安装指令文案（平台自托管分发，不发 npm）。
 * server 的 GET /install/AGENT.md 与控制台安装页共用这一份，避免文案漂移。
 *
 * 给 Agent 的安装流程只装 CLI（决策 20）：有终端环境时 CLI 覆盖全部能力；
 * MCP 是给没有 shell 的 AI 客户端的接入方式，配置指引独立在 buildMcpSetupGuide。
 * 安装入口按平台成对提供（决策 24）：install.sh 与 install.ps1，指令里要求 Agent 先判断平台再选。
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
   Windows 上生成 \`eat.cmd\` / \`eat.ps1\` / \`eat\` 三个入口并写入用户级 PATH（新开终端生效）。
   当前会话如找不到命令：类 Unix 执行 \`export PATH="$HOME/.eat/bin:$PATH"\`，PowerShell 执行 \`$env:Path = "$HOME\\.eat\\bin;$env:Path"\`，或直接用完整路径调用。

2. **登录**（设备码授权，需要用户参与）：
   \`\`\`sh
   eat login --server ${publicUrl}
   \`\`\`
   命令会输出一个链接和一个短码，然后阻塞等待授权。把链接和短码原样转告用户，请用户在浏览器打开链接、登录平台并输入短码确认；授权完成后命令自动结束，凭证保存在 \`~/.eat/credentials.json\`。

3. **同步团队能力**：
   \`\`\`sh
   eat sync
   \`\`\`
   会把有权限的 Skill 落地到 \`~/.agents/skills/\`，并同步一份到 \`~/.claude/skills/\`（类 Unix 用软链，Windows 因为建软链需要管理员权限，改为复制实文件，行为等价）。其中始终包含平台内置的 \`eat-platform-guide\`——之后的 AI 会话读它就知道 eat 平台有哪些能力、该怎么用（先查经验再求助、无权限走申请等）。只想装进当前项目时用 \`eat sync --project\`（落 \`./.agents/skills/\` 并同步到 \`./.claude/skills/\`）。

4. **验证**：\`eat whoami\` 应输出用户身份；失败则回到第 2 步重试。

装好后你就可以直接执行 \`eat\` 命令使用平台全部能力（env / skill / ask / db / deploy 等），无需其他配置。

注意：全程不要向用户索要密码，也不要试图绕过设备码授权；所有凭证只存放在 \`~/.eat/credentials.json\`。
`;
}

/**
 * MCP 配置指引（独立板块）：只给没有 shell 环境、无法直接执行 eat 命令的
 * AI 客户端用；有终端的 Agent 装 CLI 即可，不需要配置 MCP。
 */
export function buildMcpSetupGuide(publicUrl: string): string {
  return `# eat MCP 配置（给没有终端的 AI 客户端）

eat 的全部能力都可以通过 \`eat\` CLI 使用——**AI Agent 有 shell 环境时，装好 CLI 即可，无需配置 MCP**。
只有当 AI 客户端不能执行 shell 命令时，才把 eat 注册为 MCP server 接入平台。

前提：本机已完成 CLI 安装与登录（macOS/Linux 用 \`curl -fsSL ${publicUrl}/install.sh | sh\`，Windows 用 \`powershell -ExecutionPolicy ByPass -c "irm ${publicUrl}/install.ps1 | iex"\`，随后 \`eat login --server ${publicUrl}\`）。MCP 复用 CLI 凭证（\`~/.eat/credentials.json\`），无需再登录。

- Claude Code（macOS / Linux）：\`claude mcp add --scope user eat -- eat mcp\`
- Claude Code（Windows）：\`claude mcp add --scope user eat -- cmd /c eat mcp\`
  Windows 上 \`eat\` 实际是 \`eat.cmd\`，而 Node 出于安全不允许不经 shell 直接拉起 \`.cmd\`，所以要加 \`cmd /c\`。
- 其他 MCP 客户端：配置一个 stdio server，命令 \`eat\`、参数 \`mcp\`（Windows 为命令 \`cmd\`、参数 \`/c eat mcp\`）。
- 兜底写法（\`eat\` 不在 PATH，或客户端不走 shell）：命令 \`node\`、参数 \`<CLI 路径>/eat.js mcp\`——
  类 Unix 是 \`~/.eat/bin/eat.js\`，Windows 是 \`%USERPROFILE%\\.eat\\bin\\eat.js\`（配置里请写展开后的绝对路径）。

注册后客户端将获得平台全套 MCP 工具（环境变量清单/取值/权限申请、经验搜索、求助、部署等）。
`;
}
