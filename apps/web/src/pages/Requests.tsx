import type { AccessRequestInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime } from '../lib/utils';

const STATUS_BADGE: Record<string, JSX.Element> = {
  pending: <Badge variant="warning">待审批</Badge>,
  approved: <Badge variant="success">已批准</Badge>,
  rejected: <Badge variant="destructive">已驳回</Badge>,
};

export function RequestsPage() {
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState<AccessRequestInfo | null>(null);

  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<AccessRequestInfo[]>('GET', '/api/access-requests/inbox'),
  });
  const mine = useQuery({
    queryKey: ['mine-requests'],
    queryFn: () => api<AccessRequestInfo[]>('GET', '/api/access-requests/mine'),
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
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

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
        <TableCell>{STATUS_BADGE[row.status]}</TableCell>
        <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDateTime(row.createdAt)}</TableCell>
      </>
    );
  }

  const headCells = (
    <>
      <TableHead>环境</TableHead>
      <TableHead>变量</TableHead>
      <TableHead className="hidden md:table-cell">理由</TableHead>
      <TableHead className="w-22">状态</TableHead>
      <TableHead className="hidden w-36 lg:table-cell">时间</TableHead>
    </>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="权限申请"
        description="成员对环境变量发起的读取申请。CLI 里 eat env request 或 AI 通过 MCP 也可以发起。"
      />

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">待我审批</h2>
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
                  <TableHead className="w-32">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(inbox.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium whitespace-nowrap">{row.requesterName}</TableCell>
                    <RequestCells row={row} />
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

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">我发起的申请</h2>
          {mine.isLoading ? (
            <TableSkeleton rows={2} />
          ) : (mine.data ?? []).length === 0 ? (
            <Empty text="暂无申请。CLI 里 eat env request 或 AI 通过 MCP 也可以发起。" className="py-6" />
          ) : (
            <Table className="min-w-[520px]">
              <TableHeader>
                <TableRow>{headCells}</TableRow>
              </TableHeader>
              <TableBody>
                {(mine.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <RequestCells row={row} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
