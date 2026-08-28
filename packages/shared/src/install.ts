/**
 * CLI 安装指令文案（平台自托管分发，不发 npm）。
 * server 的 GET /install/AGENT.md 与控制台安装页共用这一份，避免文案漂移。
 */
export function buildAgentInstallGuide(publicUrl: string): string {
  return `# 安装 easy-agent-team CLI（eat）—— 给 AI Agent 的指令

你在帮用户安装团队 AI 能力平台 easy-agent-team 的 CLI（命令名 \`eat\`）。平台地址：${publicUrl}

请按顺序执行：

1. **安装**（需要 Node.js >= 18 与 curl）：
   \`\`\`sh
   curl -fsSL ${publicUrl}/install.sh | sh
   \`\`\`
   脚本会把 CLI 装到 \`~/.eat/bin/eat\`。若脚本提示需要手动配置 PATH，按提示处理；本次会话中也可以直接用完整路径 \`~/.eat/bin/eat\`。

2. **登录**（设备码授权，需要用户参与）：
   \`\`\`sh
   eat login --server ${publicUrl}
   \`\`\`
   命令会输出一个链接和一个短码，然后阻塞等待授权。把链接和短码原样转告用户，请用户在浏览器打开链接、登录平台并输入短码确认；授权完成后命令自动结束，凭证保存在 \`~/.eat/credentials\`。

3. **注册 MCP**（让本地 AI 能访问平台）：
   - Claude Code：\`claude mcp add --scope user eat -- eat mcp\`（若 eat 不在 PATH，用 \`~/.eat/bin/eat\` 的完整路径）
   - 其他 MCP 客户端：配置一个 stdio server，命令 \`eat\`、参数 \`mcp\`。MCP 复用 CLI 凭证，无需再登录。

4. **同步团队能力**：
   \`\`\`sh
   eat sync
   \`\`\`
   会把有权限的 Skill 落地到 \`~/.claude/skills/\`，并输出团队 MCP 配置的合并指引。

5. **验证**：\`eat whoami\` 应输出用户身份；失败则回到第 2 步重试。

注意：全程不要向用户索要密码，也不要试图绕过设备码授权；所有凭证只存放在 \`~/.eat/credentials\`。
`;
}
