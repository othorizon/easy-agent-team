import type { DistillRequest, HelpRequestDetail } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Send } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Confirm } from '../components/confirm';
import { Field, rules } from '../components/form';
import { PageLoading } from '../components/page-loading';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { formatDateTime } from '../lib/utils';
import { HELP_STATUS_BADGE } from './Help';

export function HelpDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = getStoredUser();
  const [distilling, setDistilling] = useState(false);

  const detail = useQuery({
    queryKey: ['help', id],
    queryFn: () => api<HelpRequestDetail>('GET', `/api/help-requests/${id}`),
    refetchInterval: 15_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['help', id] });

  const reply = useMutation({
    mutationFn: (content: string) => api('POST', `/api/help-requests/${id}/reply`, { content }),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '回复失败'),
  });
  const resolve = useMutation({
    mutationFn: () => api('POST', `/api/help-requests/${id}/resolve`, {}),
    onSuccess: () => {
      toast.success('已标记解决');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/help-requests/${id}`),
    onSuccess: () => {
      toast.success('已删除');
      void queryClient.invalidateQueries({ queryKey: ['help-mine'] });
      void queryClient.invalidateQueries({ queryKey: ['help-inbox'] });
      navigate('/help');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });
  const distill = useMutation({
    mutationFn: (v: DistillRequest) => api('POST', `/api/help-requests/${id}/distill`, v),
    onSuccess: (res: unknown) => {
      const r = res as { skillSlug: string; aiUsed: boolean };
      toast.success(`已沉淀为经验 ${r.skillSlug}${r.aiUsed ? '（AI 整理）' : '（模板生成）'}`);
      setDistilling(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '沉淀失败'),
  });

  const replyForm = useForm<{ content: string }>({ defaultValues: { content: '' } });

  if (!detail.data) return <PageLoading />;
  const r = detail.data;
  const isHelper = me?.id === r.helperId;
  const isRequester = me?.id === r.requesterId;

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/help"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          求助
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{r.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">{HELP_STATUS_BADGE[r.status]}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(isRequester || isHelper) && r.status !== 'resolved' && r.status !== 'closed' && (
              <Button variant="outline" onClick={() => resolve.mutate()} loading={resolve.isPending}>
                标记已解决
              </Button>
            )}
            {isHelper && r.status === 'resolved' && !r.experienceSkillSlug && (
              <Button onClick={() => setDistilling(true)}>沉淀为经验</Button>
            )}
            {(isRequester || me?.role === 'admin') && !r.experienceSkillSlug && (
              <Confirm
                title="删除这条求助？"
                description="对话记录将一并删除，不可恢复。"
                confirmText="删除"
                onConfirm={() => remove.mutate()}
              >
                <Button variant="outline-destructive" loading={remove.isPending}>
                  删除
                </Button>
              </Confirm>
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {r.requesterName} 向 {r.helperName} 求助
            {r.skillSlug && (
              <>
                ，关联 skill <InlineCode>{r.skillSlug}</InlineCode>
              </>
            )}
            {r.experienceSkillSlug && (
              <>
                ，已沉淀为经验{' '}
                <Link to={`/skills/${r.experienceSkillSlug}`}>
                  <InlineCode className="text-primary hover:underline">{r.experienceSkillSlug}</InlineCode>
                </Link>
              </>
            )}
          </p>
          <div className="mt-4 flex flex-col gap-3 text-sm leading-relaxed">
            <div>
              <div className="mb-1 font-medium">问题</div>
              <p className="whitespace-pre-wrap text-foreground/85">{r.description}</p>
            </div>
            <div>
              <div className="mb-1 font-medium">已尝试</div>
              <p className="whitespace-pre-wrap text-foreground/85">{r.tried}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-4 text-sm font-semibold">对话</h2>
          <div className="flex flex-col gap-4">
            {r.messages.length === 0 && <p className="text-sm text-muted-foreground">还没有回复</p>}
            {r.messages.map((m) => (
              <div key={m.id} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {m.senderName.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{m.senderName}</span>
                    {m.senderId === r.helperId && (
                      <Badge variant="secondary" className="px-1.5 text-[10px]">
                        被求助者
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">{formatDateTime(m.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{m.content}</p>
                </div>
              </div>
            ))}
            {r.status !== 'closed' && (
              <form
                className="mt-1 flex flex-col gap-2 border-t pt-4"
                onSubmit={replyForm.handleSubmit((v) => {
                  reply.mutate(v.content);
                  replyForm.reset();
                })}
              >
                <Textarea
                  rows={3}
                  placeholder="回复 / 追问…"
                  aria-invalid={!!replyForm.formState.errors.content}
                  {...replyForm.register('content', { required: true })}
                />
                <Button type="submit" loading={reply.isPending} className="w-fit">
                  <Send />
                  发送
                </Button>
              </form>
            )}
          </div>
        </CardContent>
      </Card>

      {distilling && (
        <DistillDialog
          requesterName={r.requesterName}
          pending={distill.isPending}
          onClose={() => setDistilling(false)}
          onSubmit={(v) => distill.mutate(v)}
        />
      )}
    </div>
  );
}

function DistillDialog({
  requesterName,
  pending,
  onClose,
  onSubmit,
}: {
  requesterName: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: DistillRequest) => void;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<DistillRequest>({
    defaultValues: { public: false, grantedToRequester: true, grantedToHelper: false, useAi: true, slug: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>沉淀为经验</DialogTitle>
          <DialogDescription>
            经验会以 Skill 的形式进入选定成员的 Skill 库（下次 eat sync 落地）。内容默认由平台 AI
            从问答整理成草稿，之后你可以随时在 Skill 页修改——只有你（被求助者）有修改权。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) => onSubmit({ ...v, slug: v.slug || undefined }))}
        >
          <Field label="公开到团队经验库" hint="否则仅求助双方可见">
            <Controller
              control={control}
              name="public"
              render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Field>
          <Field label={`沉淀给求助者（${requesterName}）`}>
            <Controller
              control={control}
              name="grantedToRequester"
              render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Field>
          <Field label="沉淀给我自己">
            <Controller
              control={control}
              name="grantedToHelper"
              render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Field>
          <Field label="用平台 AI 整理草稿" hint="未配置或失败时回退为模板">
            <Controller
              control={control}
              name="useAi"
              render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Field>
          <Field label="经验标识" htmlFor="distill-slug" hint="可选，默认自动生成" error={errors.slug?.message}>
            <Input
              id="distill-slug"
              placeholder="exp-duizhang"
              className="font-mono"
              aria-invalid={!!errors.slug}
              {...register('slug', { pattern: rules.slug })}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            沉淀
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
