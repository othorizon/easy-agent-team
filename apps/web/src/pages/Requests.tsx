import {
  REQUEST_TYPES,
  REQUEST_STATUSES,
  type ApprovalRequest,
  type ApprovalRequestPage,
  type ApprovalRequestDetail,
} from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { DateTimePicker, EXPIRY_PRESETS } from '../components/datetime-picker';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { GithubAppSummary } from '../components/github';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { formatDateTime } from '../lib/format';
import { useQueryParams } from '../lib/use-query-params';

export const EXECUTION_LABELS: Record<string, string> = {
  active: '已生效',
  provisioning: '开通中',
  failed: '开通失败',
  disabled: '已停用',
  deleted: '资源已删除',
  revoking: '回收中',
  revoked: '已撤销权限',
};
export function RequestStatus({ r }: { r: ApprovalRequest }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge
        variant={
          r.status === 'pending'
            ? 'warning'
            : r.status === 'rejected'
              ? 'destructive'
              : r.status === 'approved'
                ? 'success'
                : 'secondary'
        }
      >
        {REQUEST_STATUSES[r.status]}
      </Badge>
      {r.execution && (
        <span className={r.execution === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {EXECUTION_LABELS[r.execution] ?? r.execution}
        </span>
      )}
    </span>
  );
}
function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Record<string, string>;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-full sm:w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(options).map(([v, t]) => (
          <SelectItem key={v} value={v}>
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function RequestsPage() {
  const [p, set] = useQueryParams({
    tab: 'inbox',
    type: 'all',
    status: 'default',
    days: 'default',
    q: '',
    page: '1',
    pageSize: '20',
    request: '',
    action: '',
    resourceId: '',
    sourceId: '',
  });
  const tab = ['inbox', 'mine', 'history'].includes(p.tab) ? p.tab : 'inbox';
  const status = p.status === 'default' ? (tab === 'mine' ? 'ongoing' : 'all') : p.status;
  const days = p.days === 'default' ? (tab === 'history' ? '30' : '0') : p.days;
  const page = Math.max(1, Number(p.page) || 1),
    pageSize = [20, 50, 100].includes(Number(p.pageSize)) ? Number(p.pageSize) : 20;
  const params = new URLSearchParams({
    scope: tab,
    status,
    days,
    q: p.q,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (p.type in REQUEST_TYPES) params.set('type', p.type);
  if (p.resourceId) params.set('resourceId', p.resourceId);
  if (p.sourceId) params.set('sourceId', p.sourceId);
  const list = useQuery({
    queryKey: ['requests', params.toString()],
    queryFn: () => api<ApprovalRequestPage>('GET', '/api/requests?' + params),
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (list.data && page > Math.max(1, Math.ceil(list.data.total / pageSize)))
      set({ page: String(Math.max(1, Math.ceil(list.data.total / pageSize))) });
  }, [list.data, page, pageSize]);
  return (
    <div className="space-y-5">
      <PageHeader title="权限申请" description="在这里处理各类资源申请，查看审批结果与驳回原因。" />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v, status: 'default', days: 'default', page: '1' })}>
        <TabsList aria-label="申请范围" className="w-full sm:w-auto">
          <TabsTrigger value="inbox">
            待我审批{list.data?.pendingCount ? ` (${list.data.pendingCount})` : ''}
          </TabsTrigger>
          <TabsTrigger value="mine">我发起的</TabsTrigger>
          <TabsTrigger value="history">已处理</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <div className="relative min-w-0 flex-1 sm:min-w-56">
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索申请"
            className="pl-9"
            placeholder="搜索资源、申请人或申请理由"
            value={p.q}
            onChange={(e) => set({ q: e.target.value, page: '1' })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Filter
            label="申请类型"
            value={p.type}
            onChange={(v) => set({ type: v, page: '1' })}
            options={{ all: '全部类型', ...REQUEST_TYPES }}
          />
          {tab !== 'inbox' && (
            <Filter
              label="申请状态"
              value={status}
              onChange={(v) => set({ status: v, page: '1' })}
              options={{
                all: '全部状态',
                ...(tab === 'mine' ? { ongoing: '进行中' } : {}),
                ...Object.fromEntries(
                  Object.entries(REQUEST_STATUSES).filter(([k]) => tab !== 'history' || k !== 'pending'),
                ),
              }}
            />
          )}
          {tab !== 'inbox' && (
            <Filter
              label="时间范围"
              value={days}
              onChange={(v) => set({ days: v, page: '1' })}
              options={{ '30': '最近 30 天', '90': '最近 90 天', '0': '全部时间' }}
            />
          )}
        </div>
      </div>
      {(p.resourceId || p.sourceId) && (
        <Button variant="outline" size="sm" onClick={() => set({ resourceId: '', sourceId: '', page: '1' })}>
          清除指定资源筛选
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {tab === 'inbox'
          ? '仅显示你有权处理的待审批申请，长期未处理的申请也会保留。'
          : tab === 'mine'
            ? '默认显示进行中的申请；切换状态可查看已结束的申请。'
            : '同一事项显示最近处理的一轮，打开详情可查看全部申请记录。'}
      </p>
      <div className="overflow-hidden rounded-xl border bg-card">
        {list.isError ? (
          <div className="p-8 text-center">
            <p className="mb-3 text-destructive">{list.error.message}</p>
            <Button variant="outline" onClick={() => void list.refetch()}>
              重试
            </Button>
          </div>
        ) : !list.data ? (
          <p className="p-12 text-center text-muted-foreground">正在加载申请…</p>
        ) : !list.data.items.length ? (
          <div className="p-12 text-center text-muted-foreground">
            {tab === 'inbox' ? '没有待你审批的申请' : '当前条件下没有申请'}
            {tab !== 'inbox' && (
              <Button
                className="mt-3 block mx-auto"
                variant="link"
                onClick={() => set({ status: 'all', days: '0', q: '', type: 'all', page: '1' })}
              >
                查看全部记录
              </Button>
            )}
          </div>
        ) : (
          <ul aria-label="申请列表" className="divide-y">
            {list.data.items.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => set({ request: r.id })}
                  className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-primary sm:p-5"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">{REQUEST_TYPES[r.type]}</span>
                      <RequestStatus r={r} />
                    </div>
                    <p className="truncate font-medium">{r.targetName}</p>
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {r.rejectionReason
                        ? `驳回原因：${r.rejectionReason}`
                        : r.closedReason || r.reason || '未填写申请理由'}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{r.requesterName}</span>
                      <span>{formatDateTime(r.createdAt)}</span>
                      {r.status === 'pending' && (
                        <span>
                          已等待 {Math.max(0, Math.floor((Date.now() - Date.parse(r.createdAt)) / 86400000))} 天
                        </span>
                      )}
                      {r.round > 1 && <span>第 {r.round} 次申请</span>}
                    </div>
                  </div>
                  <span className="hidden text-sm text-muted-foreground sm:block">
                    {r.canApprove ? '查看并审批' : '查看详情'}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {list.data && (
        <Pagination
          total={list.data.total}
          page={page}
          pageSize={pageSize}
          onPageChange={(v) => set({ page: String(v) })}
          onPageSizeChange={(v) => set({ pageSize: String(v), page: '1' })}
        />
      )}
      {p.request && (
        <RequestDialog
          key={p.request}
          id={p.request}
          initialAction={p.action === 'reject' ? 'rejected' : ''}
          close={() => set({ request: '', action: '' })}
          openRequest={(id) => set({ request: id, action: '' })}
        />
      )}
    </div>
  );
}
function RequestDialog({
  id,
  close,
  openRequest,
  initialAction,
}: {
  id: string;
  close: () => void;
  openRequest: (id: string) => void;
  initialAction: string;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['request-detail', id],
    queryFn: () => api<ApprovalRequestDetail>('GET', `/api/requests/${id}`),
    refetchInterval: 10000,
  });
  const [action, setAction] = useState(initialAction),
    [reason, setReason] = useState(''),
    [expires, setExpires] = useState<Date | undefined>();
  const mutation = useMutation({
    mutationFn: () =>
      api<ApprovalRequestDetail>(
        'POST',
        `/api/requests/${id}/${['approved', 'rejected'].includes(action) ? 'decision' : action}`,
        ['approved', 'rejected'].includes(action)
          ? {
              decision: action,
              reason: reason.trim() || undefined,
              grantExpiresAt: expires?.toISOString(),
            }
          : action === 'resubmit'
            ? { reason: reason.trim() }
            : {},
      ),
    onSuccess: async (data) => {
      toast.success(action === 'remind' ? '已安排提醒；投递状态将在页面更新' : '已保存处理结果');
      setAction('');
      setReason('');
      await qc.invalidateQueries({ queryKey: ['requests'] });
      await qc.invalidateQueries({ queryKey: ['request-detail'] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
      if (data.request.id !== id) openRequest(data.request.id);
    },
    onError: (e) => toast.error(e.message),
  });
  const r = detail.data?.request;
  return (
    <Dialog open onOpenChange={(v) => !v && !mutation.isPending && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{r?.targetName ?? '申请详情'}</DialogTitle>
          <DialogDescription>{r ? REQUEST_TYPES[r.type] : '正在读取申请'}</DialogDescription>
        </DialogHeader>
        {detail.isError ? (
          <div>
            <p className="mb-3 text-destructive">{detail.error.message}</p>
            <Button variant="outline" onClick={() => void detail.refetch()}>
              重试
            </Button>
          </div>
        ) : (
          r && (
            <div className="space-y-5">
              <div className="flex flex-wrap justify-between gap-2">
                <RequestStatus r={r} />
                <Button asChild size="sm" variant="ghost">
                  <Link to={r.resourceUrl}>
                    查看资源
                    <ArrowUpRight />
                  </Link>
                </Button>
              </div>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">申请人</dt>
                  <dd>{r.requesterName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">申请时间</dt>
                  <dd>{formatDateTime(r.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">审批人</dt>
                  <dd>{r.decidedByName ?? '未记录'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">处理时间</dt>
                  <dd>{r.decidedAt ? formatDateTime(r.decidedAt) : '未记录'}</dd>
                </div>
              </dl>
              <div className="rounded-lg bg-muted/50 p-4 text-sm">
                <p className="mb-2 font-medium">申请说明</p>
                <p className="whitespace-pre-wrap break-words">{r.reason || '未填写'}</p>
                {Array.isArray(r.details.keys) && <p className="mt-3 break-words">变量：{r.details.keys.join('、')}</p>}
                {typeof r.details.prefix === 'string' && <p className="mt-3 break-all">存储目录：{r.details.prefix}</p>}
              </div>
              {r.type === 'app' && (
                <>
                  <div className="text-sm break-all">
                    仓库：{String(r.details.repoUrl ?? '未记录')}
                    <br />
                    分支：{String(r.details.branch ?? '未记录')}
                  </div>
                  {typeof r.details.slug === 'string' && <GithubAppSummary slug={r.details.slug} />}
                </>
              )}
              {r.status === 'rejected' && (
                <div className="rounded-lg border border-destructive/30 p-4 text-sm">
                  <p className="mb-1 font-medium text-destructive">驳回原因</p>
                  <p className="whitespace-pre-wrap break-words">{r.rejectionReason || '旧记录未保存驳回原因'}</p>
                </div>
              )}
              {r.closedReason && <p className="text-sm text-muted-foreground">{r.closedReason}</p>}
              {r.executionError && (
                <p className="text-sm text-destructive">
                  审批已通过，执行失败：{r.executionError}。请进入资源详情处理，勿重新提交审批。
                </p>
              )}
              {r.notificationError && <p className="text-xs text-muted-foreground">{r.notificationError}</p>}
              {!r.latest && detail.data!.rounds[0] && (
                <Button variant="outline" onClick={() => openRequest(detail.data!.rounds[0].id)}>
                  查看最新一轮申请
                </Button>
              )}
              {!action || (['approved', 'rejected'].includes(action) && !r.canApprove) ? (
                <div className="flex flex-wrap gap-2">
                  {r.canApprove && (
                    <>
                      <Button onClick={() => setAction('approved')}>批准申请</Button>
                      <Button variant="outline-destructive" onClick={() => setAction('rejected')}>
                        驳回
                      </Button>
                    </>
                  )}
                  {r.canWithdraw && (
                    <Button variant="outline" onClick={() => setAction('withdraw')}>
                      撤回申请
                    </Button>
                  )}
                  {r.canRemind && (
                    <Button variant="outline" onClick={() => setAction('remind')}>
                      提醒审批人
                    </Button>
                  )}
                  {r.canResubmit && (
                    <Button
                      onClick={() => {
                        setAction('resubmit');
                        setReason(r.reason);
                      }}
                    >
                      重新申请
                    </Button>
                  )}
                </div>
              ) : (
                <form
                  className="space-y-4 rounded-lg border p-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    mutation.mutate();
                  }}
                >
                  <p className="font-medium">
                    {
                      (
                        {
                          approved: '确认批准申请',
                          rejected: '填写驳回原因',
                          resubmit: '修改说明并重新申请',
                          withdraw: '确认撤回本次申请',
                          remind: '提醒审批人（每 24 小时一次）',
                        } as Record<string, string>
                      )[action]
                    }
                  </p>
                  {['rejected', 'resubmit'].includes(action) && (
                    <Textarea
                      aria-label={action === 'rejected' ? '驳回原因' : '申请说明'}
                      required
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={
                        action === 'rejected' ? '说明原因，申请人可在网页、CLI 和 MCP 中查看' : '说明用途及本次修改'
                      }
                      rows={4}
                    />
                  )}
                  {action === 'approved' && r.type === 'env' && (
                    <div className="space-y-1.5 text-sm">
                      <p>授权有效期（留空为永久）</p>
                      <DateTimePicker
                        aria-label="授权有效期"
                        value={expires}
                        onChange={setExpires}
                        placeholder="永久"
                        presets={EXPIRY_PRESETS}
                      />
                    </div>
                  )}
                  {action === 'approved' && ['db', 'oss'].includes(r.type) && (
                    <p className="text-sm text-muted-foreground">
                      批准后将执行资源开通。开通中或失败的状态会独立显示。
                    </p>
                  )}
                  {action === 'approved' && r.type === 'app' && (
                    <p className="text-sm text-muted-foreground">批准当前仓库版本的部署权限，并允许管理应用成员。</p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      loading={mutation.isPending}
                      disabled={['rejected', 'resubmit'].includes(action) && !reason.trim()}
                    >
                      确认{action === 'rejected' ? '驳回' : action === 'approved' ? '批准' : '提交'}
                    </Button>
                    <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setAction('')}>
                      取消
                    </Button>
                  </div>
                </form>
              )}
              {detail.data!.rounds.length > 1 && (
                <div className="border-t pt-4">
                  <h3 className="mb-3 text-sm font-medium">历次申请</h3>
                  <ul className="space-y-3">
                    {detail.data!.rounds.map((x) => (
                      <li key={x.id} className="rounded-lg border p-3 text-sm">
                        <div className="flex flex-wrap justify-between gap-2">
                          <span>
                            第 {x.round} 次 · {formatDateTime(x.createdAt)}
                          </span>
                          <RequestStatus r={x} />
                        </div>
                        <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                          {x.rejectionReason || x.closedReason || x.reason || '未记录'}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          审批人：{x.decidedByName ?? '未记录'} ·{' '}
                          {x.decidedAt ? formatDateTime(x.decidedAt) : '处理时间未记录'}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
