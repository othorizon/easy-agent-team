import type { DbAssignmentInfo } from '@eat/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, KeyRound } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, getStoredUser } from '../api';
import { Cmd, CopyButton, InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { PageHeader } from '../components/page-header';
import { PageLoading } from '../components/page-loading';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { formatDateTime } from '../lib/utils';
import { AssignmentActions, DB_STATUS_BADGE, useAssignmentAction } from './db-shared';

/**
 * 数据库分配详情（决策 39）：清单里一行放不下的东西都在这——实例地址、账号、处理人与时间、失败原因，
 * 以及最重要的「凭证在哪」：直达凭证环境，和环境详情页互相回指。
 */
export function DbAssignmentDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const backTo = isAdmin ? '/db?tab=all' : '/db';

  const detail = useQuery({
    queryKey: ['db-assignment', id],
    queryFn: () => api<DbAssignmentInfo>('GET', `/api/db/assignments/${id}`),
    retry: false,
  });
  // 删除后记录仍可查（status=deleted），但它已不在任何清单里，回清单更顺
  const act = useAssignmentAction((action) => action === 'delete' && navigate(backTo));

  if (detail.isError) {
    const err = detail.error;
    return (
      <div className="space-y-5">
        <BackLink to={backTo} />
        <Empty
          text={
            err instanceof ApiError && err.status === 403
              ? '这条分配不是你申请的，只有申请人和管理员能查看。'
              : '分配记录不存在，可能已被删除。'
          }
        />
      </div>
    );
  }
  if (!detail.data) return <PageLoading />;
  const r = detail.data;

  return (
    <div className="space-y-5">
      <div>
        <BackLink to={backTo} />
        <PageHeader
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              库 <InlineCode className="text-lg">{r.dbName}</InlineCode>
              {DB_STATUS_BADGE[r.status]}
            </span>
          }
          description={r.purpose}
          actions={isAdmin && <AssignmentActions row={r} size="default" pending={act.isPending} onAct={(action) => act.mutate({ id: r.id, action })} />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardContent>
            <h2 className="mb-4 text-sm font-semibold">分配信息</h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
              <Dt>实例</Dt>
              <Dd>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.instanceName}</span>
                  <Badge variant="secondary">{r.engine}</Badge>
                </span>
                {r.instanceHost && (
                  <div className="mt-1">
                    <InlineCode>
                      {r.instanceHost}:{r.instancePort}
                    </InlineCode>
                  </div>
                )}
              </Dd>
              <Dt>库名</Dt>
              <Dd>
                <span className="inline-flex items-center gap-1">
                  <InlineCode>{r.dbName}</InlineCode>
                  <CopyButton text={r.dbName} />
                </span>
              </Dd>
              <Dt>账号</Dt>
              <Dd>
                <span className="inline-flex items-center gap-1">
                  <InlineCode>{r.dbUser}</InlineCode>
                  <CopyButton text={r.dbUser} />
                </span>
                <div className="mt-0.5 text-xs text-muted-foreground">权限限定在本库内</div>
              </Dd>
              <Dt>申请人</Dt>
              <Dd>
                {r.requesterName}
                <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(r.createdAt)} 申请</span>
              </Dd>
              <Dt>处理</Dt>
              <Dd>
                {r.decidedByName ? (
                  <>
                    {r.decidedByName}
                    <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(r.updatedAt)} 最近处理</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">等待管理员处理</span>
                )}
              </Dd>
              {r.error && (
                <>
                  <Dt>失败原因</Dt>
                  <Dd>
                    <pre className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-destructive">
                      {r.error}
                    </pre>
                  </Dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        <CredentialsCard r={r} />
      </div>
    </div>
  );
}

function BackLink({ to }: { to: string }) {
  return (
    <Link to={to} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft className="size-3.5" />
      数据库
    </Link>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="pt-0.5 whitespace-nowrap text-muted-foreground">{children}</dt>;
}

function Dd({ children }: { children: React.ReactNode }) {
  return <dd className="min-w-0">{children}</dd>;
}

/** 凭证在哪：有环境就直达，没有就说清楚为什么没有 */
function CredentialsCard({ r }: { r: DbAssignmentInfo }) {
  let body: React.ReactNode;
  if (r.environmentSlug) {
    body = (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">
          连接信息（主机、端口、库名、账号、密码）以环境变量的形式下发在环境{' '}
          <Link to={`/envs/${r.environmentSlug}`}>
            <InlineCode className="text-primary hover:underline">{r.environmentSlug}</InlineCode>
          </Link>{' '}
          里，本地这样拉取：
        </p>
        <Cmd text={`eat env pull ${r.environmentSlug}`} />
        <p className="text-sm leading-relaxed text-muted-foreground">
          环境的 Owner 是申请人 <span className="font-medium text-foreground">{r.requesterName}</span>
          ：可以直接读取全部凭证（含密码），也可以把整个环境授权给其他成员；其他人默认看不到这组变量。
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to={`/envs/${r.environmentSlug}`}>
            打开凭证环境
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </div>
    );
  } else if (r.status === 'pending') {
    body = <Note>批准后平台会在实例上建库建号，并自动生成一个凭证环境（Owner 为申请人），这里会出现拉取命令。</Note>;
  } else if (r.status === 'rejected') {
    body = <Note>申请已驳回，没有建库，也没有生成凭证。</Note>;
  } else if (r.status === 'failed') {
    body = <Note>建库失败，未生成凭证；处理完失败原因后可删除本记录重新申请。</Note>;
  } else if (r.status === 'deleted') {
    body = <Note>记录已删除，凭证环境已一并删除；实例上的库与账号未做物理删除，需管理员到实例上手动清理。</Note>;
  } else {
    body = (
      <Note>
        凭证环境已被删除，密码无法找回。如需继续使用这个库，请管理员在实例上重置账号密码，或删除本记录后重新申请。
      </Note>
    );
  }
  return (
    <Card>
      <CardContent>
        <h2 className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold">
          <KeyRound className="size-4 text-muted-foreground" />
          连接凭证
        </h2>
        {body}
      </CardContent>
    </Card>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}
