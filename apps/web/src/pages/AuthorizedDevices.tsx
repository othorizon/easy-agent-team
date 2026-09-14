import type { ApiTokenInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
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
          {tokens.isLoading ? (
            <TableSkeleton />
          ) : devices.length === 0 ? (
            <Empty
              text="还没有授权过设备"
              action={
                <Button asChild variant="link" size="sm">
                  <Link to="/device">去授权一台设备</Link>
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>设备</TableHead>
                  <TableHead className="hidden w-44 sm:table-cell">授权时间</TableHead>
                  <TableHead className="w-32">最近使用</TableHead>
                  <TableHead className="w-20">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium">{t.name}</span>
                        {isExpired(t) && <Badge variant="warning">已过期</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">
                        授权于 {formatDateTime(t.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {formatDateTime(t.createdAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.lastUsedAt ? (
                        <span title={formatDateTime(t.lastUsedAt)}>{formatRelativeTime(t.lastUsedAt)}</span>
                      ) : (
                        <span className="text-muted-foreground/60">从未使用</span>
                      )}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
