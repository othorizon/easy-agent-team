import { buildAgentInstallGuide } from '@eat/shared';
import { App, Button, Card, Divider, Space, Steps, Typography } from 'antd';

/** 单条可复制命令 */
function Cmd({ text }: { text: string }) {
  return (
    <Typography.Paragraph style={{ marginBottom: 8 }}>
      <Typography.Text code copyable={{ text }}>
        {text}
      </Typography.Text>
    </Typography.Paragraph>
  );
}

/** 安装页：主推「复制指令给自己的 AI Agent 去装」，手动步骤作为兜底 */
export function InstallPage() {
  const { message } = App.useApp();
  const origin = window.location.origin;
  const agentPrompt = `请帮我安装团队 AI 能力平台的 CLI，按下面的指令执行：\n\n${buildAgentInstallGuide(origin)}`;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="🤖 让你的 AI 帮你装（推荐）">
        <Typography.Paragraph type="secondary">
          复制下面整段指令，粘贴给你的 AI Agent（Claude Code 等），它会完成安装、登录引导和 MCP
          配置。登录环节会给你一个链接和短码，在浏览器里确认一下就行。
        </Typography.Paragraph>
        <Button
          type="primary"
          onClick={() => {
            void navigator.clipboard.writeText(agentPrompt).then(
              () => message.success('已复制，粘贴给你的 AI Agent 即可'),
              () => message.error('复制失败，请手动选中下方文本复制'),
            );
          }}
        >
          一键复制 Agent 安装指令
        </Button>
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            background: 'rgba(0,0,0,0.04)',
            borderRadius: 8,
            maxHeight: 320,
            overflow: 'auto',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {agentPrompt}
        </pre>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这份指令也可以直接由 Agent 获取：<Typography.Text code copyable={{ text: `${origin}/install/AGENT.md` }}>{origin}/install/AGENT.md</Typography.Text>
        </Typography.Paragraph>
      </Card>

      <Card title="🛠️ 手动安装">
        <Typography.Paragraph type="secondary">
          前提：本机有 Node.js ≥ 18（使用 Claude Code 的机器都满足）。CLI 由平台直接分发，无需 npm registry。
        </Typography.Paragraph>
        <Steps
          direction="vertical"
          current={-1}
          items={[
            {
              title: '安装 CLI',
              description: <Cmd text={`curl -fsSL ${origin}/install.sh | sh`} />,
            },
            {
              title: '登录（设备码授权）',
              description: (
                <>
                  <Cmd text={`eat login --server ${origin}`} />
                  <Typography.Text type="secondary">命令会输出链接和短码，浏览器打开确认即可。</Typography.Text>
                </>
              ),
            },
            {
              title: '注册 MCP 到 Claude Code',
              description: (
                <>
                  <Cmd text="claude mcp add --scope user eat -- eat mcp" />
                  <Typography.Text type="secondary">其他 MCP 客户端：stdio 方式运行 eat mcp，凭证自动复用。</Typography.Text>
                </>
              ),
            },
            {
              title: '同步团队能力',
              description: (
                <>
                  <Cmd text="eat sync" />
                  <Typography.Text type="secondary">
                    Skill 落地 ~/.agents/skills 并软链到 ~/.claude/skills；内置的「eat 平台使用指南」会一起同步，让 AI 认识平台能力。
                  </Typography.Text>
                </>
              ),
            },
          ]}
        />
        <Divider style={{ margin: '12px 0' }} />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          安装脚本会把 CLI 放到 <Typography.Text code>~/.eat/bin</Typography.Text>，并自动配置
          PATH（软链 <Typography.Text code>~/.local/bin</Typography.Text> 与可写时的{' '}
          <Typography.Text code>/usr/local/bin</Typography.Text>，幂等写入 shell 配置）；当前终端找不到命令时执行{' '}
          <Typography.Text code>export PATH=&quot;$HOME/.eat/bin:$PATH&quot;</Typography.Text>。卸载：删除{' '}
          <Typography.Text code>~/.eat</Typography.Text> 目录及各处 eat 软链即可。
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
