import type { HelperInfo, HelpRequestInfo, HelpTargets, UpsertHelperProfileRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Combobox } from '../components/combobox';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime } from '../lib/utils';

export const HELP_STATUS_BADGE: Record<string, JSX.Element> = {
  open: <Badge variant="warning">等待回复</Badge>,
  answered: <Badge>已回复</Badge>,
  resolved: <Badge variant="success">已解决</Badge>,
  closed: <Badge variant="outline">已关闭</Badge>,
};

type MyProfile =
  | { registered: false }
  | {
      registered: true;
      description: string;
      webhookUrl: string;
      hasWebhookSecret: boolean;
      notifyHelp: boolean;
      notifyReply: boolean;
      available: boolean;
    };

export function HelpPage() {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);

  const profile = useQuery({ queryKey: ['helper-me'], queryFn: () => api<MyProfile>('GET', '/api/helpers/me') });
  const targets = useQuery({ queryKey: ['help-targets'], queryFn: () => api<HelpTargets>('GET', '/api/helpers') });
  const inbox = useQuery({ queryKey: ['help-inbox'], queryFn: () => api<HelpRequestInfo[]>('GET', '/api/help-requests/inbox') });
  const mine = useQuery({ queryKey: ['help-mine'], queryFn: () => api<HelpRequestInfo[]>('GET', '/api/help-requests/mine') });

  const saveProfile = useMutation({
    mutationFn: (v: UpsertHelperProfileRequest) => api<MyProfile>('PUT', '/api/helpers/me', v),
    onSuccess: () => {
      toast.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['helper-me'] });
      void queryClient.invalidateQueries({ queryKey: ['help-targets'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const createRequest = useMutation({
    mutationFn: (v: { title: string; description: string; tried: string; target: string }) => {
      const [kind, value] = v.target.split(':', 2);
      return api('POST', '/api/help-requests', {
        title: v.title,
        description: v.description,
        tried: v.tried,
        ...(kind === 'helper' ? { helperUserId: value } : { skillSlug: value }),
      });
    },
    onSuccess: () => {
      toast.success('求助已发出');
      setAsking(false);
      void queryClient.invalidateQueries({ queryKey: ['help-mine'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '发起失败'),
  });

  function RequestTable({ rows, dir, loading, emptyText }: { rows: HelpRequestInfo[]; dir: 'in' | 'out'; loading: boolean; emptyText: React.ReactNode }) {
    if (loading) return <TableSkeleton rows={2} />;
    if (rows.length === 0) return <Empty text={emptyText} className="py-6" />;
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标题</TableHead>
            <TableHead className="hidden w-28 sm:table-cell">{dir === 'in' ? '求助者' : '被求助者'}</TableHead>
            <TableHead className="hidden w-36 lg:table-cell">关联 skill</TableHead>
            <TableHead className="w-24">状态</TableHead>
            <TableHead className="hidden w-36 md:table-cell">更新时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link to={`/help/${r.id}`} className="font-medium text-primary hover:underline">
                  {r.title}
                </Link>
                <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">
                  {dir === 'in' ? r.requesterName : r.helperName} · {formatDateTime(r.updatedAt)}
                </div>
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {dir === 'in' ? r.requesterName : r.helperName}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {r.skillSlug ? <InlineCode>{r.skillSlug}</InlineCode> : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>{HELP_STATUS_BADGE[r.status]}</TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">{formatDateTime(r.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="求助"
        description="遇到 AI 解决不了的问题时向擅长的同事求助；也可以登记为可求助者，帮助他人并沉淀经验。"
        actions={
          <Button onClick={() => setAsking(true)}>
            <Plus />
            发起求助
          </Button>
        }
      />

      <Card>
        <CardContent>
          <h2 className="mb-1 text-sm font-semibold">我的可求助登记</h2>
          <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
            登记后，其他成员（和他们的 AI）遇到你擅长的问题时会来求助。「能力描述」会被 AI 读取用于选择求助对象，请写清楚擅长领域。
          </p>
          {profile.data && (
            <ProfileForm
              key={profile.data.registered ? 'registered' : 'new'}
              profile={profile.data}
              pending={saveProfile.isPending}
              onSubmit={(v) => saveProfile.mutate(v)}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">找我的求助</h2>
          <RequestTable rows={inbox.data ?? []} dir="in" loading={inbox.isLoading} emptyText="暂无" />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">我发起的求助</h2>
          <RequestTable
            rows={mine.data ?? []}
            dir="out"
            loading={mine.isLoading}
            emptyText="暂无。AI 也可以通过 MCP 的 create_help_request 替你发起。"
          />
        </CardContent>
      </Card>

      {asking && (
        <AskDialog
          targets={targets.data}
          pending={createRequest.isPending}
          onClose={() => setAsking(false)}
          onSubmit={(v) => createRequest.mutate(v)}
        />
      )}
    </div>
  );
}

interface ProfileFormValues extends UpsertHelperProfileRequest {
  webhookSecret?: string;
}

function ProfileForm({
  profile,
  pending,
  onSubmit,
}: {
  profile: MyProfile;
  pending: boolean;
  onSubmit: (v: UpsertHelperProfileRequest) => void;
}) {
  const [webhookOpen, setWebhookOpen] = useState(false);
  const { register, handleSubmit, control } = useForm<ProfileFormValues>({
    defaultValues: profile.registered
      ? { ...profile, webhookSecret: '' }
      : { description: '', webhookUrl: '', webhookSecret: '', notifyHelp: true, notifyReply: true, available: true },
  });
  const webhookConfigured = profile.registered && !!profile.webhookUrl;
  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
      <Field label="能力描述" htmlFor="helper-desc" hint="AI 会读取，可留空">
        <Textarea id="helper-desc" rows={2} placeholder="例如：熟悉支付对账、内部 ERP 系统、部署流程" {...register('description')} />
      </Field>

      <Collapsible open={webhookOpen} onOpenChange={setWebhookOpen} className="rounded-lg border">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium cursor-pointer">
          <span className="flex flex-wrap items-center gap-2">
            飞书群机器人通知
            {webhookConfigured ? <Badge variant="success">已配置</Badge> : <Badge variant="outline">未配置</Badge>}
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${webhookOpen ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-4 border-t px-4 py-4">
            <Field label="飞书机器人 Webhook 地址" htmlFor="helper-webhook" hint="求助/回复以卡片消息推送到该飞书群">
              <Input id="helper-webhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." {...register('webhookUrl')} />
            </Field>
            <Field
              label="飞书加签密钥"
              htmlFor="helper-secret"
              hint={
                profile.registered && profile.hasWebhookSecret
                  ? '已配置加签密钥；留空保持不变，重新填写则覆盖'
                  : '可选：机器人开启「签名校验」时，从飞书复制粘贴到这里；未开加签则留空'
              }
            >
              <Input
                id="helper-secret"
                type="password"
                placeholder="飞书机器人安全设置里的签名密钥"
                autoComplete="new-password"
                {...register('webhookSecret')}
              />
            </Field>
            <Field label="接收求助" hint="找我的新求助推送到群">
              <Controller
                control={control}
                name="notifyHelp"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            </Field>
            <Field label="接收回复" hint="我参与的求助有新回复时推送到群">
              <Controller
                control={control}
                name="notifyReply"
                render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
              />
            </Field>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Field label="接单状态" hint="关闭 = 勿扰，不出现在候选名单">
        <Controller
          control={control}
          name="available"
          render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
        />
      </Field>
      <Button type="submit" loading={pending} className="w-fit">
        {profile.registered ? '更新登记' : '登记为可求助者'}
      </Button>
    </form>
  );
}

function AskDialog({
  targets,
  pending,
  onClose,
  onSubmit,
}: {
  targets: HelpTargets | undefined;
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: { title: string; description: string; tried: string; target: string }) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [targetError, setTargetError] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<{ title: string; description: string; tried: string }>({
    defaultValues: { title: '', description: '', tried: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>发起求助</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) => {
            if (!target) {
              setTargetError(true);
              return;
            }
            onSubmit({ ...v, target });
          })}
        >
          <Field label="求助对象" required error={targetError ? '请选择求助对象' : undefined}>
            <Combobox
              groups={[
                {
                  label: '可求助的人',
                  options: (targets?.helpers ?? []).map((h: HelperInfo) => ({
                    value: `helper:${h.userId}`,
                    label: h.name,
                    hint: h.description,
                  })),
                },
                {
                  label: '按 skill 求助（问题与某个 skill 相关时优先）',
                  options: (targets?.skillAuthors ?? []).map((s) => ({
                    value: `skill:${s.skillSlug}`,
                    label: s.skillName,
                    hint: `作者 ${s.authorName}`,
                  })),
                },
              ]}
              value={target}
              onChange={(v) => {
                setTarget(v);
                setTargetError(false);
              }}
              placeholder="选择求助对象…"
              searchPlaceholder="搜索人或 skill…"
            />
          </Field>
          <Field label="问题标题" htmlFor="ask-title" required error={errors.title?.message}>
            <Input id="ask-title" placeholder="一句话说清问题" aria-invalid={!!errors.title} {...register('title', { required: '请输入标题' })} />
          </Field>
          <Field label="问题描述" htmlFor="ask-desc" required error={errors.description?.message}>
            <Textarea
              id="ask-desc"
              rows={4}
              placeholder="背景、报错信息、AI 卡在哪一步（不要粘贴密钥）"
              aria-invalid={!!errors.description}
              {...register('description', { required: '请输入描述' })}
            />
          </Field>
          <Field label="已经尝试过什么" htmlFor="ask-tried" required error={errors.tried?.message}>
            <Textarea
              id="ask-tried"
              rows={2}
              placeholder="例如：搜过经验库、看过某文档"
              aria-invalid={!!errors.tried}
              {...register('tried', { required: '请说明已尝试的办法' })}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            发出
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
