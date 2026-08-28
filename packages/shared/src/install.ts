/**
 * CLI 安装指令文案（平台自托管分发，不发 npm）。
 * server 的 GET /install/AGENT.md 与控制台安装页共用这一份，避免文案漂移。
 *
 * 给 Agent 的安装流程只装 CLI（决策 20）：有终端环境时 CLI 覆盖全部能力；
 * MCP 是给没有 shell 的 AI 客户端的接入方式，配置指引独立在 buildMcpSetupGuide。
 */
export function buildAgentInstallGuide(publicUrl: string): string {
  return `# 安装 easy-agent-team CLI（eat）—— 给 AI Agent 的指令

你在帮用户安装团队 AI 能力平台 easy-agent-team 的 CLI（命令名 \`eat\`）。平台地址：${publicUrl}

请按顺序执行：

1. **安装**（需要 Node.js >= 18 与 curl）：
   \`\`\`sh
   curl -fsSL ${publicUrl}/install.sh | sh
   \`\`\`
   脚本会把 CLI 装到 \`~/.eat/bin/eat\`，并自动配置 PATH：软链到 \`~/.local/bin\`（以及可写时的 \`/usr/local/bin\`），同时幂等写入 shell 配置（zsh 的 \`~/.zshenv\`、bash 的 \`~/.bashrc\` 等），新开终端与非交互 shell 都能直接用 \`eat\`。当前会话如找不到命令，先执行 \`export PATH="$HOME/.eat/bin:$PATH"\` 或直接用完整路径 \`~/.eat/bin/eat\`。

2. **登录**（设备码授权，需要用户参与）：
   \`\`\`sh
   eat login --server ${publicUrl}
   \`\`\`
   命令会输出一个链接和一个短码，然后阻塞等待授权。把链接和短码原样转告用户，请用户在浏览器打开链接、登录平台并输入短码确认；授权完成后命令自动结束，凭证保存在 \`~/.eat/credentials\`。

3. **同步团队能力**：
   \`\`\`sh
   eat sync
   \`\`\`
   会把有权限的 Skill 落地到 \`~/.agents/skills/\`（并软链到 \`~/.claude/skills/\`），其中始终包含平台内置的 \`eat-platform-guide\`——之后的 AI 会话读它就知道 eat 平台有哪些能力、该怎么用（先查经验再求助、无权限走申请等）。只想装进当前项目时用 \`eat sync --project\`（落 \`./.agents/skills/\` 并软链 \`./.claude/skills/\`）。

4. **验证**：\`eat whoami\` 应输出用户身份；失败则回到第 2 步重试。

装好后你就可以直接执行 \`eat\` 命令使用平台全部能力（env / skill / ask / db / deploy 等），无需其他配置。

注意：全程不要向用户索要密码，也不要试图绕过设备码授权；所有凭证只存放在 \`~/.eat/credentials\`。
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

前提：本机已完成 CLI 安装与登录（\`curl -fsSL ${publicUrl}/install.sh | sh\` + \`eat login --server ${publicUrl}\`）。MCP 复用 CLI 凭证（\`~/.eat/credentials\`），无需再登录。

- Claude Code：\`claude mcp add --scope user eat -- eat mcp\`（若 eat 不在 PATH，用 \`~/.eat/bin/eat\` 的完整路径）
- 其他 MCP 客户端：配置一个 stdio server，命令 \`eat\`、参数 \`mcp\`。

注册后客户端将获得平台全套 MCP 工具（环境变量清单/取值/权限申请、经验搜索、求助、部署等）。
`;
}
