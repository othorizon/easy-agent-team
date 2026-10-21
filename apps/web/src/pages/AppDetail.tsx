import type { AppEnv, AppEnvChange, AppEnvTarget, AppInfo, BuildLogsResult, DeploymentInfo, RunLogsResult, UpdateAppRequest } from '@eat/shared';
import { APP_BUILD_TYPE_LABEL, APP_ENV_TARGET_LABEL, githubRepoWebUrl } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ExternalLink, GitBranch, Pencil, Plus, RefreshCw, Rocket, Search, ShieldCheck, ShieldOff, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { GithubAppSummary, useGithubApp } from '../components/github';
import { ApplicationMemberAdd, ApplicationMemberGithub, GithubRepositoryMembers, observedMember, useRepositoryCollaborators } from '../components/github-repository-members';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatDateTime } from '../lib/format';
import { ApprovalBadge, EditAppDialog } from './Apps';

const STATUS_BADGE: Record<string, JSX.Element> = {
  queued: <Badge>排队中</Badge>, running: <Badge>构建中</Badge>, done: <Badge variant="success">成功</Badge>,
  error: <Badge variant="destructive">失败</Badge>, cancelled: <Badge variant="outline">已取消</Badge>, archived: <Badge variant="outline">已归档</Badge>,
};
const BUILD_STATUS: Record<string, string> = { running: '构建中', done: '成功', error: '失败', cancelled: '已取消' };
function OriginCell({ d }: { d: DeploymentInfo }) {
  if (!d.platform) return <Badge variant="destructive">部署后台</Badge>;
  return <span className="flex flex-wrap items-center gap-1 text-muted-foreground" title={d.platform.claim === 'inferred' ? '归属按触发时间推断，未必准确' : undefined}>
    {d.platform.triggeredByName}
    {d.platform.source === 'console' && <Badge variant="outline">控制台</Badge>}
    {d.platform.source === 'remote' && <Badge variant="outline">远程 MCP</Badge>}
    {d.platform.claim === 'inferred' && ' ⚠'}
  </span>;
}

export function AppDetailPage() {
  const { slug = '' } = useParams();
  return <AppDetail key={slug} slug={slug} />;
}

function AppDetail({ slug }: { slug: string }) {
  const cache = useQueryClient(), navigate = useNavigate(), location = useLocation();
  const [params, setParams] = useSearchParams();
  const tab = ['members', 'env', 'deployments'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'overview';
  const setTab = (value: string) => setParams(prev => {
    const next = new URLSearchParams(prev);
    if (value === 'overview') next.delete('tab'); else next.set('tab', value);
    return next;
  }, { state: location.state });
  const from = location.state?.from;
  const backTo = typeof from === 'string' && (from === '/apps' || from.startsWith('/apps?')) ? from : '/apps';
  const me = getStoredUser(), isAdmin = me?.role === 'admin';
  const [editing, setEditing] = useState(false);
  // Reuse the authorized list endpoint and its cache; direct URLs also load independently.
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api<AppInfo[]>('GET', '/api/apps') });
  const app = apps.data?.find(a => a.slug === slug);
  const canManage = !!app && (isAdmin || app.ownerId === me?.id);
  const invalidate = () => {
    void cache.invalidateQueries({ queryKey: ['apps'] });
    void cache.invalidateQueries({ queryKey: ['github-app', slug] });
    void cache.invalidateQueries({ queryKey: ['github-collaborators', slug] });
  };
  const update = useMutation({
    mutationFn: (body: UpdateAppRequest) => api('PATCH', `/api/apps/${slug}`, body),
    onSuccess: () => { toast.success('配置已保存，下次部署生效'); setEditing(false); invalidate(); },
    onError: err => toast.error(err instanceof ApiError ? err.message : '更新失败'),
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/apps/${slug}`),
    onSuccess: () => { toast.success(app?.managed ? '应用已删除' : '应用已解绑'); invalidate(); navigate(backTo, { replace: true }); },
    onError: err => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });
  const deploy = useMutation({
    mutationFn: () => api<DeploymentInfo>('POST', `/api/apps/${slug}/deploy`, { source: 'console' }),
    onSuccess: () => { toast.success('已触发部署，排队中'); void cache.invalidateQueries({ queryKey: ['deployments', slug] }); invalidate(); setTab('deployments'); },
    onError: err => toast.error(err instanceof ApiError ? err.message : '部署失败'),
  });
  const back = <Link to={backTo} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />返回应用列表</Link>;
  if (apps.isLoading || (!app && apps.isFetching)) return <div className="space-y-5">{back}<TableSkeleton /></div>;
  if (apps.isError) return <div className="space-y-5">{back}<Empty text="应用加载失败" action={<Button variant="outline" onClick={() => void apps.refetch()}>重试</Button>} /></div>;
  if (!app) return <div className="space-y-5">{back}<Empty text="应用不存在或你无权查看" /></div>;
  return <div className="mx-auto max-w-6xl space-y-6">
    {back}
    <PageHeader title={<span className="flex flex-wrap items-center gap-3"><span className="break-all">{app.name}</span><ApprovalBadge a={app} /></span>}
      description={app.description || '管理应用部署、成员协作与运行配置。'}
      actions={<>
        {app.url && <Button asChild variant="outline"><a href={app.url} target="_blank" rel="noreferrer"><ExternalLink />访问应用</a></Button>}
        {canManage && <Button variant="outline" onClick={() => setEditing(true)}><Pencil />编辑配置</Button>}
        {app.isMember && <Confirm title={`部署 ${app.slug}？`} description={`将按 ${app.branch || '当前'} 分支重新构建并上线。`} confirmText="部署" destructive={false} onConfirm={() => deploy.mutate()}>
          <Button disabled={!app.canDeploy || deploy.isPending} title={!app.deployApproved ? '当前仓库需管理员授权后才能部署' : undefined}><Rocket />部署</Button>
        </Confirm>}
      </>} />
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
      <InlineCode>{app.slug}</InlineCode><span>所有者 · {app.ownerName}</span>
      <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3.5" />{app.branch || '由部署后台管理'}</span>
      <span className="inline-flex items-center gap-1.5"><Users className="size-3.5" />{new Set([app.ownerId, ...app.members.map(m => m.userId)]).size} 位成员</span>
    </div>
    {!app.deployApproved && <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">当前仓库等待管理员授权，授权后可部署和添加成员。{isAdmin && <Button variant="link" size="sm" onClick={() => setTab('overview')}>查看部署授权</Button>}</div>}
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto sm:w-auto">
        <TabsTrigger value="overview" className="flex-1 sm:flex-none">概览</TabsTrigger>
        <TabsTrigger value="members" className="flex-1 sm:flex-none">成员</TabsTrigger>
        <TabsTrigger value="env" className="flex-1 sm:flex-none">环境变量</TabsTrigger>
        <TabsTrigger value="deployments" className="flex-1 sm:flex-none">部署记录</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="mt-5 space-y-5">
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <AppOverview app={app} />
          <div className="min-w-0 space-y-5">
            <Card><CardHeader><CardTitle>仓库与 GitHub</CardTitle></CardHeader><CardContent><GithubAppSummary slug={slug} /></CardContent></Card>
            <DeploymentApproval app={app} isAdmin={isAdmin} onChanged={invalidate} />
          </div>
        </div>
        {canManage && <Card className="border-destructive/20"><CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="text-sm font-semibold">{app.managed ? '删除应用' : '解绑应用'}</h2><p className="mt-1 text-sm text-muted-foreground">{app.managed ? '删除应用及部署资源，此操作无法撤销。' : '从 EAT 移除关联，保留部署后台的应用。'}</p></div>
          <Confirm title={`删除应用 ${app.slug}？`} description={app.managed ? '将删除部署后台的应用、容器与构建记录，无法恢复。' : '仅从 EAT 解绑，不影响部署后台的应用。'} confirmText={app.managed ? '删除应用' : '解绑'} onConfirm={() => remove.mutate()}>
            <Button variant="outline-destructive" disabled={remove.isPending}><Trash2 />{app.managed ? '删除应用' : '解绑'}</Button>
          </Confirm>
        </CardContent></Card>}
      </TabsContent>
      <TabsContent value="members" className="mt-5"><AppMembers app={app} canManage={canManage} onChanged={invalidate} /></TabsContent>
      <TabsContent value="env" className="mt-5">{app.isMember ? <EnvPanel app={app} /> : <Card><CardContent><Empty text="仅应用成员可查看与修改环境变量" /></CardContent></Card>}</TabsContent>
      <TabsContent value="deployments" className="mt-5"><Card><CardContent><Deployments app={app} /></CardContent></Card></TabsContent>
    </Tabs>
    {editing && canManage && <EditAppDialog app={app} pending={update.isPending} onClose={() => !update.isPending && setEditing(false)} onSubmit={body => update.mutate(body)} />}
  </div>;
}

function AppOverview({ app }: { app: AppInfo }) {
  const githubUrl = githubRepoWebUrl(app.repoUrl);
  const rows: Array<[string, React.ReactNode]> = [
    ['Git 仓库', app.repoUrl ? <div className="space-y-1"><p className="break-all font-mono text-xs leading-6">{app.repoUrl}</p>{githubUrl && <a href={githubUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">在 GitHub 查看<ExternalLink className="size-3" /></a>}</div> : '未配置'],
    ['部署分支', app.branch || '由部署后台管理'],
    ['构建方式', app.buildType ? APP_BUILD_TYPE_LABEL[app.buildType] : '挂载应用，由部署后台维护'],
    ...(app.managed && app.buildType === 'dockerfile' ? [
      ['Dockerfile', app.dockerfile], ['构建上下文', app.dockerContextPath || '仓库根目录'], ['容器端口', String(app.port)],
    ] as Array<[string, React.ReactNode]> : []),
    ...(app.managed && app.buildType === 'static' ? [['发布目录', app.publishDirectory], ['SPA 模式', app.staticSpa ? '开启' : '关闭']] as Array<[string, React.ReactNode]> : []),
    ['访问地址', app.url ? <a href={app.url} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">{app.url}</a> : '尚未配置域名'],
    ['创建时间', formatDateTime(app.createdAt)],
  ];
  return <Card className="min-w-0"><CardHeader><CardTitle>应用配置</CardTitle></CardHeader><CardContent>
    <dl className="divide-y">{rows.map(([label, value]) => <div key={label} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-sm">{value}</dd></div>)}</dl>
  </CardContent></Card>;
}

function DeploymentApproval({ app, isAdmin, onChanged }: { app: AppInfo; isAdmin: boolean; onChanged: () => void }) {
  const approve = useMutation({
    mutationFn: (on: boolean) => api(on ? 'POST' : 'DELETE', `/api/apps/${app.slug}/approve`),
    onSuccess: (_r, on) => { toast.success(on ? '当前仓库已授权部署' : '已撤销部署授权'); onChanged(); },
    onError: err => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });
  return <Card><CardHeader><CardTitle>部署授权</CardTitle><ApprovalBadge a={app} /></CardHeader><CardContent className="space-y-4">
    <p className="text-sm leading-6 text-muted-foreground">{app.deployApproved
      ? `由 ${app.approvedByName ?? '管理员'}${app.approvedAt ? ` 于 ${formatDateTime(app.approvedAt)}` : ''} 授权当前仓库。更换仓库后需重新审批，更换分支无需重审。`
      : '请核对仓库归属和应用所有者的 GitHub 角色，再授权当前仓库部署。GitHub 信息待核验时仍可审批。'}</p>
    {app.approvalRequestedAt && !app.deployApproved && <p className="text-xs text-muted-foreground">最近部署请求：{formatDateTime(app.approvalRequestedAt)}</p>}
    {isAdmin && (app.deployApproved ? <Confirm title="撤销部署授权？" description="撤销后，所有应用成员将无法部署或添加新成员。已有成员关系保留。" confirmText="撤销授权" onConfirm={() => approve.mutate(false)}>
      <Button variant="outline" disabled={approve.isPending}><ShieldOff />撤销授权</Button>
    </Confirm> : <Button onClick={() => approve.mutate(true)} loading={approve.isPending}><ShieldCheck />授权部署</Button>)}
  </CardContent></Card>;
}

function AppMembers({ app, canManage, onChanged }: { app: AppInfo; canManage: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const github = useGithubApp(app.slug);
  const repository = useRepositoryCollaborators(app.slug, !!github.data?.enabled && github.data.scope === 'organization');
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/apps/${app.slug}/members/${id}`),
    onSuccess: () => { toast.success('已移除应用成员'); onChanged(); },
    onError: err => toast.error(err instanceof ApiError ? err.message : '移除失败'),
  });
  const members = [{ userId: app.ownerId, name: app.ownerName }, ...app.members.filter(m => m.userId !== app.ownerId)];
  return <div className="space-y-5">
    <Card><CardHeader><div><CardTitle>应用成员 <span className="ml-1 text-sm font-normal text-muted-foreground">{members.length}</span></CardTitle><p className="mt-2 text-sm text-muted-foreground">成员可部署应用、查看日志和管理环境变量。</p></div>
      {canManage && <Button disabled={!app.deployApproved} onClick={() => setAdding(true)}><Plus />添加成员</Button>}
    </CardHeader><CardContent>
      {!app.deployApproved && canManage && <p className="mb-4 text-sm text-muted-foreground">当前仓库获部署授权后可添加成员；已有成员仍可移除。</p>}
      <div className="divide-y">{members.map(m => {
        const status = observedMember(github.data?.members.find(g => g.userId === m.userId), repository.isError ? undefined : repository.data);
        return <section key={m.userId} aria-label={`${m.name} 的应用成员信息`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_12rem]">
        <div className="flex min-w-0 items-center gap-3"><span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">{m.name.slice(0, 1)}</span><div className="min-w-0"><p className="break-words text-sm font-medium">{m.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{m.userId === app.ownerId ? '应用所有者' : '应用成员'}</p></div></div>
        <div data-member-status className="col-start-1 min-w-0 pl-12 lg:col-auto lg:pl-0"><ApplicationMemberGithub member={status} enabled={github.data?.enabled} /></div>
        <div className="col-start-2 row-start-1 row-end-3 flex flex-col items-end gap-2 lg:col-auto lg:row-auto lg:flex-row lg:justify-end">
        <ApplicationMemberAdd member={status} slug={app.slug} repository={github.data?.repository ?? null} />
        {canManage && m.userId !== app.ownerId && <Confirm title={`移除 ${m.name}？`} description="移除后，该用户将失去此应用的部署、日志和环境变量权限。相关 GitHub 授权按现有回收规则处理，不会退出组织。" confirmText="移除成员" onConfirm={() => remove.mutate(m.userId)}>
          <Button variant="ghost" size="sm" disabled={remove.isPending} aria-label={`移除 ${m.name}`}>移除成员</Button>
        </Confirm>}
        </div>
      </section>; })}</div>
    </CardContent></Card>
    <Card><CardContent><GithubRepositoryMembers slug={app.slug} appInfo={github.data} /></CardContent></Card>
    {adding && canManage && app.deployApproved && <AddMemberDialog app={app} onClose={() => setAdding(false)} onAdded={onChanged} />}
  </div>;
}

interface MemberCandidate { id: string; name: string; email: string }
function AddMemberDialog({ app, onClose, onAdded }: { app: AppInfo; onClose: () => void; onAdded: () => void }) {
  const [search, setSearch] = useState(''), [selectedId, setSelectedId] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<MemberCandidate[]>('GET', '/api/users') });
  const candidates = (users.data ?? []).filter(u => u.id !== app.ownerId && !app.members.some(m => m.userId === u.id));
  const selected = candidates.find(u => u.id === selectedId);
  const keyword = search.trim().toLowerCase();
  const matches = candidates.filter(u => `${u.name} ${u.email}`.toLowerCase().includes(keyword));
  const add = useMutation({
    mutationFn: (id: string) => api('POST', `/api/apps/${app.slug}/members`, { userId: id }),
    onSuccess: () => { toast.success('应用成员已添加，GitHub 授权将在后台处理'); onAdded(); onClose(); },
  });
  return <Dialog open onOpenChange={open => !open && !add.isPending && onClose()}><DialogContent className="max-w-lg">
    <DialogHeader><DialogTitle>添加应用成员</DialogTitle><DialogDescription>选择一位 EAT 用户加入「{app.name}」。GitHub 授权结果可在成员页查看。</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (selected && !add.isPending) add.mutate(selected.id); }}>
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="h-10 pl-9" type="search" placeholder="搜索姓名或邮箱" aria-label="搜索姓名或邮箱" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="max-h-[min(20rem,40dvh)] overflow-y-auto rounded-lg border p-1">
        {users.isLoading ? <TableSkeleton rows={3} /> : users.isError ? <Empty text="用户列表加载失败" action={<Button type="button" variant="outline" onClick={() => void users.refetch()}>重试</Button>} /> : !matches.length ? <Empty text={keyword ? '没有匹配的用户，试试其他姓名或邮箱' : '所有可选用户都已是应用成员'} className="py-8" /> :
          <fieldset disabled={add.isPending} className="space-y-1"><legend className="sr-only">选择要添加的成员</legend>{matches.map(u => <label key={u.id} className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-3 hover:bg-accent focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring ${selectedId === u.id ? 'bg-accent' : ''}`}>
            <input type="radio" name="app-member" value={u.id} checked={selectedId === u.id} onChange={() => { setSelectedId(u.id); add.reset(); }} className="size-4 shrink-0 accent-primary" />
            <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{u.name}</span><span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{u.email}</span></span>
          </label>)}</fieldset>}
      </div>
      {selected && <p className="flex items-center gap-1.5 text-sm"><Check className="size-4 shrink-0 text-success" /><span className="break-all">已选择：{selected.name}</span></p>}
      {add.isError && <p role="alert" className="text-sm text-destructive">{add.error instanceof ApiError ? add.error.message : '添加失败，请重试'}</p>}
      <div className="flex justify-end gap-2 border-t pt-4"><Button type="button" variant="outline" disabled={add.isPending} onClick={onClose}>取消</Button><Button type="submit" loading={add.isPending} disabled={!selected || users.isError || !app.deployApproved}>添加成员</Button></div>
    </form>
  </DialogContent></Dialog>;
}

function EnvPanel({ app }: { app: AppInfo }) {
  const [editing, setEditing] = useState<AppEnvTarget | null>(null);
  const env = useQuery({ queryKey: ['app-env', app.slug], queryFn: () => api<AppEnv>('GET', `/api/apps/${app.slug}/env`), retry: false });
  return <div className="space-y-5">
    <p className="text-sm text-muted-foreground">运行时与构建时变量分别管理，保存后在下次部署生效。</p>
    {env.isLoading ? <TableSkeleton /> : env.isError ? <Empty text="环境变量加载失败" action={<Button variant="outline" onClick={() => void env.refetch()}>重试</Button>} /> :
      <div className="grid items-start gap-5 lg:grid-cols-2">{(['runtime', 'build'] as const).map(target => <Card className="min-w-0" key={target}>
        <CardHeader><div><CardTitle>{APP_ENV_TARGET_LABEL[target]}</CardTitle><p className="mt-2 text-xs text-muted-foreground">{target === 'runtime' ? '应用运行时读取的配置' : 'Dockerfile 构建时使用的 ARG'}</p></div><Button variant="outline" size="sm" onClick={() => setEditing(target)}><Pencil />编辑</Button></CardHeader>
        <CardContent><pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-4 font-mono text-xs leading-6 whitespace-pre-wrap break-all">{env.data?.[target]?.trim() || '暂无环境变量'}</pre></CardContent>
      </Card>)}</div>}
    {editing && <EnvEditor app={app} initialTarget={editing} onClose={() => setEditing(null)} />}
  </div>;
}
/** 应用 env（决策 31）：运行时 / 构建时两块，直接读写 Dokploy；保存是整体覆盖，结果只报 key 级变化 */
function EnvEditor({ app, initialTarget, onClose }: { app: AppInfo; initialTarget: AppEnvTarget; onClose: () => void }) {
  const queryClient = useQueryClient();
  const target = initialTarget;
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
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  return <Dialog open onOpenChange={open => !open && !save.isPending && onClose()}>
    <DialogContent className="max-w-3xl">
      <DialogHeader><DialogTitle>编辑环境变量</DialogTitle><DialogDescription>{APP_ENV_TARGET_LABEL[target]} · 保存将整体替换此类变量，下次部署生效。</DialogDescription></DialogHeader>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{target === 'runtime' ? '应用运行时读取的配置，每行一条 KEY=value。' : 'Dockerfile 中通过 ARG 读取，每行一条 KEY=value。'}</p>
        <Button variant="outline" size="sm" onClick={() => void env.refetch()} disabled={env.isFetching || save.isPending}><RefreshCw />刷新</Button>
      </div>
      {env.isError ? <p role="alert" className="text-sm text-destructive">{env.error instanceof ApiError ? env.error.message : '读取失败，请重试'}</p> : env.isLoading ? <TableSkeleton rows={3} /> :
        <Textarea rows={12} aria-label="环境变量内容" disabled={save.isPending} className="font-mono text-xs" spellCheck={false} placeholder={'KEY=value\n# 一行一条'} value={current} onChange={e => setDraft(d => ({ ...d, [target]: e.target.value }))} />}
      {save.isError && <p role="alert" className="text-sm text-destructive">{save.error instanceof ApiError ? save.error.message : '保存失败，请重试'}</p>}
      <div className="flex justify-end gap-2 border-t pt-4">
        <Button variant="outline" disabled={save.isPending} onClick={onClose}>取消</Button>
        <Button onClick={() => save.mutate()} disabled={!dirty || env.isError} loading={save.isPending}>保存</Button>
      </div>
    </DialogContent>
  </Dialog>;
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
        <div className="flex flex-wrap gap-2">
          <Button variant={allHistory ? 'default' : 'outline'} size="sm" onClick={() => setAllHistory((v) => !v)}>
            {allHistory ? '最近部署' : '显示全部历史'}
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
      ) : deployments.isError ? (
        <Empty text="部署记录加载失败" action={<Button variant="outline" onClick={() => void deployments.refetch()}>重试</Button>} />
      ) : (deployments.data ?? []).length === 0 ? (
        <Empty text={`暂无部署。点击页面上方「部署」，或运行 eat deploy ${app.slug}。`} className="py-6" />
      ) : (
        <>
        <div className="space-y-3 md:hidden">
          {(deployments.data ?? []).map(d => <article key={d.deploymentId ?? d.platform?.id} className="space-y-3 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">{STATUS_BADGE[d.status]}<time className="text-xs text-muted-foreground">{formatDateTime(d.createdAt)}</time></div>
            <OriginCell d={d} />
            {d.error && <p className="break-words text-xs leading-5 text-destructive">{d.error}</p>}
          </article>)}
        </div>
        <div className="hidden md:block">
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">时间</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-32">来源</TableHead>
              <TableHead>备注</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(deployments.data ?? []).map((d) => (
              <TableRow key={d.deploymentId ?? d.platform?.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(d.createdAt)}</TableCell>
                <TableCell>{STATUS_BADGE[d.status]}</TableCell>
                <TableCell>
                  <OriginCell d={d} />
                </TableCell>
                <TableCell className="max-w-80 truncate text-muted-foreground" title={d.error ?? undefined}>
                  {d.error ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        </>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {allHistory
          ? '「已归档」= Dokploy 那边的构建记录已被清理，只剩平台侧元数据（谁触发的、从哪触发的）。'
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
