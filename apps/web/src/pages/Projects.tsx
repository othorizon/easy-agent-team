import type { CreateProjectRequest, DeploymentInfo, ProjectInfo, UpdateProjectRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Combobox } from '../components/combobox';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime } from '../lib/utils';

const STATUS_BADGE: Record<string, JSX.Element> = {
  deploying: <Badge>部署中</Badge>,
  success: <Badge variant="success">成功</Badge>,
  failed: <Badge variant="destructive">失败</Badge>,
};

interface UserRow {
  id: string;
  name: string;
  email: string;
}

export function ProjectsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [viewingSlug, setViewingSlug] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectInfo[]>('GET', '/api/projects') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('GET', '/api/users') });

  // 弹窗数据从最新列表里取，成员变更后自动刷新
  const viewing = viewingSlug ? (projects.data ?? []).find((p) => p.slug === viewingSlug) ?? null : null;
  const editingProject = editingSlug ? (projects.data ?? []).find((p) => p.slug === editingSlug) ?? null : null;

  const deployments = useQuery({
    queryKey: ['deployments', viewingSlug],
    queryFn: () => api<DeploymentInfo[]>('GET', `/api/projects/${viewingSlug}/deployments`),
    enabled: viewingSlug !== null,
    refetchInterval: 10_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: (v: CreateProjectRequest) => api('POST', '/api/projects', v),
    onSuccess: () => {
      toast.success('项目已创建');
      setCreating(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const update = useMutation({
    mutationFn: (v: { slug: string; body: UpdateProjectRequest }) => api('PATCH', `/api/projects/${v.slug}`, v.body),
    onSuccess: () => {
      toast.success('项目已更新');
      setEditingSlug(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '更新失败'),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api('DELETE', `/api/projects/${slug}`),
    onSuccess: () => {
      toast.success('项目已删除');
      setViewingSlug(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const addMember = useMutation({
    mutationFn: (v: { slug: string; userId: string }) => api('POST', `/api/projects/${v.slug}/members`, { userId: v.userId }),
    onSuccess: () => {
      toast.success('已添加成员');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '添加失败'),
  });

  const removeMember = useMutation({
    mutationFn: (v: { slug: string; userId: string }) => api('DELETE', `/api/projects/${v.slug}/members/${v.userId}`),
    onSuccess: () => {
      toast.success('已移除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '移除失败'),
  });

  const canManage = (p: ProjectInfo) => me?.role === 'admin' || p.ownerId === me?.id;

  return (
    <div className="space-y-5">
      <PageHeader
        title="部署项目"
        description={
          <>
            项目绑定 Dokploy 上的应用。部署从本地发起：项目目录里运行 <InlineCode>eat deploy &lt;slug&gt;</InlineCode>
            ——CLI 会先做本地密钥扫描（含平台密钥指纹匹配），通过后才触发 Dokploy 部署；AI 也可经 MCP 的 trigger_deploy 自助部署。
          </>
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            创建项目
          </Button>
        }
      />
      <Card>
        <CardContent>
          {projects.isLoading ? (
            <TableSkeleton />
          ) : (projects.data ?? []).length === 0 ? (
            <Empty text="暂无项目" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead className="hidden md:table-cell">Dokploy 应用</TableHead>
                  <TableHead className="hidden w-24 sm:table-cell">Owner</TableHead>
                  <TableHead className="hidden lg:table-cell">成员</TableHead>
                  <TableHead className="w-20">我可部署</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(projects.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="group inline-flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 text-left"
                        onClick={() => setViewingSlug(p.slug)}
                      >
                        <InlineCode className="text-primary group-hover:underline">{p.slug}</InlineCode>
                        <span className="font-medium">{p.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <InlineCode>{p.dokployApplicationId}</InlineCode>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{p.ownerName}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground lg:table-cell">
                      {p.members.length > 0 ? p.members.map((m) => m.name).join('、') : '—'}
                    </TableCell>
                    <TableCell>
                      {p.canDeploy ? <Badge variant="success">是</Badge> : <Badge variant="outline">否</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {creating && (
        <CreateProjectDialog pending={create.isPending} onClose={() => setCreating(false)} onSubmit={(v) => create.mutate(v)} />
      )}

      {editingProject && (
        <EditProjectDialog
          project={editingProject}
          pending={update.isPending}
          onClose={() => setEditingSlug(null)}
          onSubmit={(v) => update.mutate({ slug: editingProject.slug, body: v })}
        />
      )}

      {viewing && (
        <Dialog open onOpenChange={(open) => !open && setViewingSlug(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                项目 <InlineCode>{viewing.slug}</InlineCode> {viewing.name}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-5">
              {canManage(viewing) && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditingSlug(viewing.slug)}>
                    <Pencil />
                    编辑配置
                  </Button>
                  <Confirm
                    title={`删除项目 ${viewing.slug}？`}
                    description="将删除平台上的项目配置与部署记录，不影响 Dokploy 上的应用本身。"
                    confirmText="删除"
                    onConfirm={() => remove.mutate(viewing.slug)}
                  >
                    <Button variant="outline-destructive" size="sm">
                      <Trash2 />
                      删除项目
                    </Button>
                  </Confirm>
                </div>
              )}
              {canManage(viewing) && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">成员管理</h3>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {viewing.members.map((m) => (
                      <Badge key={m.userId} variant="secondary" className="gap-1 pr-1">
                        {m.name}
                        <button
                          type="button"
                          aria-label={`移除 ${m.name}`}
                          className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 cursor-pointer"
                          onClick={() => removeMember.mutate({ slug: viewing.slug, userId: m.userId })}
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
                              .filter((u) => u.id !== viewing.ownerId && !viewing.members.some((m) => m.userId === u.id))
                              .map((u) => ({ value: u.id, label: u.name, hint: u.email })),
                          },
                        ]}
                        value={null}
                        onChange={(userId) => addMember.mutate({ slug: viewing.slug, userId })}
                        placeholder="添加成员…"
                        searchPlaceholder="搜索姓名或邮箱…"
                        className="h-7 text-xs"
                      />
                    </div>
                  </div>
                </div>
              )}
              <div>
                <h3 className="mb-2 text-sm font-semibold">部署历史</h3>
                {deployments.isLoading ? (
                  <TableSkeleton rows={2} />
                ) : (deployments.data ?? []).length === 0 ? (
                  <Empty text="暂无部署。项目目录运行 eat deploy 发起。" className="py-6" />
                ) : (
                  <Table className="min-w-[560px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-36">时间</TableHead>
                        <TableHead className="w-20">状态</TableHead>
                        <TableHead className="w-24">触发人</TableHead>
                        <TableHead>检查</TableHead>
                        <TableHead>备注</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(deployments.data ?? []).map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="text-muted-foreground">{formatDateTime(d.createdAt)}</TableCell>
                          <TableCell>{STATUS_BADGE[d.status]}</TableCell>
                          <TableCell className="text-muted-foreground">{d.triggeredByName}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {d.report ? `扫描 ${d.report.scannedFiles} 文件 / ${d.report.findings.length} 问题` : '—'}
                          </TableCell>
                          <TableCell className="max-w-48 truncate text-muted-foreground" title={d.error ?? undefined}>
                            {d.error ?? '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function EditProjectDialog({
  project,
  pending,
  onClose,
  onSubmit,
}: {
  project: ProjectInfo;
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: UpdateProjectRequest) => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<{
    name: string;
    dokployApplicationId: string;
    repoUrl: string;
    description: string;
  }>({
    defaultValues: {
      name: project.name,
      dokployApplicationId: project.dokployApplicationId,
      repoUrl: project.repoUrl,
      description: project.description,
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑项目 {project.slug}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="名称" htmlFor="proj-edit-name" required error={errors.name?.message}>
            <Input id="proj-edit-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field
            label="Dokploy Application ID"
            htmlFor="proj-edit-app"
            required
            error={errors.dokployApplicationId?.message}
            hint="在 Dokploy 控制台的应用详情里查看"
          >
            <Input
              id="proj-edit-app"
              className="font-mono"
              aria-invalid={!!errors.dokployApplicationId}
              {...register('dokployApplicationId', { required: '请输入 Application ID' })}
            />
          </Field>
          <Field label="仓库地址" htmlFor="proj-edit-repo" hint="可选">
            <Input id="proj-edit-repo" placeholder="https://git.example.com/crm" {...register('repoUrl')} />
          </Field>
          <Field label="说明" htmlFor="proj-edit-desc">
            <Textarea id="proj-edit-desc" rows={2} {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            保存
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateProjectDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: CreateProjectRequest) => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CreateProjectRequest>({
    defaultValues: { slug: '', name: '', dokployApplicationId: '', repoUrl: '', description: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建项目</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标识（slug）" htmlFor="proj-slug" required error={errors.slug?.message}>
              <Input
                id="proj-slug"
                placeholder="crm-tool"
                className="font-mono"
                aria-invalid={!!errors.slug}
                {...register('slug', { required: '请输入标识', pattern: rules.slug })}
              />
            </Field>
            <Field label="名称" htmlFor="proj-name" required error={errors.name?.message}>
              <Input id="proj-name" placeholder="CRM 小工具" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
            </Field>
          </div>
          <Field
            label="Dokploy Application ID"
            htmlFor="proj-app"
            required
            error={errors.dokployApplicationId?.message}
            hint="在 Dokploy 控制台的应用详情里查看"
          >
            <Input
              id="proj-app"
              className="font-mono"
              aria-invalid={!!errors.dokployApplicationId}
              {...register('dokployApplicationId', { required: '请输入 Application ID' })}
            />
          </Field>
          <Field label="仓库地址" htmlFor="proj-repo" hint="可选">
            <Input id="proj-repo" placeholder="https://git.example.com/crm" {...register('repoUrl')} />
          </Field>
          <Field label="说明" htmlFor="proj-desc">
            <Textarea id="proj-desc" rows={2} {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
