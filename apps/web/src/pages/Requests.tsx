import type { AccessRequestHistoryResult, AccessRequestHistoryStatus, AccessRequestInfo } from '@eat/shared';
import { ACCESS_REQUEST_HISTORY_DEFAULT_PAGE_SIZE } from '@eat/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatDateTime } from '../lib/format';
import { useQueryParams } from '../lib/use-query-params';

const STATUS_BADGE: Record<string, JSX.Element> = {
  pending: <Badge variant="warning">待审批</Badge>,
  approved: <Badge variant="success">已批准</Badge>,
  rejected: <Badge variant="destructive">已驳回</Badge>,
};

const HISTORY_STATUSES: AccessRequestHistoryStatus[] = ['all', 'approved', 'rejected'];
const HISTORY_STATUS_LABEL: Record<AccessRequestHistoryStatus, string> = {
  all: '全部',
  approved: '已批准',
  rejected: '已驳回',
};

export function RequestsPage() {
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState<AccessRequestInfo | null>(null);
  // tab 之外的三个参数只属于「历史审批」页签：结果筛选与分页都同步到 URL，刷新 / 分享链接能还原
  const [params, setParams] = useQueryParams({
    tab: 'inbox',
    status: 'all',
    page: '1',
    pageSize: String(ACCESS_REQUEST_HISTORY_DEFAULT_PAGE_SIZE),
  });
  const tab = params.tab;
  const status = (HISTORY_STATUSES as string[]).includes(params.status)
    ? (params.status as AccessRequestHistoryStatus)
    : 'all';
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Number(params.pageSize) || ACCESS_REQUEST_HISTORY_DEFAULT_PAGE_SIZE;

  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<AccessRequestInfo[]>('GET', '/api/access-requests/inbox'),
  });
  const mine = useQuery({
    queryKey: ['mine-requests'],
    queryFn: () => api<AccessRequestInfo[]>('GET', '/api/access-requests/mine'),
  });
  const history = useQuery({
    queryKey: ['access-requests-history', status, page, pageSize],
    queryFn: () =>
      api<AccessRequestHistoryResult>(
        'GET',
        `/api/access-requests/history?${new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) })}`,
      ),
    // 翻页 / 切筛选时保留上一页数据，避免整张表闪成骨架屏
    placeholderData: keepPreviousData,
    enabled: tab === 'history',
  });

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected'; grantExpiresAt?: string }) =>
      api('POST', `/api/access-requests/${v.id}/decision`, {
        decision: v.decision,
        grantExpiresAt: v.grantExpiresAt,
      }),
    onSuccess: () => {
      toast.success('已处理');
      setApproving(null);
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['mine-requests'] });
      // 处理完的申请从 inbox 移到历史里
      void queryClient.invalidateQueries({ queryKey: ['access-requests-history'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  /** 三张表共用的四列：环境 / 变量 / 理由 / 状态；时间列各表含义不同（申请时间 vs 审批时间），由各表自己给 */
  function RequestCells({ row }: { row: AccessRequestInfo }) {
    return (
      <>
        <TableCell>
          <InlineCode>{row.environmentSlug}</InlineCode>
        </TableCell>
        <TableCell>
          <div className="flex max-w-56 flex-wrap gap-1">
            {row.keys.map((k) => (
              <InlineCode key={k}>{k}</InlineCode>
            ))}
          </div>
        </TableCell>
        <TableCell className="hidden max-w-56 truncate text-muted-foreground md:table-cell" title={row.reason}>
          {row.reason}
        </TableCell>
        <TableCell>
          {STATUS_BADGE[row.status]}
          {row.status === 'approved' && (
            <div className="mt-1 text-xs whitespace-nowrap text-muted-foreground">
              {row.grantExpiresAt ? `有效至 ${formatDateTime(row.grantExpiresAt)}` : '永久有效'}
            </div>
          )}
        </TableCell>
      </>
    );
  }

  const headCells = (
    <>
      <TableHead>环境</TableHead>
      <TableHead>变量</TableHead>
      <TableHead className="hidden md:table-cell">理由</TableHead>
      <TableHead className="w-22">状态</TableHead>
    </>
  );

  const historyItems = history.data?.items ?? [];
  const historyCounts = history.data?.counts;
  const historyTotalAll = historyCounts ? historyCounts.approved + historyCounts.rejected : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="权限申请"
        description="成员对环境变量发起的读取申请。CLI 里 eat env request 或 AI 通过 MCP 也可以发起。"
      />

      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        {/* 页签（实心轨道 = 导航）与只属于「历史审批」的结果筛选（描边轨道）并排一行，窄屏下换行 */}
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          <TabsList aria-label="申请范围">
            <TabsTrigger value="inbox">
              待我审批
              {(inbox.data ?? []).length > 0 && <Badge className="px-1.5">{(inbox.data ?? []).length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="mine">我发起的申请</TabsTrigger>
            <TabsTrigger value="history">历史审批</TabsTrigger>
          </TabsList>
          {tab === 'history' && (
            <Segmented
              variant="outline"
              ariaLabel="按审批结果筛选"
              value={status}
              onChange={(v) => setParams({ status: v, page: '1' })}
              options={HISTORY_STATUSES.map((s) => ({
                value: s,
                label: (
                  <>
                    {HISTORY_STATUS_LABEL[s]}
                    {/* 数量回答「切过去会有几条」：筛选本身不参与计数 */}
                    {historyCounts && (
                      <span className="text-xs tabular-nums opacity-60">
                        {s === 'all' ? historyTotalAll : historyCounts[s]}
                      </span>
                    )}
                  </>
                ),
              }))}
            />
          )}
        </div>

        <TabsContent value="inbox" className="mt-4">
          <Card>
            <CardContent>
              {inbox.isLoading ? (
                <TableSkeleton rows={2} />
              ) : (inbox.data ?? []).length === 0 ? (
                <Empty text="没有待审批的申请" className="py-6" />
              ) : (
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">申请人</TableHead>
                      {headCells}
                      <TableHead className="hidden w-36 lg:table-cell">申请时间</TableHead>
                      <TableHead className="w-32">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(inbox.data ?? []).map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium whitespace-nowrap">{row.requesterName}</TableCell>
                        <RequestCells row={row} />
                        <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                          {formatDateTime(row.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Button size="sm" onClick={() => setApproving(row)}>
                              批准
                            </Button>
                            <Button
                              size="sm"
                              variant="outline-destructive"
                              onClick={() => decide.mutate({ id: row.id, decision: 'rejected' })}
                            >
                              驳回
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mine" className="mt-4">
          <Card>
            <CardContent>
              {mine.isLoading ? (
                <TableSkeleton rows={2} />
              ) : (mine.data ?? []).length === 0 ? (
                <Empty text="暂无申请。CLI 里 eat env request 或 AI 通过 MCP 也可以发起。" className="py-6" />
              ) : (
                <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow>
                      {headCells}
                      <TableHead className="hidden w-36 lg:table-cell">申请时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(mine.data ?? []).map((row) => (
                      <TableRow key={row.id}>
                        <RequestCells row={row} />
                        <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                          {formatDateTime(row.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardContent>
              {history.isPending ? (
                <TableSkeleton rows={3} />
              ) : historyItems.length === 0 ? (
                status !== 'all' && historyTotalAll > 0 ? (
                  <Empty
                    text={`没有${HISTORY_STATUS_LABEL[status]}的申请`}
                    className="py-6"
                    action={
                      <Button variant="outline" size="sm" onClick={() => setParams({ status: 'all', page: '1' })}>
                        查看全部
                      </Button>
                    }
                  />
                ) : (
                  <Empty
                    text="还没有处理过的申请。你审批范围内的申请被批准或驳回后会记在这里，管理员可见全部。"
                    className="py-6"
                  />
                )
              ) : (
                <div className="space-y-3">
                  <Table className="min-w-[760px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">申请人</TableHead>
                        {headCells}
                        <TableHead className="hidden w-24 md:table-cell">审批人</TableHead>
                        <TableHead className="hidden w-36 lg:table-cell">审批时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {historyItems.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="font-medium whitespace-nowrap">{row.requesterName}</TableCell>
                          <RequestCells row={row} />
                          <TableCell className="hidden whitespace-nowrap md:table-cell">
                            {row.decidedByName ?? '—'}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                            {formatDateTime(row.decidedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Pagination
                    total={history.data?.total ?? 0}
                    page={page}
                    pageSize={pageSize}
                    onPageChange={(p) => setParams({ page: String(p) })}
                    onPageSizeChange={(size) => setParams({ pageSize: String(size), page: '1' })}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {approving && (
        <ApproveDialog
          request={approving}
          pending={decide.isPending}
          onClose={() => setApproving(null)}
          onSubmit={(expiresAt) => decide.mutate({ id: approving.id, decision: 'approved', grantExpiresAt: expiresAt })}
        />
      )}
    </div>
  );
}

function ApproveDialog({
  request,
  pending,
  onClose,
  onSubmit,
}: {
  request: AccessRequestInfo;
  pending: boolean;
  onClose: () => void;
  onSubmit: (expiresAt?: string) => void;
}) {
  const [expiresAt, setExpiresAt] = useState('');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>批准 {request.requesterName} 的申请</DialogTitle>
          <DialogDescription>
            {request.environmentSlug}: {request.keys.join(', ')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(expiresAt ? new Date(expiresAt).toISOString() : undefined);
          }}
        >
          <Field label="授权有效期" htmlFor="approve-expire" hint="不填为永久">
            <Input
              id="approve-expire"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            确认批准
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
