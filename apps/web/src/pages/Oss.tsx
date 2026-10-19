import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  OSS_CREDENTIAL_NOTE,
  OSS_PUBLIC_READ_NOTE,
  type OssCapability,
  type OssSpaceInfo,
  type OssCredentialInfo,
  type OssAccountInfo,
  type OssOperationInfo,
} from '@eat/shared';
import { api, getStoredUser } from '../api';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Input, Textarea } from '../components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../components/ui/dialog';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { SettingsLoadError, SettingsLoading } from '../components/settings';
import { formatDateTime } from '../lib/format';
import { useQueryParams } from '../lib/use-query-params';

const statuses = {
  pending: '待审批',
  provisioning: '开通中',
  active: '可用',
  failed: '开通失败',
  rejected: '已拒绝',
  revoking: '回收中',
  revoked: '已回收',
};
function useCapability() {
  return useQuery({
    queryKey: ['oss', 'capability'],
    queryFn: () => api<OssCapability>('GET', '/api/oss/capability'),
    refetchInterval: 5000,
  });
}
function useRefresh() {
  const q = useQueryClient();
  return () => q.invalidateQueries({ queryKey: ['oss'] });
}
function Notice({ enabled }: { enabled: boolean }) {
  return enabled ? null : (
    <p className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
      OSS 功能尚未启用，已有空间信息可继续查看。
      {getStoredUser()?.role === 'admin' && (
        <Link
          className="ml-2 text-primary underline"
          to="/settings?section=oss"
        >
          前往系统设置
        </Link>
      )}
    </p>
  );
}
function SpaceForm({
  initial,
  title,
  submit,
  close,
}: {
  initial?: OssSpaceInfo;
  title: string;
  submit: (
    name: string,
    purpose: string,
    requestId: string,
  ) => Promise<unknown>;
  close: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? ''),
    [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const requestId = useRef(crypto.randomUUID());
  const save = useMutation({
    mutationFn: () => submit(name, purpose, requestId.current),
    onSuccess: close,
  });
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !save.isPending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {initial
              ? '修改名称或用途不会改变目录和权限。'
              : '提交后等待管理员批准，默认不授予目录公开读。'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label className="block space-y-2 text-sm">
            空间名称
            <Input
              autoFocus
              required
              maxLength={100}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                requestId.current = crypto.randomUUID();
              }}
            />
          </label>
          <label className="block space-y-2 text-sm">
            用途
            <Textarea
              required
              maxLength={2000}
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value);
                requestId.current = crypto.randomUUID();
              }}
            />
          </label>
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {save.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={close}
            >
              取消
            </Button>
            <Button type="submit" loading={save.isPending}>
              {initial ? '保存更改' : '提交申请'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function RejectSpaceDialog({
  space,
  close,
}: {
  space: OssSpaceInfo;
  close: () => void;
}) {
  const refresh = useRefresh();
  const [reason, setReason] = useState('');
  const reject = useMutation({
    mutationFn: () =>
      api('POST', `/api/oss/spaces/${space.id}/reject`, { reason: reason.trim() }),
    onSuccess: async () => {
      await refresh();
      toast.success('已拒绝空间申请');
      close();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !reject.isPending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>拒绝空间申请</DialogTitle>
          <DialogDescription className="break-words">
            拒绝「{space.name}」的申请，请填写原因，方便申请人了解。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim() && !reject.isPending) reject.mutate();
          }}
        >
          <label className="block space-y-2 text-sm">
            拒绝原因
            <Textarea
              autoFocus
              value={reason}
              required
              maxLength={2000}
              disabled={reject.isPending}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {reject.error && (
            <p role="alert" className="text-sm text-destructive">
              {reject.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={reject.isPending} onClick={close}>
              取消
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={reject.isPending}
              disabled={!reason.trim()}
            >
              确认拒绝
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function OssPage() {
  const admin = getStoredUser()?.role === 'admin',
    cap = useCapability(),
    refresh = useRefresh();
  const [params, setParams] = useQueryParams({ tab: 'mine' });
  const tab = admin && ['all', 'approvals'].includes(params.tab) ? params.tab : 'mine';
  const all = tab !== 'mine',
    approvals = tab === 'approvals';
  const [requesting, setRequesting] = useState(false),
    [rejecting, setRejecting] = useState<OssSpaceInfo | null>(null);
  const spaces = useQuery({
    queryKey: ['oss', 'spaces', all],
    queryFn: () =>
      api<OssSpaceInfo[]>('GET', `/api/oss/spaces${all ? '?all=true' : ''}`),
    refetchInterval: 5000,
  });
  const rows = approvals
    ? spaces.data?.filter((space) => space.status === 'pending')
    : spaces.data;
  const approve = useMutation({
    mutationFn: (id: string) => api('POST', `/api/oss/spaces/${id}/approve`),
    onSuccess: async () => {
      await refresh();
      toast.success('已批准，正在开通空间');
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="OSS 对象存储"
        description={approvals
          ? '审核存储空间申请，批准后自动开通；拒绝时需填写原因。'
          : '申请专属存储目录，通过 OSS SDK、CLI 或可用域名访问文件。每位成员的多个空间共用一组 AK/SK。'}
        actions={
          !approvals && (
            <Button
              disabled={!cap.data?.enabled}
              onClick={() => setRequesting(true)}
            >
              申请空间
            </Button>
          )
        }
      />
      {cap.error ? (
        <SettingsLoadError error={cap.error} retry={() => void cap.refetch()} />
      ) : (
        <Notice enabled={!!cap.data?.enabled} />
      )}
      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value })}>
        {admin && (
          <TabsList>
            <TabsTrigger value="mine">我的空间</TabsTrigger>
            <TabsTrigger value="all">全部空间</TabsTrigger>
            <TabsTrigger value="approvals">审批</TabsTrigger>
          </TabsList>
        )}
        <TabsContent value={tab} className={admin ? 'mt-4' : undefined}>
          <Card>
            <CardContent>
              {spaces.isError ? (
                <SettingsLoadError
                  error={spaces.error}
                  retry={() => void spaces.refetch()}
                />
              ) : !rows ? (
                <SettingsLoading />
              ) : !rows.length ? (
                <Empty
                  className="py-12"
                  text={approvals ? '没有待审批的空间申请' : all ? '暂无空间' : '还没有存储空间，启用后可提交申请。'}
                />
              ) : (
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>空间</TableHead>
                      {all && <TableHead>申请人</TableHead>}
                      {approvals ? (
                        <TableHead>申请时间</TableHead>
                      ) : (
                        <>
                          <TableHead>状态</TableHead>
                          <TableHead>公开读</TableHead>
                        </>
                      )}
                      <TableHead className="w-40 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="max-w-72">
                          {approvals ? (
                            <span className="break-words font-medium">{s.name}</span>
                          ) : (
                            <Link
                              className="font-medium text-primary hover:underline"
                              to={`/oss/${s.id}`}
                            >
                              {s.name}
                            </Link>
                          )}
                          <p className={approvals
                            ? 'mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground'
                            : 'mt-1 truncate text-xs text-muted-foreground'}>
                            {s.purpose}
                          </p>
                        </TableCell>
                        {all && <TableCell>{s.ownerName}</TableCell>}
                        {approvals ? (
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDateTime(s.createdAt)}
                          </TableCell>
                        ) : (
                          <>
                            <TableCell>
                              <Badge variant={s.status === 'pending' ? 'warning' : 'default'}>
                                {statuses[s.status]}
                              </Badge>
                              {s.lastError && (
                                <p className="mt-1 text-xs text-destructive">
                                  操作失败，可在详情重试
                                </p>
                              )}
                            </TableCell>
                            <TableCell>{s.publicRead ? '已开启' : '未开启'}</TableCell>
                          </>
                        )}
                        <TableCell className="text-right">
                          {approvals ? (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                className="h-8 min-w-16"
                                loading={approve.isPending && approve.variables === s.id}
                                disabled={!cap.data?.enabled || approve.isPending || s.operationPending}
                                onClick={() => approve.mutate(s.id)}
                              >
                                批准
                              </Button>
                              <Button
                                variant="outline-destructive"
                                size="sm"
                                className="h-8 min-w-16"
                                disabled={!cap.data?.enabled || approve.isPending || s.operationPending}
                                onClick={() => setRejecting(s)}
                              >
                                拒绝
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 min-w-16"
                              asChild
                            >
                              <Link to={`/oss/${s.id}`}>
                                详情
                              </Link>
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {rejecting && (
        <RejectSpaceDialog space={rejecting} close={() => setRejecting(null)} />
      )}
      {requesting && (
        <SpaceForm
          title="申请存储空间"
          close={() => setRequesting(false)}
          submit={async (name, purpose, requestId) => {
            await api('POST', '/api/oss/spaces', { name, purpose, requestId });
            refresh();
            toast.success('申请已提交，等待管理员批准');
          }}
        />
      )}
    </div>
  );
}
function Credentials({ enabled }: { enabled: boolean }) {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false),
    [secret, setSecret] = useState<OssCredentialInfo>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0);
  const [opId, setOpId] = useState<string>();
  const account = useQuery({
    queryKey: ['oss', 'account'],
    queryFn: () => api<OssAccountInfo>('GET', '/api/oss/me/account'),
    refetchInterval: 3000,
  });
  const op = useQuery({
    queryKey: ['oss', 'operation', opId],
    queryFn: () => api<OssOperationInfo>('GET', `/api/oss/operations/${opId}`),
    enabled: !!opId,
    refetchInterval: (q) => (q.state.data?.state === 'complete' ? false : 3000),
  });
  const reveal = async () => {
    const version = ++generation.current;
    setOpen(true);
    setLoading(true);
    setError('');
    try {
      const value = await api<OssCredentialInfo>(
        'POST',
        '/api/oss/me/credentials',
      );
      if (version === generation.current) setSecret(value);
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  const reset = useMutation({
    mutationFn: () =>
      api<OssOperationInfo>('POST', '/api/oss/me/credentials/reset'),
    onSuccess: (v) => {
      setSecret(undefined);
      setOpId(v.id);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <h2 className="font-medium">我的访问凭证</h2>
        <p className="text-sm text-muted-foreground">{OSS_CREDENTIAL_NOTE}</p>
        <p className="font-mono text-sm">
          {account.data?.accessKeyIdMasked || '尚未分配'}
          {account.data?.syncPending && ' · 同步中'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={
              !enabled || !account.data?.configured || account.data.syncPending
            }
            onClick={() => void reveal()}
          >
            查看 AK/SK
          </Button>
          <Confirm
            title="重置所有空间的凭证？"
            description="旧 AK/SK 将失效，所有使用它的客户端都需要更新。重置任务完成后可重新查看凭证。"
            onConfirm={() => reset.mutate()}
          >
            <Button
              variant="outline"
              loading={reset.isPending}
              disabled={
                !enabled ||
                !account.data?.configured ||
                account.data.syncPending
              }
            >
              重置凭证
            </Button>
          </Confirm>
        </div>
        {(account.error || account.data?.lastError) && (
          <p role="alert" className="text-sm text-destructive">
            {account.error?.message ?? account.data?.lastError}
          </p>
        )}
        {op.data && (
          <p aria-live="polite" className="text-sm">
            {op.data.state === 'complete'
              ? '重置已完成，可查看新凭证。'
              : op.data.state === 'failed'
                ? `重置未完成，将自动重试：${op.data.lastError}`
                : '正在重置凭证…'}
          </p>
        )}
        <Dialog
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) {
              generation.current++;
              setSecret(undefined);
              setError('');
              setLoading(false);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>我的 OSS AK/SK</DialogTitle>
              <DialogDescription>{OSS_CREDENTIAL_NOTE}</DialogDescription>
            </DialogHeader>
            {loading ? (
              <p role="status">正在读取…</p>
            ) : error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : (
              secret && (
                <div className="space-y-4">
                  <label className="block space-y-2 text-sm">
                    AccessKey ID
                    <Input
                      readOnly
                      value={secret.accessKeyId}
                      autoComplete="off"
                    />
                  </label>
                  <label className="block space-y-2 text-sm">
                    AccessKey Secret
                    <Input
                      readOnly
                      value={secret.accessKeySecret}
                      autoComplete="off"
                    />
                  </label>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(JSON.stringify(secret, null, 2))
                        .then(
                          () => toast.success('凭证已复制'),
                          () => toast.error('复制失败，请手动复制'),
                        )
                    }
                  >
                    复制凭证 JSON
                  </Button>
                </div>
              )
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
export function OssDetailPage() {
  const { id } = useParams(),
    me = getStoredUser(),
    admin = me?.role === 'admin';
  const cap = useCapability(),
    refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const query = useQuery({
    queryKey: ['oss', 'space', id],
    queryFn: () => api<OssSpaceInfo>('GET', `/api/oss/spaces/${id}`),
    refetchInterval: 3000,
  });
  const action = useMutation({
    mutationFn: (kind: 'revoke' | 'retry') =>
      api('POST', `/api/oss/spaces/${id}/${kind}`),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const publicity = useMutation({
    mutationFn: (enabled: boolean) =>
      api('PUT', `/api/oss/spaces/${id}/public-read`, { enabled }),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  if (query.isError)
    return (
      <SettingsLoadError
        error={query.error}
        retry={() => void query.refetch()}
      />
    );
  if (!query.data) return <SettingsLoading />;
  const s = query.data,
    busy = action.isPending || publicity.isPending || s.operationPending,
    enabled = !!cap.data?.enabled;
  return (
    <div className="space-y-5">
      <Link to="/oss" className="text-sm text-muted-foreground hover:underline">
        ← OSS 对象存储
      </Link>
      <PageHeader
        title={s.name}
        description={s.purpose}
        actions={<Badge>{statuses[s.status]}</Badge>}
      />
      <Notice enabled={enabled} />
      {s.lastError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 p-4 text-sm text-destructive"
        >
          {s.lastError}。后台会自动重试。
        </p>
      )}
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">空间信息</h2>
            {enabled &&
              !['revoked', 'revoking', 'rejected'].includes(s.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  编辑信息
                </Button>
              )}
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-[7rem_1fr]">
            {[
              ['申请人', s.ownerName],
              ['Bucket', s.bucket],
              ['地域', s.region],
              ['Endpoint', s.endpoint],
              ['目录', s.prefix],
            ].map(([label, value]) => (
              <div className="contents" key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-all font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          {s.credentialSyncPending && (
            <p role="status" className="text-sm text-muted-foreground">
              RAM 凭证状态同步中，失败后会自动重试。{s.credentialSyncError}
            </p>
          )}
          {s.rejectionReason && (
            <p className="text-sm">拒绝原因：{s.rejectionReason}</p>
          )}
          {s.status === 'revoked' && (
            <p className="text-sm text-muted-foreground">
              EAT 目录授权已回收，云端文件保留。
            </p>
          )}
          {admin && (
            <div className="flex flex-wrap gap-2">
              {s.status === 'pending' && (
                <Button variant="outline" asChild>
                  <Link to="/oss?tab=approvals">前往审批</Link>
                </Button>
              )}
              {s.lastError && (
                <Button
                  disabled={action.isPending}
                  variant="outline"
                  onClick={() => action.mutate('retry')}
                >
                  重试操作
                </Button>
              )}
              {s.status === 'active' && (
                <Confirm
                  title="回收此存储空间？"
                  description="移除此目录的 RAM 权限和 EAT 公开读授权，保留云端文件；对象 ACL 和 CDN 缓存不变。此记录将归档。"
                  onConfirm={() => action.mutate('revoke')}
                >
                  <Button disabled={busy} variant="outline">
                    回收空间
                  </Button>
                </Confirm>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">目录公开读</h2>
            <Badge>{s.publicRead ? '已开启' : '未开启'}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {OSS_PUBLIC_READ_NOTE}
          </p>
          {s.publicPrefixes.map((p) => (
            <p key={p} className="break-all font-mono text-xs">
              {p}
            </p>
          ))}
          {s.operationPending && (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              云操作同步中，完成后状态会自动刷新。
            </p>
          )}
          <Confirm
            title={s.publicRead ? '关闭目录公开读？' : '开启目录公开读？'}
            description={
              s.publicRead
                ? OSS_PUBLIC_READ_NOTE
                : '此目录下的所有对象将允许通过 OSS 匿名读取。'
            }
            destructive={!s.publicRead}
            onConfirm={() => publicity.mutate(!s.publicRead)}
          >
            <Button
              variant="outline"
              disabled={!enabled || busy || s.status !== 'active'}
            >
              {s.publicRead ? '关闭公开读' : '开启公开读'}
            </Button>
          </Confirm>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 pt-5">
          <h2 className="font-medium">可用访问域名</h2>
          <p className="text-sm text-muted-foreground">
            CDN 标记由管理员维护。私有 Bucket 回源不等于 CDN
            访客鉴权，请按业务需求选择域名和访问方式。
          </p>
          {s.addresses.map((a) => (
            <div key={a.domain} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap gap-2">
                <Badge>
                  {a.kind === 'official' ? 'OSS 官方' : '自定义域名'}
                </Badge>
                <Badge>
                  {a.cdn ? 'CDN 已启用（管理员标记）' : '未标记 CDN'}
                </Badge>
              </div>
              <p className="break-all font-mono text-sm">{a.url}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard.writeText(a.url).then(
                    () => toast.success('地址已复制'),
                    () => toast.error('复制失败'),
                  )
                }
              >
                复制地址前缀
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      {s.ownerId === me?.id && (
        <Credentials enabled={enabled && s.status === 'active'} />
      )}
      {editing && (
        <SpaceForm
          initial={s}
          title="编辑空间"
          close={() => setEditing(false)}
          submit={async (name, purpose) => {
            await api('PATCH', `/api/oss/spaces/${id}`, { name, purpose });
            refresh();
          }}
        />
      )}
    </div>
  );
}
