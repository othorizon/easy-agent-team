import type { ApprovalRequestDetail } from '@eat/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CircleAlert, LoaderCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button } from '../components/ui/button';

/** Only signed notification links can automatically POST a decision. GET is read-only. */
export function RequestApprovePage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  return <RequestApproval key={`${id}:${token}`} id={id} token={token} />;
}

function RequestApproval({ id, token }: { id: string; token: string }) {
  const started = useRef(false);
  const qc = useQueryClient();
  const [result, setResult] = useState<ApprovalRequestDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setError('快捷审批链接不完整，请前往申请详情处理。');
      return;
    }
    void api<ApprovalRequestDetail>('POST', `/api/requests/${encodeURIComponent(id)}/notification-approve`, {
      token,
    })
      .then((data) => {
        setResult(data);
        void qc.invalidateQueries({ queryKey: ['requests'] });
        void qc.invalidateQueries({ queryKey: ['request-detail'] });
        void qc.invalidateQueries({ queryKey: ['apps'] });
      })
      .catch((e: Error) => setError(e.message));
  }, [id, token, qc]);
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => window.close(), 1200);
    return () => window.clearTimeout(timer);
  }, [result]);
  return (
    <section
      className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-5 text-center"
      aria-live="polite"
    >
      {result ? (
        <CheckCircle2 className="size-10 text-emerald-600" />
      ) : error ? (
        <CircleAlert className="size-10 text-destructive" />
      ) : (
        <LoaderCircle className="size-10 animate-spin text-muted-foreground" />
      )}
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">
          {result ? '已同意申请' : error ? '未完成快捷审批' : '正在同意申请…'}
        </h1>
        <p className="break-words text-sm leading-6 text-muted-foreground">
          {result ? result.request.targetName : error || '正在核验登录账户与审批权限，请稍候。'}
        </p>
        {result && (
          <p className="text-sm leading-6 text-muted-foreground">
            {result.request.execution === 'failed'
              ? '审批已通过，资源开通失败，请查看详情处理。'
              : result.request.execution === 'provisioning'
                ? '审批已通过，资源正在开通。'
                : '审批结果已保存。'}
            <br />
            若页面没有自动关闭，可手动关闭并返回飞书。
          </p>
        )}
      </div>
      {(result || error) && (
        <Button asChild variant="outline">
          <Link to={`/requests?request=${encodeURIComponent(id)}`}>查看详情</Link>
        </Button>
      )}
    </section>
  );
}
