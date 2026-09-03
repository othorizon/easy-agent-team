import type { PushSkillRequest, SkillInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

export function SkillsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<SkillInfo[]>('GET', '/api/skills') });

  const toggleSubscribe = useMutation({
    mutationFn: (s: SkillInfo) => api(s.subscribed ? 'DELETE' : 'POST', `/api/skills/${s.slug}/subscribe`),
    onSuccess: (_data, s) => {
      toast.success(s.subscribed ? '已退订' : '已订阅，本地运行 eat sync 即可落地');
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const create = useMutation({
    mutationFn: (v: PushSkillRequest) => api('POST', '/api/skills/push', v),
    onSuccess: () => {
      // 创建不代表订阅（决策 34）：不提一句的话，作者会以为 eat sync 就该带上它
      toast.success('Skill 已创建；想让它随 eat sync 落到本地，记得订阅一下');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Skill"
        description={
          <>
            订阅后在本地运行 <InlineCode>eat sync</InlineCode> 即落地到 <InlineCode>~/.claude/skills</InlineCode>
            ；本地已有的 skill 目录可用 <InlineCode>eat skill push &lt;目录&gt;</InlineCode> 上传纳管，
            <InlineCode>eat skill export &lt;slug&gt;</InlineCode> 把这里的 skill 下载到本地目录。
          </>
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            创建 Skill
          </Button>
        }
      />
      <Card>
        <CardContent>
          {skills.isLoading ? (
            <TableSkeleton />
          ) : (skills.data ?? []).length === 0 ? (
            <Empty text="还没有 Skill" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead className="hidden md:table-cell">触发描述</TableHead>
                  <TableHead className="hidden w-24 lg:table-cell">作者</TableHead>
                  <TableHead className="hidden w-16 sm:table-cell">版本</TableHead>
                  <TableHead className="hidden w-20 sm:table-cell">可见性</TableHead>
                  <TableHead className="w-20">订阅</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(skills.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link to={`/skills/${s.slug}`} className="group inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <InlineCode className="text-primary group-hover:underline">{s.slug}</InlineCode>
                        <span className="font-medium">{s.name}</span>
                      </Link>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{s.description}</div>
                    </TableCell>
                    <TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">
                      {s.description}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{s.ownerName}</TableCell>
                    <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                      v{s.currentVersion}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {s.visibility === 'private' ? <Badge variant="outline">私有</Badge> : <Badge>团队</Badge>}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant={s.subscribed ? 'outline' : 'default'}
                        loading={toggleSubscribe.isPending && toggleSubscribe.variables?.id === s.id}
                        onClick={() => toggleSubscribe.mutate(s)}
                      >
                        {s.subscribed ? '退订' : '订阅'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {creating && (
        <CreateSkillDialog
          pending={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(v) => create.mutate(v)}
        />
      )}
    </div>
  );
}

interface CreateFormValues {
  slug: string;
  name: string;
  description: string;
  content: string;
  private: boolean;
}

function CreateSkillDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: PushSkillRequest) => void;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateFormValues>({
    defaultValues: { slug: '', name: '', description: '', content: '', private: false },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>创建 Skill</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) =>
            onSubmit({
              slug: v.slug,
              name: v.name,
              description: v.description,
              content: v.content,
              files: [],
              changelog: '',
              visibility: v.private ? 'private' : 'team',
            }),
          )}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标识（slug）" htmlFor="skill-slug" required error={errors.slug?.message} hint="将作为本地目录名">
              <Input
                id="skill-slug"
                placeholder="weekly-report"
                className="font-mono"
                aria-invalid={!!errors.slug}
                {...register('slug', { required: '请输入标识', pattern: rules.slug })}
              />
            </Field>
            <Field label="名称" htmlFor="skill-name" required error={errors.name?.message}>
              <Input id="skill-name" placeholder="运营周报生成" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
            </Field>
          </div>
          <Field label="触发描述" htmlFor="skill-desc" hint="AI 靠它判断何时使用这个 skill">
            <Textarea id="skill-desc" rows={2} placeholder="根据运营数据生成周报，适用于每周一汇报" {...register('description')} />
          </Field>
          <Field label="SKILL.md 正文" htmlFor="skill-content" required error={errors.content?.message}>
            <Textarea
              id="skill-content"
              rows={10}
              className="font-mono text-[13px]"
              placeholder={'# 周报生成\n\n步骤……'}
              aria-invalid={!!errors.content}
              {...register('content', { required: '请输入正文' })}
            />
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
          <Button type="submit" loading={pending} className="w-full">
            创建（v1）
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
