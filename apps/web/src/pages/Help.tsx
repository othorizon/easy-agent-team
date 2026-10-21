import type { AccountInfo, HelperInfo, HelpListResult, HelpTargets, NotificationSettings } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getToken } from '../api';
import { InlineCode } from '../components/code';
import { Combobox } from '../components/combobox';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { PAGE_SIZE_OPTIONS, Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatDateTime } from '../lib/format';
import { useQueryParams } from '../lib/use-query-params';

export const HELP_STATUS_BADGE: Record<string, JSX.Element> = {
  open: <Badge variant="warning">等待回复</Badge>,
  answered: <Badge>已回复</Badge>,
  resolved: <Badge variant="success">已解决</Badge>,
  closed: <Badge variant="outline">已关闭</Badge>,
};

/**
 * 状态筛选与页签（找我的 / 我发起的）是**两个正交的维度**：页签选方向，这里选进展。
 * 「待回复」= 对话还等着某一方回应——`open` 等被求助者回复、`answered` 等求助者确认或追问；
 * 与之相对的 `resolved` / `closed` 是暂时不需要任何人回应的（`resolved` 一有新回复就会被重新打开，决策 65）。默认只看待回复的，
 * 免得已经了结的历史把当下要处理的淹掉；两个页签共用同一个筛选值，切页签不重置。
 */
const PENDING_HINT = '还等着某一方回应的求助：等待回复 + 已回复但未确认解决';

export function HelpPage() {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  // 方向、进展与分页同步到 URL；等于默认值的不写进去。
  const [params, setParams] = useQueryParams({ tab: 'inbox', status: 'pending', page: '1', pageSize: '20' });
  const tab = params.tab === 'mine' ? 'mine' : 'inbox';
  const status = params.status === 'all' ? 'all' : 'pending';
  const requestedPage = Number(params.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize)) ? Number(params.pageSize) : 20;
  const query = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });

  const targets = useQuery({ queryKey: ['help-targets'], queryFn: () => api<HelpTargets>('GET', '/api/helpers') });
  const inbox = useQuery({
    queryKey: ['help-inbox', status, page, pageSize],
    queryFn: () => api<HelpListResult>('GET', `/api/help-requests/inbox/page?${query}`),
  });
  const mine = useQuery({
    queryKey: ['help-mine', status, page, pageSize],
    queryFn: () => api<HelpListResult>('GET', `/api/help-requests/mine/page?${query}`),
  });
  const activeQuery = tab === 'mine' ? mine : inbox;
  useEffect(() => {
    if (activeQuery.data && !activeQuery.isFetching && params.page !== String(activeQuery.data.page)) {
      setParams({ page: String(activeQuery.data.page) });
    }
  }, [activeQuery.data, activeQuery.isFetching, params.page, setParams]);

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

  // tab 角标 = 需要我出手的数量（找我的：等我回复；我发起的：有新回复待我确认），
  // 与分段上的数量不是一回事——那个回答的是「切过去会有几条」，所以两者都留着。
  const inboxOpen = inbox.data?.counts.attention ?? 0;
  const mineAnswered = mine.data?.counts.attention ?? 0;

  // 分段上的数量按**当前页签**算：切页签数字跟着变，切筛选数字不变
  const counts = activeQuery.data?.counts;

  function RequestTable({ data, dir, loading, emptyText }: { data?: HelpListResult; dir: 'in' | 'out'; loading: boolean; emptyText: React.ReactNode }) {
    const rows = data?.items ?? [];
    const allCount = data?.counts.all ?? 0;
    if (loading) return <TableSkeleton rows={2} />;
    const request = dir === 'in' ? inbox : mine;
    if (request.isError) return <Empty text="求助列表加载失败" action={<Button variant="outline" onClick={() => void request.refetch()}>重试</Button>} />;
    if (rows.length === 0) {
      // 全被筛掉和真的一条都没有是两回事：前者要给出口，后者才该讲怎么开始
      return status === 'pending' && allCount > 0 ? (
        <Empty
          className="py-6"
          text={`没有待回复的求助，${allCount} 条已了结的记录都在「全部」里。`}
          action={
            <Button variant="outline" size="sm" onClick={() => setParams({ status: 'all', page: '1' })}>
              查看全部
            </Button>
          }
        />
      ) : (
        <Empty text={emptyText} className="py-6" />
      );
    }
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
        description="遇到 AI 解决不了的问题时向擅长的同事求助；完善用户中心的个人简介，让 AI 找到擅长的同事。"
        actions={
          <>
            <Button variant="outline" onClick={() => setConfiguring(true)}><UserCog />求助设置</Button>
            <Button onClick={() => setAsking(true)}>
              <Plus />
              发起求助
            </Button>
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v, page: '1' })}>
        {/* 两个维度并排一行：左边页签选方向（实心轨道 = 导航），右边分段选进展（描边轨道 = 筛选），
            外观不同才不会被当成同一组开关；窄屏下换行，筛选仍紧挨着清单 */}
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          <TabsList aria-label="求助方向">
            <TabsTrigger value="inbox">
              找我的求助
              {inboxOpen > 0 && <Badge className="px-1.5">{inboxOpen}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="mine">
              我发起的求助
              {mineAnswered > 0 && <Badge className="px-1.5">{mineAnswered}</Badge>}
            </TabsTrigger>
          </TabsList>
          <Segmented
            variant="outline"
            ariaLabel="按进展筛选"
            value={status}
            onChange={(v) => setParams({ status: v, page: '1' })}
            options={[
              {
                value: 'pending',
                label: (
                  <>
                    <span title={PENDING_HINT}>待回复</span>
                    {counts && <span className="text-xs tabular-nums opacity-60">{counts.pending}</span>}
                  </>
                ),
              },
              {
                value: 'all',
                label: (
                  <>
                    全部
                    {counts && <span className="text-xs tabular-nums opacity-60">{counts.all}</span>}
                  </>
                ),
              },
            ]}
          />
        </div>
        <TabsContent value="inbox" className="mt-4">
          <Card>
            <CardContent className="space-y-4">
              <RequestTable
                data={inbox.data}
                dir="in"
                loading={inbox.isLoading}
                emptyText="暂无找你的求助。完善个人简介，并在求助设置中开启「接受他人求助」，同事的 AI 就能找到你。"
              />
              {tab === 'inbox' && !inbox.isLoading && !inbox.isError && inbox.data && (
                <Pagination
                  total={inbox.data.total}
                  page={inbox.data.page}
                  pageSize={pageSize}
                  onPageChange={(value) => setParams({ page: String(value) })}
                  onPageSizeChange={(value) => setParams({ pageSize: String(value), page: '1' })}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="mine" className="mt-4">
          <Card>
            <CardContent className="space-y-4">
              <RequestTable
                data={mine.data}
                dir="out"
                loading={mine.isLoading}
                emptyText="暂无。AI 也可以通过 MCP 的 create_help_request 替你发起。"
              />
              {tab === 'mine' && !mine.isLoading && !mine.isError && mine.data && (
                <Pagination
                  total={mine.data.total}
                  page={mine.data.page}
                  pageSize={pageSize}
                  onPageChange={(value) => setParams({ page: String(value) })}
                  onPageSizeChange={(value) => setParams({ pageSize: String(value), page: '1' })}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {configuring && <HelpSettingsDialog onClose={() => setConfiguring(false)} />}
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

function HelpSettingsDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = ['account', getToken()];
  const account = useQuery({ queryKey, queryFn: () => api<AccountInfo>('GET', '/api/account'), refetchOnMount: 'always' });
  const onError = (err: unknown) => toast.error(err instanceof ApiError ? err.message : '保存失败，请重试');
  const help = useMutation({
    mutationFn: (allowHelp: boolean) => api<AccountInfo>('PATCH', '/api/account', { allowHelp }),
    onSuccess: async (data) => {
      queryClient.setQueryData(queryKey, data);
      toast.success('求助偏好已保存');
      await queryClient.invalidateQueries({ queryKey: ['help-targets'] });
    },
    onError,
  });
  const reply = useMutation({
    mutationFn: (notifyReply: boolean) => api<NotificationSettings>('PATCH', '/api/account/notification/preferences', { notifyReply }),
    onSuccess: (notification) => {
      queryClient.setQueryData<AccountInfo>(queryKey, (data) => data ? { ...data, notification } : data);
      toast.success('回复通知偏好已保存');
    },
    onError,
  });
  const busy = help.isPending || reply.isPending || account.isFetching;
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>求助设置</DialogTitle>
        <DialogDescription>设置是否接受他人求助，以及是否接收回复通知。修改后立即保存。</DialogDescription>
      </DialogHeader>
      {account.isError ? <Empty text="求助设置加载失败" action={<Button onClick={() => void account.refetch()}>重试</Button>} />
        : !account.data ? <p role="status" className="text-sm text-muted-foreground">正在加载求助设置…</p>
        : <div className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="help-allow" className="text-sm font-medium">接受他人求助</label>
              <p className="text-xs text-muted-foreground">关闭后进入勿扰状态，不再接收新的求助；已有求助仍可继续处理。</p>
            </div>
            <Switch id="help-allow" checked={account.data.allowHelp} disabled={busy} onCheckedChange={(value) => help.mutate(value)} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="help-reply" className="text-sm font-medium">接收回复通知</label>
              <p className="text-xs text-muted-foreground">求助有新回复时，通过已验证的飞书通知渠道提醒你。</p>
            </div>
            <Switch id="help-reply" checked={account.data.notification.notifyReply} disabled={busy} onCheckedChange={(value) => reply.mutate(value)} />
          </div>
          {!account.data.notification.verified && <p className="text-sm text-muted-foreground">尚未验证飞书通知渠道，可以先保存偏好；完成用户中心的通知验证后才能收到提醒。</p>}
          <Button variant="outline" disabled={busy} onClick={onClose}>完成</Button>
        </div>}
    </DialogContent>
  </Dialog>;
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
