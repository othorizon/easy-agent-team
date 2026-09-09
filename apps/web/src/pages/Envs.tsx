import type { CreateEnvironmentRequest, EnvironmentInfo, EnvListResult } from '@eat/shared';
import { ENV_LIST_DEFAULT_PAGE_SIZE } from '@eat/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Database, Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { ListSkeleton } from '../components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { cn } from '../lib/utils';
import { useQueryParams } from '../lib/use-query-params';
import { DB_STATUS_BADGE } from './db-shared';

/**
 * 页签 ↔ 清单接口的 source 参数。「常规」是手工创建的环境，「数据库」是数据库分配批准时自动生成的
 * 凭证环境（决策 39）——后者一条对应一个库、Owner 是申请人，混在一起会把公共配置淹没在一堆 db-xxx 里
 */
const TABS = [
  { value: 'regular', source: 'manual', label: '常规' },
  { value: 'database', source: 'db_assignment', label: '数据库' },
] as const;
type TabValue = (typeof TABS)[number]['value'];

export function EnvsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useQueryParams({
    tab: 'regular',
    q: '',
    page: '1',
    pageSize: String(ENV_LIST_DEFAULT_PAGE_SIZE),
  });
  const tab = (TABS.find((t) => t.value === params.tab) ?? TABS[0]) as (typeof TABS)[number];
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Number(params.pageSize) || ENV_LIST_DEFAULT_PAGE_SIZE;

  // 搜索框本地即时回显、300ms 后才落到 URL 与请求（与 Skill 清单同一套节奏）
  const [search, setSearch] = useState(params.q);
  const pushedQuery = useRef(params.q);
  useEffect(() => {
    if (search === params.q) return;
    const timer = setTimeout(() => {
      pushedQuery.current = search;
      setParams({ q: search, page: '1' });
    }, 300);
    return () => clearTimeout(timer);
  }, [search, params.q]);
  useEffect(() => {
    if (params.q !== pushedQuery.current) {
      pushedQuery.current = params.q;
      setSearch(params.q);
    }
  }, [params.q]);

  const envs = useQuery({
    queryKey: ['envs', params.q, tab.source, page, pageSize],
    queryFn: () =>
      api<EnvListResult>(
        'GET',
        `/api/envs?${new URLSearchParams({ q: params.q, source: tab.source, page: String(page), pageSize: String(pageSize) })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = envs.data?.items ?? [];
  const counts = envs.data?.counts;

  const create = useMutation({
    mutationFn: (values: CreateEnvironmentRequest) => api('POST', '/api/envs', values),
    onSuccess: () => {
      toast.success('环境已创建');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['envs'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const emptyText = params.q
    ? '没有符合条件的环境'
    : tab.value === 'database'
      ? '还没有数据库凭证环境。到「数据库」页申请一个库，批准后凭证会以环境的形式出现在这里。'
      : '还没有环境。新建一个开始集中管理团队的密钥与配置。';

  return (
    <div className="space-y-5">
      <PageHeader
        title="环境变量"
        description="环境是变量的分组（如「内部服务」「第三方 SaaS」）。变量默认对全员可见 key 与备注，值需要授权才能读取；数据库分配生成的凭证环境单独归在「数据库」页签。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            新建环境
          </Button>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-[300px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={tab.value === 'database' ? '搜索标识 / 名称 / 库名' : '搜索标识 / 名称 / 备注'}
            aria-label="搜索环境"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Tabs value={tab.value} onValueChange={(v) => setParams({ tab: v as TabValue, page: '1' })}>
          <TabsList aria-label="环境来源">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
                {/* 数量回答「切过去会有几条」：关键词已应用、页签本身不参与计数 */}
                {counts && <span className="text-xs tabular-nums opacity-60">{counts[t.source]}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {envs.isPending ? (
        <ListSkeleton rows={5} />
      ) : items.length === 0 ? (
        <Empty text={emptyText} className="border-t" />
      ) : (
        <div>
          <div className="-mx-3 divide-y border-t">
            {items.map((env) => (
              <EnvRow key={env.id} env={env} isMine={env.ownerId === me?.id} />
            ))}
          </div>
          <Pagination
            total={envs.data?.total ?? 0}
            page={page}
            pageSize={pageSize}
            onPageChange={(p) => setParams({ page: String(p) })}
            onPageSizeChange={(size) => setParams({ pageSize: String(size), page: '1' })}
          />
        </div>
      )}

      {creating && (
        <CreateEnvDialog
          pending={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(v) => create.mutate(v)}
        />
      )}
    </div>
  );
}

function MetaDot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('text-muted-foreground/60', className)}>
      ·
    </span>
  );
}

/**
 * 清单的一行：名称 + 备注排成阅读流，slug 退为等宽小字，元信息压成一行小字（Owner · 变量数 · 创建时间），
 * 右侧只放一个变量数——它是扫清单时最想知道的「这个环境有多少东西」。
 * 数据库凭证环境多一行「库 · 实例 · 状态」并直达分配详情（决策 39）。
 */
function EnvRow({ env, isMine }: { env: EnvironmentInfo; isMine: boolean }) {
  return (
    <div className="group grid gap-x-6 gap-y-2 px-3 py-3.5 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Link
            to={`/envs/${env.slug}`}
            className="text-[15px] leading-[22px] font-semibold tracking-[-0.005em] underline-offset-3 group-hover:underline"
          >
            {env.name}
          </Link>
          <span className="font-mono text-[12.5px] text-muted-foreground">{env.slug}</span>
        </div>
        {env.description ? (
          <p className="line-clamp-2 text-[13.5px] leading-relaxed break-words text-foreground/70">{env.description}</p>
        ) : (
          <p className="text-[13.5px] leading-relaxed text-muted-foreground/70">
            未填写备注{isMine && '，AI 无法据此判断这个环境是干嘛的，建议补上'}
          </p>
        )}
        {env.source === 'db_assignment' && <DbSourceMeta env={env} />}
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <span
              aria-hidden
              className={cn(
                'inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                isMine ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/15 text-foreground/70',
              )}
            >
              {isMine ? '我' : env.ownerName.slice(0, 1)}
            </span>
            <span className={cn('truncate', isMine && 'font-medium text-foreground')}>{isMine ? '我' : env.ownerName}</span>
            <MetaDot />
            <span className="sm:hidden">{env.variableCount} 个变量</span>
            <MetaDot className="sm:hidden" />
            <span title={formatDateTime(env.createdAt)}>{formatRelativeTime(env.createdAt)}创建</span>
          </div>
        </div>
      </div>
      <div className="hidden min-w-[72px] flex-col items-end justify-self-end sm:flex">
        <span className="text-lg leading-none font-semibold tabular-nums">{env.variableCount}</span>
        <span className="mt-1 text-[11px] text-muted-foreground">个变量</span>
      </div>
    </div>
  );
}

/** 凭证环境的来源行：哪个库、哪台实例、现在什么状态，点过去就是分配详情 */
function DbSourceMeta({ env }: { env: EnvironmentInfo }) {
  const link = env.dbAssignment;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
      <Database className="size-3.5 shrink-0" aria-hidden />
      {link ? (
        <>
          <span>
            库 <InlineCode>{link.dbName}</InlineCode>
          </span>
          <MetaDot />
          <span className="truncate">{link.instanceName}</span>
          {DB_STATUS_BADGE[link.status]}
          <Link
            to={`/db/${link.id}`}
            className="inline-flex items-center gap-0.5 text-primary underline-offset-3 hover:underline"
          >
            分配详情
            <ArrowRight className="size-3" />
          </Link>
        </>
      ) : (
        <span>数据库分配生成的凭证环境，关联的分配记录已不存在</span>
      )}
    </div>
  );
}

function CreateEnvDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: CreateEnvironmentRequest) => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CreateEnvironmentRequest>({
    defaultValues: { slug: '', name: '', description: '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建环境</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
          <Field label="标识（slug）" htmlFor="env-slug" required error={errors.slug?.message}>
            <Input
              id="env-slug"
              placeholder="internal-services"
              className="font-mono"
              aria-invalid={!!errors.slug}
              {...register('slug', { required: '请输入标识', pattern: rules.slug })}
            />
          </Field>
          <Field label="名称" htmlFor="env-name" required error={errors.name?.message}>
            <Input id="env-name" placeholder="内部服务" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field label="备注" htmlFor="env-desc" hint="供人和 AI 理解这个环境的用途">
            <Textarea id="env-desc" rows={2} placeholder="公司内部服务相关的密钥与配置" {...register('description')} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
