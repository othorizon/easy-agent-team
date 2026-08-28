import type { CreateEnvironmentRequest, EnvironmentInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

export function EnvsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const envs = useQuery({
    queryKey: ['envs'],
    queryFn: () => api<EnvironmentInfo[]>('GET', '/api/envs'),
  });

  const create = useMutation({
    mutationFn: (values: CreateEnvironmentRequest) => api('POST', '/api/envs', values),
    onSuccess: () => {
      toast.success('环境已创建');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['envs'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="环境变量"
        description="环境是变量的分组（如「内部服务」「测试数据库」）。变量默认对全员可见 key 与备注，值需要授权才能读取。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            新建环境
          </Button>
        }
      />
      <Card>
        <CardContent>
          {envs.isLoading ? (
            <TableSkeleton />
          ) : (envs.data ?? []).length === 0 ? (
            <Empty text="还没有环境。新建一个开始集中管理团队的密钥与配置。" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>环境</TableHead>
                  <TableHead className="hidden md:table-cell">备注</TableHead>
                  <TableHead className="hidden sm:table-cell w-28">Owner</TableHead>
                  <TableHead className="w-20 text-right">变量数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(envs.data ?? []).map((env) => (
                  <TableRow key={env.id}>
                    <TableCell>
                      <Link to={`/envs/${env.slug}`} className="group inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <InlineCode className="text-primary group-hover:underline">{env.slug}</InlineCode>
                        <span className="font-medium">{env.name}</span>
                      </Link>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{env.description}</div>
                    </TableCell>
                    <TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">
                      {env.description}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{env.ownerName}</TableCell>
                    <TableCell className="text-right tabular-nums">{env.variableCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {creating && (
        <CreateEnvDialog
          pending={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(v) => create.mutate(v)}
        />
      )}
    </div>
  );
}

function CreateEnvDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: CreateEnvironmentRequest) => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CreateEnvironmentRequest>({
    defaultValues: { slug: '', name: '', description: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建环境</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="标识（slug）" htmlFor="env-slug" required error={errors.slug?.message}>
            <Input
              id="env-slug"
              placeholder="internal-services"
              className="font-mono"
              aria-invalid={!!errors.slug}
              {...register('slug', { required: '请输入标识', pattern: rules.slug })}
            />
          </Field>
          <Field label="名称" htmlFor="env-name" required error={errors.name?.message}>
            <Input id="env-name" placeholder="内部服务" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field label="备注" htmlFor="env-desc" hint="供人和 AI 理解这个环境的用途">
            <Textarea id="env-desc" rows={2} placeholder="公司内部服务相关的密钥与配置" {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
