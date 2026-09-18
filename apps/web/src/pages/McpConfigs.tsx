import type {
  McpConfigInfo,
  McpSubscriber,
  McpSubscriptionRequest,
  SubscribeMcpConfigResult,
  UpsertMcpConfigRequest,
} from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Plus, Trash2, UserCog, X } from 'lucide-react';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Combobox } from '../components/combobox';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime } from '../lib/format';

const REQUESTS_KEY = 'mcp-subscription-requests';

export function McpConfigsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [editing, setEditing] = useState<McpConfigInfo | 'new' | null>(null);
  const [requesting, setRequesting] = useState<McpConfigInfo | null>(null);
  const [managing, setManaging] = useState<McpConfigInfo | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const configs = useQuery({ queryKey: ['mcp-configs'], queryFn: () => api<McpConfigInfo[]>('GET', '/api/mcp-configs') });
  const list = configs.data ?? [];
  /** 审批人 = 配置 Owner 或管理员；一个配置都不 Own 的普通成员看不到审批入口 */
  const canApprove = (c: McpConfigInfo) => c.ownerId === me?.id || me?.role === 'admin';
  const canApproveAny = me?.role === 'admin' || list.some((c) => c.ownerId === me?.id);

  const pending = useQuery({
    queryKey: [REQUESTS_KEY, 'pending'],
    queryFn: () => api<McpSubscriptionRequest[]>('GET', '/api/mcp-configs/subscription-requests?status=pending'),
    enabled: canApproveAny,
  });
  const pendingCount = pending.data?.length ?? 0;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['mcp-configs'] });
    void queryClient.invalidateQueries({ queryKey: [REQUESTS_KEY] });
  };

  const upsert = useMutation({
    mutationFn: (v: UpsertMcpConfigRequest) => api('POST', '/api/mcp-configs', v),
    onSuccess: () => {
      toast.success('已保存');
      setEditing(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const subscribe = useMutation({
    mutationFn: (v: { slug: string; reason: string }) =>
      api<SubscribeMcpConfigResult>('POST', `/api/mcp-configs/${v.slug}/subscribe`, { reason: v.reason }),
    onSuccess: (res) => {
      toast.success(res.status === 'approved' ? '已订阅，下次 eat sync 生效' : '申请已提交，等待审批');
      setRequesting(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const unsubscribe = useMutation({
    mutationFn: (c: McpConfigInfo) => api('DELETE', `/api/mcp-configs/${c.slug}/subscribe`),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api('DELETE', `/api/mcp-configs/${slug}`),
    onSuccess: () => {
      toast.success('已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="MCP 配置"
        description={
          <>
            团队共享的 MCP Server 配置。敏感值写成引用 <InlineCode>{'${env:环境slug/KEY}'}</InlineCode>——订阅经审批通过后{' '}
            <InlineCode>eat sync</InlineCode> 会按你的权限渲染出可用配置（无权限的引用保留占位并提示申请）。
          </>
        }
        actions={
          <>
            {canApproveAny && (
              <Button variant="outline" onClick={() => setReviewing(true)}>
                <ClipboardCheck />
                订阅申请
                {pendingCount > 0 && (
                  <span className="size-1.5 rounded-full bg-warning" title={`${pendingCount} 条待审批`} />
                )}
              </Button>
            )}
            <Button onClick={() => setEditing('new')}>
              <Plus />
              新建配置
            </Button>
          </>
        }
      />
      <Card>
        <CardContent>
          {configs.isLoading ? (
            <TableSkeleton />
          ) : list.length === 0 ? (
            <Empty text="还没有 MCP 配置" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>配置</TableHead>
                  <TableHead className="hidden md:table-cell">说明</TableHead>
                  <TableHead className="hidden w-18 sm:table-cell">传输</TableHead>
                  <TableHead className="hidden w-24 lg:table-cell">作者</TableHead>
                  <TableHead className="hidden w-24 sm:table-cell">可见性</TableHead>
                  <TableHead className="w-80">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((c) => {
                  const canManage = canApprove(c);
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <InlineCode>{c.slug}</InlineCode>
                          <span className="font-medium">{c.name}</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{c.description}</div>
                      </TableCell>
                      <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                        {c.description}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary">{c.transport}</Badge>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{c.ownerName}</TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {c.visibility === 'private' ? (
                          <Badge variant="outline" title="不出现在其他成员的清单里，只能由 Owner / 管理员分配">
                            不公开
                          </Badge>
                        ) : (
                          <Badge title="全员可见，可自助申请订阅">团队可见</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5 lg:flex-nowrap">
                          <SubscribeAction
                            config={c}
                            canApprove={canManage}
                            pending={subscribe.isPending || unsubscribe.isPending}
                            onSubscribe={() => subscribe.mutate({ slug: c.slug, reason: '' })}
                            onRequest={() => setRequesting(c)}
                            onUnsubscribe={() => unsubscribe.mutate(c)}
                          />
                          {canManage && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => setManaging(c)}>
                                订阅者
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setEditing(c)}>
                                编辑
                              </Button>
                              <Confirm
                                title={`删除配置 ${c.slug}？`}
                                description="订阅者本地的该配置会在下次 sync 时移除。"
                                confirmText="删除"
                                onConfirm={() => remove.mutate(c.slug)}
                              >
                                <Button size="sm" variant="outline-destructive">
                                  删除
                                </Button>
                              </Confirm>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editing !== null && (
        <McpConfigDialog
          editing={editing}
          pending={upsert.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(v) => upsert.mutate(v)}
        />
      )}
      {requesting && (
        <RequestSubscribeDialog
          config={requesting}
          pending={subscribe.isPending}
          onClose={() => setRequesting(null)}
          onSubmit={(reason) => subscribe.mutate({ slug: requesting.slug, reason })}
        />
      )}
      {managing && <SubscribersDialog config={managing} onClose={() => setManaging(null)} />}
      {reviewing && <RequestsDialog onClose={() => setReviewing(false)} />}
    </div>
  );
}

/** 订阅按钮按关系分级：没订过 → 申请 / 待审批 → 撤回 / 已驳回 → 重新申请 / 已订阅 → 退订 */
function SubscribeAction({
  config,
  canApprove,
  pending,
  onSubscribe,
  onRequest,
  onUnsubscribe,
}: {
  config: McpConfigInfo;
  canApprove: boolean;
  pending: boolean;
  onSubscribe: () => void;
  onRequest: () => void;
  onUnsubscribe: () => void;
}) {
  if (config.subscriptionStatus === 'approved') {
    return (
      <Button size="sm" variant="outline" loading={pending} onClick={onUnsubscribe}>
        退订
      </Button>
    );
  }
  if (config.subscriptionStatus === 'pending') {
    return (
      <>
        <Badge variant="warning">待审批</Badge>
        <Button size="sm" variant="ghost" loading={pending} onClick={onUnsubscribe}>
          撤回
        </Button>
      </>
    );
  }
  if (config.subscriptionStatus === 'rejected') {
    return (
      <>
        <Badge variant="destructive">已驳回</Badge>
        <Button size="sm" variant="outline" loading={pending} onClick={onRequest}>
          重新申请
        </Button>
      </>
    );
  }
  // 自己能审批的配置不用绕一圈申请自己批自己
  return (
    <Button size="sm" loading={pending} onClick={canApprove ? onSubscribe : onRequest}>
      {canApprove ? '订阅' : '申请订阅'}
    </Button>
  );
}

function RequestSubscribeDialog({
  config,
  pending,
  onClose,
  onSubmit,
}: {
  config: McpConfigInfo;
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>申请订阅 {config.name}</DialogTitle>
          <DialogDescription>
            配置 Owner（{config.ownerName}）或管理员批准后，这个 MCP 会在你下次 <InlineCode>eat sync</InlineCode> 时落地。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="申请理由" htmlFor="mcp-reason" hint="选填，写清用途能让审批快一些">
            <Textarea
              id="mcp-reason"
              rows={3}
              placeholder="例如：接手内部工单系统的自动化，需要这个 MCP 查工单"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button loading={pending} onClick={() => onSubmit(reason)} className="w-full">
            提交申请
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 审批清单：默认只看待审批的，「全部」里能回看已处理的（照求助清单的口径） */
function RequestsDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const requests = useQuery({
    queryKey: [REQUESTS_KEY, status],
    queryFn: () => api<McpSubscriptionRequest[]>('GET', `/api/mcp-configs/subscription-requests?status=${status}`),
  });

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) =>
      api('POST', `/api/mcp-configs/subscription-requests/${v.id}/decision`, { decision: v.decision }),
    onSuccess: (_res, v) => {
      toast.success(v.decision === 'approved' ? '已批准，对方下次 eat sync 生效' : '已驳回');
      void queryClient.invalidateQueries({ queryKey: [REQUESTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['mcp-configs'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const rows = requests.data ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>订阅申请</DialogTitle>
          <DialogDescription>你 Own 的配置上的订阅申请；管理员可审批全部配置。</DialogDescription>
        </DialogHeader>
        <Segmented
          value={status}
          onChange={setStatus}
          variant="outline"
          ariaLabel="申请状态"
          options={[
            { label: '待审批', value: 'pending' },
            { label: '全部', value: 'all' },
          ]}
        />
        {requests.isPending ? (
          <TableSkeleton rows={2} />
        ) : rows.length === 0 ? (
          <Empty text={status === 'pending' ? '没有待审批的申请' : '还没有订阅申请'} className="py-6" />
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium">{r.userName}</span>
                    <span className="text-xs text-muted-foreground">{r.userEmail}</span>
                    <span className="text-sm">申请订阅</span>
                    <InlineCode>{r.configSlug}</InlineCode>
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">{r.reason || '（没写理由）'}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(r.createdAt)}
                    {r.status !== 'pending' && r.decidedAt && (
                      <>
                        {' · '}
                        {r.decidedByName} 于 {formatDateTime(r.decidedAt)}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {r.status === 'pending' ? (
                    <>
                      <Button size="sm" loading={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>
                        批准
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-destructive"
                        loading={decide.isPending}
                        onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}
                      >
                        驳回
                      </Button>
                    </>
                  ) : r.status === 'approved' ? (
                    <Badge variant="success">已批准</Badge>
                  ) : (
                    <Badge variant="destructive">已驳回</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const SUBSCRIBER_SOURCE_LABEL: Record<McpSubscriber['source'], string> = {
  manual: '自助订阅',
  admin: '主动分配',
  template: '角色模板',
};

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
}

/**
 * 订阅者明细与主动分配（Owner / 管理员）。
 * 不公开的配置只有这条路能到成员手里，所以「添加订阅者」直接放在弹窗里，不再套一层。
 */
function SubscribersDialog({ config, onClose }: { config: McpConfigInfo; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);

  const subscribers = useQuery({
    queryKey: ['mcp-subscribers', config.slug],
    queryFn: () => api<McpSubscriber[]>('GET', `/api/mcp-configs/${config.slug}/subscribers`),
  });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('GET', '/api/users') });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['mcp-subscribers', config.slug] });
    void queryClient.invalidateQueries({ queryKey: ['mcp-configs'] });
    void queryClient.invalidateQueries({ queryKey: [REQUESTS_KEY] });
  };

  const add = useMutation({
    mutationFn: (id: string) => api('POST', `/api/mcp-configs/${config.slug}/subscribers`, { userId: id }),
    onSuccess: () => {
      toast.success('已分配，对方下次 eat sync 时落地');
      setUserId(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/mcp-configs/${config.slug}/subscribers/${id}`),
    onSuccess: () => {
      toast.success('已取消该用户的订阅');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const rows = subscribers.data ?? [];
  const options = (users.data ?? [])
    .filter((u) => u.status === 'active' && !rows.some((r) => r.userId === u.id))
    .map((u) => ({ value: u.id, label: u.name, hint: u.email }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{config.name} 的订阅者</DialogTitle>
          <DialogDescription>
            {config.visibility === 'private'
              ? '这个配置不公开，成员在清单里看不到它——只有在这里分配才能拿到。'
              : '成员可以自助申请订阅；这里也能直接分配，分配即视为已批准。'}
          </DialogDescription>
        </DialogHeader>
        <Field label="添加订阅者" hint="分配后无需审批，对方下次 eat sync 就会拿到这个配置">
          <div className="flex items-center gap-2">
            <Combobox
              groups={[{ options }]}
              value={userId}
              onChange={setUserId}
              className="flex-1"
              placeholder={options.length === 0 ? '没有可添加的成员' : '选择成员…'}
              searchPlaceholder="搜索姓名 / 邮箱…"
            />
            <Button disabled={!userId} loading={add.isPending} onClick={() => userId && add.mutate(userId)}>
              <UserCog />
              分配
            </Button>
          </div>
        </Field>
        {subscribers.isPending ? (
          <TableSkeleton rows={2} />
        ) : rows.length === 0 ? (
          <Empty text="还没有人订阅" className="py-6" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead className="hidden w-24 sm:table-cell">来源</TableHead>
                <TableHead className="hidden w-40 md:table-cell">生效时间</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.userId}>
                  <TableCell>
                    <span className="font-medium">{r.name}</span>
                    {r.role === 'admin' && (
                      <Badge variant="outline" className="ml-2">
                        管理员
                      </Badge>
                    )}
                    <div className="truncate text-xs text-muted-foreground">{r.email}</div>
                    <div className="text-xs text-muted-foreground sm:hidden">{SUBSCRIBER_SOURCE_LABEL[r.source]}</div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="secondary">{SUBSCRIBER_SOURCE_LABEL[r.source]}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {r.subscribedAt ? formatDateTime(r.subscribedAt) : '—'}
                  </TableCell>
                  <TableCell>
                    {r.removable && (
                      <Confirm
                        title={`取消 ${r.name} 的订阅？`}
                        description="对方下次 eat sync 时会从本地移除这个 MCP 配置。"
                        confirmText="取消订阅"
                        onConfirm={() => remove.mutate(r.userId)}
                      >
                        <Button variant="ghost" size="icon-sm" aria-label={`取消 ${r.name} 的订阅`}>
                          <X />
                        </Button>
                      </Confirm>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface FormValues {
  slug: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string;
  argsText: string;
  url: string;
  envPairs: Array<{ key: string; value: string }>;
  visibility: 'team' | 'private';
}

function McpConfigDialog({
  editing,
  pending,
  onClose,
  onSubmit,
}: {
  editing: McpConfigInfo | 'new';
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: UpsertMcpConfigRequest) => void;
}) {
  const isNew = editing === 'new';
  const { register, handleSubmit, control, watch, formState: { errors } } = useForm<FormValues>({
    defaultValues: isNew
      ? { slug: '', name: '', description: '', transport: 'stdio', command: '', argsText: '', url: '', envPairs: [], visibility: 'team' }
      : {
          slug: editing.slug,
          name: editing.name,
          description: editing.description,
          transport: editing.transport,
          command: editing.command ?? '',
          argsText: editing.args.join(' '),
          url: editing.url ?? '',
          envPairs: Object.entries(editing.env).map(([key, value]) => ({ key, value })),
          visibility: editing.visibility,
        },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'envPairs' });
  const transport = watch('transport');
  const visibility = watch('visibility');

  function toPayload(v: FormValues): UpsertMcpConfigRequest {
    return {
      slug: v.slug,
      name: v.name,
      description: v.description ?? '',
      transport: v.transport,
      command: v.transport === 'stdio' ? v.command : undefined,
      args: v.transport === 'stdio' && v.argsText ? v.argsText.split(/\s+/).filter(Boolean) : [],
      url: v.transport === 'http' ? v.url : undefined,
      headers: {},
      env: Object.fromEntries(v.envPairs.filter((p) => p.key).map((p) => [p.key, p.value ?? ''])),
      visibility: v.visibility,
    };
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? '新建 MCP 配置' : `编辑 ${editing.slug}`}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit((v) => onSubmit(toPayload(v)))}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标识（slug）" htmlFor="mcp-slug" required error={errors.slug?.message}>
              <Input
                id="mcp-slug"
                placeholder="internal-api"
                className="font-mono"
                disabled={!isNew}
                aria-invalid={!!errors.slug}
                {...register('slug', { required: '请输入标识', pattern: rules.slug })}
              />
            </Field>
            <Field label="名称" htmlFor="mcp-name" required error={errors.name?.message}>
              <Input id="mcp-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
            </Field>
          </div>
          <Field label="说明" htmlFor="mcp-desc" hint="这个 MCP 能做什么">
            <Textarea id="mcp-desc" rows={2} {...register('description')} />
          </Field>
          <Field label="传输方式" required>
            <Controller
              control={control}
              name="transport"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: 'stdio（本地命令）', value: 'stdio' },
                    { label: 'http', value: 'http' },
                  ]}
                />
              )}
            />
          </Field>
          {transport === 'stdio' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="命令" htmlFor="mcp-command" required error={errors.command?.message}>
                <Input
                  id="mcp-command"
                  placeholder="npx"
                  className="font-mono"
                  aria-invalid={!!errors.command}
                  {...register('command', {
                    validate: (v) => transport !== 'stdio' || !!v.trim() || '请输入命令',
                  })}
                />
              </Field>
              <Field label="参数" htmlFor="mcp-args" hint="空格分隔">
                <Input id="mcp-args" placeholder="-y some-mcp-server" className="font-mono" {...register('argsText')} />
              </Field>
            </div>
          ) : (
            <Field label="URL" htmlFor="mcp-url" required error={errors.url?.message}>
              <Input
                id="mcp-url"
                placeholder="https://mcp.internal.example.com/sse"
                className="font-mono"
                aria-invalid={!!errors.url}
                {...register('url', {
                  validate: (v) => transport !== 'http' || !!v.trim() || '请输入 URL',
                })}
              />
            </Field>
          )}
          <Field
            label="环境变量"
            hint={
              <>
                值可写 <InlineCode>{'${env:slug/KEY}'}</InlineCode> 引用平台环境变量
              </>
            }
          >
            <div className="flex flex-col gap-2">
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <Input
                    placeholder="API_TOKEN"
                    className="w-2/5 font-mono"
                    {...register(`envPairs.${index}.key`)}
                  />
                  <Input
                    placeholder={'${env:internal/API_TOKEN}'}
                    className="flex-1 font-mono"
                    {...register(`envPairs.${index}.value`)}
                  />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="删除该变量" onClick={() => remove(index)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => append({ key: '', value: '' })}
              >
                <Plus />
                添加变量
              </Button>
            </div>
          </Field>
          <Field
            label="可见性"
            hint={
              visibility === 'private'
                ? '不出现在其他成员的清单里，只能由你或管理员在「订阅者」里分配'
                : '全员看得到名称与说明，可自助申请订阅（订阅需你或管理员批准）'
            }
          >
            <Controller
              control={control}
              name="visibility"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: '团队可见', value: 'team' },
                    { label: '不公开（仅分配）', value: 'private' },
                  ]}
                />
              )}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            保存
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
