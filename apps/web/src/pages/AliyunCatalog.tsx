import { configureAliyunPermissionSchema, requestAliyunPermissionSchema, type AliyunCatalogPermission, type AliyunPermissionRequestResult, type ConfigureAliyunPermission, type RequestAliyunPermission, type UserPublic } from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Tip } from '../components/ui/tooltip';

export function AliyunCatalog() {
  const [requesting, setRequesting] = useState<AliyunCatalogPermission | null>(null);
  const points = useQuery({ queryKey: ['aliyun', 'permissions', 'catalog'], queryFn: () => api<AliyunCatalogPermission[]>('GET', '/api/aliyun/permissions') });
  const columns: DataTableColumn<AliyunCatalogPermission>[] = [
    { id: 'point', header: '权限点', cell: ({ row: { original: p } }) => <div className="space-y-1"><Tip content={p.policyName}><span className="block max-w-64 truncate font-mono text-xs">{p.policyName}</span></Tip><p className="max-w-md whitespace-pre-wrap break-words text-sm text-muted-foreground">{p.description || '暂无说明'}</p><div className="space-y-1 text-xs text-muted-foreground md:hidden"><p className="whitespace-pre-wrap break-words">用途：{p.purpose || '未填写'}</p><p className="whitespace-pre-wrap break-words">范围：{p.dataScope || '未填写'}</p></div></div> },
    { id: 'scope', header: '用途与数据范围', meta: { hideBelow: 'md' }, cell: ({ row: { original: p } }) => <div className="max-w-xs space-y-1 break-words text-sm"><p>{p.purpose || '未填写用途'}</p><p className="text-muted-foreground">{p.dataScope || '未填写数据范围'}</p></div> },
    { id: 'owner', header: 'Owner', meta: { className: 'w-32' }, cell: ({ row: { original: p } }) => <div className="text-sm">{p.ownerName || '管理员审批'}{p.ownerStatus === 'disabled' && <p className="text-xs text-amber-700">Owner 已停用</p>}</div> },
    { id: 'actions', header: '操作', meta: { className: 'w-28' }, cell: ({ row: { original: p } }) => p.pendingRequestId ? <Button size="sm" variant="outline" asChild><Link to={`/requests?request=${p.pendingRequestId}`}>查看申请</Link></Button> : p.held ? <Button size="sm" variant="ghost" asChild><Link to="/aliyun?tab=mine">已持有</Link></Button> : p.connectionStatus === 'paused' ? <Tip content="接入已暂停，恢复后可申请"><span tabIndex={0}><Button size="sm" disabled>申请</Button></span></Tip> : <Button size="sm" onClick={() => setRequesting(p)}>申请</Button> },
  ];
  if (points.isError) return <Empty text={`目录加载失败：${points.error.message}`} action={<Button variant="outline" onClick={() => void points.refetch()}>重试</Button>} />;
  return <div className="space-y-5">
    {points.isPending ? <p className="text-muted-foreground">正在加载…</p> : !points.data?.length ? <Empty text="暂无开放申请的权限点" /> : [...new Set(points.data.map(p => p.connectionId))].map(id => {
      const rows = points.data!.filter(p => p.connectionId === id), c = rows[0];
      return <section key={id} className="space-y-3 rounded-xl border bg-card p-4"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium break-all">{c.connectionName}</h2><span className="break-all text-xs text-muted-foreground">云账号 ID：{c.accountId}</span>{c.connectionStatus === 'paused' && <Badge variant="secondary">已暂停</Badge>}</div><DataTable data={rows} columns={columns} getRowId={p => p.id} /></section>;
    })}
    <Dialog open={!!requesting} onOpenChange={v => !v && setRequesting(null)}><DialogContent><DialogHeader><DialogTitle>申请阿里云权限</DialogTitle><DialogDescription>{requesting?.policyName} · {requesting?.connectionName}</DialogDescription></DialogHeader>{requesting && <RequestForm point={requesting} done={() => setRequesting(null)} />}</DialogContent></Dialog>
  </div>;
}
function RequestForm({ point, done }: { point: AliyunCatalogPermission; done(): void }) {
  const client = useQueryClient();
  const form = useForm<RequestAliyunPermission>({ resolver: zodResolver(requestAliyunPermissionSchema), defaultValues: { reason: '' } });
  const submit = useMutation({ mutationFn: (v: RequestAliyunPermission) => api<AliyunPermissionRequestResult>('POST', `/api/aliyun/permissions/${point.id}/requests`, v),
    onSuccess: r => { toast[r.grant?.error ? 'error' : 'success'](r.grant?.error ?? (r.grant ? '已直接授予本人，无需审批' : '申请已提交')); void client.invalidateQueries({ queryKey: ['aliyun'] }); void client.invalidateQueries({ queryKey: ['requests'] }); done(); }, onError: (e: Error) => toast.error(e.message) });
  return <form className="space-y-4" onSubmit={form.handleSubmit(v => submit.mutate(v))}><div className="space-y-1 whitespace-pre-wrap break-words text-sm text-muted-foreground"><p>{point.description}</p><p>用途：{point.purpose || '未填写'}</p><p>数据范围：{point.dataScope || '未填写'}</p></div><Field label="申请用途" htmlFor="aliyun-request-reason" error={form.formState.errors.reason?.message}><Textarea id="aliyun-request-reason" rows={4} {...form.register('reason')} /></Field><div className="flex justify-end"><Button type="submit" loading={submit.isPending}>提交申请</Button></div></form>;
}
export function AliyunConfigureDialog({ point, done }: { point: AliyunCatalogPermission | null; done(): void }) {
  return <Dialog open={!!point} onOpenChange={v => !v && done()}><DialogContent><DialogHeader><DialogTitle>开放申请设置</DialogTitle><DialogDescription>{point?.policyName}。关闭后已有申请仍可由管理员审批，已有授权保持。</DialogDescription></DialogHeader>{point && <ConfigureForm key={point.id} point={point} done={done} />}</DialogContent></Dialog>;
}
function ConfigureForm({ point, done }: { point: AliyunCatalogPermission; done(): void }) {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserPublic[]>('GET', '/api/users') });
  const form = useForm<ConfigureAliyunPermission>({ resolver: zodResolver(configureAliyunPermissionSchema), defaultValues: { open: point.open, purpose: point.purpose, dataScope: point.dataScope, ownerId: point.ownerId } });
  const save = useMutation({ mutationFn: (v: ConfigureAliyunPermission) => api('PATCH', `/api/aliyun/permissions/${point.id}`, v), onSuccess: () => { toast.success('开放申请设置已保存'); void client.invalidateQueries({ queryKey: ['aliyun'] }); done(); }, onError: (e: Error) => toast.error(e.message) });
  return <form className="space-y-4" onSubmit={form.handleSubmit(v => save.mutate(v))}>
    <Field label="开放申请" htmlFor="aliyun-point-open"><Controller control={form.control} name="open" render={({ field }) => <Switch id="aliyun-point-open" checked={field.value} disabled={!point.cloudExists} onCheckedChange={field.onChange} />} /></Field>
    <Field label="用途" htmlFor="aliyun-point-purpose" error={form.formState.errors.purpose?.message}><Textarea id="aliyun-point-purpose" {...form.register('purpose')} /></Field>
    <Field label="数据范围" htmlFor="aliyun-point-scope" error={form.formState.errors.dataScope?.message}><Textarea id="aliyun-point-scope" {...form.register('dataScope')} /></Field>
    <Field label="Owner（留空由管理员审批）" htmlFor="aliyun-point-owner" error={form.formState.errors.ownerId?.message}><Controller control={form.control} name="ownerId" render={({ field }) => <Select value={field.value ?? 'none'} onValueChange={v => field.onChange(v === 'none' ? null : v)}><SelectTrigger id="aliyun-point-owner"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">未指定</SelectItem>{users.data?.map(u => <SelectItem key={u.id} value={u.id}>{u.name}（{u.email}）</SelectItem>)}</SelectContent></Select>} /></Field>
    {users.isError && <p role="alert" className="text-sm text-destructive">用户列表加载失败<Button type="button" variant="ghost" onClick={() => void users.refetch()}>重试</Button></p>}
    <div className="flex justify-end"><Button type="submit" loading={save.isPending}>保存</Button></div>
  </form>;
}
