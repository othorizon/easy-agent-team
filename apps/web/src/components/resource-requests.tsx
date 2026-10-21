import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { type ApprovalRequestPage, type ApprovalRequest, REQUEST_STATUSES } from '@eat/shared';
import { api } from '../api';
import { Button } from './ui/button';

/** A small resource-local status, with all decisions handled in the request centre. */
export function ResourceRequests({
  type,
  resourceId,
  sourceId,
}: {
  type: ApprovalRequest['type'];
  resourceId?: string;
  sourceId?: string;
}) {
  const q = new URLSearchParams({ scope: 'resource', type, pageSize: '3' });
  if (resourceId) q.set('resourceId', resourceId);
  if (sourceId) q.set('sourceId', sourceId);
  const result = useQuery({
    queryKey: ['requests', 'resource', q.toString()],
    queryFn: () => api<ApprovalRequestPage>('GET', '/api/requests?' + q),
    refetchInterval: 15000,
  });
  if (result.isError)
    return (
      <p className="text-xs text-muted-foreground">
        申请状态暂不可用，
        <Link className="underline" to="/requests?tab=mine">
          前往申请中心
        </Link>
      </p>
    );
  if (!result.data?.items.length) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      {result.data.items.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <p>
              {r.requesterName} · {REQUEST_STATUSES[r.status]}
            </p>
            {r.rejectionReason && (
              <p className="mt-1 break-words text-muted-foreground">驳回原因：{r.rejectionReason}</p>
            )}
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to={`/requests?request=${r.id}`}>查看申请</Link>
          </Button>
        </div>
      ))}
    </div>
  );
}
