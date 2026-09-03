import type {
  AppBuildType,
  AppEnv,
  AppEnvChange,
  AppEnvTarget,
  AppInfo,
  BuildLogsResult,
  CreateAppRequest,
  DeploymentInfo,
  DokployApplication,
  MountAppRequest,
  RunLogsResult,
  UpdateAppRequest,
} from '@eat/shared';
import { APP_BUILD_TYPE_LABEL, APP_ENV_TARGET_LABEL, DEFAULT_BRANCH, DEFAULT_DOCKERFILE, DEFAULT_PUBLISH_DIRECTORY } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Pencil, Plus, RefreshCw, Rocket, ShieldCheck, ShieldOff, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Combobox } from '../components/combobox';
import { Confirm } from '../components/confirm';
import { DokployAppPicker } from '../components/dokploy-app-picker';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatDateTime } from '../lib/utils';

/** 部署状态（决策 30：queued/archived 是平台补的，其余直接是 Dokploy 构建记录的取值） */
const STATUS_BADGE: Record<string, JSX.Element> = {
  queued: <Badge>排队中</Badge>,
  running: <Badge>构建中</Badge>,
  done: <Badge variant="success">成功</Badge>,
  error: <Badge variant="destructive">失败</Badge>,
  cancelled: <Badge variant="outline">已取消</Badge>,
  archived: <Badge variant="outline">已归档</Badge>,
};

/** Dokploy 构建记录自己的状态取值 */
const BUILD_STATUS: Record<string, string> = { running: '构建中', done: '成功', error: '失败', cancelled: '已取消' };

const BUILD_TYPE_OPTIONS: Array<{ label: string; value: AppBuildType }> = [
  { label: APP_BUILD_TYPE_LABEL.dockerfile, value: 'dockerfile' },
  { label: APP_BUILD_TYPE_LABEL.static, value: 'static' },
];

/**
 * 一次部署是谁发起的（决策 30 / 31）。platform 为 null 就是「有人绕过平台、直接在 Dokploy 侧触发」；
 * source=console 是控制台按钮触发的，同样没做本地密钥扫描——两种都要显眼地标出来。
 */
function OriginCell({ d }: { d: DeploymentInfo }) {
  if (!d.platform) {
    return <Badge variant="destructive">Dokploy 侧</Badge>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1 text-muted-foreground" title={d.platform.claim === 'inferred' ? '归属按触发时间推断，未必准确' : undefined}>
      {d.platform.triggeredByName}
      {d.platform.source === 'console' && <Badge variant="warning">控制台</Badge>}
      {d.platform.claim === 'inferred' && ' ⚠'}
    </span>
  );
}

function ApprovalBadge({ a }: { a: AppInfo }) {
  if (a.deployApproved) return <Badge variant="success">已授权</Badge>;
  return <Badge variant="warning">{a.approvalRequestedAt ? '待授权 · 有人尝试部署' : '待授权'}</Badge>;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
}

export function AppsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const [creating, setCreating] = useState(false);
  const [mounting, setMounting] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [viewingSlug, setViewingSlug] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending'>('all');

  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api<AppInfo[]>('GET', '/api/apps') });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['apps'] });

  // 弹窗数据从最新列表里取，成员 / 授权变更后自动刷新
  const viewing = viewingSlug ? (apps.data ?? []).find((p) => p.slug === viewingSlug) ?? null : null;
  const editing = editingSlug ? (apps.data ?? []).find((p) => p.slug === editingSlug) ?? null : null;

  const create = useMutation({
    mutationFn: (v: CreateAppRequest) => api<AppInfo>('POST', '/api/apps', v),
    onSuccess: (a) => {
      toast.success(a.deployApproved ? '应用已创建' : '应用已创建；首次部署前需管理员授权一次');
      setCreating(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const mount = useMutation({
    mutationFn: (v: MountAppRequest) => api('POST', '/api/apps/mount', v),
    onSuccess: () => {
      toast.success('已挂载');
      setMounting(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '挂载失败'),
  });

  const update = useMutation({
    mutationFn: (v: { slug: string; body: UpdateAppRequest }) => api('PATCH', `/api/apps/${v.slug}`, v.body),
    onSuccess: () => {
      toast.success('已更新，下次部署生效');
      setEditingSlug(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '更新失败'),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api<{ dokployDeleted: boolean }>('DELETE', `/api/apps/${slug}`),
    onSuccess: (r) => {
      toast.success(r.dokployDeleted ? '已删除（含 Dokploy 上的应用）' : '已解绑');
      setViewingSlug(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const pendingCount = (apps.data ?? []).filter((a) => !a.deployApproved).length;
  const rows = (apps.data ?? []).filter((a) => filter === 'all' || !a.deployApproved);

  return (
    <div className="space-y-5">
      <PageHeader
        title="应用"
        description={
          <>
            应用对应 Dokploy 上的 application：填 Git 地址与构建方式即可自助创建，平台自动在 Dokploy 上建好应用并绑定 SSH key。
            首次部署需管理员授权一次。命令行里 <InlineCode>eat deploy &lt;slug&gt;</InlineCode> 会先做本地密钥扫描再部署；控制台的「部署」按钮不做扫描，记录会标注。
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <Button variant="outline" onClick={() => setMounting(true)}>
                <Link2 />
                挂载已有应用
              </Button>
            )}
            <Button onClick={() => setCreating(true)}>
              <Plus />
              创建应用
            </Button>
          </div>
        }
      />
      {isAdmin && pendingCount > 0 && (
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { label: '全部', value: 'all' },
            { label: `待授权 ${pendingCount}`, value: 'pending' },
          ]}
        />
      )}
      <Card>
        <CardContent>
          {apps.isLoading ? (
            <TableSkeleton />
          ) : rows.length === 0 ? (
            <Empty text={filter === 'pending' ? '没有待授权的应用' : '暂无应用'} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>应用</TableHead>
                  <TableHead className="hidden md:table-cell">Git</TableHead>
                  <TableHead className="hidden w-24 sm:table-cell">Owner</TableHead>
                  <TableHead className="hidden lg:table-cell">成员</TableHead>
                  <TableHead className="w-28">部署授权</TableHead>
                  <TableHead className="w-20">我可部署</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="group inline-flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 text-left"
                        onClick={() => setViewingSlug(a.slug)}
                      >
                        <InlineCode className="text-primary group-hover:underline">{a.slug}</InlineCode>
                        <span className="font-medium">{a.name}</span>
                        <Badge variant="outline">{a.buildType ? APP_BUILD_TYPE_LABEL[a.buildType] : '挂载'}</Badge>
                      </button>
                    </TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell" title={a.repoUrl}>
                      {a.repoUrl || '—'}
                      {a.managed && <span className="ml-1 text-xs">({a.branch})</span>}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{a.ownerName}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground lg:table-cell">
                      {a.members.length > 0 ? a.members.map((m) => m.name).join('、') : '—'}
                    </TableCell>
                    <TableCell>
                      <ApprovalBadge a={a} />
                    </TableCell>
                    <TableCell>
                      {a.canDeploy ? <Badge variant="success">是</Badge> : <Badge variant="outline">{a.isMember ? '等授权' : '否'}</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {creating && <CreateAppDialog pending={create.isPending} onClose={() => setCreating(false)} onSubmit={(v) => create.mutate(v)} />}
      {mounting && <MountAppDialog pending={mount.isPending} onClose={() => setMounting(false)} onSubmit={(v) => mount.mutate(v)} />}
      {editing && (
        <EditAppDialog app={editing} pending={update.isPending} onClose={() => setEditingSlug(null)} onSubmit={(v) => update.mutate({ slug: editing.slug, body: v })} />
      )}
      {viewing && (
        <AppDetailDialog
          app={viewing}
          isAdmin={isAdmin}
          canManage={isAdmin || viewing.ownerId === me?.id}
          onClose={() => setViewingSlug(null)}
          onEdit={() => setEditingSlug(viewing.slug)}
          onRemove={() => remove.mutate(viewing.slug)}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}

// ---------- 详情弹窗：概览 / 环境变量 / 部署记录 ----------

function AppDetailDialog({
  app,
  isAdmin,
  canManage,
  onClose,
  onEdit,
  onRemove,
  onChanged,
}: {
  app: AppInfo;
  isAdmin: boolean;
  canManage: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState('overview');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            应用 <InlineCode>{app.slug}</InlineCode> {app.name}
            <ApprovalBadge a={app} />
          </DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="env">环境变量</TabsTrigger>
            <TabsTrigger value="deployments">部署记录</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-4">
            <Overview app={app} isAdmin={isAdmin} canManage={canManage} onEdit={onEdit} onRemove={onRemove} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="env" className="mt-4">
            {app.isMember ? <EnvEditor app={app} /> : <Empty text="仅应用成员可查看与修改环境变量" className="py-6" />}
          </TabsContent>
          <TabsContent value="deployments" className="mt-4">
            <Deployments app={app} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Overview({
  app,
  isAdmin,
  canManage,
  onEdit,
  onRemove,
  onChanged,
}: {
  app: AppInfo;
  isAdmin: boolean;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('GET', '/api/users'), enabled: canManage });

  const deploy = useMutation({
    mutationFn: () => api<DeploymentInfo>('POST', `/api/apps/${app.slug}/deploy`, { source: 'console' }),
    onSuccess: () => {
      toast.success('已触发部署，排队中；到「部署记录」查看进度');
      void queryClient.invalidateQueries({ queryKey: ['deployments', app.slug] });
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '触发失败'),
  });
  const approve = useMutation({
    mutationFn: (on: boolean) => api(on ? 'POST' : 'DELETE', `/api/apps/${app.slug}/approve`),
    onSuccess: (_r, on) => {
      toast.success(on ? '已授权，该应用之后可直接部署' : '已撤销授权');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });
  const addMember = useMutation({
    mutationFn: (userId: string) => api('POST', `/api/apps/${app.slug}/members`, { userId }),
    onSuccess: () => {
      toast.success('已添加成员');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '添加失败'),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api('DELETE', `/api/apps/${app.slug}/members/${userId}`),
    onSuccess: () => {
      toast.success('已移除');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '移除失败'),
  });

  const deployHint = !app.isMember ? '仅应用成员可部署' : !app.deployApproved ? '待管理员授权后才能部署' : undefined;
  const rows: Array<[string, React.ReactNode]> = [
    ['Git 仓库', app.repoUrl ? <span className="break-all">{app.repoUrl}</span> : '—'],
    ...(app.managed ? ([['分支', app.branch]] as Array<[string, React.ReactNode]>) : []),
    [
      '构建方式',
      app.managed && app.buildType ? (
        <>
          {APP_BUILD_TYPE_LABEL[app.buildType]}
          <span className="ml-2 text-xs text-muted-foreground">
            {app.buildType === 'dockerfile'
              ? `Dockerfile ${app.dockerfile}，上下文 ${app.dockerContextPath || '仓库根'}`
              : `发布目录 ${app.publishDirectory}，SPA 模式${app.staticSpa ? '开' : '关'}`}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">管理员挂载的既有应用，构建配置在 Dokploy 侧维护</span>
      ),
    ],
    ['Dokploy application', <InlineCode key="id">{app.dokployApplicationId}</InlineCode>],
    ['Owner', app.ownerName],
    ...(app.description ? ([['说明', app.description]] as Array<[string, React.ReactNode]>) : []),
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {app.isMember && (
          <Confirm
            title={`部署 ${app.slug}？`}
            description="从控制台触发不做本地密钥扫描（eat deploy 才做），这次部署会在记录里标注「控制台」。Dokploy 将按当前分支重新构建并上线。"
            confirmText="部署"
            destructive={false}
            onConfirm={() => deploy.mutate()}
          >
            <Button size="sm" disabled={!app.canDeploy || deploy.isPending} title={deployHint}>
              <Rocket />
              部署
            </Button>
          </Confirm>
        )}
        {canManage && (
          <>
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil />
              编辑配置
            </Button>
            <Confirm
              title={`删除应用 ${app.slug}？`}
              description={
                app.managed
                  ? '平台托管的应用会连同 Dokploy 上的 application 一起删除，容器与构建记录不可恢复。'
                  : '只从平台解绑，不影响 Dokploy 上的应用本身。'
              }
              confirmText={app.managed ? '连 Dokploy 一起删除' : '解绑'}
              onConfirm={onRemove}
            >
              <Button variant="outline-destructive" size="sm">
                <Trash2 />
                {app.managed ? '删除应用' : '解绑'}
              </Button>
            </Confirm>
          </>
        )}
      </div>

      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="rounded-md border px-3 py-2.5 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="font-medium">部署授权</span>
            <span className="ml-2 text-muted-foreground">
              {app.deployApproved
                ? `已由 ${app.approvedByName ?? '-'} 于 ${app.approvedAt ? formatDateTime(app.approvedAt) : '-'} 授权，之后不再拦`
                : app.approvalRequestedAt
                  ? `待管理员授权；${formatDateTime(app.approvalRequestedAt)} 有成员尝试部署被拒`
                  : '待管理员授权（首次部署前需放行一次）'}
            </span>
          </div>
          {isAdmin &&
            (app.deployApproved ? (
              <Button variant="outline" size="sm" onClick={() => approve.mutate(false)} loading={approve.isPending}>
                <ShieldOff />
                撤销授权
              </Button>
            ) : (
              <Button size="sm" onClick={() => approve.mutate(true)} loading={approve.isPending}>
                <ShieldCheck />
                授权部署
              </Button>
            ))}
        </div>
      </div>

      {canManage && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">成员管理</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {app.members.map((m) => (
              <Badge key={m.userId} variant="secondary" className="gap-1 pr-1">
                {m.name}
                <button
                  type="button"
                  aria-label={`移除 ${m.name}`}
                  className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 cursor-pointer"
                  onClick={() => removeMember.mutate(m.userId)}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <div className="w-52">
              <Combobox
                groups={[
                  {
                    options: (users.data ?? [])
                      .filter((u) => u.id !== app.ownerId && !app.members.some((m) => m.userId === u.id))
                      .map((u) => ({ value: u.id, label: u.name, hint: u.email })),
                  },
                ]}
                value={null}
                onChange={(userId) => addMember.mutate(userId)}
                placeholder="添加成员…"
                searchPlaceholder="搜索姓名或邮箱…"
                className="h-7 text-xs"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 应用 env（决策 31）：运行时 / 构建时两块，直接读写 Dokploy；保存是整体覆盖，结果只报 key 级变化 */
function EnvEditor({ app }: { app: AppInfo }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<AppEnvTarget>('runtime');
  const [draft, setDraft] = useState<Record<AppEnvTarget, string | null>>({ runtime: null, build: null });
  const env = useQuery({ queryKey: ['app-env', app.slug], queryFn: () => api<AppEnv>('GET', `/api/apps/${app.slug}/env`), retry: false });
  const current = draft[target] ?? (env.data ? env.data[target] : '');
  const dirty = env.data !== undefined && draft[target] !== null && draft[target] !== env.data[target];

  const save = useMutation({
    mutationFn: () => api<AppEnvChange>('PUT', `/api/apps/${app.slug}/env`, { target, content: current }),
    onSuccess: (r) => {
      const parts = [
        r.added.length && `新增 ${r.added.join(', ')}`,
        r.changed.length && `修改 ${r.changed.join(', ')}`,
        r.removed.length && `删除 ${r.removed.join(', ')}`,
      ].filter(Boolean);
      toast.success(parts.length ? `已保存：${parts.join('；')}` : '已保存，没有变化');
      setDraft((d) => ({ ...d, [target]: null }));
      void queryClient.invalidateQueries({ queryKey: ['app-env', app.slug] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  if (env.isError) {
    return <div className="text-sm text-destructive">{env.error instanceof ApiError ? env.error.message : '读取失败'}</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={target}
          onChange={setTarget}
          options={[
            { label: APP_ENV_TARGET_LABEL.runtime, value: 'runtime' },
            { label: APP_ENV_TARGET_LABEL.build, value: 'build' },
          ]}
        />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void env.refetch()} disabled={env.isFetching}>
            <RefreshCw className={env.isFetching ? 'animate-spin' : ''} />
            刷新
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
            保存
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {target === 'runtime' ? '容器运行时的环境变量（Dokploy 的 Environment）。' : '构建时变量（Dokploy 的 Build Args），Dockerfile 里以 ARG 取用。'}
        保存是整体覆盖，下次部署生效；值可能是密钥，读取与修改都会记入审计。命令行等价：
        <InlineCode>eat app env pull / push {app.slug}{target === 'build' ? ' --build' : ''}</InlineCode>
      </p>
      {env.isLoading ? (
        <TableSkeleton rows={3} />
      ) : (
        <Textarea
          rows={12}
          className="font-mono text-xs"
          spellCheck={false}
          placeholder={'KEY=value\n# 一行一条'}
          value={current}
          onChange={(e) => setDraft((d) => ({ ...d, [target]: e.target.value }))}
        />
      )}
    </div>
  );
}

type LogKind = 'build' | 'run';

function Deployments({ app }: { app: AppInfo }) {
  const [logsOf, setLogsOf] = useState<LogKind | null>(null);
  /** 默认只看 Dokploy 上还留着的（每个应用最近 10 次），打开看平台侧完整历史（决策 30） */
  const [allHistory, setAllHistory] = useState(false);
  const deployments = useQuery({
    queryKey: ['deployments', app.slug, allHistory],
    queryFn: () => api<DeploymentInfo[]>('GET', `/api/apps/${app.slug}/deployments${allHistory ? '?all=1' : ''}`),
    refetchInterval: 10_000,
  });
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">部署历史</h3>
        <div className="flex gap-2">
          <Button variant={allHistory ? 'default' : 'outline'} size="sm" onClick={() => setAllHistory((v) => !v)}>
            {allHistory ? '只看 Dokploy 现存' : '显示全部历史'}
          </Button>
          {/* 日志可能带出构建期注入的密钥，与部署同权限（服务端也这么校验） */}
          {app.isMember && (
            <>
              <Button variant="outline" size="sm" onClick={() => setLogsOf('build')}>
                构建日志
              </Button>
              <Button variant="outline" size="sm" onClick={() => setLogsOf('run')}>
                运行日志
              </Button>
            </>
          )}
        </div>
      </div>
      {deployments.isLoading ? (
        <TableSkeleton rows={2} />
      ) : (deployments.data ?? []).length === 0 ? (
        <Empty text="暂无部署。概览里点「部署」，或在代码目录运行 eat deploy。" className="py-6" />
      ) : (
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">时间</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-32">来源</TableHead>
              <TableHead>检查</TableHead>
              <TableHead>备注</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(deployments.data ?? []).map((d) => (
              <TableRow key={d.deploymentId ?? d.platform?.id}>
                <TableCell className="text-muted-foreground">{formatDateTime(d.createdAt)}</TableCell>
                <TableCell>{STATUS_BADGE[d.status]}</TableCell>
                <TableCell>
                  <OriginCell d={d} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {d.platform?.report
                    ? `扫描 ${d.platform.report.scannedFiles} 文件 / ${d.platform.report.findings.length} 问题`
                    : d.platform
                      ? '未做密钥扫描'
                      : '未经平台扫描'}
                </TableCell>
                <TableCell className="max-w-48 truncate text-muted-foreground" title={d.error ?? undefined}>
                  {d.error ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {allHistory
          ? '「已归档」= Dokploy 那边的构建记录已被清理，只剩平台侧元数据（谁触发的、扫描报告）。'
          : 'Dokploy 每个应用只保留最近 10 次构建；更早的部署点「显示全部历史」查看。'}
      </p>
      {logsOf && <LogsDialog slug={app.slug} kind={logsOf} onClose={() => setLogsOf(null)} />}
    </div>
  );
}

/**
 * 构建日志 / 运行日志（决策 28）。两者形状不同但用法一致：都是「取最近 N 行」的一次性读取，
 * 不做实时流——Dokploy 那边虽然是流式接口，平台侧统一收敛成一次读完。
 */
function LogsDialog({ slug, kind, onClose }: { slug: string; kind: LogKind; onClose: () => void }) {
  const [tail, setTail] = useState(200);
  const query = useQuery({
    queryKey: ['logs', kind, slug, tail],
    queryFn: () => api<BuildLogsResult | RunLogsResult>('GET', `/api/apps/${slug}/${kind === 'build' ? 'build-logs' : 'run-logs'}?tail=${tail}`),
    retry: false,
  });
  const data = query.data;
  const subject =
    data && 'deployment' in data
      ? data.deployment && `构建 ${data.deployment.deploymentId}（${BUILD_STATUS[data.deployment.status] ?? data.deployment.status}）`
      : data && data.container && `容器 ${data.container.name}（${data.container.state}）`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {kind === 'build' ? '构建日志' : '运行日志'} · {slug}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          {[100, 200, 1000].map((n) => (
            <Button key={n} variant={n === tail ? 'default' : 'outline'} size="sm" onClick={() => setTail(n)}>
              最近 {n} 行
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={query.isFetching ? 'animate-spin' : ''} />
            刷新
          </Button>
          {subject && <span className="text-xs text-muted-foreground">{subject}</span>}
        </div>
        {query.isError ? (
          <div className="text-sm text-destructive">{query.error instanceof ApiError ? query.error.message : '读取失败'}</div>
        ) : query.isLoading ? (
          <TableSkeleton rows={4} />
        ) : (
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {data?.logs.trimEnd() || (kind === 'build' ? '（还没有构建记录）' : '（当前没有运行中的容器）')}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- 表单：构建方式字段（创建与编辑共用） ----------

type BuildFormValues = {
  buildType: AppBuildType;
  dockerfile: string;
  dockerContextPath: string;
  publishDirectory: string;
  staticSpa: boolean;
};

/** 构建方式 + 各自的可选项（决策 31：只开放 static / dockerfile 两种） */
function BuildFields<T extends BuildFormValues>({
  form,
  idPrefix,
}: {
  form: ReturnType<typeof useForm<T>>;
  idPrefix: string;
}) {
  // 泛型表单在这里只用得到构建字段，收窄一次省得每处都断言
  const f = form as unknown as ReturnType<typeof useForm<BuildFormValues>>;
  const buildType = f.watch('buildType');
  return (
    <>
      <Field
        label="构建方式"
        required
        hint={
          buildType === 'static'
            ? '静态托管不跑任何构建命令：把发布目录原样交给 nginx，仓库里得直接有构建产物。要先 build 再托管的请选 Dockerfile。'
            : '按仓库里的 Dockerfile 构建镜像并运行。'
        }
      >
        <Controller
          control={f.control}
          name="buildType"
          render={({ field }) => <Segmented value={field.value} onChange={field.onChange} options={BUILD_TYPE_OPTIONS} />}
        />
      </Field>
      {buildType === 'dockerfile' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dockerfile 路径" htmlFor={`${idPrefix}-dockerfile`} hint="相对仓库根" error={f.formState.errors.dockerfile?.message}>
            <Input id={`${idPrefix}-dockerfile`} className="font-mono" placeholder={DEFAULT_DOCKERFILE} {...f.register('dockerfile', { validate: repoPath })} />
          </Field>
          <Field label="构建上下文" htmlFor={`${idPrefix}-context`} hint="相对仓库根，留空为仓库根" error={f.formState.errors.dockerContextPath?.message}>
            <Input id={`${idPrefix}-context`} className="font-mono" placeholder="." {...f.register('dockerContextPath', { validate: repoPath })} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="发布目录" htmlFor={`${idPrefix}-publish`} hint="相对仓库根，交给 nginx 托管的目录" error={f.formState.errors.publishDirectory?.message}>
            <Input id={`${idPrefix}-publish`} className="font-mono" placeholder={DEFAULT_PUBLISH_DIRECTORY} {...f.register('publishDirectory', { validate: repoPath })} />
          </Field>
          <Field label="SPA 模式" hint="所有路径回退到 index.html（前端路由用）">
            <Controller control={f.control} name="staticSpa" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
          </Field>
        </div>
      )}
    </>
  );
}

const repoPath = (v: string) => (v.startsWith('/') || v.split('/').includes('..') ? '需为相对仓库根的路径' : true);

type CreateFormValues = CreateAppRequest;

function CreateAppDialog({ pending, onClose, onSubmit }: { pending: boolean; onClose: () => void; onSubmit: (v: CreateAppRequest) => void }) {
  const form = useForm<CreateFormValues>({
    defaultValues: {
      slug: '',
      name: '',
      repoUrl: '',
      branch: DEFAULT_BRANCH,
      buildType: 'dockerfile',
      dockerfile: DEFAULT_DOCKERFILE,
      dockerContextPath: '',
      publishDirectory: DEFAULT_PUBLISH_DIRECTORY,
      staticSpa: false,
      description: '',
    },
  });
  const { register, handleSubmit, formState: { errors } } = form;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>创建应用</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) =>
            onSubmit({
              ...v,
              name: v.name || v.slug,
              dockerfile: v.dockerfile || DEFAULT_DOCKERFILE,
              publishDirectory: v.publishDirectory || DEFAULT_PUBLISH_DIRECTORY,
              branch: v.branch || DEFAULT_BRANCH,
            }),
          )}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标识（slug）" htmlFor="app-slug" required error={errors.slug?.message}>
              <Input id="app-slug" placeholder="crm-tool" className="font-mono" aria-invalid={!!errors.slug} {...register('slug', { required: '请输入标识', pattern: rules.slug })} />
            </Field>
            <Field label="名称" htmlFor="app-name" hint="留空同标识">
              <Input id="app-name" placeholder="CRM 小工具" {...register('name')} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <Field label="Git 仓库地址" htmlFor="app-repo" required error={errors.repoUrl?.message} hint="https 或 ssh 地址；私有仓库需管理员在 Dokploy 设置里配好 SSH key">
              <Input id="app-repo" className="font-mono" placeholder="git@git.example.com:team/crm.git" aria-invalid={!!errors.repoUrl} {...register('repoUrl', { required: '请输入 Git 仓库地址' })} />
            </Field>
            <Field label="分支" htmlFor="app-branch">
              <Input id="app-branch" className="font-mono" placeholder={DEFAULT_BRANCH} {...register('branch')} />
            </Field>
          </div>
          <BuildFields form={form} idPrefix="app" />
          <Field label="说明" htmlFor="app-desc">
            <Textarea id="app-desc" rows={2} {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建（在 Dokploy 上建应用并绑定）
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type EditFormValues = BuildFormValues & { name: string; description: string; repoUrl: string; branch: string; dokployApplicationId: string };

function EditAppDialog({ app, pending, onClose, onSubmit }: { app: AppInfo; pending: boolean; onClose: () => void; onSubmit: (v: UpdateAppRequest) => void }) {
  const form = useForm<EditFormValues>({
    defaultValues: {
      name: app.name,
      description: app.description,
      repoUrl: app.repoUrl,
      branch: app.branch,
      buildType: app.buildType ?? 'dockerfile',
      dockerfile: app.dockerfile,
      dockerContextPath: app.dockerContextPath,
      publishDirectory: app.publishDirectory,
      staticSpa: app.staticSpa,
      dokployApplicationId: app.dokployApplicationId,
    },
  });
  const { register, handleSubmit, setValue, watch, formState: { errors } } = form;
  const [picked, setPicked] = useState<DokployApplication | null>(null);
  const appId = watch('dokployApplicationId');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑应用 {app.slug}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) =>
            onSubmit(
              app.managed
                ? {
                    name: v.name,
                    description: v.description,
                    repoUrl: v.repoUrl,
                    branch: v.branch || DEFAULT_BRANCH,
                    buildType: v.buildType,
                    dockerfile: v.dockerfile || DEFAULT_DOCKERFILE,
                    dockerContextPath: v.dockerContextPath,
                    publishDirectory: v.publishDirectory || DEFAULT_PUBLISH_DIRECTORY,
                    staticSpa: v.staticSpa,
                  }
                : { name: v.name, description: v.description, repoUrl: v.repoUrl, dokployApplicationId: v.dokployApplicationId },
            ),
          )}
        >
          <Field label="名称" htmlFor="app-edit-name" required error={errors.name?.message}>
            <Input id="app-edit-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          {app.managed ? (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
                <Field label="Git 仓库地址" htmlFor="app-edit-repo" required error={errors.repoUrl?.message}>
                  <Input id="app-edit-repo" className="font-mono" aria-invalid={!!errors.repoUrl} {...register('repoUrl', { required: '平台托管的应用必须有 Git 仓库地址' })} />
                </Field>
                <Field label="分支" htmlFor="app-edit-branch">
                  <Input id="app-edit-branch" className="font-mono" {...register('branch')} />
                </Field>
              </div>
              <BuildFields form={form} idPrefix="app-edit" />
            </>
          ) : (
            <>
              <Field
                label="Dokploy Application ID"
                htmlFor="app-edit-app"
                required
                error={errors.dokployApplicationId?.message}
                hint={picked && picked.applicationId === appId ? `已选择：${picked.name}${picked.projectName ? `（${picked.projectName}）` : ''}` : '挂载的应用：构建配置在 Dokploy 侧维护'}
              >
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input id="app-edit-app" className="flex-1 font-mono" aria-invalid={!!errors.dokployApplicationId} {...register('dokployApplicationId', { required: '请输入 Application ID' })} />
                  <DokployAppPicker
                    value={appId}
                    onPick={(a) => {
                      setValue('dokployApplicationId', a.applicationId, { shouldValidate: true, shouldDirty: true });
                      setPicked(a);
                    }}
                  />
                </div>
              </Field>
              <Field label="仓库地址" htmlFor="app-edit-repo2" hint="仅作备注">
                <Input id="app-edit-repo2" className="font-mono" {...register('repoUrl')} />
              </Field>
            </>
          )}
          <Field label="说明" htmlFor="app-edit-desc">
            <Textarea id="app-edit-desc" rows={2} {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            保存
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 管理员挂载 Dokploy 上既有的 application（决策 27 的选择器只在这里用） */
function MountAppDialog({ pending, onClose, onSubmit }: { pending: boolean; onClose: () => void; onSubmit: (v: MountAppRequest) => void }) {
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<MountAppRequest>({
    defaultValues: { slug: '', name: '', dokployApplicationId: '', repoUrl: '', description: '' },
  });
  const [picked, setPicked] = useState<DokployApplication | null>(null);
  const appId = watch('dokployApplicationId');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>挂载已有 Dokploy 应用</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <p className="text-sm text-muted-foreground">把 Dokploy 上已经存在的 application 登记到平台：平台只记 id，Git 源与构建配置仍在 Dokploy 侧维护，删除时也只解绑。创建即视为已授权部署。</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标识（slug）" htmlFor="mount-slug" required error={errors.slug?.message}>
              <Input id="mount-slug" placeholder="crm-tool" className="font-mono" aria-invalid={!!errors.slug} {...register('slug', { required: '请输入标识', pattern: rules.slug })} />
            </Field>
            <Field label="名称" htmlFor="mount-name" required error={errors.name?.message}>
              <Input id="mount-name" placeholder="CRM 小工具" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
            </Field>
          </div>
          <Field
            label="Dokploy Application ID"
            htmlFor="mount-app"
            required
            error={errors.dokployApplicationId?.message}
            hint={picked && picked.applicationId === appId ? `已选择：${picked.name}${picked.projectName ? `（${picked.projectName}）` : ''}` : '可从 Dokploy 搜索选择，或在应用详情里查到后手动填写'}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="mount-app" className="flex-1 font-mono" aria-invalid={!!errors.dokployApplicationId} {...register('dokployApplicationId', { required: '请输入 Application ID' })} />
              <DokployAppPicker
                value={appId}
                onPick={(a) => {
                  setValue('dokployApplicationId', a.applicationId, { shouldValidate: true, shouldDirty: true });
                  setPicked(a);
                }}
              />
            </div>
          </Field>
          <Field label="仓库地址" htmlFor="mount-repo" hint="可选，仅作备注">
            <Input id="mount-repo" className="font-mono" placeholder="https://git.example.com/crm" {...register('repoUrl')} />
          </Field>
          <Field label="说明" htmlFor="mount-desc">
            <Textarea id="mount-desc" rows={2} {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            挂载
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
