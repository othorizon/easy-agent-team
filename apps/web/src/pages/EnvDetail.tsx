import type {
  EnvironmentInfo,
  GrantInfo,
  PullValuesResponse,
  UpdateEnvironmentRequest,
  UpsertVariableRequest,
  UserPublic,
  VariableMeta,
} from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Database, Eye, EyeOff, Loader2, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
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
import { cn, formatDateTime } from '../lib/utils';
import { DB_STATUS_BADGE } from './db-shared';

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
  // 敏感值点眼睛后的明文，按 key 记；离开页面即忘
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const envQuery = useQuery({
    queryKey: ['env', slug],
    queryFn: () => api<EnvironmentInfo>('GET', `/api/envs/${slug}`),
  });
  const env = envQuery.data;
  // 管理权与服务端 canManage 同口径：Owner 或管理员
  const canManage = !!me && !!env && (me.role === 'admin' || env.ownerId === me.id);

  const variables = useQuery({
    queryKey: ['vars', slug],
    queryFn: () => api<VariableMeta[]>('GET', `/api/envs/${slug}/variables`),
  });
  const grants = useQuery({
    queryKey: ['grants', slug],
    queryFn: () => api<GrantInfo[]>('GET', `/api/envs/${slug}/grants`),
    enabled: canManage,
    retry: false,
  });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserRow[]>('GET', '/api/users'),
    enabled: canManage,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vars', slug] });
    void queryClient.invalidateQueries({ queryKey: ['grants', slug] });
    void queryClient.invalidateQueries({ queryKey: ['env', slug] });
    void queryClient.invalidateQueries({ queryKey: ['envs'] });
  };

  const upsert = useMutation({
    mutationFn: (v: UpsertVariableRequest) => api('POST', `/api/envs/${slug}/variables`, v),
    onSuccess: (_data, v) => {
      toast.success('已保存');
      setEditing(null);
      // 值可能换了，已展开的明文作废
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[v.key];
        return next;
      });
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

  /** 敏感值走正式的拉取通道（服务端落 secret.read 审计），不另开后门 */
  const reveal = useMutation({
    mutationFn: (key: string) => api<PullValuesResponse>('POST', `/api/envs/${slug}/values`, { keys: [key] }),
    onSuccess: (res, key) => {
      const value = res.values[key];
      if (value === undefined) {
        toast.error(res.denied[0]?.message ?? '无法读取该值');
        return;
      }
      setRevealed((prev) => ({ ...prev, [key]: value }));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '读取失败'),
  });

  const createGrant = useMutation({
    mutationFn: (v: { userId: string; variableId?: string; expiresAt?: string }) =>
      api('POST', `/api/envs/${slug}/grants`, {
        userId: v.userId,
        variableId: v.variableId || undefined,
        ...(v.variableId ? {} : { environmentId: env?.id }),
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
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '更新失败'),
  });

  const removeEnv = useMutation({
    mutationFn: () => api('DELETE', `/api/envs/${slug}`),
    onSuccess: () => {
      toast.success('环境已删除');
      void queryClient.invalidateQueries({ queryKey: ['envs'] });
      navigate(env?.source === 'db_assignment' ? '/?tab=database' : '/');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const isDbEnv = env?.source === 'db_assignment';

  return (
    <div className="space-y-5">
      <div>
        <Link
          to={isDbEnv ? '/?tab=database' : '/'}
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
              {isDbEnv && (
                <Badge variant="secondary">
                  <Database />
                  数据库凭证
                </Badge>
              )}
            </span>
          }
          description={
            env && (env.description || isDbEnv) ? (
              <>
                {env.description}
                {isDbEnv && <DbSourceLine env={env} />}
              </>
            ) : undefined
          }
          actions={
            canManage && (
              <>
                <Button variant="outline" onClick={() => setEditingEnv(true)}>
                  <Pencil />
                  编辑环境
                </Button>
                <Confirm
                  title={`删除环境 ${slug}？`}
                  description={
                    isDbEnv
                      ? '这是数据库分配生成的凭证环境：删除后密码无法找回，分配记录会失去凭证。如果是想回收这个库，请到「数据库」页删除分配记录。'
                      : '将同时删除环境下的全部变量与授权，此操作不可恢复。'
                  }
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
                  <TableHead className="w-44">值</TableHead>
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
                      <ValueCell
                        row={row}
                        revealed={revealed[row.key]}
                        canReveal={canManage && row.hasAccess}
                        revealing={reveal.isPending && reveal.variables === row.key}
                        onReveal={() => reveal.mutate(row.key)}
                        onHide={() =>
                          setRevealed((prev) => {
                            const next = { ...prev };
                            delete next[row.key];
                            return next;
                          })
                        }
                      />
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

      {env && <OwnerCard env={env} me={me} canManage={canManage} />}

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

/** 页头下的来源行：这组凭证是哪个库的、在哪台实例、分配现在什么状态，点过去就是分配详情（决策 39） */
function DbSourceLine({ env }: { env: EnvironmentInfo }) {
  const link = env.dbAssignment;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <Database className="size-3.5 shrink-0" aria-hidden />
      {link ? (
        <>
          <span>
            数据库分配自动生成 · 库 <InlineCode>{link.dbName}</InlineCode> · {link.instanceName}
          </span>
          {DB_STATUS_BADGE[link.status]}
          <Link to={`/db/${link.id}`} className="inline-flex items-center gap-0.5 text-primary underline-offset-3 hover:underline">
            查看分配
            <ArrowRight className="size-3" />
          </Link>
        </>
      ) : (
        <span>数据库分配自动生成，关联的分配记录已不存在</span>
      )}
    </span>
  );
}

/**
 * 值列：非敏感直接明文；敏感打码，有管理权者点眼睛临时查看——走的是正式拉取接口，
 * 服务端照常记 secret.read，和在终端里 eat env pull 一样受审计。
 */
function ValueCell({
  row,
  revealed,
  canReveal,
  revealing,
  onReveal,
  onHide,
}: {
  row: VariableMeta;
  revealed: string | undefined;
  canReveal: boolean;
  revealing: boolean;
  onReveal: () => void;
  onHide: () => void;
}) {
  const shown = row.value ?? revealed;
  if (shown != null) {
    return (
      <span className="inline-flex max-w-44 items-center gap-1">
        <InlineCode className="truncate" title={shown}>
          {shown}
        </InlineCode>
        <CopyButton text={shown} />
        {row.value == null && (
          <IconButton label="隐藏值" onClick={onHide}>
            <EyeOff className="size-3.5" />
          </IconButton>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-xs tracking-widest text-muted-foreground">••••••</span>
      {canReveal && (
        <IconButton label="查看值（读取会记入审计）" onClick={onReveal} disabled={revealing}>
          {revealing ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />}
        </IconButton>
      )}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/**
 * Owner 卡片：谁对这个环境负责、能做什么，摆在授权名单前面——授权名单是「谁被允许读」，
 * 而 Owner 的权限不来自授权、不在名单里，不说清楚的话名单看起来像是漏了自己。
 */
function OwnerCard({ env, me, canManage }: { env: EnvironmentInfo; me: UserPublic | null; canManage: boolean }) {
  const isOwner = me?.id === env.ownerId;
  const isAdmin = me?.role === 'admin';
  const abilities = ['读取全部变量的值，含敏感值', '新增、更新、删除变量', '授予或撤销其他成员的读取权限'];
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full text-base font-semibold',
                isOwner ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary',
              )}
            >
              {env.ownerName.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[15px] leading-tight font-semibold">
                <span className="truncate">{env.ownerName}</span>
                {isOwner && <Badge>我</Badge>}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{env.ownerEmail}</div>
            </div>
          </div>
          <Badge variant="secondary" className="gap-1.5 px-2.5 py-1 text-xs">
            <ShieldCheck className="size-3.5" />
            环境 Owner
          </Badge>
        </div>
        <div className="space-y-2.5 text-sm">
          <p className="leading-relaxed text-foreground/80">
            Owner 对整个环境拥有完整的读写权限，不需要出现在下面的授权名单里；平台管理员拥有同样的权限。
          </p>
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-muted-foreground">
            {abilities.map((a) => (
              <li key={a} className="inline-flex items-center gap-1.5">
                <Check className="size-3.5 text-success" aria-hidden />
                {a}
              </li>
            ))}
          </ul>
          {env.source === 'db_assignment' && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              这个环境随数据库分配自动生成，申请人即 Owner；想让同事一起用这个库，把整个环境授权给对方即可。
            </p>
          )}
          {!canManage && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              需要读取这里的变量？在清单里对目标变量发起权限申请，由 Owner 或管理员审批。
            </p>
          )}
          {isAdmin && !isOwner && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">你以管理员身份查看，权限与 Owner 相同。</p>
          )}
        </div>
      </CardContent>
    </Card>
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
  // 更新时值留空 = 保持当前值（只改备注 / 可见性 / 敏感标记，版本不动）；非敏感变量带出的旧值没改也当没改
  const submit = (v: VariableFormValues) => {
    const unchanged = !isNew && (v.value === '' || v.value === editing.value);
    onSubmit({
      key: v.key,
      description: v.description,
      visibleWithoutPermission: v.visibleWithoutPermission,
      secret: v.secret,
      ...(unchanged ? {} : { value: v.value }),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? '新增变量' : `更新 ${editing.key}`}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(submit)}>
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
            required={isNew}
            error={errors.value?.message}
            hint={
              isNew
                ? secret
                  ? '值会加密存储，读取受审计'
                  : '非敏感配置（如服务地址、端口），明文存储'
                : secret
                  ? '留空则保持当前值不变；填写新值会使旧值失效并递增版本'
                  : '留空或不改则保持当前值不变；改了才递增版本'
            }
          >
            <Input
              id="var-value"
              type={secret ? 'password' : 'text'}
              autoComplete={secret ? 'new-password' : 'off'}
              placeholder={isNew ? undefined : '不填则保持当前值'}
              className={secret ? undefined : 'font-mono'}
              aria-invalid={!!errors.value}
              {...register('value', { required: isNew ? '请输入值' : false })}
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
