import { ResourceRequests } from '../components/resource-requests';
import type { DbAssignmentInfo, DbCredentials } from '@eat/shared';
import { dbCredentialsToEnv } from '@eat/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Eye, EyeOff, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { Cmd, CopyButton, InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { PageHeader } from '../components/page-header';
import { PageLoading } from '../components/page-loading';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { formatDateTime } from '../lib/format';
import { AssignmentActions, DB_STATUS_BADGE, useAssignmentAction } from './db-shared';

/**
 * 数据库分配详情（决策 39）：清单里一行放不下的东西都在这——实例地址、账号、处理人与时间、失败原因，
 * 以及最重要的连接凭证：决策 91 起凭证只在这里取（申请人与管理员可读、每次读取落审计），不再生成环境变量。
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

      <ResourceRequests type="db" sourceId={r.id}/>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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

/** 连接凭证：开通了就在这里查看（读取落审计），没开通就说清楚为什么还没有 */
function CredentialsCard({ r }: { r: DbAssignmentInfo }) {
  let body: React.ReactNode;
  if (r.status === 'active' && r.hasCredentials) {
    body = <CredentialsView r={r} />;
  } else if (r.status === 'active') {
    body = (
      <Note>
        平台上没有这个账号的密码（旧版本里它所在的凭证环境被删除过），无法找回。如需继续使用这个库，请管理员在实例上重置账号密码，或删除本记录后重新申请。
      </Note>
    );
  } else if (r.status === 'pending') {
    body = <Note>批准后平台会在实例上建库建号，连接凭证会出现在这里（只有申请人和管理员能查看）。</Note>;
  } else if (r.status === 'provisioning') {
    body = <Note>审批已通过，正在开通数据库与凭证。请勿重复申请；如长时间没有完成，请联系管理员核对执行情况。</Note>;
  } else if (r.status === 'withdrawn') {
    body = <Note>申请已撤回。需要时可在申请中心重新提交。</Note>;
  } else if (r.status === 'rejected') {
    body = <Note>申请已驳回，没有建库，也没有生成凭证。</Note>;
  } else if (r.status === 'failed') {
    body = <Note>审批已通过，但建库失败。请管理员处理失败原因后重试开通，无需重新申请；如实例上已有同名库或账号，先核对未完成的资源。</Note>;
  } else if (r.status === 'deleted') {
    body = <Note>记录已删除，平台上存的密码已一并清除；实例上的库与账号未做物理删除，需管理员到实例上手动清理。</Note>;
  } else {
    body = <Note>账号已被管理员禁用（无法登录），恢复后才能查看连接凭证。</Note>;
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

/**
 * 主机 / 端口 / 库名 / 账号本就在页上，密码打码；点「查看」才走正式的读取接口——
 * 服务端照常落 db_credentials.read 审计，与终端里 eat db credentials pull 一视同仁。拿到后可复制密码、连接串、整段 .env
 */
function CredentialsView({ r }: { r: DbAssignmentInfo }) {
  const [cred, setCred] = useState<DbCredentials | null>(null);
  const reveal = useMutation({
    mutationFn: () => api<DbCredentials>('POST', `/api/db/assignments/${r.id}/credentials`),
    onSuccess: setCred,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '读取凭证失败'),
  });
  const dotenv = cred ? dbCredentialsToEnv(cred).map(([k, v]) => `${k}=${v}`).join('\n') : '';
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-3 text-sm">
        <Dt>主机</Dt>
        <Dd>
          <span className="inline-flex items-center gap-1">
            <InlineCode>
              {r.instanceHost}:{r.instancePort}
            </InlineCode>
            {r.instanceHost && <CopyButton text={r.instanceHost} />}
          </span>
        </Dd>
        <Dt>密码</Dt>
        <Dd>
          <span className="inline-flex flex-wrap items-center gap-1">
            <InlineCode>{cred ? cred.password : '••••••••••••'}</InlineCode>
            {cred ? (
              <>
                <CopyButton text={cred.password} />
                <Button variant="ghost" size="icon-sm" aria-label="隐藏密码" onClick={() => setCred(null)}>
                  <EyeOff />
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" loading={reveal.isPending} onClick={() => reveal.mutate()}>
                <Eye />
                查看
              </Button>
            )}
          </span>
        </Dd>
        {cred && (
          <>
            <Dt>连接串</Dt>
            <Dd>
              <span className="inline-flex items-start gap-1">
                <InlineCode>{cred.url}</InlineCode>
                <CopyButton text={cred.url} />
              </span>
            </Dd>
            <Dt>.env</Dt>
            <Dd>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                DB_HOST … DB_PASSWORD、DATABASE_URL
                <CopyButton text={dotenv} />
              </span>
            </Dd>
          </>
        )}
      </dl>
      <div className="space-y-2">
        <p className="text-sm leading-relaxed text-muted-foreground">在项目目录里写进 .env（已有手写的 .env 加 --merge）：</p>
        <Cmd text={`eat db credentials pull ${r.dbName}`} />
        <p className="text-sm leading-relaxed text-muted-foreground">或只注入给一条命令，不落盘：</p>
        <Cmd text={`eat db credentials run ${r.dbName} -- <命令>`} />
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        凭证只在这里取，不在环境变量里。只有申请人 <span className="font-medium text-foreground">{r.requesterName}</span>{' '}
        和管理员能查看，每次查看或拉取都会记入审计。
      </p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}
