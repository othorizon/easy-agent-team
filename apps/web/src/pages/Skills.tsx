import type { PushSkillRequest, SkillInfo, SkillListResult } from '@eat/shared';
import { SKILL_LIST_DEFAULT_PAGE_SIZE, parseSkillFrontmatter, slugifyName } from '@eat/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Minus, Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { ListSkeleton } from '../components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { cn } from '../lib/utils';
import { useQueryParams } from '../lib/use-query-params';

/** 范围是高频筛选，做成带数量的分段切换；数量键对应 SkillListResult.counts */
const SCOPE_OPTIONS: Array<{ value: keyof SkillListResult['counts']; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'subscribed', label: '已订阅' },
  { value: 'unsubscribed', label: '未订阅' },
  { value: 'mine', label: '我创建的' },
];

const KIND_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'team', label: '团队可见' },
  { value: 'private', label: '私有' },
  { value: 'granted', label: '授予可见' },
  { value: 'bundled', label: '捆绑' },
  { value: 'experience', label: '经验沉淀' },
];

export function SkillsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useQueryParams({
    q: '',
    scope: 'all',
    kind: 'all',
    page: '1',
    pageSize: String(SKILL_LIST_DEFAULT_PAGE_SIZE),
  });
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Number(params.pageSize) || SKILL_LIST_DEFAULT_PAGE_SIZE;

  // 搜索框本地即时回显、300ms 后才落到 URL 与请求，免得每敲一个字打一次接口
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
    // URL 上的关键词不是自己推上去的（前进后退、点了带参数的链接）时，把输入框拉回来对齐
    if (params.q !== pushedQuery.current) {
      pushedQuery.current = params.q;
      setSearch(params.q);
    }
  }, [params.q]);

  const skills = useQuery({
    queryKey: ['skills', params.q, params.scope, params.kind, page, pageSize],
    queryFn: () =>
      api<SkillListResult>(
        'GET',
        `/api/skills?${new URLSearchParams({
          q: params.q,
          scope: params.scope,
          kind: params.kind,
          page: String(page),
          pageSize: String(pageSize),
        })}`,
      ),
    // 翻页时保留上一页内容，避免整张表闪成骨架屏
    placeholderData: keepPreviousData,
  });
  const items = skills.data?.items ?? [];
  const counts = skills.data?.counts;
  const filtered = params.q !== '' || params.scope !== 'all' || params.kind !== 'all';
  const me = getStoredUser();

  const toggleSubscribe = useMutation({
    mutationFn: (s: SkillInfo) => api(s.subscribed ? 'DELETE' : 'POST', `/api/skills/${s.slug}/subscribe`),
    onSuccess: (_data, s) => {
      toast.success(s.subscribed ? '已退订' : '已订阅，本地运行 eat sync 即可落地');
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const create = useMutation({
    mutationFn: (v: PushSkillRequest) => api('POST', '/api/skills/push', v),
    onSuccess: () => {
      // 创建不代表订阅（决策 34）：不提一句的话，作者会以为 eat sync 就该带上它
      toast.success('Skill 已创建；想让它随 eat sync 落到本地，记得订阅一下');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Skill"
        description={
          <>
            订阅后在本地运行 <InlineCode>eat sync</InlineCode> 即落地到 <InlineCode>~/.claude/skills</InlineCode>
            ；本地已有的 skill 目录可用 <InlineCode>eat skill push &lt;目录&gt;</InlineCode> 上传纳管，
            <InlineCode>eat skill export &lt;slug&gt;</InlineCode> 把这里的 skill 下载到本地目录。
          </>
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            创建 Skill
          </Button>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-[300px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="搜索标识 / 名称 / 触发描述"
            aria-label="搜索 Skill"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Segmented
          value={params.scope}
          onChange={(v) => setParams({ scope: v, page: '1' })}
          options={SCOPE_OPTIONS.map((o) => ({
            value: o.value,
            label: (
              <>
                {o.label}
                {/* 数量回答「切过去会有几条」：已订阅的那个数就是 eat sync 会落地的条数 */}
                {counts && <span className="ml-1 text-xs tabular-nums opacity-60">{counts[o.value]}</span>}
              </>
            ),
          }))}
        />
        <div className="hidden flex-1 sm:block" />
        {/* 类型是低频筛选，留在下拉；窄屏时靠右单占一行，与桌面端位置一致 */}
        <Select value={params.kind} onValueChange={(v) => setParams({ kind: v, page: '1' })}>
          <SelectTrigger className="w-[132px] self-end sm:self-auto" aria-label="按类型筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {skills.isPending ? (
        <ListSkeleton rows={5} />
      ) : items.length === 0 ? (
        <Empty text={filtered ? '没有符合条件的 Skill' : '还没有 Skill'} className="border-t" />
      ) : (
        <div>
          {/* 行的悬停底色要盖过左右留白，所以清单整体向外扩 12px、行内再补回来 */}
          <div className="-mx-3 divide-y border-t">
            {items.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                isMine={s.ownerId === me?.id}
                pending={toggleSubscribe.isPending && toggleSubscribe.variables?.id === s.id}
                onToggle={() => toggleSubscribe.mutate(s)}
              />
            ))}
          </div>
          <Pagination
            total={skills.data?.total ?? 0}
            page={page}
            pageSize={pageSize}
            onPageChange={(p) => setParams({ page: String(p) })}
            onPageSizeChange={(size) => setParams({ pageSize: String(size), page: '1' })}
          />
        </div>
      )}

      {creating && (
        <CreateSkillDialog
          pending={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(v) => create.mutate(v)}
        />
      )}
    </div>
  );
}

/**
 * 订阅人数的小人图标。lucide 的 Users（两个人）在 14px 下两个人形的笔画糊成一团，
 * User（单人）的头又偏大，所以照它的线条风格自己画一个：头小一号、肩线更平，
 * 小尺寸下才立得住。用图标而不是「N 人订阅」，同样的信息省掉三个汉字的宽度。
 */
function SubscriberGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="5.1" r="2.6" />
      <path d="M3.2 13.3c0-2.4 2.15-3.9 4.8-3.9s4.8 1.5 4.8 3.9" />
    </svg>
  );
}

/**
 * 名称旁的状态徽标：只出**非默认**状态。「团队可见」是默认值、九成行都是它，
 * 每行挂一个纯属噪音，扫描时反而看不见真正特殊的那几条。
 */
function SkillTags({ skill }: { skill: SkillInfo }) {
  return (
    <>
      {skill.bundled && (
        <Badge variant="warning">
          <Lock />
          捆绑
        </Badge>
      )}
      {skill.visibility === 'private' && <Badge variant="outline">私有</Badge>}
      {skill.visibility === 'granted' && <Badge variant="secondary">授予可见</Badge>}
      {skill.source === 'experience' && <Badge variant="secondary">经验沉淀</Badge>}
    </>
  );
}

/**
 * 清单的一行（决策 38）：名称 + 描述排成阅读流，slug 退为等宽小字，元信息压成一行小字，
 * 订阅按钮按状态分级。桌面端按钮在行右侧垂直居中；窄屏挪到元信息那一行的右端、slug 并入元信息。
 */
function SkillRow({
  skill,
  isMine,
  pending,
  onToggle,
}: {
  skill: SkillInfo;
  isMine: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="group grid gap-x-6 gap-y-2 px-3 py-3.5 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Link
            to={`/skills/${skill.slug}`}
            className="text-[15px] leading-[22px] font-semibold tracking-[-0.005em] underline-offset-3 group-hover:underline"
          >
            {skill.name}
          </Link>
          <span className="hidden font-mono text-[12.5px] text-muted-foreground sm:inline">{skill.slug}</span>
          <SkillTags skill={skill} />
        </div>
        {skill.description ? (
          // 多行描述（决策 36 的 | 块）按原换行显示，两行封顶——长描述看详情页
          <p className="line-clamp-2 text-[13.5px] leading-relaxed break-words whitespace-pre-line text-foreground/70">
            {skill.description}
          </p>
        ) : (
          <p className="text-[13.5px] leading-relaxed text-muted-foreground/70">
            未填写触发描述{isMine && '，AI 无法据此判断何时使用它，建议补上'}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <SkillMeta skill={skill} isMine={isMine} />
          <div className="sm:hidden">
            <SubscribeAction skill={skill} pending={pending} onToggle={onToggle} />
          </div>
        </div>
      </div>
      <div className="hidden min-w-[88px] justify-end justify-self-end sm:flex">
        <SubscribeAction skill={skill} pending={pending} onToggle={onToggle} />
      </div>
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
 * 元信息一行小字：作者 · 版本 · 订阅人数 · 更新时间。作者是自己时显示加深的「我」——
 * 「我创建的」不值得一个徽标，但扫描时得能一眼挑出来。
 * 窄屏把 slug 放进来（名称行不放）、去掉头像与更新时间，给右侧的按钮让位。
 */
function SkillMeta({ skill, isMine }: { skill: SkillInfo; isMine: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <span className="truncate font-mono sm:hidden">{skill.slug}</span>
      <MetaDot className="sm:hidden" />
      <span
        aria-hidden
        className={cn(
          'hidden size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold sm:inline-flex',
          isMine ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/15 text-foreground/70',
        )}
      >
        {isMine ? '我' : skill.ownerName.slice(0, 1)}
      </span>
      <span className={cn('truncate', isMine && 'font-medium text-foreground')}>{isMine ? '我' : skill.ownerName}</span>
      <MetaDot />
      <span>v{skill.currentVersion}</span>
      <MetaDot />
      <span className="inline-flex items-center gap-0.5" title={`${skill.subscriberCount} 人订阅`}>
        <SubscriberGlyph />
        {skill.subscriberCount}
        <span className="sr-only sm:not-sr-only"> 人订阅</span>
      </span>
      <MetaDot className="hidden sm:inline" />
      <span className="hidden sm:inline" title={formatDateTime(skill.updatedAt)}>
        {formatRelativeTime(skill.updatedAt)}更新
      </span>
    </div>
  );
}

/**
 * 订阅按钮按状态分级，页面上不再是一列实心黑按钮：
 * 未订阅 = 描边（唯一需要用户动手的），已订阅 = 安静灰底 + 绿勾、悬停整行时原位变「退订」，
 * 捆绑 = 只读的锁（禁用但留着，比藏起来少让人困惑），进行中 = 加载态防重复点。
 * 悬停换字只在有指针的设备上发生（Tailwind 的 hover 变体自带 hover:hover 媒体查询），
 * 触屏上按钮一直写「已订阅」、点它退订，跟「Following」类按钮的惯例一致。
 */
function SubscribeAction({ skill, pending, onToggle }: { skill: SkillInfo; pending: boolean; onToggle: () => void }) {
  if (skill.subscriptionLocked) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled
        className="text-muted-foreground disabled:opacity-100"
        title="管理员已设为捆绑，全员同步且不可退订"
      >
        <Lock className="size-3.5" />
        已捆绑
      </Button>
    );
  }
  if (pending) {
    return (
      <Button size="sm" variant="outline" loading className="text-muted-foreground">
        {skill.subscribed ? '退订中' : '订阅中'}
      </Button>
    );
  }
  if (skill.subscribed) {
    return (
      <Button
        size="sm"
        variant={null}
        aria-label={`退订 ${skill.name}`}
        onClick={onToggle}
        className="border border-transparent bg-muted text-foreground/70 group-hover:border-destructive/30 group-hover:bg-card group-hover:text-destructive group-hover:shadow-xs group-hover:hover:bg-destructive/10"
      >
        <span className="inline-flex items-center gap-1 group-hover:hidden">
          <Check className="size-3.5 text-success" />
          已订阅
        </span>
        <span className="hidden items-center gap-1 group-hover:inline-flex">
          <Minus className="size-3.5" />
          退订
        </span>
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" onClick={onToggle}>
      <Plus className="size-3.5" />
      订阅
    </Button>
  );
}

interface CreateFormValues {
  slug: string;
  name: string;
  description: string;
  content: string;
  private: boolean;
}

function CreateSkillDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: PushSkillRequest) => void;
}) {
  const { register, handleSubmit, control, getValues, setValue, formState: { errors } } = useForm<CreateFormValues>({
    defaultValues: { slug: '', name: '', description: '', content: '', private: false },
  });

  /**
   * 正文是整份 SKILL.md 时，从 frontmatter 回填还空着的 slug / 名称 / 触发描述——
   * description 常写成 `>-` 折叠或 `|` 保留的多行块，解析在 @eat/shared，与 eat skill push 同一套。
   */
  const fillFromFrontmatter = (content: string) => {
    const fm = parseSkillFrontmatter(content);
    const filled: string[] = [];
    // 长度按服务端契约截断，免得回填出一个必然被拒的值
    const fill = (field: 'slug' | 'name' | 'description', value: string, max: number, label: string) => {
      if (!value || getValues(field).trim()) return;
      setValue(field, value.slice(0, max), { shouldValidate: true, shouldDirty: true });
      filled.push(label);
    };
    if (fm.name) fill('slug', slugifyName(fm.name), 64, '标识');
    if (fm.name) fill('name', fm.name, 100, '名称');
    if (fm.description) fill('description', fm.description, 2000, '触发描述');
    if (filled.length > 0) toast.info(`已从 SKILL.md frontmatter 填入${filled.join('、')}`);
  };
  const contentField = register('content', { required: '请输入正文' });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>创建 Skill</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) =>
            onSubmit({
              slug: v.slug,
              name: v.name,
              description: v.description,
              content: v.content,
              files: [],
              changelog: '',
              visibility: v.private ? 'private' : 'team',
            }),
          )}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标识（slug）" htmlFor="skill-slug" required error={errors.slug?.message} hint="将作为本地目录名">
              <Input
                id="skill-slug"
                placeholder="weekly-report"
                className="font-mono"
                aria-invalid={!!errors.slug}
                {...register('slug', { required: '请输入标识', pattern: rules.slug })}
              />
            </Field>
            <Field label="名称" htmlFor="skill-name" required error={errors.name?.message}>
              <Input id="skill-name" placeholder="运营周报生成" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
            </Field>
          </div>
          <Field label="触发描述" htmlFor="skill-desc" hint="AI 靠它判断何时使用这个 skill">
            <Textarea id="skill-desc" rows={2} placeholder="根据运营数据生成周报，适用于每周一汇报" {...register('description')} />
          </Field>
          <Field
            label="SKILL.md 正文"
            htmlFor="skill-content"
            required
            error={errors.content?.message}
            hint="可直接粘贴整份 SKILL.md：上面空着的字段会从 frontmatter 自动填入"
          >
            <Textarea
              id="skill-content"
              rows={10}
              className="font-mono text-[13px]"
              placeholder={'# 周报生成\n\n步骤……'}
              aria-invalid={!!errors.content}
              {...contentField}
              onBlur={(e) => {
                void contentField.onBlur(e);
                fillFromFrontmatter(e.target.value);
              }}
            />
          </Field>
          <Field label="可见性">
            <Controller
              control={control}
              name="private"
              render={({ field }) => (
                <Segmented
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { label: '团队可见', value: false },
                    { label: '私有', value: true },
                  ]}
                />
              )}
            />
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            创建（v1）
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
