import type { McpConfigInfo, UpsertMcpConfigRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

export function McpConfigsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [editing, setEditing] = useState<McpConfigInfo | 'new' | null>(null);

  const configs = useQuery({ queryKey: ['mcp-configs'], queryFn: () => api<McpConfigInfo[]>('GET', '/api/mcp-configs') });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['mcp-configs'] });

  const upsert = useMutation({
    mutationFn: (v: UpsertMcpConfigRequest) => api('POST', '/api/mcp-configs', v),
    onSuccess: () => {
      toast.success('已保存');
      setEditing(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const toggleSubscribe = useMutation({
    mutationFn: (c: McpConfigInfo) => api(c.subscribed ? 'DELETE' : 'POST', `/api/mcp-configs/${c.slug}/subscribe`),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api('DELETE', `/api/mcp-configs/${slug}`),
    onSuccess: () => {
      toast.success('已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="MCP 配置"
        description={
          <>
            团队共享的 MCP Server 配置。敏感值写成引用 <InlineCode>{'${env:环境slug/KEY}'}</InlineCode>——订阅后{' '}
            <InlineCode>eat sync</InlineCode> 会按你的权限渲染出可用配置（无权限的引用保留占位并提示申请）。
          </>
        }
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus />
            新建配置
          </Button>
        }
      />
      <Card>
        <CardContent>
          {configs.isLoading ? (
            <TableSkeleton />
          ) : (configs.data ?? []).length === 0 ? (
            <Empty text="还没有 MCP 配置" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>配置</TableHead>
                  <TableHead className="hidden md:table-cell">说明</TableHead>
                  <TableHead className="hidden w-18 sm:table-cell">传输</TableHead>
                  <TableHead className="hidden w-24 lg:table-cell">作者</TableHead>
                  <TableHead className="hidden w-20 sm:table-cell">可见性</TableHead>
                  <TableHead className="w-44">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(configs.data ?? []).map((c) => {
                  const canManage = c.ownerId === me?.id || me?.role === 'admin';
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <InlineCode>{c.slug}</InlineCode>
                          <span className="font-medium">{c.name}</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{c.description}</div>
                      </TableCell>
                      <TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">
                        {c.description}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary">{c.transport}</Badge>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">{c.ownerName}</TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {c.visibility === 'private' ? <Badge variant="outline">私有</Badge> : <Badge>团队</Badge>}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            size="sm"
                            variant={c.subscribed ? 'outline' : 'default'}
                            onClick={() => toggleSubscribe.mutate(c)}
                          >
                            {c.subscribed ? '退订' : '订阅'}
                          </Button>
                          {canManage && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => setEditing(c)}>
                                编辑
                              </Button>
                              <Confirm
                                title={`删除配置 ${c.slug}？`}
                                description="订阅者本地的该配置会在下次 sync 时移除。"
                                confirmText="删除"
                                onConfirm={() => remove.mutate(c.slug)}
                              >
                                <Button size="sm" variant="outline-destructive">
                                  删除
                                </Button>
                              </Confirm>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editing !== null && (
        <McpConfigDialog
          editing={editing}
          pending={upsert.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(v) => upsert.mutate(v)}
        />
      )}
    </div>
  );
}

interface FormValues {
  slug: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string;
  argsText: string;
  url: string;
  envPairs: Array<{ key: string; value: string }>;
  visibility: 'team' | 'private';
}

function McpConfigDialog({
  editing,
  pending,
  onClose,
  onSubmit,
}: {
  editing: McpConfigInfo | 'new';
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: UpsertMcpConfigRequest) => void;
}) {
  const isNew = editing === 'new';
  const { register, handleSubmit, control, watch, formState: { errors } } = useForm<FormValues>({
    defaultValues: isNew
      ? { slug: '', name: '', description: '', transport: 'stdio', command: '', argsText: '', url: '', envPairs: [], visibility: 'team' }
      : {
          slug: editing.slug,
          name: editing.name,
          description: editing.description,
          transport: editing.transport,
          command: editing.command ?? '',
          argsText: editing.args.join(' '),
          url: editing.url ?? '',
          envPairs: Object.entries(editing.env).map(([key, value]) => ({ key, value })),
          visibility: editing.visibility,
        },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'envPairs' });
  const transport = watch('transport');

  function toPayload(v: FormValues): UpsertMcpConfigRequest {
    return {
      slug: v.slug,
      name: v.name,
      description: v.description ?? '',
      transport: v.transport,
      command: v.transport === 'stdio' ? v.command : undefined,
      args: v.transport === 'stdio' && v.argsText ? v.argsText.split(/\s+/).filter(Boolean) : [],
      url: v.transport === 'http' ? v.url : undefined,
      headers: {},
      env: Object.fromEntries(v.envPairs.filter((p) => p.key).map((p) => [p.key, p.value ?? ''])),
      visibility: v.visibility,
    };
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? '新建 MCP 配置' : `编辑 ${editing.slug}`}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit((v) => onSubmit(toPayload(v)))}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标识（slug）" htmlFor="mcp-slug" required error={errors.slug?.message}>
              <Input
                id="mcp-slug"
                placeholder="internal-api"
                className="font-mono"
                disabled={!isNew}
                aria-invalid={!!errors.slug}
                {...register('slug', { required: '请输入标识', pattern: rules.slug })}
              />
            </Field>
            <Field label="名称" htmlFor="mcp-name" required error={errors.name?.message}>
              <Input id="mcp-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
            </Field>
          </div>
          <Field label="说明" htmlFor="mcp-desc" hint="这个 MCP 能做什么">
            <Textarea id="mcp-desc" rows={2} {...register('description')} />
          </Field>
          <Field label="传输方式" required>
            <Controller
              control={control}
              name="transport"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: 'stdio（本地命令）', value: 'stdio' },
                    { label: 'http', value: 'http' },
                  ]}
                />
              )}
            />
          </Field>
          {transport === 'stdio' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="命令" htmlFor="mcp-command" required error={errors.command?.message}>
                <Input
                  id="mcp-command"
                  placeholder="npx"
                  className="font-mono"
                  aria-invalid={!!errors.command}
                  {...register('command', {
                    validate: (v) => transport !== 'stdio' || !!v.trim() || '请输入命令',
                  })}
                />
              </Field>
              <Field label="参数" htmlFor="mcp-args" hint="空格分隔">
                <Input id="mcp-args" placeholder="-y some-mcp-server" className="font-mono" {...register('argsText')} />
              </Field>
            </div>
          ) : (
            <Field label="URL" htmlFor="mcp-url" required error={errors.url?.message}>
              <Input
                id="mcp-url"
                placeholder="https://mcp.internal.example.com/sse"
                className="font-mono"
                aria-invalid={!!errors.url}
                {...register('url', {
                  validate: (v) => transport !== 'http' || !!v.trim() || '请输入 URL',
                })}
              />
            </Field>
          )}
          <Field
            label="环境变量"
            hint={
              <>
                值可写 <InlineCode>{'${env:slug/KEY}'}</InlineCode> 引用平台环境变量
              </>
            }
          >
            <div className="flex flex-col gap-2">
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2">
                  <Input
                    placeholder="API_TOKEN"
                    className="w-2/5 font-mono"
                    {...register(`envPairs.${index}.key`)}
                  />
                  <Input
                    placeholder={'${env:internal/API_TOKEN}'}
                    className="flex-1 font-mono"
                    {...register(`envPairs.${index}.value`)}
                  />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="删除该变量" onClick={() => remove(index)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => append({ key: '', value: '' })}
              >
                <Plus />
                添加变量
              </Button>
            </div>
          </Field>
          <Field label="可见性">
            <Controller
              control={control}
              name="visibility"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: '团队可见', value: 'team' },
                    { label: '私有', value: 'private' },
                  ]}
                />
              )}
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
