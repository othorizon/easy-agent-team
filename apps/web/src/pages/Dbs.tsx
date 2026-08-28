import type { CreateDbInstanceRequest, DbAssignmentInfo, DbInstanceInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

const STATUS_BADGE: Record<string, JSX.Element> = {
  pending: <Badge variant="warning">待批准</Badge>,
  active: <Badge variant="success">可用</Badge>,
  failed: <Badge variant="destructive">执行失败</Badge>,
  rejected: <Badge variant="outline">已驳回</Badge>,
  disabled: <Badge variant="destructive">已禁用</Badge>,
  deleted: <Badge variant="outline">已删除</Badge>,
};

export function DbsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const [addingInstance, setAddingInstance] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const instances = useQuery({ queryKey: ['db-instances'], queryFn: () => api<DbInstanceInfo[]>('GET', '/api/db/instances') });
  const mine = useQuery({ queryKey: ['db-mine'], queryFn: () => api<DbAssignmentInfo[]>('GET', '/api/db/assignments/mine') });
  const all = useQuery({
    queryKey: ['db-all'],
    queryFn: () => api<DbAssignmentInfo[]>('GET', '/api/db/assignments'),
    enabled: isAdmin,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['db-instances'] });
    void queryClient.invalidateQueries({ queryKey: ['db-mine'] });
    void queryClient.invalidateQueries({ queryKey: ['db-all'] });
  };

  const addInstance = useMutation({
    mutationFn: (v: CreateDbInstanceRequest) => api('POST', '/api/db/instances', v),
    onSuccess: () => {
      toast.success('实例已登记');
      setAddingInstance(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '登记失败'),
  });

  const request = useMutation({
    mutationFn: (v: { instanceId: string; dbName: string; purpose: string }) => api('POST', '/api/db/assignments', v),
    onSuccess: () => {
      toast.success('申请已提交，等待管理员批准');
      setRequesting(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '申请失败'),
  });

  const act = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject' | 'disable' | 'enable' | 'delete' }) =>
      v.action === 'delete'
        ? api('DELETE', `/api/db/assignments/${v.id}`)
        : api('POST', `/api/db/assignments/${v.id}/${v.action}`, {}),
    onSuccess: (res: unknown) => {
      const r = res as DbAssignmentInfo;
      if (r.status === 'failed') toast.error(`执行失败：${r.error}`);
      else toast.success('已处理');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const removeInstance = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/db/instances/${id}`),
    onSuccess: () => {
      toast.success('实例已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  function AssignmentTable({ rows, admin, loading, emptyText }: { rows: DbAssignmentInfo[]; admin: boolean; loading: boolean; emptyText: React.ReactNode }) {
    if (loading) return <TableSkeleton rows={2} />;
    if (rows.length === 0) return <Empty text={emptyText} className="py-6" />;
    return (
      <Table className={admin ? 'min-w-[720px]' : 'min-w-[560px]'}>
        <TableHeader>
          <TableRow>
            <TableHead>库</TableHead>
            <TableHead className="w-32">实例</TableHead>
            {admin && <TableHead className="w-24">申请人</TableHead>}
            <TableHead>用途</TableHead>
            <TableHead className="w-22">状态</TableHead>
            <TableHead className="w-40">凭证</TableHead>
            {admin && <TableHead className="w-52">操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <InlineCode>{r.dbName}</InlineCode>
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">{r.instanceName}</TableCell>
              {admin && <TableCell className="text-muted-foreground whitespace-nowrap">{r.requesterName}</TableCell>}
              <TableCell className="max-w-48 truncate text-muted-foreground" title={r.purpose}>
                {r.purpose}
              </TableCell>
              <TableCell>{STATUS_BADGE[r.status]}</TableCell>
              <TableCell>
                {r.environmentSlug ? (
                  <Link to={`/envs/${r.environmentSlug}`}>
                    <InlineCode className="text-primary hover:underline">{r.environmentSlug}</InlineCode>
                  </Link>
                ) : r.error ? (
                  <span className="block max-w-40 truncate text-destructive" title={r.error}>
                    {r.error}
                  </span>
                ) : (
                  '—'
                )}
              </TableCell>
              {admin && (
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.status === 'pending' && (
                      <>
                        <Button size="sm" onClick={() => act.mutate({ id: r.id, action: 'approve' })} loading={act.isPending}>
                          批准并建库
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => act.mutate({ id: r.id, action: 'reject' })}>
                          驳回
                        </Button>
                      </>
                    )}
                    {r.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => act.mutate({ id: r.id, action: 'disable' })}>
                        禁用
                      </Button>
                    )}
                    {r.status === 'disabled' && (
                      <Button size="sm" variant="outline" onClick={() => act.mutate({ id: r.id, action: 'enable' })}>
                        恢复
                      </Button>
                    )}
                    {['active', 'disabled', 'failed', 'rejected'].includes(r.status) && (
                      <Confirm
                        title="删除分配记录？"
                        description={
                          <>
                            仅删除平台上的记录与凭证环境，<b>不会</b>删除实例上的数据库与账号；如需彻底清理，只能到数据库实例上手动删除。
                          </>
                        }
                        confirmText="删除"
                        onConfirm={() => act.mutate({ id: r.id, action: 'delete' })}
                      >
                        <Button size="sm" variant="outline-destructive">
                          删除
                        </Button>
                      </Confirm>
                    )}
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="数据库"
        description="团队共享的数据库实例（面向日常项目，非生产核心）。成员申请后由管理员批准，平台自动建库建号，凭证以环境变量形式下发。"
        actions={
          <>
            {isAdmin && (
              <Button variant="outline" onClick={() => setAddingInstance(true)}>
                <Plus />
                登记实例
              </Button>
            )}
            <Button onClick={() => setRequesting(true)}>
              <Plus />
              申请数据库
            </Button>
          </>
        }
      />

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">数据库实例</h2>
          {instances.isLoading ? (
            <TableSkeleton rows={2} />
          ) : (instances.data ?? []).length === 0 ? (
            <Empty text="暂无实例（由管理员登记）" className="py-6" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-24">类型</TableHead>
                  <TableHead className="hidden md:table-cell">地址</TableHead>
                  <TableHead className="w-18 text-right">已分配</TableHead>
                  <TableHead className="hidden lg:table-cell">备注</TableHead>
                  {isAdmin && <TableHead className="w-20">操作</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(instances.data ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {r.name}
                      <div className="mt-0.5 text-xs text-muted-foreground md:hidden">
                        {r.host}:{r.port}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{r.engine}</Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <InlineCode>
                        {r.host}:{r.port}
                      </InlineCode>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.assignmentCount}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground lg:table-cell">{r.note}</TableCell>
                    {isAdmin && (
                      <TableCell>
                        <Confirm
                          title="删除实例登记？"
                          description="不影响实例本身，仅移除平台上的登记。"
                          confirmText="删除"
                          onConfirm={() => removeInstance.mutate(r.id)}
                        >
                          <Button size="sm" variant="outline-destructive">
                            删除
                          </Button>
                        </Confirm>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">我的数据库</h2>
          <AssignmentTable
            rows={mine.data ?? []}
            admin={false}
            loading={mine.isLoading}
            emptyText="暂无。点击「申请数据库」，批准后凭证会出现在你的环境列表里。"
          />
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardContent>
            <h2 className="mb-3 text-sm font-semibold">全部分配（管理员）</h2>
            <AssignmentTable rows={all.data ?? []} admin loading={all.isLoading} emptyText="暂无分配" />
          </CardContent>
        </Card>
      )}

      {addingInstance && (
        <AddInstanceDialog
          pending={addInstance.isPending}
          onClose={() => setAddingInstance(false)}
          onSubmit={(v) => addInstance.mutate(v)}
        />
      )}
      {requesting && (
        <RequestDbDialog
          instances={instances.data ?? []}
          pending={request.isPending}
          onClose={() => setRequesting(false)}
          onSubmit={(v) => request.mutate(v)}
        />
      )}
    </div>
  );
}

function AddInstanceDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: CreateDbInstanceRequest) => void;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateDbInstanceRequest>({
    defaultValues: { name: '', engine: 'postgres', host: '', port: 5432, adminUser: '', adminPassword: '', note: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>登记数据库实例</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) => onSubmit({ ...v, port: Number(v.port) }))}
        >
          <Field label="名称" htmlFor="ins-name" required error={errors.name?.message}>
            <Input id="ins-name" placeholder="团队测试 PG" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field label="类型">
            <Controller
              control={control}
              name="engine"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: 'PostgreSQL', value: 'postgres' },
                    { label: 'MySQL（暂不支持自动建库）', value: 'mysql' },
                  ]}
                />
              )}
            />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="主机" htmlFor="ins-host" required error={errors.host?.message} className="col-span-2">
              <Input id="ins-host" placeholder="db.internal.example.com" aria-invalid={!!errors.host} {...register('host', { required: '请输入主机' })} />
            </Field>
            <Field label="端口" htmlFor="ins-port" required error={errors.port?.message}>
              <Input
                id="ins-port"
                type="number"
                min={1}
                max={65535}
                aria-invalid={!!errors.port}
                {...register('port', { required: '请输入端口', valueAsNumber: true })}
              />
            </Field>
          </div>
          <Field label="管理账号" htmlFor="ins-user" required error={errors.adminUser?.message}>
            <Input id="ins-user" placeholder="postgres" aria-invalid={!!errors.adminUser} {...register('adminUser', { required: '请输入管理账号' })} />
          </Field>
          <Field label="管理密码" htmlFor="ins-pass" hint="加密存储">
            <Input id="ins-pass" type="password" autoComplete="new-password" {...register('adminPassword')} />
          </Field>
          <Field label="备注" htmlFor="ins-note">
            <Input id="ins-note" placeholder="用途说明" {...register('note')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            登记
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RequestDbDialog({
  instances,
  pending,
  onClose,
  onSubmit,
}: {
  instances: DbInstanceInfo[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: { instanceId: string; dbName: string; purpose: string }) => void;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<{
    instanceId: string;
    dbName: string;
    purpose: string;
  }>({ defaultValues: { instanceId: '', dbName: '', purpose: '' } });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>申请数据库</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="实例" required error={errors.instanceId?.message}>
            <Controller
              control={control}
              name="instanceId"
              rules={{ required: '请选择实例' }}
              render={({ field }) => (
                <Select value={field.value || undefined} onValueChange={field.onChange}>
                  <SelectTrigger aria-invalid={!!errors.instanceId}>
                    <SelectValue placeholder="选择实例…" />
                  </SelectTrigger>
                  <SelectContent>
                    {instances.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name}（{i.engine} {i.host}:{i.port}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field
            label="库名"
            htmlFor="req-dbname"
            required
            error={errors.dbName?.message}
            hint="也用于生成账号名与凭证环境名"
          >
            <Input
              id="req-dbname"
              placeholder="proj_crm"
              className="font-mono"
              aria-invalid={!!errors.dbName}
              {...register('dbName', { required: '请输入库名', pattern: rules.dbName })}
            />
          </Field>
          <Field label="用途" htmlFor="req-purpose" required error={errors.purpose?.message} hint="给管理员看">
            <Textarea
              id="req-purpose"
              rows={2}
              placeholder="CRM 小工具的数据存储"
              aria-invalid={!!errors.purpose}
              {...register('purpose', { required: '请说明用途' })}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            提交申请
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
