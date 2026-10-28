import { GithubAccountPanel } from '../components/github';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createUserRequestSchema, resetUserPasswordRequestSchema, type UserListItem } from '@eat/shared';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser, getToken, setSession } from '../api';
import { Switch } from '../components/ui/switch';
import { Pagination } from '../components/pagination';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
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

type UserRow = UserListItem;
const orgLabels = { unknown: '待核验', absent: '未加入', pending: '待接受邀请', processing: '处理中', active: '已加入' };

/** 用户管理（仅管理员）：建号、改角色、禁用/启用、重置密码 */
export function UsersPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [editingProfile, setEditingProfile] = useState<UserRow | null>(null);
  const [permissions, setPermissions] = useState<UserRow | null>(null);
  const [githubUser, setGithubUser] = useState<UserRow | null>(null);
  const [statusUser, setStatusUser] = useState<UserRow | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
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
    mutationFn: (v: { id: string; role?: 'admin' | 'member'; status?: 'active' | 'disabled'; canNotifyAll?: boolean }) =>
      api<{ llmGatewaySyncPending?: boolean; ossSyncPending?: boolean }>('PATCH', `/api/users/${v.id}`, { role: v.role, status: v.status, canNotifyAll: v.canNotifyAll }),
    onSuccess: (_d, v) => {
      setPermissions(null); setStatusUser(null);
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

  const keyword = search.trim().toLowerCase();
  const filtered = (users.data ?? []).filter(u => (status === 'all' || u.status === status)
    && [u.name, u.email, u.id, u.github?.login ?? ''].some(v => v.toLowerCase().includes(keyword)));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const columns: DataTableColumn<UserRow>[] = [
    { accessorKey: 'name', header: '用户', cell: ({ row: { original: row } }) => <div className="max-w-36 sm:max-w-56">
      <div className="flex items-center gap-2"><span className="truncate font-medium" title={row.name}>{row.name}</span>{row.id === me?.id && <span className="text-xs text-muted-foreground">我</span>}</div>
      <Tip content={row.email}><span className="block truncate text-xs text-muted-foreground">{row.email}</span></Tip>
    </div> },
    { accessorKey: 'role', header: '角色', meta: { hideBelow: 'md' }, cell: ({ row: { original: row } }) =>
      <Badge variant={row.role === 'admin' ? 'warning' : 'secondary'}>{row.role === 'admin' ? '管理员' : '成员'}</Badge> },
    { accessorKey: 'status', header: '状态', meta: { className: 'whitespace-nowrap' }, cell: ({ row: { original: row } }) =>
      <Badge variant={row.status === 'active' ? 'success' : 'destructive'}>{row.status === 'active' ? '正常' : '已禁用'}</Badge> },
    { id: 'broadcast', header: '全员通知', meta: { hideBelow: 'lg' }, cell: ({ row: { original: row } }) =>
      row.canNotifyAll ? <Badge variant="outline">允许发送</Badge> : <span className="text-sm text-muted-foreground">未授权</span> },
    { id: 'github', header: 'GitHub', meta: { hideBelow: 'md' }, cell: ({ row: { original: row } }) => row.github
      ? <button className="max-w-44 cursor-pointer text-left text-sm hover:underline" onClick={() => setGithubUser(row)} aria-label={`查看 ${row.name} 的 GitHub`}>
        <span className="block truncate">@{row.github.login}</span><span className="block text-xs text-muted-foreground">{row.github.needsAuthorization ? '需重新授权' : orgLabels[row.github.orgState]}</span>
      </button> : <span className="text-sm text-muted-foreground">未关联</span> },
    { id: 'actions', header: '', meta: { className: 'w-12 text-right' }, cell: ({ row: { original: row } }) =>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`${row.name} 的操作`}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => { setEditingProfile(row); setName(row.name); setBio(row.bio); }}>编辑资料</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPermissions(row)}>权限设置</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setGithubUser(row)}>GitHub 详情</DropdownMenuItem>
          {row.id !== me?.id && <><DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setResetting(row)}>重置密码</DropdownMenuItem>
            <DropdownMenuItem destructive={row.status === 'active'} onSelect={() => setStatusUser(row)}>{row.status === 'active' ? '禁用账号' : '启用账号'}</DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu> },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="用户"
        description="管理团队账号、角色与通知权限。"
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
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Input className="w-full sm:max-w-xs" aria-label="搜索用户" placeholder="搜索姓名、邮箱、ID 或 GitHub" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
            <Select value={status} onValueChange={v => { setStatus(v); setPage(1); }}><SelectTrigger className="w-32" aria-label="账号状态"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="all">全部状态</SelectItem><SelectItem value="active">正常</SelectItem><SelectItem value="disabled">已禁用</SelectItem>
            </SelectContent></Select>
          </div>
          {users.isError ? <div role="alert" className="text-sm text-destructive">用户列表加载失败。<Button variant="ghost" onClick={() => void users.refetch()}>重试</Button></div> : <>
            <DataTable columns={columns} data={filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)} loading={users.isLoading}
              getRowId={row => row.id} empty={<p className="py-8 text-center text-sm text-muted-foreground">没有匹配的用户</p>} />
            <Pagination total={filtered.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />
          </>}
        </CardContent>
      </Card>

      {editingProfile && <Dialog open onOpenChange={(open) => !open && !saveProfile.isPending && setEditingProfile(null)}>
        <DialogContent><DialogHeader><DialogTitle>编辑用户资料</DialogTitle>
          <DialogDescription>修改 {editingProfile.name} 的姓名与个人简介，帮助 AI 识别用户、了解擅长领域并匹配求助对象。</DialogDescription>
        </DialogHeader><p className="break-all text-xs text-muted-foreground">用户 ID：{editingProfile.id}</p><form className="space-y-4" onSubmit={(e) => { e.preventDefault(); saveProfile.mutate({ id: editingProfile.id, name, bio }); }}>
          <Field label="姓名" htmlFor="admin-user-name"><Input id="admin-user-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="个人简介" htmlFor="admin-user-bio"><Textarea id="admin-user-bio" rows={6} maxLength={2000} value={bio} onChange={(e) => setBio(e.target.value)} /></Field>
          <Button type="submit" disabled={!name.trim()} loading={saveProfile.isPending}>保存资料</Button>
        </form></DialogContent>
      </Dialog>}
      {permissions && <PermissionsDialog user={permissions} self={permissions.id === me?.id} pending={update.isPending} onClose={() => setPermissions(null)} onSubmit={body => update.mutate({ id: permissions.id, ...body })} />}
      {githubUser && <Dialog open onOpenChange={open => { if (!open) { setGithubUser(null); invalidate(); } }}><DialogContent>
        <DialogHeader><DialogTitle>GitHub 详情 · {githubUser.name}</DialogTitle><DialogDescription>查看账户关联、组织状态及邀请进度。</DialogDescription></DialogHeader>
        <GithubAccountPanel userId={githubUser.id} />
      </DialogContent></Dialog>}
      {statusUser && <Dialog open onOpenChange={open => !open && !update.isPending && setStatusUser(null)}><DialogContent>
        <DialogHeader><DialogTitle>{statusUser.status === 'active' ? '禁用' : '启用'} {statusUser.name}？</DialogTitle><DialogDescription>
          {statusUser.status === 'active' ? '其 EAT 登录凭证将立即吊销，模型 API Key 和 OSS 权限将同步停用，云端生效存在传播延迟。' : '恢复账号使用权限，用户需要重新登录。'}
        </DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" disabled={update.isPending} onClick={() => setStatusUser(null)}>取消</Button>
          <Button variant={statusUser.status === 'active' ? 'destructive' : 'default'} loading={update.isPending} onClick={() => update.mutate({ id: statusUser.id, status: statusUser.status === 'active' ? 'disabled' : 'active' })}>确认{statusUser.status === 'active' ? '禁用' : '启用'}</Button></div>
      </DialogContent></Dialog>}
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

function PermissionsDialog({ user, self, pending, onClose, onSubmit }: { user: UserRow; self: boolean; pending: boolean; onClose: () => void;
  onSubmit: (body: { role?: UserRow['role']; canNotifyAll: boolean }) => void }) {
  const [role, setRole] = useState(user.role);
  const [canNotifyAll, setCanNotifyAll] = useState(user.canNotifyAll);
  return <Dialog open onOpenChange={open => !open && !pending && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>权限设置 · {user.name}</DialogTitle><DialogDescription>全员通知权限独立于角色，默认关闭。</DialogDescription></DialogHeader>
    <Field label="角色"><Select value={role} disabled={self || pending} onValueChange={v => setRole(v as UserRow['role'])}><SelectTrigger aria-label="角色"><SelectValue /></SelectTrigger><SelectContent>
      <SelectItem value="member">成员</SelectItem><SelectItem value="admin">管理员</SelectItem>
    </SelectContent></Select>{self && <p className="text-xs text-muted-foreground">不能修改自己的角色或状态。</p>}</Field>
    <div className="flex items-center justify-between gap-4 rounded-lg border p-4"><div><label htmlFor="can-notify-all" className="text-sm font-medium">允许发送全员通知</label>
      <p className="mt-1 text-xs text-muted-foreground">开启后可向所有正常用户的飞书通知渠道广播。</p></div><Switch id="can-notify-all" checked={canNotifyAll} disabled={pending} onCheckedChange={setCanNotifyAll} /></div>
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={pending} onClick={onClose}>取消</Button><Button loading={pending}
      disabled={role === user.role && canNotifyAll === user.canNotifyAll} onClick={() => onSubmit({ ...(!self && role !== user.role ? { role } : {}), canNotifyAll })}>保存权限</Button></div>
  </DialogContent></Dialog>;
}
