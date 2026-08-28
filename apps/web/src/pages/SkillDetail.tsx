import type { SkillDetail, SkillVersionInfo, UpdateSkillRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { CodeBlock, InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageLoading } from '../components/page-loading';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime } from '../lib/utils';

export function SkillDetailPage() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = getStoredUser();
  const [editing, setEditing] = useState(false);

  const skill = useQuery({
    queryKey: ['skill', slug],
    queryFn: () => api<SkillDetail>('GET', `/api/skills/${slug}`),
  });
  const versions = useQuery({
    queryKey: ['skill-versions', slug],
    queryFn: () => api<SkillVersionInfo[]>('GET', `/api/skills/${slug}/versions`),
  });

  const canManage = skill.data && me && (skill.data.ownerId === me.id || me.role === 'admin');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['skill', slug] });
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
  };

  const update = useMutation({
    mutationFn: (v: UpdateSkillRequest) => api('PATCH', `/api/skills/${slug}`, v),
    onSuccess: () => {
      toast.success('已保存');
      setEditing(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const toggleSubscribe = useMutation({
    mutationFn: () => api(skill.data?.subscribed ? 'DELETE' : 'POST', `/api/skills/${slug}/subscribe`),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/skills/${slug}`),
    onSuccess: () => {
      toast.success('已删除');
      navigate('/skills');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  if (!skill.data) return <PageLoading />;
  const s = skill.data;

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/skills"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Skill
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              <InlineCode className="text-lg">{s.slug}</InlineCode>
              {s.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {s.visibility === 'private' ? <Badge variant="outline">私有</Badge> : <Badge>团队可见</Badge>}
              {s.allowHelp && <Badge variant="warning">允许求助</Badge>}
              {s.source === 'experience' && <Badge variant="secondary">经验沉淀</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={s.subscribed ? 'outline' : 'default'}
              loading={toggleSubscribe.isPending}
              onClick={() => toggleSubscribe.mutate()}
            >
              {s.subscribed ? '退订' : '订阅'}
            </Button>
            {canManage && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                编辑元信息
              </Button>
            )}
            {canManage && (
              <Confirm
                title="确认删除该 Skill？"
                description="删除后订阅者本地的副本会在下次 sync 时移除。"
                confirmText="删除"
                onConfirm={() => remove.mutate()}
              >
                <Button variant="outline-destructive" loading={remove.isPending}>
                  删除
                </Button>
              </Confirm>
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">作者</dt>
              <dd>{s.ownerName}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">当前版本</dt>
              <dd className="tabular-nums">v{s.currentVersion}</dd>
            </div>
            <div className="flex gap-3 sm:col-span-2">
              <dt className="w-20 shrink-0 text-muted-foreground">触发描述</dt>
              <dd className="leading-relaxed">{s.description || '（未填写）'}</dd>
            </div>
            {s.files.length > 0 && (
              <div className="flex gap-3 sm:col-span-2">
                <dt className="w-20 shrink-0 text-muted-foreground">附属文件</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {s.files.map((f) => (
                    <InlineCode key={f.path}>
                      {f.path}
                      {f.executable ? ' ⚙' : ''}
                    </InlineCode>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          <h2 className="mt-5 mb-2 text-sm font-semibold">SKILL.md</h2>
          <CodeBlock>{s.content}</CodeBlock>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">版本历史</h2>
          {versions.isLoading ? (
            <TableSkeleton rows={2} />
          ) : (versions.data ?? []).length === 0 ? (
            <Empty text="暂无版本记录" className="py-6" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">版本</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead className="hidden w-28 sm:table-cell">提交人</TableHead>
                  <TableHead className="hidden w-40 md:table-cell">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(versions.data ?? []).map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="tabular-nums">v{v.version}</TableCell>
                    <TableCell className="text-muted-foreground">{v.changelog || '—'}</TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{v.createdBy}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {formatDateTime(v.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editing && (
        <EditSkillDialog
          skill={s}
          pending={update.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(v) => update.mutate(v)}
        />
      )}
    </div>
  );
}

interface EditFormValues {
  name: string;
  description: string;
  private: boolean;
  allowHelp: boolean;
}

function EditSkillDialog({
  skill,
  pending,
  onClose,
  onSubmit,
}: {
  skill: SkillDetail;
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: UpdateSkillRequest) => void;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<EditFormValues>({
    defaultValues: {
      name: skill.name,
      description: skill.description,
      private: skill.visibility === 'private',
      allowHelp: skill.allowHelp,
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑元信息</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) =>
            onSubmit({
              name: v.name,
              description: v.description,
              visibility: v.private ? 'private' : 'team',
              allowHelp: v.allowHelp,
            }),
          )}
        >
          <Field label="名称" htmlFor="edit-name" required error={errors.name?.message}>
            <Input id="edit-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field label="触发描述" htmlFor="edit-desc">
            <Textarea id="edit-desc" rows={2} {...register('description')} />
          </Field>
          <Field label="可见性">
            <Controller
              control={control}
              name="private"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: '团队可见', value: false },
                    { label: '私有', value: true },
                  ]}
                />
              )}
            />
          </Field>
          <Field label="允许求助" hint="开启后，使用者的 AI 可以就这个 skill 向你发起求助">
            <Controller
              control={control}
              name="allowHelp"
              render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            保存
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
