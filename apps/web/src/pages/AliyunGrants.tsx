import { Link } from 'react-router-dom';
import { ALIYUN_CREDENTIAL_NOTE, type AliyunCredentials, grantAliyunPermissionSchema, revokeAliyunGrantSchema, type AliyunIdentityDrift, type AliyunGrantInfo, type AliyunGrantsResult, type AliyunPermissionInfo, type GrantAliyunPermissionRequest, type RevokeAliyunGrantRequest, type UserPublic } from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api } from '../api';
import { CopyButton, Cmd } from '../components/code';
import { Confirm } from '../components/confirm';
import { DataTable, type DataTableColumn } from '../components/data-table';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Tip } from '../components/ui/tooltip';

const STATE = { pending: '待执行', active: '已生效', failed: '执行失败', revoking: '撤销中', revoked: '已撤销' };
const SOURCE = { direct: '直接授予', approval: '审批', self: '给自己申请' };

/** Existing table/dialog vocabulary; grant execution errors remain visible beside their status. */
export function AliyunGrants({ manage = false }: { manage?: boolean }) {
  const client = useQueryClient();
  const [revoking, setRevoking] = useState<AliyunGrantInfo | null>(null);
  const result = useQuery({ queryKey: ['aliyun', 'grants', manage ? 'manage' : 'mine'],
    queryFn: () => api<AliyunGrantsResult>('GET', `/api/aliyun/grants${manage ? '/manage' : ''}`),
    refetchInterval: q => q.state.data?.grants.some(g => ['pending', 'failed', 'revoking'].includes(g.state)) ? 5_000 : false,
  });
  const invalidate = () => { void client.invalidateQueries({ queryKey: ['aliyun', 'grants'] }); };
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'relinquish' | 'retry' }) => api<AliyunGrantInfo>('POST', `/api/aliyun/grants/${id}/${action}`),
    onSuccess: r => { if (r.error) toast.error(r.error); else toast.success(r.state === 'revoked' ? (r.relinquished ? '已放弃授权' : '授权已撤销') : '授权已生效'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const repair = useMutation({ mutationFn: (row: AliyunIdentityDrift) => api<{ ok: boolean; drift: AliyunIdentityDrift }>('POST', `/api/aliyun/connections/${row.connectionId}/identities/${row.identityId}/repair`),
    onSuccess: r => { if (r.ok) toast.success('已按 EAT 记录修复'); else toast.error(r.drift.error ?? r.drift.repairError ?? '仍有云端不一致，请重试'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: DataTableColumn<AliyunGrantInfo>[] = [
    { id: 'permission', header: '权限点', cell: ({ row: { original: r } }) => <div className="space-y-1"><Tip content={r.policyName}><span className="block max-w-64 truncate font-mono text-xs">{r.policyName}</span></Tip><p className="text-xs text-muted-foreground break-all">{r.connectionName} · {r.accountId}</p></div> },
    ...(manage ? [{ accessorKey: 'userName', header: '持有人', meta: { className: 'w-28' } } satisfies DataTableColumn<AliyunGrantInfo>] : []),
    { id: 'source', header: '来源', meta: { hideBelow: 'md', className: 'w-28' }, cell: ({ row: { original: r } }) => SOURCE[r.source] },
    { id: 'state', header: '状态', meta: { className: 'w-40' }, cell: ({ row: { original: r } }) => <div className="space-y-1"><Badge variant={r.state === 'active' ? 'success' : r.error ? 'destructive' : 'secondary'}>{STATE[r.state]}</Badge>{!r.cloudExists && <Badge variant="destructive">云端已删除</Badge>}{r.error && <Tip content={r.error}><p className="max-w-48 truncate text-xs text-destructive">{r.error}</p></Tip>}</div> },
    { id: 'actions', header: '操作', meta: { className: 'w-40' }, cell: ({ row: { original: r } }) => <div className="flex flex-wrap gap-1.5">
      {r.state === 'failed' && (r.canManage || r.relinquished) && <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: r.id, action: 'retry' })}>重试</Button>}
      {!['revoked', 'revoking'].includes(r.state) && (manage ? <Button size="sm" variant="outline-destructive" onClick={() => setRevoking(r)}>撤销</Button> : <Confirm title="放弃这条授权？" description="将解绑这个权限点对应的策略，其他授权不受影响。" confirmText="放弃授权" onConfirm={() => act.mutate({ id: r.id, action: 'relinquish' })}><Button size="sm" variant="outline-destructive" disabled={act.isPending}>放弃</Button></Confirm>)}
    </div> },
  ];
  if (result.isError) return <Empty text={`授权加载失败：${result.error.message}`} action={<Button variant="outline" onClick={() => void result.refetch()}>重试</Button>} />;
  return <div className="space-y-5">
    {!manage && result.data?.accounts.map(a => <section key={a.accountId} className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2"><h2 className="font-medium break-all">{a.connectionName}</h2>{a.connectionStatus === 'paused' && <Badge variant="secondary">接入已暂停</Badge>}</div>
      <p className="break-all text-xs text-muted-foreground">云账号 ID：{a.accountId} · 个人身份：{a.ramName}</p>
      <p className="text-sm">已绑定的自定义策略：{a.customPolicyCount === null ? '暂时无法读取' : `${a.customPolicyCount} 条`}</p>
      <AliyunKeyCard connectionId={a.connectionId} connectionName={a.connectionName} paused={a.connectionStatus === 'paused'} authorized={result.data!.grants.some(g => g.accountId === a.accountId && g.state === 'active') || result.data!.ossSpaces?.some(s => s.accountId === a.accountId && s.status === 'active')} />
      {a.error && <p role="alert" className="break-words text-sm text-destructive">{a.error}</p>}
    </section>)}
    {manage && result.data?.drift?.filter(d => d.error || d.repairError || d.missing.length || d.extra.length).map(d => <section key={d.identityId} className="space-y-2 rounded-xl border border-destructive/30 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2"><Badge variant="destructive">云端不一致</Badge><span className="text-sm font-medium break-all">{d.userName} · {d.connectionName}</span></div>
      {d.missing.length > 0 && <p className="text-sm break-all">云端缺少：{d.missing.join('、')}</p>}
      {d.extra.length > 0 && <p className="text-sm break-all">云端多出：{d.extra.join('、')}</p>}
      {d.error && <p role="alert" className="text-sm break-words text-destructive">{d.error}</p>}
      {d.repairError && d.repairError !== d.error && <p role="alert" className="text-sm break-words text-destructive">上次修复失败：{d.repairError}</p>}
      <p className="text-xs text-muted-foreground">仅核对 eat-perm- 自定义策略。页面核对不会覆盖云端绑定。</p>
      <Confirm title="按 EAT 记录修复绑定？" description="会补齐记录中缺少的权限点绑定，并解绑记录之外的 eat-perm- 自定义策略；无关策略不受影响。" confirmText="修复绑定" onConfirm={() => repair.mutate(d)}>
        <Button size="sm" variant="outline" disabled={!d.canRepair || repair.isPending}>按 EAT 记录修复</Button>
      </Confirm>
      {!d.canRepair && <p className="text-xs text-muted-foreground">接入已暂停或正在清理，暂不能修复。</p>}
    </section>)}
    {!manage && !!result.data?.ossSpaces?.length && <section className="space-y-3"><h2 className="text-sm font-semibold">OSS 空间（只读）</h2><DataTable data={result.data.ossSpaces} getRowId={row => row.id} columns={[
      { id: 'name', header: '空间', cell: ({ row: { original: row } }) => <Link className="text-primary hover:underline" to={`/oss/${row.id}`}>{row.name}</Link> },
      { accessorKey: 'accountId', header: '云账号', cell: ({ row: { original: row } }) => <span className="break-all text-xs">{row.connectionName ? `${row.connectionName} · ` : ''}{row.accountId}</span> },
      { id: 'status', header: '状态', cell: ({ row: { original: row } }) => <Badge variant="secondary">{row.status === 'active' ? '可用' : row.status === 'revoked' ? '已回收' : row.status}</Badge> },
    ]} /></section>}
    {manage && <h2 className="text-sm font-semibold">授权清单</h2>}
    <DataTable columns={columns} data={result.data?.grants} loading={result.isPending} getRowId={g => g.id} empty={<Empty text={manage ? '暂无可管理的授权' : '暂无阿里云授权'} />} />
    <Dialog open={!!revoking} onOpenChange={v => !v && setRevoking(null)}><DialogContent><DialogHeader><DialogTitle>撤销阿里云授权</DialogTitle><DialogDescription>{revoking?.userName} · {revoking?.policyName}。撤销后通知持有人，其他授权不受影响。</DialogDescription></DialogHeader>{revoking && <RevokeForm row={revoking} done={() => { setRevoking(null); invalidate(); }} />}</DialogContent></Dialog>
  </div>;
}

export function AliyunGrantDialog({ permission, onClose }: { permission: AliyunPermissionInfo | null; onClose(): void }) {
  const client = useQueryClient();
  return <Dialog open={!!permission} onOpenChange={v => !v && onClose()}><DialogContent><DialogHeader><DialogTitle>直接授予权限点</DialogTitle><DialogDescription>{permission?.policyName} · 无需开放申请，授权执行完成后生效。</DialogDescription></DialogHeader>{permission && <GrantForm permission={permission} done={() => { onClose(); void client.invalidateQueries({ queryKey: ['aliyun', 'grants'] }); }} />}</DialogContent></Dialog>;
}
function GrantForm({ permission, done }: { permission: AliyunPermissionInfo; done(): void }) {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<(UserPublic & { status?: string })[]>('GET', '/api/users') });
  const form = useForm<GrantAliyunPermissionRequest>({ resolver: zodResolver(grantAliyunPermissionSchema), defaultValues: { userId: '' } });
  const save = useMutation({ mutationFn: (v: GrantAliyunPermissionRequest) => api<AliyunGrantInfo>('POST', `/api/aliyun/permissions/${permission.id}/grants`, v),
    onSuccess: r => { if (r.error) toast.error(r.error); else toast.success('授权已生效'); done(); }, onError: (e: Error) => toast.error(e.message) });
  return <form className="space-y-4" onSubmit={form.handleSubmit(v => save.mutate(v))}>
    <Field label="EAT 用户" htmlFor="aliyun-grant-user" error={form.formState.errors.userId?.message}><Controller control={form.control} name="userId" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="aliyun-grant-user"><SelectValue placeholder="选择用户" /></SelectTrigger><SelectContent>{(users.data ?? []).filter(u => u.status !== 'disabled').map(u => <SelectItem key={u.id} value={u.id}>{u.name}（{u.email}）</SelectItem>)}</SelectContent></Select>} /></Field>
    {users.isError && <p role="alert" className="text-sm text-destructive">用户列表加载失败<Button type="button" variant="ghost" onClick={() => void users.refetch()}>重试</Button></p>}
    <div className="flex justify-end"><Button type="submit" loading={save.isPending} disabled={users.isPending || users.isError}>授予权限</Button></div>
  </form>;
}
function RevokeForm({ row, done }: { row: AliyunGrantInfo; done(): void }) {
  const form = useForm<RevokeAliyunGrantRequest>({ resolver: zodResolver(revokeAliyunGrantSchema.required()), defaultValues: { reason: '' } });
  const save = useMutation({ mutationFn: (v: RevokeAliyunGrantRequest) => api<AliyunGrantInfo>('POST', `/api/aliyun/grants/${row.id}/revoke`, v),
    onSuccess: r => { if (r.error) toast.error(r.error); else toast.success('授权已撤销'); done(); }, onError: (e: Error) => toast.error(e.message) });
  return <form className="space-y-4" onSubmit={form.handleSubmit(v => save.mutate(v))}><Field label="撤销原因（选填）" htmlFor="aliyun-revoke-reason" error={form.formState.errors.reason?.message}><Textarea id="aliyun-revoke-reason" {...form.register('reason')} /></Field><div className="flex justify-end"><Button type="submit" variant="destructive" loading={save.isPending}>撤销授权</Button></div></form>;
}

/** Secrets stay in this component's memory and never enter the shared query cache. */
function AliyunKeyCard({ connectionId, connectionName, paused, authorized }: { connectionId: string; connectionName: string; paused: boolean; authorized: boolean }) {
  const [credentials, setCredentials] = useState<AliyunCredentials | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (reset: boolean) => {
    setBusy(true);
    try { setCredentials(await api<AliyunCredentials>('POST', `/api/aliyun/connections/${connectionId}/credentials${reset ? '/reset' : ''}`)); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 border-t pt-3">
    <h3 className="text-sm font-medium">个人凭证</h3>
    <p className="text-xs text-muted-foreground">{ALIYUN_CREDENTIAL_NOTE}同一云账号下的 OSS 空间也使用这把 Key。</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!authorized || busy} loading={busy} onClick={() => credentials ? setCredentials(null) : void load(false)}>{credentials ? '隐藏 Key' : '查看 / 领取 Key'}</Button>
      <Confirm title="重置这个云账号的个人 Key？" description="同一云账号下的 OSS 空间也在使用这把 Key。新 Key 生效后旧 Key 将失效，请更新本人的临时使用配置；不要用于线上服务。" confirmText="重置 Key" onConfirm={() => void load(true)}>
        <Button size="sm" variant="outline-destructive" disabled={!authorized || paused || busy}>重置 Key</Button>
      </Confirm>
    </div>
    {paused && <p className="text-xs text-muted-foreground">接入已暂停，不能新领或重置；已有 Key 照常可读。</p>}
    {!authorized && <p className="text-xs text-muted-foreground">需要先取得此云账号的有效授权。</p>}
    {authorized && credentials && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-muted/50 p-3 text-xs">
      <dt className="text-muted-foreground">AccessKey ID</dt><dd className="flex min-w-0 items-center gap-1"><code className="break-all">{credentials.accessKeyId}</code><CopyButton text={credentials.accessKeyId} /></dd>
      <dt className="text-muted-foreground">AccessKey Secret</dt><dd className="flex min-w-0 items-center gap-1"><code className="break-all">{credentials.accessKeySecret}</code><CopyButton text={credentials.accessKeySecret} /></dd>
    </dl>}
    <Cmd text={`eat aliyun run ${connectionName} -- aliyun sts GetCallerIdentity`} />
  </div>;
}
