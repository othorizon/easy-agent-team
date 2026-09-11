import type { SkillBundleExemption, SkillDetail, SkillSubscriber, SkillVersionInfo, UpdateSkillRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, LockOpen, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, getStoredUser } from '../api';
import { CodeBlock, InlineCode } from '../components/code';
import { Combobox } from '../components/combobox';
import { Confirm } from '../components/confirm';
import { Empty } from '../components/empty';
import { Field } from '../components/form';
import { PageLoading } from '../components/page-loading';
import { Segmented } from '../components/segmented';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime } from '../lib/utils';

export function SkillDetailPage() {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = getStoredUser();
  const [editing, setEditing] = useState(false);
  /** SKILL.md 在线编辑的草稿：null = 只读展示 */
  const [draft, setDraft] = useState<string | null>(null);
  const [changelog, setChangelog] = useState('');

  const skill = useQuery({
    queryKey: ['skill', slug],
    queryFn: () => api<SkillDetail>('GET', `/api/skills/${slug}`),
  });
  const versions = useQuery({
    queryKey: ['skill-versions', slug],
    queryFn: () => api<SkillVersionInfo[]>('GET', `/api/skills/${slug}/versions`),
  });

  const isAdmin = me?.role === 'admin';
  const canManage = skill.data && me && (skill.data.ownerId === me.id || isAdmin);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['skill', slug] });
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
    void queryClient.invalidateQueries({ queryKey: ['skill-subscribers', slug] });
    void queryClient.invalidateQueries({ queryKey: ['skill-bundle-exemptions', slug] });
  };

  const update = useMutation({
    mutationFn: (v: UpdateSkillRequest) => api('PATCH', `/api/skills/${slug}`, v),
    onSuccess: () => {
      toast.success('已保存');
      setEditing(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  /** 在线编辑正文：保存即新版本（决策 42） */
  const saveContent = useMutation({
    mutationFn: (v: { content: string; changelog: string }) =>
      api<SkillDetail>('PUT', `/api/skills/${slug}/content`, { ...v, baseVersion: skill.data?.currentVersion ?? 0 }),
    onSuccess: (res) => {
      toast.success(`已保存为 v${res.currentVersion}`);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['skill-versions', slug] });
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const toggleSubscribe = useMutation({
    mutationFn: () => api(skill.data?.subscribed ? 'DELETE' : 'POST', `/api/skills/${slug}/subscribe`),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/skills/${slug}`),
    onSuccess: () => {
      toast.success('已删除');
      navigate('/skills');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  if (!skill.data) return <PageLoading />;
  const s = skill.data;

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/skills"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Skill
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              <InlineCode className="text-lg">{s.slug}</InlineCode>
              {s.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {s.visibility === 'private' ? (
                <Badge variant="outline">私有</Badge>
              ) : s.visibility === 'granted' ? (
                <Badge variant="secondary">授予可见</Badge>
              ) : (
                <Badge>团队可见</Badge>
              )}
              {s.bundled && <Badge variant="warning">捆绑 · 全员必装</Badge>}
              {s.allowHelp && <Badge variant="warning">允许求助</Badge>}
              {s.source === 'experience' && <Badge variant="secondary">经验沉淀</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {s.subscriptionLocked ? (
              <Button variant="outline" disabled title="管理员已设为捆绑，全员同步且不可退订">
                已捆绑
              </Button>
            ) : (
              <Button
                variant={s.subscribed ? 'outline' : 'default'}
                loading={toggleSubscribe.isPending}
                onClick={() => toggleSubscribe.mutate()}
              >
                {s.subscribed ? '退订' : '订阅'}
              </Button>
            )}
            {canManage && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                编辑元信息
              </Button>
            )}
            {canManage && (
              <Confirm
                title="确认删除该 Skill？"
                description="删除后订阅者本地的副本会在下次 sync 时移除。"
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
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">作者</dt>
              <dd>{s.ownerName}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">当前版本</dt>
              <dd className="tabular-nums">v{s.currentVersion}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 text-muted-foreground">订阅人数</dt>
              <dd className="tabular-nums">
                {s.subscriberCount} 人{s.bundled && <span className="ml-1 text-muted-foreground">（捆绑，全员）</span>}
              </dd>
            </div>
            <div className="flex gap-3 sm:col-span-2">
              <dt className="w-20 shrink-0 text-muted-foreground">触发描述</dt>
              {/* 描述可以是 SKILL.md 里 `|` 保留块的多行文本（决策 36），按原样换行显示，别挤成一坨 */}
              <dd className="min-w-0 whitespace-pre-line break-words leading-relaxed">{s.description || '（未填写）'}</dd>
            </div>
            {s.files.length > 0 && (
              <div className="flex gap-3 sm:col-span-2">
                <dt className="w-20 shrink-0 text-muted-foreground">附属文件</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {s.files.map((f) => (
                    <InlineCode key={f.path}>
                      {f.path}
                      {f.executable ? ' ⚙' : ''}
                    </InlineCode>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          <div className="mt-5 mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">SKILL.md</h2>
            {canManage && draft === null && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(s.content);
                  setChangelog('');
                }}
              >
                <Pencil />
                编辑
              </Button>
            )}
          </div>
          {draft === null ? (
            <CodeBlock>{s.content}</CodeBlock>
          ) : (
            <div className="flex flex-col gap-3">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                // 高度按视口给，别用 rows：手机上 22 行是一大片空白，桌面上又嫌矮
                className="h-[50vh] min-h-64 font-mono text-[13px] leading-relaxed sm:h-[34rem]"
                aria-label="SKILL.md 内容"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                保存即产生新版本（v{s.currentVersion} → v{s.currentVersion + 1}），订阅者下次{' '}
                <InlineCode>eat sync</InlineCode> 拿到。名称与触发描述取正文 frontmatter；附属文件保持不变，要增删附件请用{' '}
                <InlineCode>eat skill push</InlineCode>。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={changelog}
                  onChange={(e) => setChangelog(e.target.value)}
                  placeholder="本次修改说明（可选）"
                  maxLength={500}
                  className="w-full sm:max-w-xs"
                />
                <Button
                  loading={saveContent.isPending}
                  disabled={draft.trim() === ''}
                  onClick={() => saveContent.mutate({ content: draft, changelog })}
                >
                  保存为新版本
                </Button>
                {draft === s.content ? (
                  <Button variant="outline" onClick={() => setDraft(null)}>
                    取消
                  </Button>
                ) : (
                  <Confirm
                    title="放弃这次编辑？"
                    description="改动不会保存。"
                    confirmText="放弃"
                    onConfirm={() => setDraft(null)}
                  >
                    <Button variant="outline">取消</Button>
                  </Confirm>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isAdmin && <SubscribersCard slug={slug} skill={s} />}

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">版本历史</h2>
          {versions.isLoading ? (
            <TableSkeleton rows={2} />
          ) : (versions.data ?? []).length === 0 ? (
            <Empty text="暂无版本记录" className="py-6" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">版本</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead className="hidden w-28 sm:table-cell">提交人</TableHead>
                  <TableHead className="hidden w-40 md:table-cell">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(versions.data ?? []).map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="tabular-nums">v{v.version}</TableCell>
                    <TableCell className="text-muted-foreground">{v.changelog || '—'}</TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{v.createdBy}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {formatDateTime(v.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editing && (
        <EditSkillDialog
          skill={s}
          isAdmin={!!isAdmin}
          pending={update.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(v) => update.mutate(v)}
        />
      )}
    </div>
  );
}

interface EditFormValues {
  name: string;
  description: string;
  private: boolean;
  allowHelp: boolean;
  bundled: boolean;
}

function EditSkillDialog({
  skill,
  isAdmin,
  pending,
  onClose,
  onSubmit,
}: {
  skill: SkillDetail;
  isAdmin: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (v: UpdateSkillRequest) => void;
}) {
  const { register, handleSubmit, control, watch, formState: { errors } } = useForm<EditFormValues>({
    defaultValues: {
      name: skill.name,
      description: skill.description,
      private: skill.visibility === 'private',
      allowHelp: skill.allowHelp,
      bundled: skill.bundled,
    },
  });
  const isPrivate = watch('private');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑元信息</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) =>
            onSubmit({
              name: v.name,
              description: v.description,
              visibility: v.private ? 'private' : 'team',
              allowHelp: v.allowHelp,
              ...(isAdmin ? { bundled: v.bundled && !v.private } : {}),
            }),
          )}
        >
          <Field label="名称" htmlFor="edit-name" required error={errors.name?.message}>
            <Input id="edit-name" aria-invalid={!!errors.name} {...register('name', { required: '请输入名称' })} />
          </Field>
          <Field label="触发描述" htmlFor="edit-desc" hint="可多行；AI 靠它判断何时使用这个 skill">
            <Textarea id="edit-desc" rows={4} {...register('description')} />
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
          <Field label="允许求助" hint="开启后，使用者的 AI 可以就这个 skill 向你发起求助">
            <Controller
              control={control}
              name="allowHelp"
              render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
            />
          </Field>
          {/* 捆绑是替全员做决定，只有管理员能改；私有 skill 不能捆绑（会变成「被强制订阅却看不到」） */}
          {isAdmin && (
            <Field
              label="捆绑模式"
              hint={
                isPrivate
                  ? '私有 Skill 不能捆绑：请先改为团队可见'
                  : '开启后所有成员恒为已订阅、不可退订，eat sync 总会同步；管理员自己不受影响'
              }
            >
              <Controller
                control={control}
                name="bundled"
                render={({ field }) => (
                  <Switch checked={field.value && !isPrivate} disabled={isPrivate} onCheckedChange={field.onChange} />
                )}
              />
            </Field>
          )}
          <Button type="submit" loading={pending} className="w-full">
            保存
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SOURCE_LABEL: Record<SkillSubscriber['source'], string> = {
  manual: '手动订阅',
  template: '角色模板',
  experience: '经验沉淀',
  bundled: '捆绑',
};

/**
 * 订阅者明细与代订阅（仅管理员）。
 * 这是低频管理操作，所以整块放在详情页下方，「添加订阅者」收在卡片标题右侧而不是页面主操作区。
 *
 * 捆绑 skill 上多两个动作（决策 45）：对被捆绑的成员可「解除捆绑」——此后由其自行决定订不订；
 * 解除过的成员若没自己订，就不在订阅者名单里了，所以名单下方单列一块「已解除捆绑」供恢复。
 */
function SubscribersCard({ slug, skill }: { slug: string; skill: SkillDetail }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const subscribers = useQuery({
    queryKey: ['skill-subscribers', slug],
    queryFn: () => api<SkillSubscriber[]>('GET', `/api/skills/${slug}/subscribers`),
  });
  const exemptions = useQuery({
    queryKey: ['skill-bundle-exemptions', slug],
    queryFn: () => api<SkillBundleExemption[]>('GET', `/api/skills/${slug}/bundle-exemptions`),
    enabled: skill.bundled,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['skill-subscribers', slug] });
    void queryClient.invalidateQueries({ queryKey: ['skill-bundle-exemptions', slug] });
    void queryClient.invalidateQueries({ queryKey: ['skill', slug] });
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
  };
  const onError = (err: unknown) => toast.error(err instanceof ApiError ? err.message : '操作失败');

  const remove = useMutation({
    mutationFn: (userId: string) => api('DELETE', `/api/skills/${slug}/subscribers/${userId}`),
    onSuccess: () => {
      toast.success('已取消该用户的订阅');
      invalidate();
    },
    onError,
  });

  const add = useMutation({
    mutationFn: (userId: string) => api('POST', `/api/skills/${slug}/subscribers`, { userId }),
    onSuccess: () => {
      toast.success('已为该用户订阅，对方下次 eat sync 时落地');
      setAdding(false);
      invalidate();
    },
    onError,
  });

  const exempt = useMutation({
    mutationFn: (userId: string) => api('POST', `/api/skills/${slug}/bundle-exemptions`, { userId }),
    onSuccess: () => {
      toast.success('已解除捆绑，该成员可自行决定是否订阅');
      invalidate();
    },
    onError,
  });

  const restore = useMutation({
    mutationFn: (userId: string) => api('DELETE', `/api/skills/${slug}/bundle-exemptions/${userId}`),
    onSuccess: () => {
      toast.success('已恢复捆绑，对方下次 eat sync 时落地');
      invalidate();
    },
    onError,
  });

  const rows = subscribers.data ?? [];
  const exempted = skill.bundled ? (exemptions.data ?? []) : [];
  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">订阅者（{skill.subscriberCount}）</h2>
          <div className="flex flex-wrap items-center gap-2">
            {skill.bundled && (
              <span className="text-xs text-muted-foreground">捆绑 Skill：全体成员恒为订阅，可对个别成员解除捆绑</span>
            )}
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus />
              添加订阅者
            </Button>
          </div>
        </div>
        {subscribers.isPending ? (
          <TableSkeleton rows={2} />
        ) : rows.length === 0 ? (
          <Empty text="还没有人订阅" className="py-6" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead className="hidden w-24 sm:table-cell">来源</TableHead>
                <TableHead className="hidden w-40 md:table-cell">订阅时间</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.userId}>
                  <TableCell>
                    <span className="font-medium">{r.name}</span>
                    {r.role === 'admin' && (
                      <Badge variant="outline" className="ml-2">
                        管理员
                      </Badge>
                    )}
                    {r.bundleExempt && (
                      <Badge variant="outline" className="ml-2">
                        已解除捆绑
                      </Badge>
                    )}
                    <div className="truncate text-xs text-muted-foreground">{r.email}</div>
                    <div className="text-xs text-muted-foreground sm:hidden">{SOURCE_LABEL[r.source]}</div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant={r.source === 'bundled' ? 'warning' : 'secondary'}>{SOURCE_LABEL[r.source]}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {r.subscribedAt ? formatDateTime(r.subscribedAt) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.removable ? (
                      <Confirm
                        title={`取消 ${r.name} 的订阅？`}
                        description="对方下次 eat sync 时会从本地移除这个 skill。"
                        confirmText="取消订阅"
                        onConfirm={() => remove.mutate(r.userId)}
                      >
                        <Button variant="ghost" size="icon-sm" aria-label={`取消 ${r.name} 的订阅`}>
                          <X />
                        </Button>
                      </Confirm>
                    ) : (
                      // 被捆绑的成员：不能直接取消订阅，但可以解除对其的捆绑
                      <Confirm
                        title={`解除 ${r.name} 的捆绑？`}
                        description="解除后这个 skill 对该成员不再强制订阅，由其自行决定是否订阅；未自行订阅的话，下次 eat sync 时会从本地移除。随时可以恢复捆绑。"
                        confirmText="解除捆绑"
                        destructive={false}
                        onConfirm={() => exempt.mutate(r.userId)}
                      >
                        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label={`解除 ${r.name} 的捆绑`}>
                          <LockOpen className="size-3.5" />
                          解除捆绑
                        </Button>
                      </Confirm>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {exempted.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              已解除捆绑（{exempted.length}）· 这些成员自行决定是否订阅
            </h3>
            <ul className="divide-y">
              {exempted.map((e) => (
                <li key={e.userId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{e.name}</span>
                    <Badge variant={e.subscribed ? 'success' : 'outline'} className="ml-2">
                      {e.subscribed ? '已自行订阅' : '未订阅'}
                    </Badge>
                    <div className="truncate text-xs text-muted-foreground">
                      {e.email} · {e.exemptedBy} 于 {formatDateTime(e.exemptedAt)} 解除
                    </div>
                  </div>
                  <Confirm
                    title={`恢复 ${e.name} 的捆绑？`}
                    description="恢复后这个 skill 对该成员重新强制订阅、不可退订，对方下次 eat sync 时落地。"
                    confirmText="恢复捆绑"
                    destructive={false}
                    onConfirm={() => restore.mutate(e.userId)}
                  >
                    <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label={`恢复 ${e.name} 的捆绑`}>
                      <Lock className="size-3.5" />
                      恢复捆绑
                    </Button>
                  </Confirm>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      {adding && (
        <AddSubscriberDialog
          existing={rows.map((r) => r.userId)}
          bundled={skill.bundled}
          pending={add.isPending}
          onClose={() => setAdding(false)}
          onSubmit={(userId) => add.mutate(userId)}
        />
      )}
    </Card>
  );
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
}

function AddSubscriberDialog({
  existing,
  bundled,
  pending,
  onClose,
  onSubmit,
}: {
  existing: string[];
  /** 捆绑 skill 上，能添加的只剩没自己订的管理员与已解除捆绑的成员（其余人本就恒为订阅、都在名单里） */
  bundled: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (userId: string) => void;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('GET', '/api/users') });
  // 已订阅的与已禁用的不再列出——选了也只会被服务端拒掉
  const options = (users.data ?? [])
    .filter((u) => u.status === 'active' && !existing.includes(u.id))
    .map((u) => ({ value: u.id, label: u.name, hint: u.email }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加订阅者</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field
            label="成员"
            hint={
              bundled
                ? '捆绑 Skill 全体成员本就恒为订阅，这里只会列出未自行订阅的管理员与已解除捆绑的成员'
                : '订阅后对方下次 eat sync 就会落地这个 skill'
            }
          >
            <Combobox
              groups={[{ options }]}
              value={userId}
              onChange={setUserId}
              placeholder={options.length === 0 ? '没有可添加的成员' : '选择成员…'}
              searchPlaceholder="搜索姓名 / 邮箱…"
            />
          </Field>
          <Button disabled={!userId} loading={pending} onClick={() => userId && onSubmit(userId)} className="w-full">
            添加
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
