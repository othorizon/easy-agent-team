import { GithubRepositoryScope } from '../components/github';
import type {
  AppBuildType,
  AppInfo,
  CreateAppRequest,
  DokployApplication,
  MountAppRequest,
  UpdateAppRequest,
} from '@eat/shared';
import {
  APP_BUILD_TYPE_LABEL,
  DEFAULT_BRANCH,
  DEFAULT_CONTAINER_PORT,
  DEFAULT_DOCKERFILE,
  DEFAULT_PUBLISH_DIRECTORY,
  STATIC_CONTAINER_PORT,
  createAppSchema,
  githubRepoWebUrl,
  mountAppSchema,
} from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, GitBranch, Link2, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { DokployAppPicker } from '../components/dokploy-app-picker';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { PAGE_SIZE_OPTIONS, Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tip } from '../components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { useQueryParams } from '../lib/use-query-params';
import { z } from '../lib/zod';

const BUILD_TYPE_OPTIONS: Array<{ label: string; value: AppBuildType }> = [
  { label: APP_BUILD_TYPE_LABEL.dockerfile, value: 'dockerfile' },
  { label: APP_BUILD_TYPE_LABEL.static, value: 'static' },
];

export function ApprovalBadge({ a }: { a: AppInfo }) {
  if (a.deployApproved) return <Badge variant="success">已授权部署</Badge>;
  return <Badge variant="warning">{a.approvalRequestedAt ? '待授权 · 有部署请求' : '待授权部署'}</Badge>;
}

export function AppsPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const [creating, setCreating] = useState(false);
  const [mounting, setMounting] = useState(false);
  const [params, setParams] = useQueryParams({ scope: 'mine', q: '', filter: 'all', page: '1', pageSize: '20' });
  const scope = params.scope === 'all' ? 'all' : 'mine';
  const filter = ['ready', 'pending', 'unavailable'].includes(params.filter) ? params.filter : 'all';
  const requestedPage = Number(params.page);
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize)) ? Number(params.pageSize) : 20;

  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api<AppInfo[]>('GET', '/api/apps') });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['apps'] });

  const create = useMutation({
    mutationFn: (v: CreateAppRequest) => api<AppInfo>('POST', '/api/apps', v),
    onSuccess: (a) => {
      const domain = a.domain ? `，已分配域名 ${a.domain}` : '';
      toast.success(a.deployApproved ? `应用已创建${domain}` : `应用已创建${domain}；首次部署前需管理员授权一次`);
      setCreating(false);
      invalidate();
      navigate(`/apps/${encodeURIComponent(a.slug)}`);
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

  const keyword = params.q.trim().toLowerCase();
  const allApps = apps.data ?? [];
  const myApps = allApps.filter(a => a.ownerId === me?.id || a.members.some(m => m.userId === me?.id));
  const scopedApps = scope === 'mine' ? myApps : allApps;
  const matching = scopedApps.filter((a) => a.name.toLowerCase().includes(keyword) || a.slug.toLowerCase().includes(keyword));
  const filtered = matching.filter(a => filter === 'all' || deploymentAccess(a) === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pageCount, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  // 删除或刷新后总页数可能缩小；同步有效页码，避免停在空白页。
  useEffect(() => {
    if (apps.data && !apps.isFetching && params.page !== String(page)) {
      setParams({ page: String(page) });
    }
  }, [apps.data, apps.isFetching, params.page, page, setParams]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader title="应用" description="找到正在协作的应用，继续你的工作。" actions={
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && <Button variant="ghost" className="text-muted-foreground" onClick={() => setMounting(true)}><Link2 />挂载应用</Button>}
          <Button onClick={() => setCreating(true)}><Plus />创建应用</Button>
        </div>
      } />
      <Tabs value={scope} onValueChange={value => setParams({ scope: value, page: '1' })}>
        <div className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <TabsList aria-label="应用范围" className="gap-7 rounded-none bg-transparent p-0">
            {([{ value: 'mine', label: '我的', count: myApps.length }, { value: 'all', label: '全部', count: allApps.length }] as const).map(item =>
              <TabsTrigger key={item.value} value={item.value} className="-mb-px gap-2 rounded-none border-b-2 border-transparent px-0 py-3 data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none">
                {item.label}{apps.data && <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal tabular-nums text-muted-foreground">{item.count}</span>}
              </TabsTrigger>)}
          </TabsList>
          <div className="flex min-w-0 gap-2 pb-3 sm:pb-2">
            <div className="relative min-w-0 flex-1 sm:w-56">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" className="pl-9 text-xs" placeholder="搜索名称或标识" aria-label="搜索应用名称或标识" value={params.q} onChange={e => setParams({ q: e.target.value, page: '1' })} />
            </div>
            <Select value={filter} onValueChange={value => setParams({ filter: value, page: '1' })}>
              <SelectTrigger className="w-32 shrink-0 text-xs" aria-label="部署权限筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部部署权限</SelectItem>
                <SelectItem value="ready">可部署</SelectItem>
                <SelectItem value="pending">待授权</SelectItem>
                <SelectItem value="unavailable">无部署权限</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <TabsContent value={scope} className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{scope === 'mine' ? '我创建或加入的应用' : '全部应用'}</span>
            {apps.data && <span className="tabular-nums">{filtered.length} 个应用</span>}
          </div>
          {apps.isLoading ? <TableSkeleton /> : apps.isError ? (
            <Empty text="应用列表加载失败" action={<Button variant="outline" onClick={() => void apps.refetch()}>重试</Button>} />
          ) : rows.length === 0 ? (
            <div className="rounded-xl border bg-card"><Empty
              text={keyword || filter !== 'all' ? '没有符合条件的应用' : scope === 'mine' ? '暂无我创建或加入的应用' : '暂无应用'}
              action={keyword || filter !== 'all' ? <Button variant="outline" onClick={() => setParams({ q: '', filter: 'all', page: '1' })}>清除筛选</Button> : scope === 'mine' ? <Button variant="outline" onClick={() => setParams({ scope: 'all', page: '1' })}>查看全部应用</Button> : undefined}
            /></div>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <div aria-hidden className="hidden grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_6rem_6rem_1rem] gap-6 border-b bg-muted/25 px-5 py-3 text-xs text-muted-foreground lg:grid">
                <span>应用</span><span>仓库与分支</span><span>我的身份</span><span>部署权限</span><span />
              </div>
              <ul className="divide-y" aria-label="应用列表">
                {rows.map(a => <AppListRow key={a.id} app={a} userId={me?.id} isAdmin={isAdmin} showOwner={scope === 'all'} from={location.pathname + location.search} />)}
              </ul>
            </div>
          )}
          {!apps.isLoading && !apps.isError && <Pagination total={filtered.length} page={page} pageSize={pageSize}
            onPageChange={value => setParams({ page: String(value) })} onPageSizeChange={value => setParams({ pageSize: String(value), page: '1' })} />}
        </TabsContent>
      </Tabs>
      {creating && <CreateAppDialog pending={create.isPending} onClose={() => setCreating(false)} onSubmit={v => create.mutate(v)} />}
      {mounting && <MountAppDialog pending={mount.isPending} onClose={() => setMounting(false)} onSubmit={v => mount.mutate(v)} />}
    </div>
  );
}

function deploymentAccess(app: AppInfo): 'ready' | 'pending' | 'unavailable' {
  if (app.canDeploy) return 'ready';
  return app.isMember && !app.deployApproved ? 'pending' : 'unavailable';
}

/** 展示安全的仓库简称，不把 Git URL 中可能包含的用户名、密码或查询串带入列表。 */
function repositoryName(raw: string): string {
  if (!raw.trim()) return '未配置仓库';
  const github = githubRepoWebUrl(raw);
  if (github) return new URL(github).pathname.slice(1);
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname.replace(/\.git\/?$/i, '').replace(/\/$/, '')}`;
  } catch {
    const parts = /^(?:[^@/:\s]+@)?([^@/:\s]+)[:/](\S+)$/.exec(raw.trim());
    return parts ? `${parts[1]}/${parts[2].replace(/[?#].*$/, '').replace(/\.git\/?$/i, '')}` : '仓库地址待核验';
  }
}

function AppListRow({ app: a, userId, isAdmin, showOwner, from }: { app: AppInfo; userId?: string; isAdmin: boolean; showOwner: boolean; from: string }) {
  const mine = a.ownerId === userId;
  const joined = a.members.some(m => m.userId === userId);
  const relationship = mine ? '我创建' : joined ? '我加入' : isAdmin ? '管理员访问' : '未加入';
  const access = deploymentAccess(a);
  const status = access === 'ready' ? '可部署' : access === 'pending' ? '待授权' : !a.isMember ? '未加入' : '权限待核验';
  const repository = repositoryName(a.repoUrl);
  return <li>
    <Link to={`/apps/${encodeURIComponent(a.slug)}`} state={{ from }} aria-label={`${a.slug} ${a.name}，查看应用详情`}
      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-4 px-5 py-5 outline-none transition-colors hover:bg-muted/25 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_6rem_6rem_1rem] lg:gap-6 lg:py-6">
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span className="break-words text-sm font-semibold">{a.name}</span><span className="break-all font-mono text-[10px] text-muted-foreground">{a.slug}</span></div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{a.managed ? '平台创建' : '挂载应用'}</span><span aria-hidden className="text-muted-foreground/50">·</span><span>{!a.managed ? '构建由部署后台管理' : a.buildType === 'dockerfile' ? 'Dockerfile' : a.buildType === 'static' ? '静态站点' : '构建方式待核验'}</span></div>
      </div>
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <Tip content={repository}><p className="break-all font-mono text-xs text-muted-foreground lg:truncate">{repository}</p></Tip>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1 rounded bg-muted/70 px-1.5 py-0.5"><GitBranch className="size-3 shrink-0" aria-hidden /><span className="break-all">{a.managed ? a.branch || '分支未配置' : '分支由部署后台管理'}</span></span>
          {a.repoUrl && <GithubRepositoryScope slug={a.slug} />}
        </div>
      </div>
      <div className="min-w-0"><p className={`text-xs ${mine ? 'text-foreground' : 'text-muted-foreground'}`}>{relationship}</p>{showOwner && <p className="mt-1 break-words text-[11px] text-muted-foreground">所有者 {a.ownerName}</p>}</div>
      <div className="justify-self-end lg:justify-self-start"><span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-[11px] ${access === 'ready' ? 'bg-success/10 text-success' : access === 'pending' ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground'}`}><span aria-hidden className="size-1.5 rounded-full bg-current" />{status}</span></div>
      <ChevronRight aria-hidden className="hidden size-4 text-muted-foreground/50 group-hover:text-foreground lg:block" />
    </Link>
  </li>;
}

// ---------- 表单：构建方式字段（创建与编辑共用） ----------

const appShape = createAppSchema.shape;

/** 构建字段的规则直接取创建契约（相对路径、端口范围与服务端同一份），创建与编辑共用 */
const buildFieldsShape = {
  buildType: appShape.buildType,
  dockerfile: appShape.dockerfile.unwrap(),
  dockerContextPath: appShape.dockerContextPath.unwrap(),
  publishDirectory: appShape.publishDirectory.unwrap(),
  staticSpa: z.boolean(),
  port: appShape.port.unwrap(),
};
/* 用输入类型：端口是 coerce 的数字，输入侧为 unknown */
type BuildFormValues = z.input<z.ZodObject<typeof buildFieldsShape>>;

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
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_7rem]">
          <Field label="Dockerfile 路径" htmlFor={`${idPrefix}-dockerfile`} hint="相对仓库根" error={f.formState.errors.dockerfile?.message}>
            <Input id={`${idPrefix}-dockerfile`} className="font-mono" placeholder={DEFAULT_DOCKERFILE} {...f.register('dockerfile')} />
          </Field>
          <Field label="构建上下文" htmlFor={`${idPrefix}-context`} hint="相对仓库根，留空为仓库根" error={f.formState.errors.dockerContextPath?.message}>
            <Input id={`${idPrefix}-context`} className="font-mono" placeholder="." {...f.register('dockerContextPath')} />
          </Field>
          <Field label="容器端口" htmlFor={`${idPrefix}-port`} hint="域名流量转发到它" error={f.formState.errors.port?.message}>
            <Input id={`${idPrefix}-port`} type="number" className="font-mono" placeholder={String(DEFAULT_CONTAINER_PORT)} {...f.register('port', { valueAsNumber: true })} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="发布目录" htmlFor={`${idPrefix}-publish`} hint="相对仓库根，交给 nginx 托管的目录" error={f.formState.errors.publishDirectory?.message}>
            <Input id={`${idPrefix}-publish`} className="font-mono" placeholder={DEFAULT_PUBLISH_DIRECTORY} {...f.register('publishDirectory')} />
          </Field>
          <Field label="SPA 模式" hint={`所有路径回退到 index.html（前端路由用）；静态托管由 nginx 监听 ${STATIC_CONTAINER_PORT} 端口，域名流量转发到它`}>
            <Controller control={f.control} name="staticSpa" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
          </Field>
        </div>
      )}
    </>
  );
}

/** 名称 / 分支 / Dockerfile 路径留空时提交前回落默认值，所以表单上允许留空 */
const createAppFormSchema = z.object({
  slug: appShape.slug,
  name: z.literal('').or(appShape.name),
  repoUrl: appShape.repoUrl,
  branch: z.literal('').or(appShape.branch.unwrap()),
  ...buildFieldsShape,
  description: appShape.description.unwrap(),
});

function CreateAppDialog({ pending, onClose, onSubmit }: { pending: boolean; onClose: () => void; onSubmit: (v: CreateAppRequest) => void }) {
  const form = useForm({
    resolver: zodResolver(createAppFormSchema),
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
      port: DEFAULT_CONTAINER_PORT,
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
              <Input id="app-slug" placeholder="crm-tool" className="font-mono" aria-invalid={!!errors.slug} {...register('slug')} />
            </Field>
            <Field label="名称" htmlFor="app-name" hint="留空同标识">
              <Input id="app-name" placeholder="CRM 小工具" {...register('name')} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <Field label="Git 仓库地址" htmlFor="app-repo" required error={errors.repoUrl?.message} hint="https 或 ssh 地址；私有仓库需管理员在 Dokploy 设置里配好 SSH key">
              <Input id="app-repo" className="font-mono" placeholder="git@git.example.com:team/crm.git" aria-invalid={!!errors.repoUrl} {...register('repoUrl')} />
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

/** 平台托管的应用必须有仓库地址；挂载的应用仓库地址只作备注、必须有 application id */
function editAppFormSchema(managed: boolean) {
  return z.object({
    name: appShape.name,
    description: appShape.description.unwrap(),
    repoUrl: managed ? appShape.repoUrl : mountAppSchema.shape.repoUrl.unwrap(),
    branch: z.literal('').or(appShape.branch.unwrap()),
    ...buildFieldsShape,
    dokployApplicationId: managed ? z.string() : mountAppSchema.shape.dokployApplicationId,
  });
}

export function EditAppDialog({ app, pending, onClose, onSubmit }: { app: AppInfo; pending: boolean; onClose: () => void; onSubmit: (v: UpdateAppRequest) => void }) {
  const form = useForm({
    resolver: zodResolver(editAppFormSchema(app.managed)),
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
      port: app.port,
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
                    port: v.port,
                  }
                : { name: v.name, description: v.description, repoUrl: v.repoUrl, dokployApplicationId: v.dokployApplicationId },
            ),
          )}
        >
          <Field label="名称" htmlFor="app-edit-name" required error={errors.name?.message}>
            <Input id="app-edit-name" aria-invalid={!!errors.name} {...register('name')} />
          </Field>
          {app.managed ? (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
                <Field label="Git 仓库地址" htmlFor="app-edit-repo" required error={errors.repoUrl?.message} hint="更换仓库后需重新审批，更换分支无需重审。">
                  <Input id="app-edit-repo" className="font-mono" aria-invalid={!!errors.repoUrl} {...register('repoUrl')} />
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
                  <Input id="app-edit-app" className="flex-1 font-mono" aria-invalid={!!errors.dokployApplicationId} {...register('dokployApplicationId')} />
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
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>取消</Button>
            <Button type="submit" loading={pending}>保存</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 管理员挂载 Dokploy 上既有的 application（决策 27 的选择器只在这里用） */
function MountAppDialog({ pending, onClose, onSubmit }: { pending: boolean; onClose: () => void; onSubmit: (v: MountAppRequest) => void }) {
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm({
    resolver: zodResolver(mountAppSchema),
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
              <Input id="mount-slug" placeholder="crm-tool" className="font-mono" aria-invalid={!!errors.slug} {...register('slug')} />
            </Field>
            <Field label="名称" htmlFor="mount-name" required error={errors.name?.message}>
              <Input id="mount-name" placeholder="CRM 小工具" aria-invalid={!!errors.name} {...register('name')} />
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
              <Input id="mount-app" className="flex-1 font-mono" aria-invalid={!!errors.dokployApplicationId} {...register('dokployApplicationId')} />
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
