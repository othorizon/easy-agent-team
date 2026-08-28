import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import * as fs from 'node:fs';
import { buildAgentInstallGuide } from '@eat/shared';
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

LINKED=""
if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  ln -sf "$BIN_DIR/eat" /usr/local/bin/eat && LINKED="/usr/local/bin/eat"
fi

echo ""
echo "✅ eat CLI 安装完成：$BIN_DIR/eat（$("$BIN_DIR/eat" --version)）"
if [ -n "$LINKED" ]; then
  echo "已链接到 $LINKED，可直接使用 eat 命令。"
else
  echo "请把下面这行加入 ~/.bashrc 或 ~/.zshrc，然后重开终端："
  echo '  export PATH="$HOME/.eat/bin:$PATH"'
fi
echo ""
echo "下一步："
echo "  1. eat login --server $SERVER    # 浏览器完成设备码授权"
echo "  2. eat sync                      # 同步团队 Skill 与 MCP 配置"
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

  /** 给 AI Agent 看的安装指令（控制台安装页提供一键复制，也可直接 curl 本地址） */
  @Public()
  @Get('install/AGENT.md')
  @Header('content-type', 'text/markdown; charset=utf-8')
  agentGuide(): string {
    const { publicUrl } = loadConfig();
    return buildAgentInstallGuide(publicUrl);
  }
}
