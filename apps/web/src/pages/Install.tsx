import { buildAgentInstallGuide } from '@eat/shared';
import { Bot, Copy, TerminalSquare, Unplug } from 'lucide-react';
import * as React from 'react';
import { Cmd, CodeBlock, copyText, InlineCode } from '../components/code';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

type Os = 'unix' | 'windows';

/** 按浏览器嗅探默认展示哪套命令（用户仍可自行切换 tab） */
function detectOs(): Os {
  if (typeof navigator === 'undefined') return 'unix';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent}`;
  return /windows|win32|win64|wow64/i.test(hint) ? 'windows' : 'unix';
}

/** 垂直步骤条 */
function Steps({ items }: { items: Array<{ title: string; content: React.ReactNode }> }) {
  return (
    <ol className="flex flex-col">
      {items.map((item, i) => (
        <li key={i} className="relative flex gap-3 pb-5 last:pb-0">
          {i < items.length - 1 && <span className="absolute top-7 left-[13px] h-[calc(100%-2rem)] w-px bg-border" />}
          <span className="z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="mb-1.5 text-sm font-medium">{item.title}</div>
            <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">{item.content}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 安装页：主推「复制指令给自己的 AI Agent 去装」，手动步骤按平台分 tab 兜底 */
export function InstallPage() {
  const origin = window.location.origin;
  const [os, setOs] = React.useState<Os>(detectOs);
  const agentPrompt = `请帮我安装团队 AI 能力平台的 CLI，按下面的指令执行：\n\n${buildAgentInstallGuide(origin)}`;

  const loginStep = {
    title: '登录（设备码授权）',
    content: (
      <>
        <Cmd text={`eat login --server ${origin}`} />
        <span>命令会输出链接和短码，浏览器打开确认即可。</span>
      </>
    ),
  };

  return (
    <div className="space-y-5">
      <PageHeader title="安装 CLI" description="把团队能力接入你（和你的 AI）的工作环境。" />

      <Card>
        <CardContent>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <Bot className="size-4 text-primary" />
            让你的 AI 帮你装（推荐）
          </h2>
          <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
            复制下面整段指令，粘贴给你的 AI Agent（Claude Code 等），它会完成 CLI 安装、登录引导和能力同步。
            指令里同时给了 macOS/Linux 与 Windows 两套命令，Agent 会先判断你的系统再选；
            登录环节会给你一个链接和短码，在浏览器里确认一下就行。有终端环境的 Agent 装好 CLI
            即可使用平台全部能力，无需配置 MCP。
          </p>
          <Button onClick={() => void copyText(agentPrompt)}>
            <Copy />
            一键复制 Agent 安装指令
          </Button>
          <CodeBlock className="mt-4 max-h-80 text-xs">{agentPrompt}</CodeBlock>
          <p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            这份指令也可以直接由 Agent 获取：<Cmd text={`${origin}/install/AGENT.md`} />
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <TerminalSquare className="size-4 text-primary" />
            手动安装
          </h2>
          <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
            前提：本机有 Node.js ≥ 18（使用 Claude Code 的机器都满足）。CLI 由平台直接分发，无需 npm registry。
          </p>

          <Tabs value={os} onValueChange={(v) => setOs(v as Os)}>
            <TabsList>
              <TabsTrigger value="unix">macOS / Linux</TabsTrigger>
              <TabsTrigger value="windows">Windows</TabsTrigger>
            </TabsList>

            <TabsContent value="unix" className="mt-4">
              <Steps
                items={[
                  { title: '安装 CLI', content: <Cmd text={`curl -fsSL ${origin}/install.sh | sh`} /> },
                  loginStep,
                  {
                    title: '同步团队能力',
                    content: (
                      <>
                        <Cmd text="eat sync" />
                        <span>
                          Skill 落地 ~/.agents/skills 并软链到 ~/.claude/skills；内置的「eat
                          平台使用指南」会一起同步，让 AI 认识平台能力。
                        </span>
                      </>
                    ),
                  },
                ]}
              />
              <p className="mt-4 border-t pt-4 text-sm leading-relaxed text-muted-foreground">
                安装脚本会把 CLI 放到 <InlineCode>~/.eat/bin</InlineCode>，并自动配置 PATH（软链{' '}
                <InlineCode>~/.local/bin</InlineCode> 与可写时的 <InlineCode>/usr/local/bin</InlineCode>
                ，幂等写入 shell 配置）；当前终端找不到命令时执行{' '}
                <InlineCode>export PATH=&quot;$HOME/.eat/bin:$PATH&quot;</InlineCode>。卸载：删除{' '}
                <InlineCode>~/.eat</InlineCode> 目录及各处 eat 软链即可。
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                WSL 与 Git Bash 属于这一套；Windows 原生终端请切到 Windows 页签。
              </p>
            </TabsContent>

            <TabsContent value="windows" className="mt-4">
              <Steps
                items={[
                  {
                    title: '安装 CLI（PowerShell）',
                    content: (
                      <>
                        <Cmd text={`powershell -ExecutionPolicy ByPass -c "irm ${origin}/install.ps1 | iex"`} />
                        <span>
                          在 PowerShell 里执行；cmd 里同样可用这条完整命令。不要在 Windows 原生终端用{' '}
                          <InlineCode>curl ... | sh</InlineCode>。
                        </span>
                      </>
                    ),
                  },
                  loginStep,
                  {
                    title: '同步团队能力',
                    content: (
                      <>
                        <Cmd text="eat sync" />
                        <span>
                          Skill 落地 %USERPROFILE%\.agents\skills，并复制一份到 %USERPROFILE%\.claude\skills（Windows
                          上建软链需要管理员权限，改用复制，效果等价）。
                        </span>
                      </>
                    ),
                  },
                ]}
              />
              <p className="mt-4 border-t pt-4 text-sm leading-relaxed text-muted-foreground">
                安装脚本会把 CLI 放到 <InlineCode>%USERPROFILE%\.eat\bin</InlineCode>，生成{' '}
                <InlineCode>eat.cmd</InlineCode>（cmd / PowerShell / 子进程通用）与 <InlineCode>eat</InlineCode>
                （Git Bash）两个入口，并把该目录写入用户级 PATH（新开终端生效）。
                这里不生成 <InlineCode>eat.ps1</InlineCode>：PowerShell 选命令时 <InlineCode>.ps1</InlineCode> 优先于{' '}
                <InlineCode>.cmd</InlineCode>，会撞上默认「禁止运行脚本」的执行策略；
                <InlineCode>.cmd</InlineCode> 不受该策略约束，PowerShell 里直接敲 <InlineCode>eat</InlineCode> 即可。
                当前窗口找不到命令时执行{' '}
                <InlineCode>$env:Path = &quot;$HOME\.eat\bin;$env:Path&quot;</InlineCode>；AI 客户端若在安装前就已启动，
                需重启它才能继承新 PATH。卸载：删除 <InlineCode>%USERPROFILE%\.eat</InlineCode> 目录，并从用户 PATH 中移除该项。
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <Unplug className="size-4 text-primary" />
            MCP 配置（无终端环境的 AI 客户端）
          </h2>
          <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
            eat 的全部能力都可以通过 CLI 使用——<strong className="text-foreground">Agent 有 shell 环境时装好 CLI 即可，不需要配置 MCP</strong>。
            只有当 AI 客户端不能执行 shell 命令时，才把 eat 注册为 MCP server 接入平台。 前提：本机已完成上面的 CLI
            安装与登录；MCP 复用 CLI 凭证（<InlineCode>~/.eat/credentials.json</InlineCode>），无需再登录。
          </p>
          <div className="mb-2 text-sm font-medium">Claude Code（macOS / Linux）：</div>
          <Cmd text="claude mcp add --scope user eat -- eat mcp" />
          <div className="mt-3 mb-2 text-sm font-medium">Claude Code（Windows）：</div>
          <Cmd text="claude mcp add --scope user eat -- cmd /c eat mcp" />
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Windows 上 <InlineCode>eat</InlineCode> 实际是 <InlineCode>eat.cmd</InlineCode>，而 Node
            出于安全不允许不经 shell 直接拉起 <InlineCode>.cmd</InlineCode>，所以要加{' '}
            <InlineCode>cmd /c</InlineCode>。其他 MCP 客户端：配置一个 stdio server，命令{' '}
            <InlineCode>eat</InlineCode>、参数 <InlineCode>mcp</InlineCode>（Windows 为命令{' '}
            <InlineCode>cmd</InlineCode>、参数 <InlineCode>/c eat mcp</InlineCode>）。
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            兜底写法（<InlineCode>eat</InlineCode> 不在 PATH，或客户端不走 shell）：命令{' '}
            <InlineCode>node</InlineCode>、参数为 CLI 绝对路径加 <InlineCode>mcp</InlineCode>——类 Unix 是{' '}
            <InlineCode>~/.eat/bin/eat.js</InlineCode>，Windows 是{' '}
            <InlineCode>%USERPROFILE%\.eat\bin\eat.js</InlineCode>。
          </p>
          <p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            这份指引也可直接获取：<Cmd text={`${origin}/install/MCP.md`} />
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
