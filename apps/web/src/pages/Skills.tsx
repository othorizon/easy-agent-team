import type { PushSkillRequest, SkillInfo, SkillListResult } from '@eat/shared';
import { SKILL_LIST_DEFAULT_PAGE_SIZE, parseSkillFrontmatter, slugifyName } from '@eat/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Empty } from '../components/empty';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Pagination } from '../components/pagination';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { TableSkeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useQueryParams } from '../lib/use-query-params';

const SCOPE_OPTIONS = [
  { value: 'all', label: '全部范围' },
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
  const filtered = params.q !== '' || params.scope !== 'all' || params.kind !== 'all';

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
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="搜索标识 / 名称 / 触发描述"
                aria-label="搜索 Skill"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={params.scope} onValueChange={(v) => setParams({ scope: v, page: '1' })}>
              <SelectTrigger className="sm:w-[132px]" aria-label="按范围筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={params.kind} onValueChange={(v) => setParams({ kind: v, page: '1' })}>
              <SelectTrigger className="sm:w-[132px]" aria-label="按类型筛选">
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
            <TableSkeleton />
          ) : items.length === 0 ? (
            <Empty text={filtered ? '没有符合条件的 Skill' : '还没有 Skill'} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Skill</TableHead>
                    <TableHead className="hidden md:table-cell">触发描述</TableHead>
                    <TableHead className="hidden w-24 lg:table-cell">作者</TableHead>
                    <TableHead className="hidden w-16 sm:table-cell">版本</TableHead>
                    <TableHead className="hidden w-24 sm:table-cell">类型</TableHead>
                    <TableHead className="hidden w-20 sm:table-cell">订阅数</TableHead>
                    <TableHead className="w-20">订阅</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link to={`/skills/${s.slug}`} className="group inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <InlineCode className="text-primary group-hover:underline">{s.slug}</InlineCode>
                          <span className="font-medium">{s.name}</span>
                        </Link>
                        {/* 窄屏才显示的描述：truncate 是 nowrap，不封顶会把整张表撑到要横向滚动 */}
                        <div className="mt-0.5 max-w-[55vw] truncate text-xs text-muted-foreground md:hidden">
                          {s.description}
                        </div>
                      </TableCell>
                      {/* 描述列吃掉所有富余宽度、也让得出去：truncate 是 nowrap，
                          直接写在 td 上会让它恒占一个固定宽度、把窄窗口的表格顶出横向滚动条。
                          max-w-0 + w-full 把「能缩到多窄」交还给表格，截断交给内层 div。 */}
                      <TableCell className="hidden w-full max-w-0 text-muted-foreground md:table-cell">
                        <div className="truncate">{s.description}</div>
                      </TableCell>
                      {/* 描述列会把富余宽度吃光，作者列于是被挤到最窄——不许它把名字拆成竖排 */}
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                        {s.ownerName}
                      </TableCell>
                      <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                        v{s.currentVersion}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {s.bundled && <Badge variant="warning">捆绑</Badge>}
                          {s.visibility === 'private' ? (
                            <Badge variant="outline">私有</Badge>
                          ) : s.visibility === 'granted' ? (
                            <Badge variant="secondary">授予</Badge>
                          ) : (
                            !s.bundled && <Badge>团队</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden tabular-nums text-muted-foreground sm:table-cell">
                        {s.subscriberCount}
                      </TableCell>
                      <TableCell>
                        {s.subscriptionLocked ? (
                          // 捆绑：对成员恒为订阅，按钮留着但禁用，比直接藏起来更少让人困惑
                          <Button size="sm" variant="outline" disabled title="管理员已设为捆绑，全员同步且不可退订">
                            已捆绑
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant={s.subscribed ? 'outline' : 'default'}
                            loading={toggleSubscribe.isPending && toggleSubscribe.variables?.id === s.id}
                            onClick={() => toggleSubscribe.mutate(s)}
                          >
                            {s.subscribed ? '退订' : '订阅'}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                total={skills.data?.total ?? 0}
                page={page}
                pageSize={pageSize}
                onPageChange={(p) => setParams({ page: String(p) })}
                onPageSizeChange={(size) => setParams({ pageSize: String(size), page: '1' })}
              />
            </>
          )}
        </CardContent>
      </Card>

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
