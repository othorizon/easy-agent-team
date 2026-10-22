import type { LlmGatewayInfo, LlmModelInfo, LlmUsagePage } from '@eat/shared';
import { formatDateTime, llmAmountToQuota } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, getStoredUser } from '../api';
import { Confirm } from '../components/confirm';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { llmAmountInput, llmDisplayQuota } from '../lib/llm-quota';

const ROOT = '/api/llm-gateway';
const labels: Record<string, string> = {
  creating: '正在申请',
  active: '可用',
  disabled: '已停用',
  exhausted: '额度已用完',
  expired: '已过期',
  missing: '上游记录缺失',
  deleting: '正在删除',
};

export function LlmGatewayPage() {
  const admin = getStoredUser()?.role === 'admin';
  const info = useQuery({
    queryKey: ['llm-mine'],
    queryFn: () => api<LlmGatewayInfo>('GET', ROOT),
    refetchInterval: 15000,
  });
  return (
    <div className="space-y-5">
      <PageHeader title="LLM API 网关" description="申请自己的模型 API Key，查看可用模型和额度消耗。" />
      {info.isError && (
        <p role="alert" className="text-sm text-destructive">
          {info.error.message}
        </p>
      )}
      {!info.data ? (
        !info.isError && <p className="text-muted-foreground">正在加载…</p>
      ) : !info.data.configured ? (
        <Card>
          <CardContent>
            <p>LLM API 网关尚未配置。</p>
            {admin && (
              <Button className="mt-3" asChild>
                <Link to="/settings">前往系统设置</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="mine">
          <TabsList>
            <TabsTrigger value="mine">我的 API Key</TabsTrigger>
            {admin && <TabsTrigger value="admin">成员与额度</TabsTrigger>}
          </TabsList>
          <TabsContent value="mine" className="mt-4">
            <PersonalGateway info={info.data} />
          </TabsContent>
          {admin && (
            <TabsContent value="admin" className="mt-4">
              <AdminGateway />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}

type UsageRow = LlmUsagePage['items'][number];

const USAGE_COLUMNS = (currency: LlmGatewayInfo['currency']): DataTableColumn<UsageRow>[] => [
  {
    id: 'createdAt',
    header: '时间',
    meta: { cellClassName: 'whitespace-nowrap text-xs' },
    cell: ({ row: { original: r } }) => formatDateTime(new Date(r.createdAt * 1000)),
  },
  {
    id: 'model',
    header: '模型',
    meta: { cellClassName: 'font-mono text-xs' },
    cell: ({ row: { original: r } }) => r.model || '—',
  },
  {
    id: 'tokens',
    header: '输入 / 输出 Token',
    cell: ({ row: { original: r } }) => `${r.promptTokens} / ${r.completionTokens}`,
  },
  {
    id: 'quota',
    header: '额度消耗',
    meta: { cellClassName: 'whitespace-nowrap' },
    cell: ({ row: { original: r } }) => llmDisplayQuota(r.quota, currency),
  },
];

function PersonalGateway({ info }: { info: LlmGatewayInfo }) {
  const qc = useQueryClient();
  const requests = useRef(new Map<string, string>());
  const [visible, setVisible] = useState(false);
  const [secret, setSecret] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [page, setPage] = useState(1);
  const models = useQuery({
    queryKey: ['llm-models', info.key?.id, info.key?.status],
    queryFn: () => api<LlmModelInfo[]>('GET', `${ROOT}/models`),
    retry: false,
  });
  const usage = useQuery({
    queryKey: ['llm-usage', page, info.key?.id],
    queryFn: () => api<LlmUsagePage>('GET', `${ROOT}/usage?page=${page}&pageSize=20`),
    refetchInterval: page === 1 ? 30000 : false,
  });
  const operation = useMutation({
    mutationFn: async (action: string) => {
      if (action === 'retry') return api<LlmGatewayInfo>('POST', `${ROOT}/retry`, {});
      const requestId = requests.current.get(action) ?? crypto.randomUUID();
      requests.current.set(action, requestId);
      const method = action === 'delete' ? 'DELETE' : ['enable', 'disable'].includes(action) ? 'PUT' : 'POST';
      const path = ['enable', 'disable'].includes(action) ? '/key/status' : '/key';
      return api<LlmGatewayInfo>(method, ROOT + path, {
        requestId,
        ...(['enable', 'disable'].includes(action) ? { enabled: action === 'enable' } : {}),
      });
    },
    onSuccess: (result, action) => {
      if (!result.pending) requests.current.delete(action);
      toast[result.pending ? 'info' : 'success'](
        result.pending ? '操作结果正在同步，可稍后重试' : '操作完成',
      );
      if (action === 'create' || action === 'delete') setPage(1);
      void qc.invalidateQueries({ queryKey: ['llm-mine'] });
      void qc.invalidateQueries({ queryKey: ['llm-usage'] });
      void qc.invalidateQueries({ queryKey: ['llm-users'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const reveal = useMutation({
    gcTime: 0,
    mutationFn: () => api<{ key: string }>('POST', `${ROOT}/key/reveal`, {}),
    onSuccess: (r) => {
      setSecret(r.key);
      setVisible(true);
    },
    onError: (e) => toast.error(e.message),
  });
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('已复制');
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['总额度', info.totalQuota],
          ['已用额度', info.usedQuota],
          ['剩余额度', info.remainingQuota],
        ].map(([title, amount]) => (
          <Card key={title}>
            <CardContent>
              <p className="text-sm text-muted-foreground">{title}</p>
              <p className="mt-2 break-words text-xl font-semibold tabular-nums">
                {llmDisplayQuota(amount as number, info.currency)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-semibold">
              <KeyRound className="size-4" />
              我的 API Key
            </h2>
            {info.key && <Badge variant="secondary">{labels[info.key.status]}</Badge>}
          </div>
          {info.disabled && (
            <p className="mt-3 text-sm text-destructive">管理员已禁用你的网关权限，请联系管理员。</p>
          )}
          {info.error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {info.error}。显示的额度可能是上次同步结果。
            </p>
          )}
          {info.key ? (
            <>
              <p className="mt-4 break-all font-mono text-sm">{info.key.maskedKey || '正在确认 Key…'}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={info.disabled || info.key.status === 'creating'}
                  loading={reveal.isPending}
                  onClick={() => reveal.mutate()}
                >
                  <Copy />
                  查看 / 复制 Key
                </Button>
                <Button
                  variant="outline"
                  disabled={info.disabled || info.pending}
                  loading={operation.isPending}
                  onClick={() => operation.mutate(info.key?.status === 'disabled' ? 'enable' : 'disable')}
                >
                  {info.key.status === 'disabled' ? '启用' : '停用'}
                </Button>
                <Confirm
                  title="删除这把 API Key？"
                  description="这把 Key 将被撤销。以后重新申请会保留剩余额度和历史消耗，不会再次赠送。"
                  onConfirm={() => operation.mutate('delete')}
                >
                  <Button variant="outline-destructive" disabled={info.pending || operation.isPending}>
                    删除
                  </Button>
                </Confirm>
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm text-muted-foreground">
                {info.giftClaimed
                  ? '重新申请将继续使用剩余额度，不会重复赠送。'
                  : `首次申请将获得 ${llmDisplayQuota(info.initialQuotaEffective, info.currency)}。每人最多一把有效 Key。`}
              </p>
              <Button
                className="mt-4"
                disabled={info.disabled || info.pending}
                loading={operation.isPending}
                onClick={() => operation.mutate('create')}
              >
                申请 API Key
              </Button>
            </>
          )}
          {info.pending && (
            <Button
              className="mt-3"
              variant="outline"
              loading={operation.isPending}
              onClick={() => operation.mutate('retry')}
            >
              重试同步
            </Button>
          )}
          <div className="mt-5 border-t pt-4">
            <p className="text-xs text-muted-foreground">OpenAI 兼容接入地址</p>
            <div className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all text-sm">{info.apiBaseUrl}</code>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="复制接入地址"
                onClick={() => void copy(info.apiBaseUrl)}
              >
                <Copy />
              </Button>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {info.updatedAt ? `额度更新于 ${formatDateTime(info.updatedAt)}` : '额度将在申请后显示'}
            。需要调整额度请联系管理员。
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">可用模型 {models.data ? `(${models.data.length})` : ''}</h2>
            <Input
              className="w-full sm:w-64"
              aria-label="搜索模型"
              placeholder="搜索模型…"
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
            />
          </div>
          {models.isError && <p className="text-sm text-destructive">{models.error.message}</p>}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {models.data
              ?.filter((m) => m.id.toLowerCase().includes(modelSearch.toLowerCase()))
              .map((m) => (
                <div key={m.id} className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-xs">{m.id}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-11 shrink-0 px-2 sm:h-8"
                    aria-label={`复制模型名称：${m.id}`}
                    onClick={() => void copy(m.id)}
                  >
                    <Copy />
                    复制
                  </Button>
                </div>
              ))}
          </div>
          {models.isPending && <p className="text-sm text-muted-foreground">正在加载模型…</p>}
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <div className="mb-4">
            <h2 className="font-semibold">消耗记录</h2>
            <p className="mt-1 text-xs text-muted-foreground">只显示最近 30 天记录。</p>
          </div>
          {usage.isError && <p className="text-sm text-destructive">{usage.error.message}</p>}
          <DataTable
            columns={USAGE_COLUMNS(info.currency)}
            data={usage.data?.items}
            loading={usage.isPending}
            getRowId={(r) => String(r.id)}
            empty={<p className="py-6 text-center text-sm text-muted-foreground">最近 30 天暂无调用记录</p>}
          />
          <div className="mt-3 flex items-center justify-end gap-3 text-sm">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
              上一页
            </Button>
            <span>第 {page} 页</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!usage.data || page * 20 >= usage.data.total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={visible}
        onOpenChange={(open) => {
          setVisible(open);
          if (!open) {
            setSecret('');
            reveal.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>我的 API Key</DialogTitle>
            <DialogDescription>密钥代表你的模型访问权限，请只保存到可信客户端。</DialogDescription>
          </DialogHeader>
          <Input readOnly value={secret} aria-label="完整 API Key" className="font-mono" />
          <div className="flex justify-end">
            <Button onClick={() => void copy(secret)}>
              <Copy />
              复制 Key
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AdminGateway() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<LlmGatewayInfo | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('add');
  const [inherit, setInherit] = useState(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const people = useQuery({
    queryKey: ['llm-users'],
    queryFn: () => api<LlmGatewayInfo[]>('GET', '/api/admin/llm-gateway/users'),
    refetchInterval: 20000,
    retry: false,
  });
  const action = useMutation({
    mutationFn: async ({
      user,
      payload,
      kind,
    }: {
      user: LlmGatewayInfo;
      payload: Record<string, unknown>;
      kind: 'quota' | 'policy' | 'retry';
    }) => {
      const signature = JSON.stringify({ user: user.userId, payload, kind });
      if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
      return api<LlmGatewayInfo>(
        kind === 'policy' ? 'PUT' : 'POST',
        `/api/admin/llm-gateway/users/${user.userId}/${kind}`,
        { requestId: request.current.id, ...payload },
      );
    },
    onSuccess: (r) => {
      if (!r.pending) request.current = null;
      toast[r.pending ? 'info' : 'success'](r.pending ? '操作正在同步' : '已保存');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['llm-users'] });
      void qc.invalidateQueries({ queryKey: ['llm-mine'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const openQuota = (u: LlmGatewayInfo) => {
    setEditing(u);
    setAmount(
      u.giftClaimed
        ? ''
        : u.initialQuota !== null && u.currency
          ? llmAmountInput(u.initialQuota, u.currency)
          : '',
    );
    setInherit(u.initialQuota === null);
    setMode('add');
  };
  const peopleColumns: DataTableColumn<LlmGatewayInfo>[] = [
    {
      id: 'user',
      header: '用户',
      cell: ({ row: { original: u } }) => (
        <>
          <p>{u.userName}</p>
          {(u.disabled || u.userStatus !== 'active') && (
            <p className="text-xs text-destructive">{u.disabled ? '网关已禁用' : 'EAT 账户已禁用'}</p>
          )}
          {u.error && <p className="max-w-56 text-xs text-destructive">{u.error}</p>}
        </>
      ),
    },
    {
      id: 'keyStatus',
      header: 'Key 状态',
      meta: { cellClassName: 'whitespace-nowrap' },
      cell: ({ row: { original: u } }) =>
        u.pending ? '同步中' : u.key ? labels[u.key.status] : u.giftClaimed ? '已删除' : '未申请',
    },
    {
      id: 'total',
      header: '总额度',
      meta: { cellClassName: 'whitespace-nowrap' },
      cell: ({ row: { original: u } }) =>
        u.giftClaimed
          ? llmDisplayQuota(u.totalQuota, u.currency)
          : `首次赠送 ${llmDisplayQuota(u.initialQuotaEffective, u.currency)}${u.initialQuota === null ? '（全局）' : ''}`,
    },
    {
      id: 'used',
      header: '已用 / 剩余',
      meta: { cellClassName: 'whitespace-nowrap' },
      cell: ({ row: { original: u } }) =>
        u.giftClaimed
          ? `${llmDisplayQuota(u.usedQuota, u.currency)} / ${llmDisplayQuota(u.remainingQuota, u.currency)}`
          : '—',
    },
    {
      id: 'actions',
      header: '操作',
      cell: ({ row: { original: u } }) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={u.pending || action.isPending} onClick={() => openQuota(u)}>
            {u.giftClaimed ? '调整额度' : '首次赠送'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate({ user: u, kind: 'policy', payload: { disabled: !u.disabled } })}
          >
            {u.disabled ? '恢复网关' : '禁用网关'}
          </Button>
          {u.pending && (
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending}
              onClick={() => action.mutate({ user: u, kind: 'retry', payload: {} })}
            >
              重试
            </Button>
          )}
        </div>
      ),
    },
  ];
  return (
    <Card>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">成员与额度</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              未申请时配置首次赠送；申请后调整剩余额度。所有金额遵循 New API 的账户币种。
            </p>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Input
              aria-label="搜索成员"
              placeholder="搜索成员…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="刷新成员额度"
              loading={people.isFetching}
              onClick={() => void people.refetch()}
            >
              <RefreshCw />
            </Button>
          </div>
        </div>
        {people.isError && <p className="text-sm text-destructive">{people.error.message}</p>}
        <DataTable
          columns={peopleColumns}
          data={people.data?.filter((u) => (u.userName ?? '').toLowerCase().includes(search.toLowerCase()))}
          loading={people.isPending && !people.isError}
          getRowId={(u) => u.userId}
        />
        <Dialog
          open={!!editing}
          onOpenChange={(v) => {
            if (!v) setEditing(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editing?.userName} · {editing?.giftClaimed ? '调整剩余额度' : '首次申请赠送额度'}
              </DialogTitle>
              <DialogDescription>
                {editing?.giftClaimed
                  ? '仅调整个人 Key 的消费额度，不为公共账户钱包充值。'
                  : '仅在首次申请时发放；使用全局配置与明确填写 0 含义不同。'}
              </DialogDescription>
            </DialogHeader>
            {editing?.giftClaimed ? (
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger aria-label="调整方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">增加额度</SelectItem>
                  <SelectItem value="subtract">减少额度</SelectItem>
                  <SelectItem value="set">设置剩余额度</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} />
                使用首次申请时的全局赠送额度
              </label>
            )}
            <div className="space-y-2">
              <Label htmlFor="llm-adjust-amount">金额（{editing?.currency?.currency ?? 'quota'}）</Label>
              <Input
                id="llm-adjust-amount"
                inputMode="decimal"
                value={amount}
                disabled={!editing?.giftClaimed && inherit}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="flex justify-end">
              <Button
                loading={action.isPending}
                onClick={() => {
                  if (!editing?.currency) return;
                  try {
                    const initialQuota = editing.giftClaimed ? null : editing.initialQuota;
                    const unchanged =
                      initialQuota !== null && amount === llmAmountInput(initialQuota, editing.currency);
                    const quota =
                      !editing.giftClaimed && inherit
                        ? null
                        : unchanged
                          ? initialQuota
                          : llmAmountToQuota(amount, editing.currency);
                    action.mutate({
                      user: editing,
                      kind: editing.giftClaimed ? 'quota' : 'policy',
                      payload: editing.giftClaimed ? { mode, quota } : { initialQuota: quota },
                    });
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}
              >
                保存
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
