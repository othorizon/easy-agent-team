import { GithubAppSummary } from '../components/github';
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
} from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { DokployAppPicker } from '../components/dokploy-app-picker';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { PAGE_SIZE_OPTIONS, Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useQueryParams } from '../lib/use-query-params';

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
  const [params, setParams] = useQueryParams({ q: '', filter: 'all', page: '1', pageSize: '20' });
  const filter = isAdmin && params.filter === 'pending' ? 'pending' : 'all';
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
  const matching = (apps.data ?? []).filter((a) => a.name.toLowerCase().includes(keyword) || a.slug.toLowerCase().includes(keyword));
  const pendingCount = matching.filter((a) => !a.deployApproved).length;
  const filtered = matching.filter((a) => filter === 'all' || !a.deployApproved);
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
    <div className="space-y-5">
      <PageHeader
        title="应用"
        description="从代码仓库部署应用，管理成员协作、环境变量与部署记录。"
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-[300px]">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="pl-9"
            placeholder="搜索应用名称 / 标识"
            aria-label="搜索应用名称或标识"
            value={params.q}
            onChange={(e) => setParams({ q: e.target.value, page: '1' })}
          />
        </div>
        {isAdmin && (pendingCount > 0 || filter === 'pending') && (
          <Segmented
            value={filter}
            ariaLabel="部署授权筛选"
            onChange={(value) => setParams({ filter: value, page: '1' })}
            options={[
              { label: '全部', value: 'all' },
              { label: `待授权 ${pendingCount}`, value: 'pending' },
            ]}
          />
        )}
      </div>
      <Card>
        <CardContent className="space-y-4">
          {apps.isLoading ? (
            <TableSkeleton />
          ) : apps.isError ? (
            <Empty text="应用列表加载失败" action={<Button variant="outline" onClick={() => void apps.refetch()}>重试</Button>} />
          ) : rows.length === 0 ? (
            <Empty
              text={keyword ? '没有符合条件的应用' : filter === 'pending' ? '没有待授权的应用' : '暂无应用'}
              action={keyword || filter === 'pending' ? <Button variant="outline" onClick={() => setParams({ q: '', filter: 'all', page: '1' })}>清除筛选</Button> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>应用</TableHead>
                  <TableHead className="hidden md:table-cell">Git</TableHead>
                  <TableHead className="hidden w-24 sm:table-cell">所有者</TableHead>
                  <TableHead className="hidden lg:table-cell">成员</TableHead>
                  <TableHead className="w-28">部署授权</TableHead>
                  <TableHead className="w-20">我可部署</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link
                        className="group inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-left rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                        to={`/apps/${encodeURIComponent(a.slug)}`}
                        state={{ from: location.pathname + location.search }}
                      >
                        <InlineCode className="text-primary group-hover:underline">{a.slug}</InlineCode>
                        <span className="font-medium">{a.name}</span>
                        <Badge variant="outline">{a.buildType ? APP_BUILD_TYPE_LABEL[a.buildType] : '挂载'}</Badge>
                      </Link>
                      <GithubAppSummary slug={a.slug} compact />
                      {a.url && (
                        <a href={a.url} target="_blank" rel="noreferrer" className="mt-0.5 block truncate font-mono text-xs text-muted-foreground hover:underline">
                          {a.domain}
                        </a>
                      )}
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
          {!apps.isLoading && !apps.isError && (
            <Pagination
              total={filtered.length}
              page={page}
              pageSize={pageSize}
              onPageChange={(value) => setParams({ page: String(value) })}
              onPageSizeChange={(value) => setParams({ pageSize: String(value), page: '1' })}
            />
          )}
        </CardContent>
      </Card>

      {creating && <CreateAppDialog pending={create.isPending} onClose={() => setCreating(false)} onSubmit={(v) => create.mutate(v)} />}
      {mounting && <MountAppDialog pending={mount.isPending} onClose={() => setMounting(false)} onSubmit={(v) => mount.mutate(v)} />}
    </div>
  );
}

// ---------- 表单：构建方式字段（创建与编辑共用） ----------

type BuildFormValues = {
  buildType: AppBuildType;
  dockerfile: string;
  dockerContextPath: string;
  publishDirectory: string;
  staticSpa: boolean;
  port: number;
};

const containerPort = (v: number) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? true : '1-65535 的整数');

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
            <Input id={`${idPrefix}-dockerfile`} className="font-mono" placeholder={DEFAULT_DOCKERFILE} {...f.register('dockerfile', { validate: repoPath })} />
          </Field>
          <Field label="构建上下文" htmlFor={`${idPrefix}-context`} hint="相对仓库根，留空为仓库根" error={f.formState.errors.dockerContextPath?.message}>
            <Input id={`${idPrefix}-context`} className="font-mono" placeholder="." {...f.register('dockerContextPath', { validate: repoPath })} />
          </Field>
          <Field label="容器端口" htmlFor={`${idPrefix}-port`} hint="域名流量转发到它" error={f.formState.errors.port?.message}>
            <Input id={`${idPrefix}-port`} type="number" className="font-mono" placeholder={String(DEFAULT_CONTAINER_PORT)} {...f.register('port', { valueAsNumber: true, validate: containerPort })} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="发布目录" htmlFor={`${idPrefix}-publish`} hint="相对仓库根，交给 nginx 托管的目录" error={f.formState.errors.publishDirectory?.message}>
            <Input id={`${idPrefix}-publish`} className="font-mono" placeholder={DEFAULT_PUBLISH_DIRECTORY} {...f.register('publishDirectory', { validate: repoPath })} />
          </Field>
          <Field label="SPA 模式" hint={`所有路径回退到 index.html（前端路由用）；静态托管由 nginx 监听 ${STATIC_CONTAINER_PORT} 端口，域名流量转发到它`}>
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

export function EditAppDialog({ app, pending, onClose, onSubmit }: { app: AppInfo; pending: boolean; onClose: () => void; onSubmit: (v: UpdateAppRequest) => void }) {
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
            <Input id="app-edit-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          {app.managed ? (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
                <Field label="Git 仓库地址" htmlFor="app-edit-repo" required error={errors.repoUrl?.message} hint="更换仓库后需重新审批，更换分支无需重审。">
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
