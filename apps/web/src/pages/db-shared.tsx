import type { DbAssignmentInfo, DbAssignmentStatus } from '@eat/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { Confirm } from '../components/confirm';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

/** 分配状态徽标：清单、详情页、凭证环境的来源行三处共用一套口径 */
export const DB_STATUS_BADGE: Record<DbAssignmentStatus, JSX.Element> = {
  pending: <Badge variant="warning">待批准</Badge>,
  active: <Badge variant="success">可用</Badge>,
  failed: <Badge variant="destructive">执行失败</Badge>,
  rejected: <Badge variant="outline">已驳回</Badge>,
  disabled: <Badge variant="destructive">已禁用</Badge>,
  deleted: <Badge variant="outline">已删除</Badge>,
};

export type AssignmentAction = 'approve' | 'reject' | 'disable' | 'enable' | 'delete';

/** 管理员对分配记录的操作：清单页与详情页共用同一套调用、提示与缓存失效 */
export function useAssignmentAction(onDone?: (action: AssignmentAction, result: DbAssignmentInfo) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: AssignmentAction }) =>
      v.action === 'delete'
        ? api<DbAssignmentInfo>('DELETE', `/api/db/assignments/${v.id}`)
        : api<DbAssignmentInfo>('POST', `/api/db/assignments/${v.id}/${v.action}`, {}),
    onSuccess: (r, v) => {
      if (r.status === 'failed') toast.error(`执行失败：${r.error}`);
      else toast.success('已处理');
      for (const key of ['db-instances', 'db-mine', 'db-all', 'envs']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      void queryClient.invalidateQueries({ queryKey: ['db-assignment', v.id] });
      onDone?.(v.action, r);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });
}

/** 按状态给出可做的操作按钮（仅管理员渲染） */
export function AssignmentActions({
  row,
  pending,
  size = 'sm',
  onAct,
}: {
  row: DbAssignmentInfo;
  pending: boolean;
  size?: 'sm' | 'default';
  onAct: (action: AssignmentAction) => void;
}) {
  return (
    <>
      {row.status === 'pending' && (
        <>
          <Button size={size} onClick={() => onAct('approve')} loading={pending}>
            批准并建库
          </Button>
          <Button size={size} variant="outline" onClick={() => onAct('reject')} disabled={pending}>
            驳回
          </Button>
        </>
      )}
      {row.status === 'active' && (
        <Button size={size} variant="outline" onClick={() => onAct('disable')} disabled={pending}>
          禁用
        </Button>
      )}
      {row.status === 'disabled' && (
        <Button size={size} variant="outline" onClick={() => onAct('enable')} disabled={pending}>
          恢复
        </Button>
      )}
      {['active', 'disabled', 'failed', 'rejected'].includes(row.status) && (
        <Confirm
          title="删除分配记录？"
          description={
            <>
              仅删除平台上的记录与凭证环境，<b>不会</b>删除实例上的数据库与账号；如需彻底清理，只能到数据库实例上手动删除。
            </>
          }
          confirmText="删除"
          onConfirm={() => onAct('delete')}
        >
          <Button size={size} variant="outline-destructive" disabled={pending}>
            删除
          </Button>
        </Confirm>
      )}
    </>
  );
}
