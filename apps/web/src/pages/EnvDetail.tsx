import type { EnvironmentInfo, GrantInfo, UpdateEnvironmentRequest, UpsertVariableRequest, VariableMeta } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { CopyButton, InlineCode } from '../components/code';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime } from '../lib/utils';

interface UserRow {
  id: string;
  name: string;
  email: string;
}

export function EnvDetailPage() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = getStoredUser();
  const [editing, setEditing] = useState<VariableMeta | 'new' | null>(null);
  const [editingEnv, setEditingEnv] = useState(false);
  const [granting, setGranting] = useState(false);

  const variables = useQuery({
    queryKey: ['vars', slug],
    queryFn: () => api<VariableMeta[]>('GET', `/api/envs/${slug}/variables`),
  });
  // 授权列表仅 Owner/管理员可查；403 时静默隐藏该区块
  const grants = useQuery({
    queryKey: ['grants', slug],
    queryFn: () => api<GrantInfo[]>('GET', `/api/envs/${slug}/grants`),
    retry: false,
  });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserRow[]>('GET', '/api/users'),
  });
  // 环境信息（名称/备注/id）：从环境列表里找
  const envs = useQuery({
    queryKey: ['envs'],
    queryFn: () => api<EnvironmentInfo[]>('GET', '/api/envs'),
  });

  const canManage = !grants.isError;
  const env = envs.data?.find((e) => e.slug === slug);
  const envId = env?.id;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vars', slug] });
    void queryClient.invalidateQueries({ queryKey: ['grants', slug] });
  };

  const upsert = useMutation({
    mutationFn: (v: UpsertVariableRequest) => api('POST', `/api/envs/${slug}/variables`, v),
    onSuccess: () => {
      toast.success('已保存');
      setEditing(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const removeVar = useMutation({
    mutationFn: (key: string) => api('DELETE', `/api/envs/${slug}/variables/${key}`),
    onSuccess: () => {
      toast.success('已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const createGrant = useMutation({
    mutationFn: (v: { userId: string; variableId?: string; expiresAt?: string }) =>
      api('POST', `/api/envs/${slug}/grants`, {
        userId: v.userId,
        variableId: v.variableId || undefined,
        ...(v.variableId ? {} : { environmentId: envId }),
        expiresAt: v.expiresAt,
      }),
    onSuccess: () => {
      toast.success('已授权');
      setGranting(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '授权失败'),
  });

  const revokeGrant = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/grants/${id}`),
    onSuccess: () => {
      toast.success('已撤销');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '撤销失败'),
  });

  const updateEnv = useMutation({
    mutationFn: (v: UpdateEnvironmentRequest) => api('PATCH', `/api/envs/${slug}`, v),
    onSuccess: () => {
      toast.success('环境已更新');
      setEditingEnv(false);
      void queryClient.invalidateQueries({ queryKey: ['envs'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '更新失败'),
  });

  const removeEnv = useMutation({
    mutationFn: () => api('DELETE', `/api/envs/${slug}`),
    onSuccess: () => {
      toast.success('环境已删除');
      void queryClient.invalidateQueries({ queryKey: ['envs'] });
      navigate('/');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          环境变量
        </Link>
        <PageHeader
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              环境 <InlineCode className="text-lg">{slug}</InlineCode>
              {env?.name && <span>{env.name}</span>}
            </span>
          }
          description={env?.description || undefined}
          actions={
            canManage && (
              <>
                <Button variant="outline" onClick={() => setEditingEnv(true)}>
                  <Pencil />
                  编辑环境
                </Button>
                <Confirm
                  title={`删除环境 ${slug}？`}
                  description="将同时删除环境下的全部变量与授权，此操作不可恢复。"
                  confirmText="删除"
                  onConfirm={() => removeEnv.mutate()}
                >
                  <Button variant="outline-destructive">
                    <Trash2 />
                    删除环境
                  </Button>
                </Confirm>
                <Button onClick={() => setEditing('new')}>
                  <Plus />
                  新增变量
                </Button>
              </>
            )
          }
        />
      </div>

      <Card>
        <CardContent>
          {variables.isLoading ? (
            <TableSkeleton />
          ) : (variables.data ?? []).length === 0 ? (
            <Empty text="这个环境还没有变量" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead className="hidden md:table-cell">备注</TableHead>
                  <TableHead className="w-40">值</TableHead>
                  <TableHead className="w-24">权限</TableHead>
                  <TableHead className="hidden w-36 lg:table-cell">对未授权成员</TableHead>
                  <TableHead className="hidden w-16 sm:table-cell">版本</TableHead>
                  {canManage && <TableHead className="w-36">操作</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(variables.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <span className="inline-flex items-center gap-1">
                        <InlineCode>{row.key}</InlineCode>
                        <CopyButton text={row.key} />
                        {!row.secret && <Badge variant="secondary">非敏感</Badge>}
                      </span>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{row.description}</div>
                    </TableCell>
                    <TableCell className="hidden max-w-sm truncate text-muted-foreground md:table-cell">
                      {row.description}
                    </TableCell>
                    <TableCell>
                      {row.value != null ? (
                        <span className="inline-flex max-w-40 items-center gap-1">
                          <InlineCode className="truncate" title={row.value}>
                            {row.value}
                          </InlineCode>
                          <CopyButton text={row.value} />
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">••••••</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.hasAccess ? <Badge variant="success">可读取</Badge> : <Badge variant="outline">无权限</Badge>}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {row.visibleWithoutPermission ? '可见名称与备注' : '完全隐藏'}
                    </TableCell>
                    <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                      v{row.version}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
                            更新
                          </Button>
                          <Confirm
                            title={`删除 ${row.key}？`}
                            description="删除后已授权成员将无法再读取该变量。"
                            confirmText="删除"
                            onConfirm={() => removeVar.mutate(row.key)}
                          >
                            <Button size="sm" variant="outline-destructive">
                              删除
                            </Button>
                          </Confirm>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">读取授权</h2>
              <Button variant="outline" size="sm" onClick={() => setGranting(true)}>
                <Plus />
                新增授权
              </Button>
            </div>
            {grants.isLoading ? (
              <TableSkeleton rows={2} />
            ) : (grants.data ?? []).length === 0 ? (
              <Empty text="暂无授权。成员发起权限申请后也可在「权限申请」页审批。" className="py-6" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>用户</TableHead>
                    <TableHead>范围</TableHead>
                    <TableHead className="hidden sm:table-cell">有效期</TableHead>
                    <TableHead className="w-20">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(grants.data ?? []).map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-medium">{g.userName}</TableCell>
                      <TableCell>
                        {g.variableKey ? <InlineCode>{g.variableKey}</InlineCode> : <Badge>整个环境</Badge>}
                        <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">
                          {g.expiresAt ? `至 ${formatDateTime(g.expiresAt)}` : '永久'}
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {g.expiresAt ? formatDateTime(g.expiresAt) : '永久'}
                      </TableCell>
                      <TableCell>
                        <Confirm title="撤销该授权？" confirmText="撤销" onConfirm={() => revokeGrant.mutate(g.id)}>
                          <Button size="sm" variant="outline-destructive">
                            撤销
                          </Button>
                        </Confirm>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {editing !== null && (
        <VariableDialog
          editing={editing}
          pending={upsert.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(v) => upsert.mutate(v)}
        />
      )}
      {editingEnv && env && (
        <EditEnvDialog
          env={env}
          pending={updateEnv.isPending}
          onClose={() => setEditingEnv(false)}
          onSubmit={(v) => updateEnv.mutate(v)}
        />
      )}
      {granting && (
        <GrantDialog
          users={(users.data ?? []).filter((u) => u.id !== me?.id)}
          variables={variables.data ?? []}
          pending={createGrant.isPending}
          onClose={() => setGranting(false)}
          onSubmit={(v) => createGrant.mutate(v)}
        />
      )}
    </div>
  );
}

function EditEnvDialog({
  env,
  pending,
  onClose,
  onSubmit,
}: {
  env: EnvironmentInfo;
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: UpdateEnvironmentRequest) => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<{ name: string; description: string }>({
    defaultValues: { name: env.name, description: env.description },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑环境 {env.slug}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="名称" htmlFor="env-edit-name" required error={errors.name?.message}>
            <Input id="env-edit-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field label="备注" htmlFor="env-edit-desc" hint="供人和 AI 理解这个环境的用途">
            <Textarea id="env-edit-desc" rows={2} {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            保存
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface VariableFormValues {
  key: string;
  value: string;
  description: string;
  visibleWithoutPermission: boolean;
  secret: boolean;
}

function VariableDialog({
  editing,
  pending,
  onClose,
  onSubmit,
}: {
  editing: VariableMeta | 'new';
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: UpsertVariableRequest) => void;
}) {
  const isNew = editing === 'new';
  const { register, handleSubmit, control, watch, formState: { errors } } = useForm<VariableFormValues>({
    defaultValues: isNew
      ? { key: '', value: '', description: '', visibleWithoutPermission: true, secret: true }
      : {
          key: editing.key,
          // 非敏感变量的当前值本就明文可见，编辑时直接带出
          value: editing.secret ? '' : (editing.value ?? ''),
          description: editing.description,
          visibleWithoutPermission: editing.visibleWithoutPermission,
          secret: editing.secret,
        },
  });
  const secret = watch('secret');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? '新增变量' : `更新 ${editing.key}`}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="Key" htmlFor="var-key" required error={errors.key?.message}>
            <Input
              id="var-key"
              placeholder="INTERNAL_API_TOKEN"
              className="font-mono"
              disabled={!isNew}
              aria-invalid={!!errors.key}
              {...register('key', { required: '请输入 Key', pattern: rules.envKey })}
            />
          </Field>
          <Field
            label="敏感变量"
            hint={secret ? '值加密存储、控制台打码，读取落审计' : '值明文存储，有读取权限的成员在平台可直接明文查看；读值授权要求不变'}
          >
            <Controller
              control={control}
              name="secret"
              render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Field>
          <Field
            label={isNew ? '值' : '新值'}
            htmlFor="var-value"
            required
            error={errors.value?.message}
            hint={
              secret
                ? isNew
                  ? '值会加密存储，读取受审计'
                  : '更新会使旧值失效并递增版本'
                : '非敏感配置（如服务地址、端口），明文存储'
            }
          >
            <Input
              id="var-value"
              type={secret ? 'password' : 'text'}
              autoComplete={secret ? 'new-password' : 'off'}
              className={secret ? undefined : 'font-mono'}
              aria-invalid={!!errors.value}
              {...register('value', { required: '请输入值' })}
            />
          </Field>
          <Field label="备注" htmlFor="var-desc" hint="AI 会读取，请写清楚这个变量的作用">
            <Textarea id="var-desc" rows={2} placeholder="内部网关的调用令牌，用于 xxx 服务" {...register('description')} />
          </Field>
          <Field
            label="未授权成员可见"
            hint="开启：没有读取权限的成员在清单里能看到变量名和备注（看不到值），知道该申请什么；关闭：对他们完全隐藏，连这个变量存在都看不到。"
          >
            <Controller
              control={control}
              name="visibleWithoutPermission"
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

function GrantDialog({
  users,
  variables,
  pending,
  onClose,
  onSubmit,
}: {
  users: UserRow[];
  variables: VariableMeta[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: { userId: string; variableId?: string; expiresAt?: string }) => void;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [variableId, setVariableId] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState('');
  const [userError, setUserError] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增读取授权</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!userId) {
              setUserError(true);
              return;
            }
            onSubmit({
              userId,
              variableId: variableId || undefined,
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
            });
          }}
        >
          <Field label="授权给" required error={userError ? '请选择用户' : undefined}>
            <Combobox
              groups={[{ options: users.map((u) => ({ value: u.id, label: u.name, hint: u.email })) }]}
              value={userId}
              onChange={(v) => {
                setUserId(v);
                setUserError(false);
              }}
              placeholder="选择用户…"
              searchPlaceholder="搜索姓名或邮箱…"
            />
          </Field>
          <Field label="范围" hint="不选则授权整个环境">
            <Select value={variableId || 'ALL'} onValueChange={(v) => setVariableId(v === 'ALL' ? '' : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">整个环境</SelectItem>
                {variables.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="有效期" htmlFor="grant-expire" hint="不填为永久">
            <Input
              id="grant-expire"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            授权
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
