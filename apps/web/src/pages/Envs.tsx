import type { CreateEnvironmentRequest, EnvironmentInfo, EnvListResult, EnvListScope } from '@eat/shared';
import { ENV_LIST_DEFAULT_PAGE_SIZE } from '@eat/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CircleCheck, Clock, Database, Lock, Plus, Search, ShieldCheck, SquareTerminal } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createEnvironmentSchema } from '@eat/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode, writeClipboard } from '../components/code';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Button } from '../components/ui/button';
import { Tip } from '../components/ui/tooltip';
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

/** 范围：与页签正交的第二个维度，用描边分段与页签区分开（决策 43 的做法） */
const SCOPE_OPTIONS: Array<{ value: EnvListScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '我的' },
  { value: 'readable', label: '可读取' },
];

export function EnvsPage() {
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useQueryParams({
    tab: 'regular',
    scope: 'all',
    q: '',
    page: '1',
    pageSize: String(ENV_LIST_DEFAULT_PAGE_SIZE),
  });
  const tab = (TABS.find((t) => t.value === params.tab) ?? TABS[0]) as (typeof TABS)[number];
  const scope = SCOPE_OPTIONS.find((o) => o.value === params.scope)?.value ?? 'all';
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
    queryKey: ['envs', params.q, tab.source, scope, page, pageSize],
    queryFn: () =>
      api<EnvListResult>(
        'GET',
        `/api/envs?${new URLSearchParams({ q: params.q, source: tab.source, scope, page: String(page), pageSize: String(pageSize) })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = envs.data?.items ?? [];
  const counts = envs.data?.counts;
  const scopeCounts = envs.data?.scopeCounts;

  const create = useMutation({
    mutationFn: (values: CreateEnvironmentRequest) => api('POST', '/api/envs', values),
    onSuccess: () => {
      toast.success('环境已创建');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['envs'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const empty = emptyState({
    searching: params.q !== '',
    database: tab.value === 'database',
    scope,
    onClearSearch: () => setSearch(''),
    onCreate: () => setCreating(true),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="环境变量"
        description={
          <>
            环境是变量的分组。团队环境的 key 与备注全员可见，值需授权才能读取；Private 环境仅自己可见。有权限的变量在本地用{' '}
            <InlineCode>eat env pull &lt;环境&gt;</InlineCode> 拉取。
          </>
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            新建环境
          </Button>
        }
      />

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab.value} onValueChange={(v) => setParams({ tab: v as TabValue, page: '1' })}>
            <TabsList aria-label="环境来源">
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                  {/* 数量回答「切过去会有几条」：关键词与范围已应用、页签本身不参与计数 */}
                  {counts && <span className="text-xs tabular-nums opacity-60">{counts[t.source]}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Segmented
            variant="outline"
            ariaLabel="与我的关系"
            value={scope}
            onChange={(v) => setParams({ scope: v, page: '1' })}
            options={SCOPE_OPTIONS.map((o) => ({
              value: o.value,
              label: (
                <>
                  {o.label}
                  {scopeCounts && <span className="ml-0.5 text-xs tabular-nums opacity-60">{scopeCounts[o.value]}</span>}
                </>
              ),
            }))}
          />
        </div>
        <div className="relative order-first lg:order-none lg:w-[280px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={tab.value === 'database' ? '搜索标识 / 名称 / 库名' : '搜索标识 / 名称 / 备注'}
            aria-label="搜索环境"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {envs.isPending ? (
        <ListSkeleton rows={5} />
      ) : items.length === 0 ? (
        <Empty text={empty.text} action={empty.action} className="border-t" />
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

/** 空清单按「为什么空」给出下一步，而不是一句「暂无数据」 */
function emptyState({
  searching,
  database,
  scope,
  onClearSearch,
  onCreate,
}: {
  searching: boolean;
  database: boolean;
  scope: EnvListScope;
  onClearSearch: () => void;
  onCreate: () => void;
}): { text: string; action?: ReactNode } {
  if (searching) {
    return {
      text: '没有符合条件的环境',
      action: (
        <Button variant="outline" size="sm" onClick={onClearSearch}>
          清除搜索
        </Button>
      ),
    };
  }
  if (database) {
    const dbLink = (
      <Button variant="outline" size="sm" asChild>
        <Link to="/db">去申请数据库</Link>
      </Button>
    );
    if (scope === 'all') {
      return { text: '还没有数据库凭证环境。到「数据库」页申请一个库，批准后凭证会以环境的形式出现在这里。', action: dbLink };
    }
    return {
      text: scope === 'mine' ? '你还没有数据库凭证环境。申请的库批准后，凭证会出现在这里。' : '还没有你能读取的数据库凭证环境。',
      action: scope === 'mine' ? dbLink : undefined,
    };
  }
  if (scope === 'mine') {
    return {
      text: '你还没有创建环境。',
      action: (
        <Button variant="outline" size="sm" onClick={onCreate}>
          <Plus />
          新建环境
        </Button>
      ),
    };
  }
  if (scope === 'readable') {
    return { text: '还没有你能读取的环境。打开需要的环境，对变量发起权限申请，Owner 批准后就会出现在这里。' };
  }
  return { text: '还没有环境。新建一个开始集中管理团队的密钥与配置。' };
}

function MetaDot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('text-muted-foreground/60', className)}>
      ·
    </span>
  );
}

/**
 * 行内的链接、按钮自己响应点击，不触发整行跳转；带提示的小元素（data-row-stop）在触屏上轻点是开提示
 * （见 Tip），也不跳——鼠标点它们照常进详情，悬停本来就能看到提示
 */
function shouldSkipRowNav(target: HTMLElement, pointerType: string) {
  if (target.closest('a, button')) return true;
  return pointerType === 'touch' && !!target.closest('[data-row-stop]');
}

/**
 * 清单的一行：名称 + 备注排成阅读流，slug 退为等宽小字，元信息压成一行小字（Owner · 创建时间）；
 * 右侧是「我能不能读」——扫清单时真正要回答的问题，可读的环境悬停即可复制拉取命令。
 * 整行可点进详情（选中文字时不跳，免得复制 slug 时被带走）。
 * 数据库凭证环境多一行「库 · 实例 · 状态」并直达分配详情（决策 39）。
 */
function EnvRow({ env, isMine }: { env: EnvironmentInfo; isMine: boolean }) {
  const navigate = useNavigate();
  const pointerType = useRef('');
  const to = `/envs/${env.slug}`;
  return (
    <div
      className="group grid cursor-pointer gap-x-6 gap-y-2.5 px-3 py-3.5 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      onPointerDown={(e) => {
        pointerType.current = e.pointerType;
      }}
      onClick={(e) => {
        if (shouldSkipRowNav(e.target as HTMLElement, pointerType.current)) return;
        if (window.getSelection()?.toString()) return;
        navigate(to);
      }}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Link
            to={to}
            className="text-[15px] leading-[22px] font-semibold tracking-[-0.005em] underline-offset-3 group-hover:underline"
          >
            {env.name}
          </Link>
          {env.visibility === 'private' && (
            <Tip content="Private 环境：仅自己可见，其他成员（含管理员）都看不到">
              <Badge variant="secondary" data-row-stop>
                <Lock />
                Private
              </Badge>
            </Tip>
          )}
          <span className="font-mono text-[12.5px] text-muted-foreground">{env.slug}</span>
        </div>
        {env.description ? (
          <p className="line-clamp-2 text-[13.5px] leading-relaxed break-words text-foreground/70">{env.description}</p>
        ) : (
          <p className="text-[13.5px] leading-relaxed text-muted-foreground/70">
            未填写备注{env.access === 'manage' && '，AI 无法据此判断这个环境是干嘛的，建议补上'}
          </p>
        )}
        {env.source === 'db_assignment' && <DbSourceMeta env={env} />}
        <div className="flex min-w-0 items-center gap-1.5 pt-0.5 text-xs text-muted-foreground tabular-nums">
          {/* 窄屏把读取状态并进这一行的右端，省掉单独一行 */}
          <AccessStatus env={env} isMine={isMine} className="order-last ml-auto pl-2 sm:hidden" />
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
          <Tip content={formatDateTime(env.createdAt)}>
            <span data-row-stop>{formatRelativeTime(env.createdAt)}创建</span>
          </Tip>
        </div>
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <AccessStatus env={env} isMine={isMine} />
        {/* 读不了的行也占住按钮的位置，状态列才对得齐 */}
        {env.readableCount > 0 ? <PullCommandButton slug={env.slug} /> : <span aria-hidden className="size-8" />}
      </div>
    </div>
  );
}

/**
 * 读取状态：图标 + 一句话，副行是变量数（或「另有申请待审批」）。
 * 宽屏在行右侧右对齐成两行；窄屏摊成一行，并进元信息行的右端。
 */
function AccessStatus({ env, isMine, className }: { env: EnvironmentInfo; isMine: boolean; className?: string }) {
  const total = env.variableCount;
  const status = (() => {
    if (env.access === 'manage') {
      return {
        icon: ShieldCheck,
        label: '可管理',
        tone: 'text-success',
        tip: isMine ? '你是这个环境的 Owner：全部变量可读，也可以编辑和授权' : '管理员：全部变量可读，也可以编辑和授权',
      };
    }
    if (total === 0) return { icon: null, label: '暂无变量', tone: 'text-muted-foreground', tip: null };
    if (env.access === 'all') {
      return { icon: CircleCheck, label: '全部可读', tone: 'text-success', tip: '已获授权，可以拉取全部变量' };
    }
    if (env.access === 'partial') {
      return {
        icon: PartialIcon,
        label: `可读 ${env.readableCount} / ${total}`,
        tone: 'text-warning',
        tip: `已获授权 ${env.readableCount} 个变量，其余 ${total - env.readableCount} 个需要申请`,
      };
    }
    if (env.pendingRequest) {
      return { icon: Clock, label: '申请中', tone: 'text-warning', tip: '你的读取申请正在等 Owner 或管理员审批' };
    }
    return { icon: Lock, label: '未授权', tone: 'text-muted-foreground', tip: '值需要授权才能读取：打开环境，对需要的变量发起申请' };
  })();
  const sub =
    env.access === 'partial' && env.pendingRequest ? '另有申请待审批' : total === 0 ? (env.access === 'manage' ? '暂无变量' : null) : `${total} 个变量`;
  const Icon = status.icon;
  return (
    <Tip content={status.tip}>
      <div
        data-row-stop
        className={cn('flex shrink-0 items-center gap-1.5 text-xs sm:min-w-[96px] sm:flex-col sm:items-end sm:gap-0.5 sm:text-[13px]', className)}
      >
        <span className={cn('inline-flex items-center gap-1.5 font-medium whitespace-nowrap', status.tone)}>
          {Icon && <Icon className="size-3.5 shrink-0 sm:size-4" aria-hidden />}
          {status.label}
        </span>
        {sub && (
          // 窄屏摊成一行时，「可读 1 / 4」已经带了总数，不再重复「4 个变量」
          <span className={cn('inline-flex items-center gap-1.5', env.access === 'partial' && !env.pendingRequest && 'max-sm:hidden')}>
            <MetaDot className="sm:hidden" />
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{sub}</span>
          </span>
        )}
      </div>
    </Tip>
  );
}

/** 「部分可读」的半圆图标：lucide 没有合适的，画一个与其他图标同尺寸同线宽的 */
function PartialIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a10 10 0 0 1 0 20Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 复制 `eat env pull <slug>`：鼠标设备上悬停该行才出现，触屏平板上常驻；手机上不跑 CLI，不放 */
function PullCommandButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const command = `eat env pull ${slug}`;
  return (
    <Tip content={copied ? '已复制' : <>复制拉取命令 <span className="font-mono">{command}</span></>}>
      <button
        type="button"
        aria-label={`复制拉取命令 ${command}`}
        className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,opacity] outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
        onClick={() => {
          void writeClipboard(command).then((ok) => {
            if (!ok) {
              toast.error('复制失败，请手动选中复制');
              return;
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-4 text-success" /> : <SquareTerminal className="size-4" />}
      </button>
    </Tip>
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
  const { register, handleSubmit, control, formState: { errors } } = useForm({
    resolver: zodResolver(createEnvironmentSchema),
    defaultValues: { slug: '', name: '', description: '', visibility: 'team' },
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
              {...register('slug')}
            />
          </Field>
          <Field label="名称" htmlFor="env-name" required error={errors.name?.message}>
            <Input id="env-name" placeholder="内部服务" aria-invalid={!!errors.name} {...register('name')} />
          </Field>
          <Field label="备注" htmlFor="env-desc" hint="供人和 AI 理解这个环境的用途">
            <Textarea id="env-desc" rows={2} placeholder="公司内部服务相关的密钥与配置" {...register('description')} />
          </Field>
          <Field label="Private 模式" hint="仅环境 Owner 可见和使用，其他成员（含管理员）不可访问；变量不能单独设为未授权成员可见。">
            <Controller control={control} name="visibility" render={({ field }) => (
              <Switch aria-label="Private 模式" checked={field.value === 'private'} onCheckedChange={(checked) => field.onChange(checked ? 'private' : 'team')} />
            )} />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
