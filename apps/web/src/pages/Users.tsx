import { GithubAccountPanel } from '../components/github';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createUserRequestSchema, resetUserPasswordRequestSchema, type UserNotificationStatus } from '@eat/shared';
import { formatDateTime } from '../lib/format';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser, getToken, setSession } from '../api';
import { Confirm } from '../components/confirm';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Tip } from '../components/ui/tooltip';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  bio: string;
  /** 只有管理员拿得到（决策 92） */
  notification?: UserNotificationStatus;
}

/** 按平台当前的通知渠道展示：自建应用看飞书绑定，Webhook 看是否验证过 */
function NotificationBadge({ status }: { status?: UserNotificationStatus }) {
  if (!status) return null;
  if (status.channel === 'webhook')
    return status.webhookVerified ? <Badge variant="success">Webhook 已验证</Badge> : <Badge variant="outline">未配置</Badge>;
  if (status.feishuApp === 'bound')
    return (
      <Tip content={status.feishuBoundAt ? `绑定于 ${formatDateTime(status.feishuBoundAt)}` : undefined}>
        <Badge variant="success">已绑定</Badge>
      </Tip>
    );
  if (status.feishuApp === 'stale')
    return (
      <Tip content="绑定的是之前的飞书应用，需要重新绑定">
        <Badge variant="warning">需重新绑定</Badge>
      </Tip>
    );
  return <Badge variant="outline">未绑定</Badge>;
}

/** 用户管理（仅管理员）：建号、改角色、禁用/启用、重置密码 */
export function UsersPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [editingProfile, setEditingProfile] = useState<UserRow | null>(null);
  const [name, setName] = useState('');
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

  const saveProfile = useMutation({
    mutationFn: (v: { id: string; name: string; bio: string }) =>
      api<Pick<UserRow, 'id' | 'name' | 'bio'>>('PATCH', `/api/users/${v.id}/profile`, { name: v.name, bio: v.bio }),
    onSuccess: (profile) => {
      const token = getToken();
      const currentUser = getStoredUser();
      if (token && currentUser?.id === profile.id) setSession(token, { ...currentUser, name: profile.name });
      toast.success('用户资料已更新');
      setEditingProfile(null);
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['account'] });
      void queryClient.invalidateQueries({ queryKey: ['help-targets'] });
    }, onError,
  });

  const columns: DataTableColumn<UserRow>[] = [
    { accessorKey: 'name', header: '姓名', enableSorting: true, meta: { cellClassName: 'font-medium whitespace-nowrap' } },
    {
      accessorKey: 'email',
      header: '邮箱',
      enableSorting: true,
      meta: { cellClassName: 'text-muted-foreground' },
      cell: ({ row: { original: row } }) => (
        <Tip content={row.email}>
          <span className="block max-w-48 truncate">{row.email}</span>
        </Tip>
      ),
    },
    {
      accessorKey: 'role',
      header: '角色',
      enableSorting: true,
      meta: { className: 'w-28' },
      cell: ({ row: { original: row } }) =>
        row.id === me?.id ? (
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
        ),
    },
    {
      accessorKey: 'status',
      header: '状态',
      enableSorting: true,
      meta: { className: 'w-20' },
      cell: ({ row: { original: row } }) =>
        row.status === 'active' ? <Badge variant="success">正常</Badge> : <Badge variant="destructive">已禁用</Badge>,
    },
    {
      id: 'feishu',
      header: '飞书通知',
      meta: { className: 'w-28', hideBelow: 'md' },
      cell: ({ row: { original: row } }) => <NotificationBadge status={row.notification} />,
    },
    {
      id: 'github',
      header: 'GitHub 组织',
      meta: { cellClassName: 'min-w-64' },
      cell: ({ row: { original: row } }) => <GithubAccountPanel userId={row.id} />,
    },
    {
      id: 'actions',
      header: '操作',
      meta: { className: 'w-40' },
      cell: ({ row: { original: row } }) => (
        <>
          <Button size="sm" variant="outline" className="mb-1.5" onClick={() => { setEditingProfile(row); setName(row.name); setBio(row.bio); }}>编辑资料</Button>
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
        </>
      ),
    },
  ];

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
          <DataTable
            columns={columns}
            data={users.data}
            loading={users.isLoading}
            getRowId={(row) => row.id}
            className="min-w-[560px]"
          />
        </CardContent>
      </Card>

      {editingProfile && <Dialog open onOpenChange={(open) => !open && !saveProfile.isPending && setEditingProfile(null)}>
        <DialogContent><DialogHeader><DialogTitle>编辑用户资料</DialogTitle>
          <DialogDescription>修改 {editingProfile.name} 的姓名与个人简介，帮助 AI 识别用户、了解擅长领域并匹配求助对象。</DialogDescription>
        </DialogHeader><form className="space-y-4" onSubmit={(e) => { e.preventDefault(); saveProfile.mutate({ id: editingProfile.id, name, bio }); }}>
          <Field label="姓名" htmlFor="admin-user-name"><Input id="admin-user-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="个人简介" htmlFor="admin-user-bio"><Textarea id="admin-user-bio" rows={6} maxLength={2000} value={bio} onChange={(e) => setBio(e.target.value)} /></Field>
          <Button type="submit" disabled={!name.trim()} loading={saveProfile.isPending}>保存资料</Button>
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

/** 角色走单独的 Select，不进表单 */
const createUserFormSchema = createUserRequestSchema.omit({ role: true });

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
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(createUserFormSchema),
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
            <Input id="user-name" placeholder="张三" aria-invalid={!!errors.name} {...register('name')} />
          </Field>
          <Field label="邮箱" htmlFor="user-email" required error={errors.email?.message}>
            <Input
              id="user-email"
              type="email"
              placeholder="zhangsan@example.com"
              aria-invalid={!!errors.email}
              {...register('email')}
            />
          </Field>
          <Field label="初始密码" htmlFor="user-pass" required error={errors.password?.message} hint="至少 8 位，创建后线下告知对方">
            <Input
              id="user-pass"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              {...register('password')}
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
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(resetUserPasswordRequestSchema),
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
              {...register('password')}
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
