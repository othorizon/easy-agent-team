import type { EnvironmentInfo, McpConfigInfo, SetTemplateItemsRequest, SkillInfo, TemplateInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { TableSkeleton } from '../components/ui/skeleton';

const TYPE_LABEL: Record<string, string> = { skill: 'Skill', mcp_config: 'MCP', environment: '环境' };

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const [creating, setCreating] = useState(false);
  const [editingItems, setEditingItems] = useState<TemplateInfo | null>(null);

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<TemplateInfo[]>('GET', '/api/templates') });
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<SkillInfo[]>('GET', '/api/skills'), enabled: isAdmin });
  const mcpConfigs = useQuery({ queryKey: ['mcp-configs'], queryFn: () => api<McpConfigInfo[]>('GET', '/api/mcp-configs'), enabled: isAdmin });
  const envs = useQuery({ queryKey: ['envs'], queryFn: () => api<EnvironmentInfo[]>('GET', '/api/envs'), enabled: isAdmin });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['templates'] });

  const create = useMutation({
    mutationFn: (v: { name: string; description: string }) => api('POST', '/api/templates', v),
    onSuccess: () => {
      toast.success('模板已创建，接着为它配置条目');
      setCreating(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const setItems = useMutation({
    mutationFn: (v: { id: string } & SetTemplateItemsRequest) => api('PUT', `/api/templates/${v.id}/items`, { items: v.items }),
    onSuccess: () => {
      toast.success('条目已保存');
      setEditingItems(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const select = useMutation({
    mutationFn: (t: TemplateInfo) => api('POST', t.selectedByMe ? '/api/templates/deselect' : `/api/templates/${t.id}/select`, {}),
    onSuccess: (_d, t) => {
      toast.success(t.selectedByMe ? '已取消选用' : '已选用，本地 eat sync 即可获得模板内容');
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/templates/${id}`),
    onSuccess: () => {
      toast.success('已删除');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="角色模板"
        description="模板是管理员预定义的「能力套餐」（一组 Skill + MCP 配置 + 环境引用）。选用后，模板里的 Skill 与 MCP 配置自动进入你的同步范围（eat sync 落地），不想要的条目可以单独退订。"
        actions={
          isAdmin && (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              新建模板
            </Button>
          )
        }
      />

      {templates.isLoading ? (
        <TableSkeleton />
      ) : (templates.data ?? []).length === 0 ? (
        <Card>
          <CardContent>
            <Empty text="还没有模板" />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(templates.data ?? []).map((t) => (
            <Card key={t.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    {t.name}
                    {t.selectedByMe && (
                      <Badge variant="success">
                        <Check />
                        已选用
                      </Badge>
                    )}
                  </h2>
                </div>
                {t.description && <p className="text-sm leading-relaxed text-muted-foreground">{t.description}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {t.items.length === 0 ? (
                    <span className="text-sm text-muted-foreground">（空模板）</span>
                  ) : (
                    t.items.map((i) => (
                      <Badge key={`${i.itemType}:${i.itemId}`} variant="secondary" className="font-normal">
                        {TYPE_LABEL[i.itemType]} · {i.slug}
                      </Badge>
                    ))
                  )}
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant={t.selectedByMe ? 'outline' : 'default'}
                    onClick={() => select.mutate(t)}
                  >
                    {t.selectedByMe ? '取消选用' : '选用'}
                  </Button>
                  {isAdmin && (
                    <Button size="sm" variant="outline" onClick={() => setEditingItems(t)}>
                      配置条目
                    </Button>
                  )}
                  {isAdmin && (
                    <Confirm
                      title={`删除模板「${t.name}」？`}
                      description="已选用成员的同步范围将不再包含该模板内容。"
                      confirmText="删除"
                      onConfirm={() => remove.mutate(t.id)}
                    >
                      <Button size="sm" variant="outline-destructive">
                        删除
                      </Button>
                    </Confirm>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {creating && (
        <CreateTemplateDialog
          pending={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(v) => create.mutate(v)}
        />
      )}
      {editingItems && (
        <TemplateItemsDialog
          template={editingItems}
          skills={skills.data ?? []}
          mcpConfigs={mcpConfigs.data ?? []}
          envs={envs.data ?? []}
          pending={setItems.isPending}
          onClose={() => setEditingItems(null)}
          onSubmit={(items) => setItems.mutate({ id: editingItems.id, items })}
        />
      )}
    </div>
  );
}

function CreateTemplateDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: { name: string; description: string }) => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<{ name: string; description: string }>({
    defaultValues: { name: '', description: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建模板</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="名称" htmlFor="tpl-name" required error={errors.name?.message}>
            <Input id="tpl-name" placeholder="运营 / 测试 / 客服…" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field label="说明" htmlFor="tpl-desc" hint="适用于哪类岗位、包含什么能力">
            <Textarea id="tpl-desc" rows={2} {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CheckList({
  title,
  options,
  checked,
  onToggle,
}: {
  title: React.ReactNode;
  options: Array<{ id: string; label: string }>;
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">{title}</div>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">（暂无可选项）</p>
      ) : (
        <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto rounded-md border p-1.5">
          {options.map((opt) => (
            <Label
              key={opt.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-normal hover:bg-accent"
            >
              <Checkbox checked={checked.has(opt.id)} onCheckedChange={() => onToggle(opt.id)} />
              <span className="truncate text-sm">{opt.label}</span>
            </Label>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateItemsDialog({
  template,
  skills,
  mcpConfigs,
  envs,
  pending,
  onClose,
  onSubmit,
}: {
  template: TemplateInfo;
  skills: SkillInfo[];
  mcpConfigs: McpConfigInfo[];
  envs: EnvironmentInfo[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (items: SetTemplateItemsRequest['items']) => void;
}) {
  const initial = (type: string) => new Set(template.items.filter((i) => i.itemType === type).map((i) => i.itemId));
  const [skillIds, setSkillIds] = useState<Set<string>>(() => initial('skill'));
  const [mcpIds, setMcpIds] = useState<Set<string>>(() => initial('mcp_config'));
  const [envIds, setEnvIds] = useState<Set<string>>(() => initial('environment'));

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void) => (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>配置条目：{template.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <CheckList
            title="Skill"
            options={skills.map((s) => ({ id: s.id, label: `${s.slug} — ${s.name}` }))}
            checked={skillIds}
            onToggle={toggle(skillIds, setSkillIds)}
          />
          <CheckList
            title="MCP 配置"
            options={mcpConfigs.map((c) => ({ id: c.id, label: `${c.slug} — ${c.name}` }))}
            checked={mcpIds}
            onToggle={toggle(mcpIds, setMcpIds)}
          />
          <CheckList
            title="环境引用（展示引导用，不代表授权）"
            options={envs.map((e) => ({ id: e.id, label: `${e.slug} — ${e.name}` }))}
            checked={envIds}
            onToggle={toggle(envIds, setEnvIds)}
          />
          <Button
            loading={pending}
            className="w-full"
            onClick={() =>
              onSubmit([
                ...[...skillIds].map((id) => ({ itemType: 'skill' as const, itemId: id })),
                ...[...mcpIds].map((id) => ({ itemType: 'mcp_config' as const, itemId: id })),
                ...[...envIds].map((id) => ({ itemType: 'environment' as const, itemId: id })),
              ])
            }
          >
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
