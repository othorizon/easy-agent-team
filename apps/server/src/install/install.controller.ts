import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import * as fs from 'node:fs';
import { buildAgentInstallGuide, buildMcpSetupGuide } from '@eat/shared';
import { Public } from '../auth/auth.decorators';
import { loadConfig } from '../config';

/**
 * CLI 自托管分发：不发 npm，成员从平台直接下载安装。
 * 三个端点均免鉴权——CLI 产物不是秘密，且 curl | sh 时用户尚无 Token。
 */
@Controller()
export class InstallController {
  /** 安装脚本：下载 eat.js 到 ~/.eat/bin 并生成 eat 启动器（前提：本机 Node >= 18） */
  @Public()
  @Get('install.sh')
  @Header('content-type', 'text/x-shellscript; charset=utf-8')
  installScript(): string {
    const { publicUrl } = loadConfig();
    return `#!/bin/sh
# easy-agent-team CLI（eat）安装脚本 —— 由平台生成
# 用法: curl -fsSL ${publicUrl}/install.sh | sh
set -e

SERVER="\${EAT_SERVER:-${publicUrl}}"
BIN_DIR="$HOME/.eat/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 Node.js。eat 需要 Node.js >= 18（使用 Claude Code 的机器通常已具备）。" >&2
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：Node.js 版本过低（当前 $(node -v)），需要 >= 18。" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
echo "从 $SERVER 下载 eat CLI ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SERVER/install/eat.js" -o "$BIN_DIR/eat.js"
else
  wget -qO "$BIN_DIR/eat.js" "$SERVER/install/eat.js"
fi

cat > "$BIN_DIR/eat" <<'LAUNCHER'
#!/bin/sh
exec node "$HOME/.eat/bin/eat.js" "$@"
LAUNCHER
chmod +x "$BIN_DIR/eat"

# —— PATH 落地：三层叠加（均幂等），让交互式与非交互式 shell 都能找到 eat ——
LINKED=""

# 1) ~/.local/bin：XDG 惯例位置，多数 Linux 默认在 PATH，无需 sudo
mkdir -p "$HOME/.local/bin"
ln -sf "$BIN_DIR/eat" "$HOME/.local/bin/eat" && LINKED="$HOME/.local/bin/eat"

# 2) /usr/local/bin：系统级 PATH（非交互 shell / cron / Agent 子进程也可见），可写时顺带链接
if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  ln -sf "$BIN_DIR/eat" /usr/local/bin/eat && LINKED="/usr/local/bin/eat $LINKED"
fi

# 3) 幂等写 shell 配置，兜住前两层的盲区（macOS zsh 默认 PATH 无 ~/.local/bin 等）：
#    zsh 写 ~/.zshenv（所有 zsh 进程都会加载，含非交互）；bash 写 ~/.bashrc；
#    登录 shell 写 ~/.bash_profile，但它会屏蔽 ~/.profile——仅存在 ~/.profile 时改写后者
PATH_LINE='export PATH="$HOME/.eat/bin:$HOME/.local/bin:$PATH"'
MARKER='# easy-agent-team CLI (eat) PATH'
append_path() {
  if [ -f "$1" ] && grep -qF "$MARKER" "$1" 2>/dev/null; then return 0; fi
  printf '\\n%s\\n%s\\n' "$MARKER" "$PATH_LINE" >> "$1"
}
append_path "$HOME/.zshenv"
append_path "$HOME/.bashrc"
if [ -f "$HOME/.profile" ] && [ ! -f "$HOME/.bash_profile" ]; then
  append_path "$HOME/.profile"
else
  append_path "$HOME/.bash_profile"
fi

echo ""
echo "✅ eat CLI 安装完成：$BIN_DIR/eat（$("$BIN_DIR/eat" --version)）"
echo "已链接：$LINKED"
echo "已写入 shell 配置（zsh/bash，重复安装不会重复写入）。"
echo "新开的终端可直接使用 eat；当前终端如找不到，先执行："
echo '  export PATH="$HOME/.eat/bin:$PATH"'
echo ""
echo "下一步："
echo "  1. eat login --server $SERVER    # 浏览器完成设备码授权"
echo "  2. eat sync                      # 同步团队能力（Skill 等落地本地）"
`;
  }

  /** CLI 单文件产物（tsup 打包，Node >= 18 可直接运行）。手动控制响应：缺产物必须回真 404，curl -f 才能失败 */
  @Public()
  @Get('install/eat.js')
  cliBundle(@Res() reply: FastifyReply) {
    const { cliDistPath } = loadConfig();
    if (!fs.existsSync(cliDistPath)) {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: 'CLI 产物未就绪：请确认部署时包含 apps/cli/dist（或配置 EAT_CLI_DIST 指向单文件产物）',
      });
    }
    return reply
      .type('application/javascript; charset=utf-8')
      .header('content-disposition', 'attachment; filename="eat.js"')
      .send(fs.readFileSync(cliDistPath, 'utf8'));
  }

  /** 给 AI Agent 看的安装指令（控制台安装页提供一键复制，也可直接 curl 本地址）。只装 CLI，不含 MCP（决策 20） */
  @Public()
  @Get('install/AGENT.md')
  @Header('content-type', 'text/markdown; charset=utf-8')
  agentGuide(): string {
    const { publicUrl } = loadConfig();
    return buildAgentInstallGuide(publicUrl);
  }

  /** MCP 配置指引（独立板块）：仅无 shell 环境的 AI 客户端需要 */
  @Public()
  @Get('install/MCP.md')
  @Header('content-type', 'text/markdown; charset=utf-8')
  mcpGuide(): string {
    const { publicUrl } = loadConfig();
    return buildMcpSetupGuide(publicUrl);
  }
}
