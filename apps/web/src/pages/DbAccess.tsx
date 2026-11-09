import { grantDbAccessSchema, openDbAccessSchema, revokeDbAccessSchema, type DbAccessCredentials, type DbAccessGrantInfo, type DbCatalogInfo, type DbPersonalPasswordReset, type GrantDbAccessRequest, type OpenDbAccessRequest, type RevokeDbAccessRequest, type UserPublic } from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { CopyButton, InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { Empty } from '../components/empty';
import { Field, firstErrorMessage } from '../components/form';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tip } from '../components/ui/tooltip';

const errorMessage = (err: unknown) => err instanceof ApiError ? err.message : '操作失败，请重试';
const STATE = { pending: '待执行', active: '已生效', failed: '执行失败', revoking: '撤销中', revoked: '已撤销' };

/** 目录只展示元信息；个人凭证从按需读取接口取得，只保存在当前弹窗。 */
export function DbAccessTab({ keyword }: { keyword: string }) {
  const me = getStoredUser();
  const client = useQueryClient();
  const [opening, setOpening] = useState<DbCatalogInfo | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [granting, setGranting] = useState<DbCatalogInfo | null>(null);
  const [revoking, setRevoking] = useState<DbAccessGrantInfo | null>(null);
  const [credentials, setCredentials] = useState<DbAccessGrantInfo | null>(null);
  const catalog = useQuery({ queryKey: ['db-access-catalog'], queryFn: () => api<DbCatalogInfo[]>('GET', '/api/db/access/catalog') });
  const grants = useQuery({ queryKey: ['db-access-grants'], queryFn: () => api<DbAccessGrantInfo[]>('GET', '/api/db/access/grants') });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['db-access-catalog'] });
    void client.invalidateQueries({ queryKey: ['db-access-grants'] });
  };
  const act = useMutation({
    mutationFn: ({ path, payload }: { path: string; payload?: unknown }) => api<DbAccessGrantInfo | DbCatalogInfo>('POST', path, payload),
    onSuccess: result => {
      if (result.error) toast.error(result.error);
      else toast.success('已保存');
      invalidate();
    },
    onError: err => toast.error(errorMessage(err)),
  });
  const matches = (r: { dbName: string; instanceName: string }) => `${r.dbName} ${r.instanceName}`.toLowerCase().includes(keyword);
  const mine = (grants.data ?? []).filter(g => g.userId === me?.id && matches(g));
  const managed = (grants.data ?? []).filter(g => g.canManage && matches(g));
  const columns: DataTableColumn<DbCatalogInfo>[] = [
    { id: 'db', header: '库', cell: ({ row: { original: r } }) => <div className="space-y-1"><InlineCode>{r.dbName}</InlineCode><div className="text-xs text-muted-foreground">{r.instanceName} · EAT 建的库</div></div> },
    { accessorKey: 'ownerName', header: 'Owner', meta: { className: 'w-24' } },
    { id: 'schemas', header: 'Schema', meta: { hideBelow: 'md', className: 'w-36' }, cell: ({ row: { original: r } }) => <span className="break-all text-muted-foreground">{r.schemas.join(', ')}</span> },
    { id: 'state', header: '申请', meta: { className: 'w-24' }, cell: ({ row: { original: r } }) => r.error ? <Tip content={r.error}><Badge variant="destructive">执行失败</Badge></Tip> : <Badge variant={r.open ? 'success' : 'secondary'}>{r.open ? '开放申请' : '未开放'}</Badge> },
    { id: 'actions', header: '操作', meta: { className: 'w-48' }, cell: ({ row: { original: r } }) => r.canManage ? <div className="flex flex-wrap gap-1.5">
      {r.open ? <Confirm title="关闭申请？" description="已有授权不受影响。" onConfirm={() => act.mutate({ path: `/api/db/assignments/${r.assignmentId}/access`, payload: { open: false } })}><Button size="sm" variant="outline" disabled={act.isPending}>关闭申请</Button></Confirm> : <Button size="sm" variant="outline" onClick={() => { setConfiguring(false); setOpening(r); }}>{r.error ? '重试开放' : '开放申请'}</Button>}
      {r.id && <Button size="sm" variant="outline" onClick={() => { setConfiguring(true); setOpening(r); }}>配置 schema</Button>}
      {r.id && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/db/access/catalog/${r.id}/reapply` })}>重新应用授权</Button>}
      {r.id && r.state === 'active' && <Button size="sm" variant="outline" onClick={() => setGranting(r)}>授予权限</Button>}
    </div> : <span className="text-xs text-muted-foreground">联系 Owner 授予</span> },
  ];
  const grantColumns = (manage: boolean): DataTableColumn<DbAccessGrantInfo>[] => [
    { id: 'db', header: '库', cell: ({ row: { original: r } }) => <div className="space-y-1"><InlineCode>{r.dbName}</InlineCode><div className="text-xs text-muted-foreground">{r.instanceName}</div></div> },
    ...(manage ? [{ accessorKey: 'userName', header: '持有人', meta: { className: 'w-24' } } satisfies DataTableColumn<DbAccessGrantInfo>] : []),
    { id: 'level', header: '级别', meta: { className: 'w-20' }, cell: ({ row: { original: r } }) => r.level === 'write' ? '读写' : '只读' },
    { id: 'state', header: '状态', meta: { className: 'w-28' }, cell: ({ row: { original: r } }) => <div className="space-y-1"><Badge variant={r.state === 'active' ? 'success' : r.error ? 'destructive' : 'secondary'}>{r.error && r.state === 'revoking' ? '撤销失败' : STATE[r.state]}</Badge>{r.error && <Tip content={r.error}><p className="max-w-40 truncate text-xs text-destructive">{r.error}</p></Tip>}</div> },
    { id: 'actions', header: '操作', meta: { className: 'w-48' }, cell: ({ row: { original: r } }) => <div className="flex flex-wrap gap-1.5">
      {r.userId === me?.id && r.state === 'active' && <Button size="sm" variant="outline" onClick={() => setCredentials(r)}><KeyRound />个人凭证</Button>}
      {(r.state === 'failed' || r.state === 'pending' || r.state === 'revoking') && (r.canManage || (r.userId === me?.id && r.state === 'revoking')) && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/db/access/grants/${r.id}/retry` })}>重试</Button>}
      {r.state !== 'revoked' && r.state !== 'revoking' && (manage ? <Button size="sm" variant="outline-destructive" onClick={() => setRevoking(r)}>撤销</Button> : <Confirm title="放弃这条授权？" description="你在这个库上的连接会被断开；同实例其他库不受影响。" confirmText="放弃授权" onConfirm={() => act.mutate({ path: `/api/db/access/grants/${r.id}/relinquish` })}><Button size="sm" variant="outline-destructive" disabled={act.isPending}>放弃</Button></Confirm>)}
    </div> },
  ];
  if (catalog.isError || grants.isError) return <Empty text="数据库权限加载失败" action={<Button variant="outline" onClick={invalidate}>重试</Button>} />;
  return <div className="space-y-5">
    <Card><CardContent className="space-y-4">
      <div><h2 className="text-sm font-semibold">数据库目录</h2><p className="mt-1 text-sm text-muted-foreground">查询或修改团队数据，请联系 Owner 授予。Owner 和管理员可在此开放自己的库。</p></div>
      <DataTable columns={columns} data={(catalog.data ?? []).filter(matches)} loading={catalog.isLoading} getRowId={r => r.assignmentId} empty={<Empty text="暂无开放申请的库" />} />
    </CardContent></Card>
    <Card><CardContent className="space-y-4">
      <div><h2 className="text-sm font-semibold">我的授权</h2><p className="mt-1 text-sm text-muted-foreground">个人凭证只供本人临时使用，不要配进线上服务。同一实例的全部库共用一套个人凭证。</p></div>
      <DataTable columns={grantColumns(false)} data={mine} loading={grants.isLoading} getRowId={r => r.id} empty={<Empty text="暂无数据库授权" />} />
    </CardContent></Card>
    {managed.length > 0 && <Card><CardContent className="space-y-4"><h2 className="text-sm font-semibold">授权管理</h2><DataTable columns={grantColumns(true)} data={managed} getRowId={r => r.id} /></CardContent></Card>}
    <Dialog open={!!opening} onOpenChange={v => !v && setOpening(null)}><DialogContent><DialogHeader><DialogTitle>{configuring ? '配置数据库权限' : '开放数据库申请'}</DialogTitle><DialogDescription>收回 PUBLIC 的 CONNECT 和 public schema 的 CREATE。owner 账号照常可用。</DialogDescription></DialogHeader>{opening && <OpenForm key={opening.assignmentId} row={opening} configuring={configuring} done={() => { setOpening(null); invalidate(); }} />}</DialogContent></Dialog>
    <Dialog open={!!granting} onOpenChange={v => !v && setGranting(null)}><DialogContent><DialogHeader><DialogTitle>授予数据库权限</DialogTitle><DialogDescription>{granting?.dbName} · 已有授权会改为所选级别；降级会断开这个库上的连接。</DialogDescription></DialogHeader>{granting && <GrantForm row={granting} done={() => { setGranting(null); invalidate(); }} />}</DialogContent></Dialog>
    <Dialog open={!!revoking} onOpenChange={v => !v && setRevoking(null)}><DialogContent><DialogHeader><DialogTitle>撤销数据库授权</DialogTitle><DialogDescription>{revoking?.userName} 在 {revoking?.dbName} 上的连接会被断开，持有人收到撤销通知。</DialogDescription></DialogHeader>{revoking && <RevokeForm row={revoking} done={() => { setRevoking(null); invalidate(); }} />}</DialogContent></Dialog>
    <Dialog open={!!credentials} onOpenChange={v => !v && setCredentials(null)}><DialogContent><DialogHeader><DialogTitle>个人凭证</DialogTitle><DialogDescription>只供本人临时使用，不要配进线上服务。每次查看记入审计。</DialogDescription></DialogHeader>{credentials && <PersonalCredentials key={credentials.id} grant={credentials} />}</DialogContent></Dialog>
  </div>;
}

function OpenForm({ row, configuring, done }: { row: DbCatalogInfo; configuring: boolean; done: () => void }) {
  const form = useForm<Required<OpenDbAccessRequest>>({ resolver: zodResolver(openDbAccessSchema.required()), defaultValues: { open: configuring ? row.open : true, schemas: row.schemas } });
  const save = useMutation({ mutationFn: (v: OpenDbAccessRequest) => api<DbCatalogInfo>('POST', `/api/db/assignments/${row.assignmentId}/access`, v), onSuccess: r => { if (r.error) toast.error(r.error); else toast.success(configuring ? '配置已保存，授权已重新应用' : '已开放申请'); done(); }, onError: e => toast.error(errorMessage(e)) });
  return <form className="space-y-4" onSubmit={form.handleSubmit(v => save.mutate(v))}>
    <p className="text-sm"><InlineCode>{row.dbName}</InlineCode> · {row.instanceName}</p>
    <Field label="覆盖的 schema" htmlFor="access-schemas" error={form.formState.errors.schemas?.message} hint="用逗号分隔。请先在库中创建这些 schema。">
      <Controller control={form.control} name="schemas" render={({ field }) => <Input id="access-schemas" value={(field.value ?? []).join(', ')} onChange={e => field.onChange(e.target.value.split(/[,，]/).map(s => s.trim()))} />} />
    </Field>
    <p role="alert" className="text-xs text-destructive">{firstErrorMessage(form.formState.errors)}</p>
    <div className="flex justify-end"><Button type="submit" loading={save.isPending}>{configuring ? '保存并重新应用' : '开放申请'}</Button></div>
  </form>;
}
function GrantForm({ row, done }: { row: DbCatalogInfo; done: () => void }) {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<(UserPublic & { status?: string })[]>('GET', '/api/users') });
  const form = useForm<GrantDbAccessRequest>({ resolver: zodResolver(grantDbAccessSchema), defaultValues: { userId: '', level: 'read' } });
  const save = useMutation({ mutationFn: (v: GrantDbAccessRequest) => api<DbAccessGrantInfo>('POST', `/api/db/access/catalog/${row.id}/grants`, v), onSuccess: r => { if (r.error) toast.error(r.error); else toast.success('授权已生效'); done(); }, onError: e => toast.error(errorMessage(e)) });
  return <form className="space-y-4" onSubmit={form.handleSubmit(v => save.mutate(v))}>
    <Field label="EAT 用户" htmlFor="access-user" error={form.formState.errors.userId?.message}>
      <Controller control={form.control} name="userId" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="access-user"><SelectValue placeholder="选择用户" /></SelectTrigger><SelectContent>{(users.data ?? []).filter(u => u.status !== 'disabled').map(u => <SelectItem key={u.id} value={u.id}>{u.name}（{u.email}）</SelectItem>)}</SelectContent></Select>} />
    </Field>
    <Field label="授权级别" htmlFor="access-level" error={form.formState.errors.level?.message} hint="读写可增、改、删数据；不含建表、改结构或 TRUNCATE。">
      <Controller control={form.control} name="level" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="access-level"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="read">只读</SelectItem><SelectItem value="write">读写</SelectItem></SelectContent></Select>} />
    </Field>
    {users.isError && <p role="alert" className="text-sm text-destructive">用户列表加载失败<Button variant="ghost" type="button" onClick={() => void users.refetch()}>重试</Button></p>}
    <div className="flex justify-end"><Button type="submit" loading={save.isPending} disabled={users.isLoading || users.isError}>授予权限</Button></div>
  </form>;
}
function RevokeForm({ row, done }: { row: DbAccessGrantInfo; done: () => void }) {
  const form = useForm<RevokeDbAccessRequest>({ resolver: zodResolver(revokeDbAccessSchema.required()), defaultValues: { reason: '' } });
  const save = useMutation({ mutationFn: (v: RevokeDbAccessRequest) => api<DbAccessGrantInfo>('POST', `/api/db/access/grants/${row.id}/revoke`, v), onSuccess: r => { if (r.error) toast.error(r.error); else toast.success('授权已撤销'); done(); }, onError: e => toast.error(errorMessage(e)) });
  return <form className="space-y-4" onSubmit={form.handleSubmit(v => save.mutate(v))}><Field label="撤销原因（选填）" htmlFor="access-reason" error={form.formState.errors.reason?.message}><Textarea id="access-reason" {...form.register('reason')} /></Field><div className="flex justify-end"><Button variant="destructive" type="submit" loading={save.isPending}>撤销授权</Button></div></form>;
}
function PersonalCredentials({ grant }: { grant: DbAccessGrantInfo }) {
  const [value, setValue] = useState<DbAccessCredentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const reset = async () => {
    setResetting(true);
    setValue(null);
    try {
      const result = await api<DbPersonalPasswordReset>('POST', `/api/db/access/catalog/${grant.catalogId}/reset-password`);
      if (result.state === 'complete') toast.success('个人密码已重置，同一实例的全部库授权改用新密码');
      else toast.error(`个人密码重置待完成，平台将自动重试：${result.error ?? '请稍后再查看凭证'}`);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setResetting(false); }
  };
  const reveal = async () => {
    setLoading(true);
    try { setValue(await api<DbAccessCredentials>('POST', `/api/db/access/catalog/${grant.catalogId}/credentials`)); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  return <div className="space-y-4">
    <p className="text-sm"><InlineCode>{grant.dbName}</InlineCode> · {grant.instanceName}</p>
    {value ? <div className="space-y-3 text-sm">
      <div className="flex items-center gap-1"><span className="text-muted-foreground">个人角色</span><InlineCode>{value.user}</InlineCode><CopyButton text={value.user} /></div>
      <div className="flex flex-wrap items-center gap-1"><span className="text-muted-foreground">密码</span><InlineCode>{value.password}</InlineCode><CopyButton text={value.password} /><Button size="icon-sm" variant="ghost" aria-label="隐藏个人凭证" onClick={() => setValue(null)}><EyeOff /></Button></div>
      <div className="flex items-start gap-1"><InlineCode>{value.url}</InlineCode><CopyButton text={value.url} /></div>
    </div> : <div className="flex items-center gap-3"><InlineCode>••••••••••••</InlineCode><Button variant="outline" loading={loading} disabled={resetting} onClick={() => void reveal()}><Eye />查看个人凭证</Button></div>}
    <div className="border-t pt-4"><Confirm title="重置个人密码？" description={`同一实例「${grant.instanceName}」上其他库的授权也会使用新密码。已保存的旧密码将失效。个人凭证只供本人临时使用，不要配进线上服务。`} confirmText="重置个人密码" onConfirm={() => void reset()}><Button variant="outline" loading={resetting} disabled={loading}>重置个人密码</Button></Confirm></div>
  </div>;
}
