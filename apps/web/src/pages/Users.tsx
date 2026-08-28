import type { RegistrationSettings } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { Confirm } from '../components/confirm';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { TagsInput } from '../components/tags-input';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
}

/** 用户管理（仅管理员）：建号、改角色、禁用/启用、重置密码 */
export function UsersPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [editingRegistration, setEditingRegistration] = useState(false);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('GET', '/api/users') });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['users'] });
  const onError = (err: unknown) => toast.error(err instanceof ApiError ? err.message : '操作失败');

  const create = useMutation({
    mutationFn: (v: { name: string; email: string; password: string; role: 'admin' | 'member' }) =>
      api('POST', '/api/users', v),
    onSuccess: () => {
      toast.success('用户已创建，请把平台地址和初始密码告知对方');
      setCreating(false);
      invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: (v: { id: string; role?: 'admin' | 'member'; status?: 'active' | 'disabled' }) =>
      api('PATCH', `/api/users/${v.id}`, { role: v.role, status: v.status }),
    onSuccess: (_d, v) => {
      toast.success(v.status === 'disabled' ? '已禁用（其全部 Token 已吊销）' : '已更新');
      invalidate();
    },
    onError,
  });

  const resetPassword = useMutation({
    mutationFn: (v: { id: string; password: string }) => api('POST', `/api/users/${v.id}/password`, { password: v.password }),
    onSuccess: () => {
      toast.success('密码已重置（其全部 Token 已吊销，需重新登录）');
      setResetting(null);
    },
    onError,
  });

  const registration = useQuery({
    queryKey: ['registration-settings'],
    queryFn: () => api<RegistrationSettings>('GET', '/api/admin/registration-settings'),
  });
  const saveRegistration = useMutation({
    mutationFn: (v: RegistrationSettings) => api('PUT', '/api/admin/registration-settings', v),
    onSuccess: () => {
      toast.success('注册设置已保存');
      setEditingRegistration(false);
      void queryClient.invalidateQueries({ queryKey: ['registration-settings'] });
    },
    onError,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="用户"
        description="账号由管理员创建后线下告知初始密码，或开放注册让成员自助注册。禁用与重置密码都会立即吊销全部 Token。"
        actions={
          <>
            <Button variant="outline" onClick={() => setEditingRegistration(true)}>
              <UserPlus />
              注册设置
              {registration.data && (
                <span
                  className={`size-1.5 rounded-full ${registration.data.enabled ? 'bg-success' : 'bg-muted-foreground/40'}`}
                  title={registration.data.enabled ? '已开放注册' : '未开放注册'}
                />
              )}
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              新建用户
            </Button>
          </>
        }
      />

      <Card>
        <CardContent>
          <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
            不能修改自己的角色或状态，避免锁死唯一管理员。
          </p>
          {users.isLoading ? (
            <TableSkeleton />
          ) : (
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead>姓名</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead className="w-28">角色</TableHead>
                  <TableHead className="w-20">状态</TableHead>
                  <TableHead className="w-40">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(users.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium whitespace-nowrap">{row.name}</TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground" title={row.email}>
                      {row.email}
                    </TableCell>
                    <TableCell>
                      {row.id === me?.id ? (
                        <Badge variant={row.role === 'admin' ? 'warning' : 'secondary'}>
                          {row.role === 'admin' ? '管理员' : '成员'}（我）
                        </Badge>
                      ) : (
                        <Select
                          value={row.role}
                          onValueChange={(v) => update.mutate({ id: row.id, role: v as UserRow['role'] })}
                        >
                          <SelectTrigger className="h-7 w-24 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">管理员</SelectItem>
                            <SelectItem value="member">成员</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.status === 'active' ? <Badge variant="success">正常</Badge> : <Badge variant="destructive">已禁用</Badge>}
                    </TableCell>
                    <TableCell>
                      {row.id === me?.id ? null : (
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setResetting(row)}>
                            重置密码
                          </Button>
                          {row.status === 'active' ? (
                            <Confirm
                              title={`禁用 ${row.name}？`}
                              description="其全部 Token 将被吊销，立即生效。"
                              confirmText="禁用"
                              onConfirm={() => update.mutate({ id: row.id, status: 'disabled' })}
                            >
                              <Button size="sm" variant="outline-destructive">
                                禁用
                              </Button>
                            </Confirm>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => update.mutate({ id: row.id, status: 'active' })}>
                              启用
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editingRegistration && (
        <Dialog open onOpenChange={(open) => !open && setEditingRegistration(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>注册设置</DialogTitle>
              <DialogDescription>
                开启后登录页出现「注册」入口，任何能访问平台的人都可自助注册为<strong>成员</strong>账号。
                可用邮箱后缀限制注册范围（如 @your-company.com）；留空表示任意邮箱都可注册。
              </DialogDescription>
            </DialogHeader>
            {registration.data ? (
              <RegistrationForm
                settings={registration.data}
                pending={saveRegistration.isPending}
                onSubmit={(v) => saveRegistration.mutate(v)}
              />
            ) : (
              <TableSkeleton rows={2} />
            )}
          </DialogContent>
        </Dialog>
      )}
      {creating && (
        <CreateUserDialog pending={create.isPending} onClose={() => setCreating(false)} onSubmit={(v) => create.mutate(v)} />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          pending={resetPassword.isPending}
          onClose={() => setResetting(null)}
          onSubmit={(password) => resetPassword.mutate({ id: resetting.id, password })}
        />
      )}
    </div>
  );
}

function RegistrationForm({
  settings,
  pending,
  onSubmit,
}: {
  settings: RegistrationSettings;
  pending: boolean;
  onSubmit: (v: RegistrationSettings) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [suffixes, setSuffixes] = useState<string[]>(settings.allowedEmailSuffixes ?? []);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ enabled, allowedEmailSuffixes: suffixes });
      }}
    >
      <Field label="开放注册">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </Field>
      <Field label="允许的邮箱后缀" hint="回车添加，如 @example.com；留空 = 任意邮箱">
        <TagsInput value={suffixes} onChange={setSuffixes} placeholder="@example.com" />
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        保存
      </Button>
    </form>
  );
}

function CreateUserDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: { name: string; email: string; password: string; role: 'admin' | 'member' }) => void;
}) {
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const { register, handleSubmit, formState: { errors } } = useForm<{ name: string; email: string; password: string }>({
    defaultValues: { name: '', email: '', password: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建用户</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit((v) => onSubmit({ ...v, role }))}>
          <Field label="姓名" htmlFor="user-name" required error={errors.name?.message}>
            <Input id="user-name" placeholder="张三" aria-invalid={!!errors.name} {...register('name', { required: '请输入姓名' })} />
          </Field>
          <Field label="邮箱" htmlFor="user-email" required error={errors.email?.message}>
            <Input
              id="user-email"
              type="email"
              placeholder="zhangsan@example.com"
              aria-invalid={!!errors.email}
              {...register('email', { required: '请输入邮箱', pattern: rules.email })}
            />
          </Field>
          <Field label="初始密码" htmlFor="user-pass" required error={errors.password?.message} hint="至少 8 位，创建后线下告知对方">
            <Input
              id="user-pass"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              {...register('password', { required: '请输入初始密码', minLength: { value: 8, message: '至少 8 位' } })}
            />
          </Field>
          <Field label="角色">
            <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'member')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">成员</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  pending,
  onClose,
  onSubmit,
}: {
  user: UserRow;
  pending: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<{ password: string }>({
    defaultValues: { password: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置密码：{user.name}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit((v) => onSubmit(v.password))}>
          <Field label="新密码" htmlFor="reset-pass" required error={errors.password?.message}>
            <Input
              id="reset-pass"
              type="password"
              placeholder="至少 8 位"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              {...register('password', { required: '请输入新密码', minLength: { value: 8, message: '至少 8 位' } })}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            重置
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
