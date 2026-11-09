import { registerExternalDbSchema, type DbCatalogInfo, type DbInstanceInfo, type DbPublicCheck, type RegisterExternalDbRequest, type UserPublic } from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { CodeBlock, CopyButton, InlineCode } from '../components/code';
import { DataTable } from '../components/data-table';
import { Field, firstErrorMessage } from '../components/form';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

export function ExternalDbDialog({ instance, done, close }: { instance: DbInstanceInfo; done: () => void; close: () => void }) {
  const [result, setResult] = useState<DbCatalogInfo | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<(UserPublic & { status?: string })[]>('GET', '/api/users') });
  const form = useForm({ resolver: zodResolver(registerExternalDbSchema), defaultValues: { dbName: '', ownerId: '', schemas: ['public'], creatorRole: null } });
  const save = useMutation({ mutationFn: (v: RegisterExternalDbRequest) => api<DbCatalogInfo>('POST', `/api/db/instances/${instance.id}/access/catalog`, v), onSuccess: row => { setResult(row); done(); toast.success('外部库已登记'); } });
  return <Dialog open onOpenChange={v => !v && close()}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{result ? '外部库登记结果' : '登记外部库'}</DialogTitle><DialogDescription>{instance.name} · 只支持 PostgreSQL。登记后由 Owner 管理授权；PUBLIC 和已有角色的权限由 DBA 决定是否收紧。</DialogDescription></DialogHeader>
    {result ? <div className="space-y-4"><p><InlineCode>{result.dbName}</InlineCode> · Owner：{result.ownerName}</p>{result.publicCheck && <DbPublicCheckReport check={result.publicCheck} />}<Button className="w-full" onClick={close}>完成</Button></div> : <form className="space-y-4" onSubmit={form.handleSubmit(v => save.mutate(v))}>
      <Field label="库名" htmlFor="external-name" required error={form.formState.errors.dbName?.message}><Input id="external-name" {...form.register('dbName')} /></Field>
      <Field label="Owner" required error={form.formState.errors.ownerId?.message}><Controller control={form.control} name="ownerId" render={({ field }) => <Select value={field.value || undefined} onValueChange={field.onChange}><SelectTrigger><SelectValue placeholder="选择 EAT 用户" /></SelectTrigger><SelectContent>{(users.data ?? []).filter(u => u.status !== 'disabled').map(u => <SelectItem key={u.id} value={u.id}>{u.name}（{u.email}）</SelectItem>)}</SelectContent></Select>} /></Field>
      <Field label="Schema" htmlFor="external-schemas" required hint="逗号分隔，请先在外部库中创建。"><Controller control={form.control} name="schemas" render={({ field }) => <Input id="external-schemas" value={(field.value ?? []).join(', ')} onChange={e => field.onChange(e.target.value.split(/[,，]/).map(v => v.trim()))} />} /></Field>
      <Field label="建表角色（可选）" htmlFor="external-creator" hint="填写后，该角色未来新建的表自动授权；留空时请在建表后重新应用授权。" error={form.formState.errors.creatorRole?.message}><Controller control={form.control} name="creatorRole" render={({ field }) => <Input id="external-creator" value={field.value ?? ''} onChange={e => field.onChange(e.target.value || null)} />} /></Field>
      {users.isError && <p role="alert" className="text-sm text-destructive">用户列表加载失败<Button type="button" variant="ghost" onClick={() => void users.refetch()}>重试</Button></p>}
      {save.error && <div role="alert" className="space-y-1 text-sm text-destructive"><p>登记失败，请根据提示联系 DBA 后重试。</p><CodeBlock>{save.error instanceof ApiError ? save.error.message : '操作失败，请重试'}</CodeBlock></div>}
      <p role="alert" className="text-sm text-destructive">{firstErrorMessage(form.formState.errors)}</p>
      <Button type="submit" className="w-full" loading={save.isPending} disabled={users.isLoading || users.isError}>校验并登记</Button>
    </form>}
  </DialogContent></Dialog>;
}

export function DbPublicCheckReport({ check }: { check: DbPublicCheck }) {
  const sql = check.tighteningSql.join('\n');
  const tableText = (tables: DbPublicCheck['tables']) => tables.map(t => `${t.schema}.${t.table}：${t.privileges.join(', ')}`).join('；') || '无';
  return <div className="space-y-4 text-sm">
    <p className="text-muted-foreground">检查时间：{new Date(check.checkedAt).toLocaleString()}。以下是已有的有效权限；撤销 EAT 授权不会清除这些权限。</p>
    <dl className="grid grid-cols-2 gap-2"><dt>PUBLIC CONNECT</dt><dd>{check.connect ? '允许' : '不允许'}</dd><dt>PUBLIC 在 public 的 CREATE</dt><dd>{check.publicSchemaCreate ? '允许' : '不允许'}</dd></dl>
    <p className="break-all">PUBLIC 表权限：{tableText(check.tables)}</p>
    <details><summary className="cursor-pointer">已有角色的有效权限与继承</summary><DataTable columns={[
      { accessorKey: 'role', header: '角色' },
      { id: 'inherited', header: '继承自', cell: ({ row: { original: r } }) => <span className="break-all">{r.inheritedFrom.join(', ') || '无'}</span> },
      { id: 'effective', header: '有效权限', cell: ({ row: { original: r } }) => <div className="space-y-1 break-all"><p>CONNECT：{r.connect ? '允许' : '不允许'}</p><p>Schema CREATE：{r.schemaCreate.join(', ') || '无'}</p><p>{tableText(r.tables)}</p></div> },
    ]} data={check.roles} getRowId={r => r.role} /></details>
    {sql && <div className="space-y-2"><div className="flex items-center gap-2"><p className="font-medium">供 DBA 评估的收紧 SQL</p><CopyButton text={sql} /></div><p className="text-xs text-muted-foreground">EAT 不执行这些 SQL。会影响通过 PUBLIC 或已有角色访问的其他应用，请由 DBA 确认。</p><CodeBlock>{sql}</CodeBlock></div>}
  </div>;
}
