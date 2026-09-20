import type { ApiTokenInfo, CreateApiKeyResult } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Unplug } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { Cmd, CodeBlock, CopyButton, InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatDateTime, formatRelativeTime } from '../lib/format';

function isActiveApiKey(t: ApiTokenInfo): boolean {
  return t.kind === 'apikey' && !t.revokedAt;
}

/** 刚生成的密钥：明文只在这一次出现，页面刷新就没了 */
function FreshKey({ value, onDone }: { value: string; onDone: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
      <div className="mb-2 text-sm font-medium">密钥已生成，现在就复制走——平台只存哈希，关掉就再也看不到了。</div>
      <div className="flex items-center gap-1 rounded-md border bg-background py-1 pr-1 pl-2.5">
        <code className="overflow-x-auto whitespace-nowrap font-mono text-[13px]">{value}</code>
        <CopyButton text={value} />
      </div>
      <Button className="mt-2" size="sm" variant="outline" onClick={onDone}>
        我已保存
      </Button>
    </div>
  );
}

/** API Key 的生成与吊销：就摆在接入说明旁边，用的时候不用去别的页面找 */
function ApiKeys() {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [fresh, setFresh] = React.useState<string | null>(null);
  const tokens = useQuery({ queryKey: ['auth-tokens'], queryFn: () => api<ApiTokenInfo[]>('GET', '/api/auth/tokens') });
  const keys = (tokens.data ?? []).filter(isActiveApiKey);

  const create = useMutation({
    mutationFn: (v: string) => api<CreateApiKeyResult>('POST', '/api/auth/api-keys', { name: v }),
    onSuccess: (data) => {
      setFresh(data.token);
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['auth-tokens'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '生成失败'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/auth/tokens/${id}`),
    onSuccess: () => {
      toast.success('已吊销，使用该密钥的服务会立即断开');
      void queryClient.invalidateQueries({ queryKey: ['auth-tokens'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '吊销失败'),
  });

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 text-primary" />
        我的 API 密钥
      </div>
      <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
        密钥代表<strong className="text-foreground">你本人</strong>的权限：云端服务用它调用工具，能做的事与你自己一样，平台按你的身份审计。
        给每个接入的服务单独生成一把，不用了就吊销。
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate(name.trim());
        }}
      >
        <Input
          className="w-56"
          placeholder="密钥名称（如：扣子工作流）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={!name.trim()} loading={create.isPending}>
          <Plus />
          生成密钥
        </Button>
      </form>
      {fresh && <FreshKey value={fresh} onDone={() => setFresh(null)} />}

      {keys.length > 0 && (
        <ul className="mt-3 divide-y border-t">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{k.name}</div>
                <div className="text-xs text-muted-foreground">
                  生成于 {formatDateTime(k.createdAt)} ·{' '}
                  {k.lastUsedAt ? `最近使用 ${formatRelativeTime(k.lastUsedAt)}` : '从未使用'}
                  {k.expiresAt && ` · 有效至 ${formatDateTime(k.expiresAt)}`}
                </div>
              </div>
              <Confirm
                title={`吊销「${k.name}」？`}
                description="使用这把密钥的服务会立即失去访问权限，此操作不可撤销。"
                confirmText="吊销"
                onConfirm={() => revoke.mutate(k.id)}
              >
                <Button size="sm" variant="outline-destructive" loading={revoke.isPending && revoke.variables === k.id}>
                  吊销
                </Button>
              </Confirm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * MCP 接入（决策 55）：云端 AI 服务走平台的 HTTP 端点 + API Key，本地无 shell 的客户端走 stdio。
 * 默认停在 HTTP 那页——有终端的 Agent 装 CLI 就够了，会来看这一节的多半是云端服务。
 */
export function McpAccessCard({ origin }: { origin: string }) {
  const endpoint = `${origin}/mcp`;
  const clientJson = JSON.stringify(
    {
      mcpServers: {
        eat: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer <你的 API Key>' } },
      },
    },
    null,
    2,
  );

  return (
    <Card>
      <CardContent>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Unplug className="size-4 text-primary" />
          MCP 接入（把平台能力接给 AI 客户端）
        </h2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          <strong className="text-foreground">有终端环境的 Agent 装好 CLI 即可，不需要 MCP</strong>；
          跑在云上的 AI 服务装不了 CLI，用下面的 HTTP 端点接入。
        </p>

        <Tabs defaultValue="http">
          <TabsList>
            <TabsTrigger value="http">云端 AI 服务（HTTP）</TabsTrigger>
            <TabsTrigger value="stdio">本机客户端（stdio）</TabsTrigger>
          </TabsList>

          <TabsContent value="http" className="mt-4 space-y-3">
            <div>
              <div className="mb-1.5 text-sm font-medium">接入地址（Streamable HTTP）</div>
              <Cmd text={endpoint} />
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium">鉴权：请求头带 API Key</div>
              <Cmd text="Authorization: Bearer <你的 API Key>" />
              <p className="mt-1.5 text-sm text-muted-foreground">
                客户端若不支持自定义 <InlineCode>Authorization</InlineCode>，用 <InlineCode>X-API-Key</InlineCode>{' '}
                也认。密钥不要放进 URL——URL 会被各种日志记下来。
              </p>
            </div>

            <ApiKeys />

            <div>
              <div className="mb-1.5 text-sm font-medium">客户端配置（多数客户端通用的 JSON 形式）</div>
              <CodeBlock className="text-xs">{clientJson}</CodeBlock>
              <p className="mt-2 text-sm text-muted-foreground">Claude Code 一条命令即可：</p>
              <Cmd text={`claude mcp add --transport http eat ${endpoint} --header "Authorization: Bearer <你的 API Key>"`} />
            </div>

            <p className="text-sm leading-relaxed text-muted-foreground">
              接入后客户端会拿到平台全套工具（环境变量清单与取值、权限申请、经验搜索、求助、应用创建与 env、部署与日志）。
              建议让 AI 先调一次 <InlineCode>get_platform_guide</InlineCode> 读平台使用指南——
              云端客户端没有 <InlineCode>eat sync</InlineCode> 那条路，行为规范只能靠它取回去。
            </p>
          </TabsContent>

          <TabsContent value="stdio" className="mt-4 space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              本机上的 AI 客户端如果不能执行 shell 命令，可以把 CLI 注册成 stdio MCP server。
              前提：本机已完成上面的 CLI 安装与登录；stdio 方式复用 CLI 凭证（
              <InlineCode>~/.eat/credentials.json</InlineCode>），不需要 API Key。
            </p>
            <div>
              <div className="mb-1.5 text-sm font-medium">Claude Code（macOS / Linux）</div>
              <Cmd text="claude mcp add --scope user eat -- eat mcp" />
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium">Claude Code（Windows）</div>
              <Cmd text="claude mcp add --scope user eat -- cmd /c eat mcp" />
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Windows 上 <InlineCode>eat</InlineCode> 实际是 <InlineCode>eat.cmd</InlineCode>，而 Node 出于安全不允许不经
              shell 直接拉起 <InlineCode>.cmd</InlineCode>，所以要加 <InlineCode>cmd /c</InlineCode>。其他 MCP
              客户端：配置一个 stdio server，命令 <InlineCode>eat</InlineCode>、参数 <InlineCode>mcp</InlineCode>
              （Windows 为命令 <InlineCode>cmd</InlineCode>、参数 <InlineCode>/c eat mcp</InlineCode>）。
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              兜底写法（<InlineCode>eat</InlineCode> 不在 PATH，或客户端不走 shell）：命令{' '}
              <InlineCode>node</InlineCode>、参数为 CLI 绝对路径加 <InlineCode>mcp</InlineCode>——类 Unix 是{' '}
              <InlineCode>~/.eat/bin/eat.js</InlineCode>，Windows 是{' '}
              <InlineCode>%USERPROFILE%\.eat\bin\eat.js</InlineCode>。
            </p>
          </TabsContent>
        </Tabs>

        <p className="mt-4 flex flex-wrap items-center gap-1.5 border-t pt-4 text-sm text-muted-foreground">
          这份指引也可直接获取：<Cmd text={`${origin}/install/MCP.md`} />
        </p>
      </CardContent>
    </Card>
  );
}
