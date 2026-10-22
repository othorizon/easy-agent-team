import type { ApiTokenInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { Empty } from '../components/empty';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tip } from '../components/ui/tooltip';
import { Card, CardContent } from '../components/ui/card';
import { formatDateTime, formatRelativeTime } from '../lib/format';

/** 设备 = 设备码授权签发的 CLI Token（CLI 与 MCP 共用）；网页登录会话不算设备，吊销过的不再列 */
function isActiveDevice(t: ApiTokenInfo): boolean {
  return t.kind === 'cli' && !t.revokedAt;
}

function isExpired(t: ApiTokenInfo, now = Date.now()): boolean {
  return !!t.expiresAt && new Date(t.expiresAt).getTime() < now;
}

/** 已授权的设备清单：从 /device 授权页底部进入，查看与吊销 */
export function AuthorizedDevicesPage() {
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: ['auth-tokens'], queryFn: () => api<ApiTokenInfo[]>('GET', '/api/auth/tokens') });
  const devices = (tokens.data ?? []).filter(isActiveDevice);

  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/auth/tokens/${id}`),
    onSuccess: () => {
      toast.success('已吊销，该设备需要重新登录');
      void queryClient.invalidateQueries({ queryKey: ['auth-tokens'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '吊销失败'),
  });

  const columns: DataTableColumn<ApiTokenInfo>[] = [
    {
      id: 'name',
      header: '设备',
      cell: ({ row: { original: t } }) => (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium">{t.name}</span>
            {isExpired(t) && <Badge variant="warning">已过期</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">授权于 {formatDateTime(t.createdAt)}</div>
        </>
      ),
    },
    {
      id: 'createdAt',
      header: '授权时间',
      meta: { className: 'w-44', cellClassName: 'text-muted-foreground', hideBelow: 'sm' },
      cell: ({ row: { original: t } }) => formatDateTime(t.createdAt),
    },
    {
      id: 'lastUsedAt',
      header: '最近使用',
      meta: { className: 'w-32', cellClassName: 'text-muted-foreground' },
      cell: ({ row: { original: t } }) =>
        t.lastUsedAt ? (
          <Tip content={formatDateTime(t.lastUsedAt)}>
            <span>{formatRelativeTime(t.lastUsedAt)}</span>
          </Tip>
        ) : (
          <span className="text-muted-foreground/60">从未使用</span>
        ),
    },
    {
      id: 'actions',
      header: '操作',
      meta: { className: 'w-20' },
      cell: ({ row: { original: t } }) => (
        <Confirm
          title={`吊销「${t.name}」的授权？`}
          description="该设备上的 CLI 与 MCP 会立即失效，需要重新运行 eat login。此操作不可撤销。"
          confirmText="吊销"
          onConfirm={() => revoke.mutate(t.id)}
        >
          <Button size="sm" variant="outline-destructive" loading={revoke.isPending && revoke.variables === t.id}>
            吊销
          </Button>
        </Confirm>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="已授权的设备"
        description={
          <>
            这些设备上的 CLI / MCP 正以你的身份访问平台（MCP 复用 CLI 凭证，算同一台设备）。
            吊销后该设备立即失效，需要重新运行 <InlineCode>eat login</InlineCode>。
          </>
        }
        actions={
          <Button asChild variant="outline">
            <Link to="/device">
              <Plus />
              授权新设备
            </Link>
          </Button>
        }
      />
      <Card>
        <CardContent>
          <DataTable
            columns={columns}
            data={devices}
            loading={tokens.isLoading}
            getRowId={(t) => t.id}
            empty={
              <Empty
                text="还没有授权过设备"
                action={
                  <Button asChild variant="link" size="sm">
                    <Link to="/device">去授权一台设备</Link>
                  </Button>
                }
              />
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
