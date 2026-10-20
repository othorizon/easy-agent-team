import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { Confirm } from '../components/confirm';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  bio: string;
}

/** 用户管理（仅管理员）：建号、改角色、禁用/启用、重置密码 */
export function UsersPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [editingBio, setEditingBio] = useState<UserRow | null>(null);
  const [bio, setBio] = useState('');

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
      api<{ llmGatewaySyncPending?: boolean; ossSyncPending?: boolean }>('PATCH', `/api/users/${v.id}`, { role: v.role, status: v.status }),
    onSuccess: (_d, v) => {
      toast.success(v.status === 'disabled' ? '已禁用（其 EAT 登录凭证已吊销）' : '已更新');
      if (_d.ossSyncPending) toast.info('OSS 凭证状态正在同步，可在对应 OSS 空间详情查看进度');
      if (_d.llmGatewaySyncPending) toast.info('模型 API Key 的状态仍在同步，请在“LLM API 网关 → 成员与额度”查看进度');
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

  const saveBio = useMutation({
    mutationFn: () => api('PATCH', `/api/users/${editingBio!.id}/bio`, { bio }),
    onSuccess: () => { toast.success('个人简介已更新'); setEditingBio(null); invalidate(); }, onError,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="用户"
        description="账号由管理员创建后线下告知初始密码，或开放注册让成员自助注册。禁用与重置密码会吊销 EAT 登录凭证，禁用还会同步停用模型 API Key 和 OSS AK。"
        actions={
          <>
            <Button variant="outline" asChild><Link to="/settings?section=registration">注册与登录设置</Link></Button>
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
                      <Button size="sm" variant="outline" className="mb-1.5" onClick={() => { setEditingBio(row); setBio(row.bio); }}>编辑简介</Button>
                      {row.id === me?.id ? null : (
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setResetting(row)}>
                            重置密码
                          </Button>
                          {row.status === 'active' ? (
                            <Confirm
                              title={`禁用 ${row.name}？`}
                              description="其 EAT 登录 Token 将立即吊销。模型 API Key 和 OSS 权限会同步停用，云端生效存在传播延迟。"
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

      {editingBio && <Dialog open onOpenChange={(open) => !open && setEditingBio(null)}>
        <DialogContent><DialogHeader><DialogTitle>编辑 {editingBio.name} 的个人简介</DialogTitle>
          <DialogDescription>此内容会用于 AI 查询用户、了解擅长领域并匹配求助对象。</DialogDescription>
        </DialogHeader><form className="space-y-4" onSubmit={(e) => { e.preventDefault(); saveBio.mutate(); }}>
          <Field label="个人简介" htmlFor="admin-user-bio"><Textarea id="admin-user-bio" rows={6} maxLength={2000} value={bio} onChange={(e) => setBio(e.target.value)} /></Field>
          <Button type="submit" loading={saveBio.isPending}>保存简介</Button>
        </form></DialogContent>
      </Dialog>}
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
