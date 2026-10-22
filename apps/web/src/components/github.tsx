import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GithubAccountInfo, GithubAppInfo, GithubMemberInfo, GithubRole } from '@eat/shared';
import { toast } from 'sonner';
import { api, getToken } from '../api';
import { Button } from './ui/button';
import { Tip } from './ui/tooltip';
import { formatDateTime } from '../lib/format';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Confirm } from './confirm';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

const orgLabels: Record<string, string> = { unknown: '状态待核验', absent: '未加入组织', pending: '邀请待接受', processing: '加入处理中', active: '已加入组织' };
const taskLabels: Record<string, string> = { pending: '等待处理', waiting: '等待完成前置步骤', succeeded: '已处理', failed: '未完成', cancelled: '已取消', not_requested: '未请求授权', unlinked: '未绑定' };
const roleLabels: Record<string, string> = { unknown: '待核验', none: '无权限', read: 'Read', triage: 'Triage', write: 'Write', maintain: 'Maintain', admin: 'Admin' };
const onError = (e: Error) => toast.error(e.message);

export function GithubAccountPanel({ userId, embedded = false }: { userId?: string; embedded?: boolean }) {
  const cache = useQueryClient();
  const key = ['github-account', userId ?? 'me', getToken()];
  const base = userId ? `/api/users/${userId}/github` : '/api/account/github';
  const query = useQuery({ queryKey: key, queryFn: () => api<GithubAccountInfo>('GET', base), refetchInterval: 10000 });
  const action = useMutation({ mutationFn: (kind: string) => userId
    ? api('POST', base, { action: kind }) : api('POST', `${base}/${kind}`),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ['github-account'] }); toast.success('已提交，状态将自动更新'); }, onError });
  const authorize = useMutation({ mutationFn: () => api<{ url: string }>('POST', '/api/account/github/authorize'),
    onSuccess: r => { window.location.assign(r.url); }, onError });
  const unlink = useMutation({ mutationFn: () => api('DELETE', '/api/account/github'),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ['github-account'] }); void cache.invalidateQueries({ queryKey: ['github-app'] }); }, onError });
  const content = !query.data ? <p className="text-sm text-muted-foreground">{query.isError ? 'GitHub 状态加载失败' : '正在加载 GitHub 状态…'}{query.isError && <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>重试</Button>}</p> : (() => {
    const d = query.data;
    return <div className="space-y-2 text-sm">
      {!userId && <p className="text-muted-foreground">可选关联，自动邀请并尝试加入 {d.organization || '平台组织'}。不影响 EAT 原有功能。</p>}
      {!userId && new URLSearchParams(location.search).get('github') === 'failed' && <p className="text-destructive">GitHub 关联未完成，请重新尝试。请确认未关联其他 EAT 账户。</p>}
      <div className="flex flex-wrap items-center gap-2"><span>{d.login ? `@${d.login}` : '未关联 GitHub'}</span>
        {d.linked && <Badge variant={d.orgState === 'active' ? 'success' : 'outline'}>{orgLabels[d.orgState]}</Badge>}
        {!d.enabled && <Badge variant="outline">接入未启用</Badge>}</div>
      {d.needsAuthorization && <p className="text-destructive">用户需要重新授权 GitHub</p>}
      {d.task && <p className="text-muted-foreground">{taskLabels[d.task.state] ?? d.task.state}</p>}
      {(d.task?.error || d.error) && <p className="text-destructive break-words">{d.task?.error || d.error}</p>}
      {d.task?.notification && <p className="text-xs text-muted-foreground">{d.task.notification}</p>}
      <div className="flex flex-wrap gap-2">
        {!userId && d.enabled && <Button size="sm" variant="outline" onClick={() => authorize.mutate()} loading={authorize.isPending}>{d.linked ? '重新授权' : '关联 GitHub'}</Button>}
        {d.linked && d.enabled && <Button size="sm" variant="outline" onClick={() => action.mutate('refresh')} loading={action.isPending}>刷新状态</Button>}
        {d.linked && d.enabled && d.orgState !== 'active' && (userId
          ? <Button size="sm" onClick={() => action.mutate('join')} disabled={action.isPending}>发送／重新发送邀请</Button>
          : <Button size="sm" onClick={() => action.mutate('accept')} disabled={action.isPending || !['pending', 'processing'].includes(d.orgState)}>同意邀请</Button>)}
        {!userId && d.linked && d.orgState !== 'active' && d.organization && <a className="self-center text-primary hover:underline" href={`https://github.com/orgs/${encodeURIComponent(d.organization)}/invitation`} target="_blank" rel="noreferrer">前往 GitHub 处理</a>}
        {userId && d.linked && d.enabled && <Confirm title="移除组织成员或取消邀请？" description="这将移除该用户对组织全部仓库的成员访问，EAT 成员关系不变。" confirmText="移除／取消" onConfirm={() => action.mutate('remove-org')}><Button size="sm" variant="outline-destructive">移出组织</Button></Confirm>}
        {!userId && d.linked && <Confirm title="解除 GitHub 账户关联？" description="清除关联凭据并取消旧身份的待执行授权。EAT 应用成员身份和部署权限保留，不会退出 GitHub 组织或撤销已有仓库权限。成员列表将显示“未关联 GitHub”，不再展示旧角色。解绑不等于撤销仓库访问。" confirmText="解除关联" onConfirm={() => unlink.mutate()}><Button size="sm" variant="outline-destructive">解除关联</Button></Confirm>}
      </div>
      {!userId && d.linked && d.orgState === 'absent' && <p className="text-xs text-muted-foreground">暂无有效邀请，请联系管理员发送组织邀请。</p>}
      {d.checkedAt && <p className="text-xs text-muted-foreground">最近核验：{new Date(d.checkedAt).toLocaleString()}</p>}
    </div>;
  })();
  return userId || embedded ? content : <Card><CardHeader><CardTitle>GitHub 账户</CardTitle></CardHeader><CardContent>{content}</CardContent></Card>;
}
export function useGithubApp(slug: string) {
  return useQuery({ queryKey: ['github-app', slug, getToken()], queryFn: () => api<GithubAppInfo>('GET', `/api/apps/${slug}/github`), refetchInterval: 10000 });
}
/** 列表只显示仓库归属；使用独立缓存查询，不阻塞应用列表或推断查询失败的结果。 */
export function GithubRepositoryScope({ slug }: { slug: string }) {
  const query = useGithubApp(slug);
  if (query.isError) return <Tip content="GitHub 状态查询失败，可进入详情刷新"><span>归属暂不可用</span></Tip>;
  if (!query.data) return <span>归属加载中…</span>;
  const d = query.data;
  if (!d.enabled) return <Tip content="GitHub 集成未启用，仓库归属尚未重新核验"><span>归属待核验 · GitHub 未启用</span></Tip>;
  return <Tip content={d.error || (d.checkedAt ? `最近核验：${formatDateTime(d.checkedAt)}` : undefined)}><span>
    {d.scope === 'organization' ? 'EAT 组织仓库' : d.scope === 'outside' ? '非 EAT 组织仓库' : '仓库归属待核验'}
  </span></Tip>;
}
export function GithubAppSummary({ slug, compact = false, showOwner = true }: { slug: string; compact?: boolean; showOwner?: boolean }) {
  const query = useGithubApp(slug), cache = useQueryClient();
  const refresh = useMutation({ mutationFn: () => api('POST', `/api/apps/${slug}/github/refresh`),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['github-app', slug] }), onError });
  if (!query.data) return <p className="mt-1 text-xs text-muted-foreground">{query.isError ? 'GitHub 状态暂不可用' : 'GitHub 状态加载中…'}</p>;
  const d = query.data;
  if (!d.enabled && compact) return null;
  return <div className={`${compact ? 'mt-1 text-xs' : 'rounded-md border p-3 text-sm'} space-y-1`}>
    <div className="flex flex-wrap gap-1.5"><Badge variant={d.scope === 'organization' ? 'success' : 'outline'}>{d.scope === 'organization' ? 'EAT 组织仓库' : d.scope === 'outside' ? '非指定组织仓库' : '仓库归属待核验'}</Badge>
      {showOwner && <span>应用所有者：{d.ownerLogin ? `@${d.ownerLogin} · ${roleLabels[d.ownerRole]}` : 'GitHub 未绑定'}</span>}
      {showOwner && d.ownerIsOrgOwner && <Badge variant="outline">组织 Owner</Badge>}</div>
    {!compact && <><p className="text-muted-foreground break-all">仓库：{d.repository ?? '待核验'} · 所有者：{d.scope === 'organization' ? d.organization : '待核验'}</p>
      {d.checkedAt && <p className="text-xs text-muted-foreground">最近核验：{new Date(d.checkedAt).toLocaleString()}</p>}
      {d.error && <p className="text-destructive">{d.error}</p>}
      {d.enabled && <Button size="sm" variant="outline" loading={refresh.isPending} onClick={() => refresh.mutate()}>刷新 GitHub 状态</Button>}
      <p className="text-xs text-muted-foreground">更换仓库后需重新审批。待核验信息不代表无权限。</p></>}
  </div>;
}
const roleDescriptions: Record<GithubRole, string> = {
  read: '查看与克隆仓库，不可推送代码。', triage: '管理 Issue 和 Pull Request，不可推送代码。',
  write: '推送代码，参与日常开发协作。', maintain: '维护仓库与日常设置。', admin: '管理仓库设置及访问权限。',
};
function hasRole(m: GithubMemberInfo): m is GithubMemberInfo & { role: GithubRole } {
  return m.role !== 'none' && m.role !== 'unknown';
}
const processing = (m: GithubMemberInfo) => m.state === 'pending' || m.state === 'verifying';
export function roleText(m: GithubMemberInfo) {
  if (!m.login) return '未关联 GitHub';
  if (hasRole(m)) return roleLabels[m.role];
  return m.role === 'none' && !m.roleError ? '未添加到仓库' : '暂未核验';
}
export function memberHint(m: GithubMemberInfo) {
  if (!m.login) return '关联账户后才能核验；原 GitHub 仓库权限不会因解绑而自动撤销。';
  if (m.needsAuthorization) return '请本人在用户中心重新授权 GitHub。';
  if (m.state === 'verifying') return '操作已执行，正在核验实际角色。';
  if (m.state === 'pending') return m.operation === 'role' ? '正在修改，完成后更新实际角色。' : '正在添加，完成后更新实际角色。';
  if (m.roleError) return `${hasRole(m) ? '显示上次核验角色，待更新。' : '暂时无法核验，不能判定没有权限。'}${m.roleError}`;
  if (m.orgState !== 'active') return m.orgState === 'pending' ? '等待本人接受组织邀请。' : m.orgState === 'unknown' ? '组织状态待核验。' : '加入组织后可设置仓库权限。';
  if (m.state === 'failed') return `最近一次${m.operation === 'role' ? '修改' : '添加'}未完成。${m.error}`;
  return m.error;
}
function MemberRoleDialog({ member: m, slug, repository, onClose }: { member: GithubMemberInfo; slug: string; repository: string | null; onClose: () => void }) {
  const cache = useQueryClient();
  const [initial] = useState({ login: m.login, role: m.role });
  const adding = initial.role === 'none';
  const [role, setRole] = useState<GithubRole>(hasRole(m) ? m.role : 'write');
  const [error, setError] = useState('');
  const allowed = adding ? m.canGrant && (role === 'write' || m.canChangeRole) : m.canChangeRole;
  const stale = initial.login !== m.login || initial.role !== m.role;
  const unavailable = !m.login || !!m.needsAuthorization || m.orgState !== 'active' || !!m.roleError || processing(m) || !allowed || stale;
  const change = useMutation({
    mutationFn: () => api(adding ? 'POST' : 'PUT', `/api/apps/${slug}/github/members/${m.userId}/${adding ? 'add' : 'role'}`, { role }),
    onSuccess: async () => {
      // The worker performs the GitHub operation; do not optimistically replace the actual role.
      cache.setQueryData<GithubAppInfo>(['github-app', slug, getToken()], data => data ? { ...data,
        members: data.members.map(member => member.userId === m.userId ? { ...member, state: 'pending', operation: adding ? 'grant' : 'role', error: '' } : member) } : data);
      toast.success('GitHub 操作已提交，核验后更新角色');
      onClose();
      await cache.invalidateQueries({ queryKey: ['github-app'] });
      await cache.invalidateQueries({ queryKey: ['github-collaborators'] });
    },
    onError: (e: Error) => setError(e.message),
  });
  return <Dialog open onOpenChange={open => !open && !change.isPending && onClose()}>
    <DialogContent>
      <DialogHeader><DialogTitle>{adding ? '添加到仓库' : '修改仓库角色'}</DialogTitle><DialogDescription className="break-all">{repository}</DialogDescription></DialogHeader>
      <div className="rounded-lg border bg-muted/40 p-3 text-sm"><p className="font-medium">{m.name}</p><p className="mt-1 text-xs text-muted-foreground">@{m.login} · {adding ? '未添加到仓库' : `当前角色：${roleLabels[m.role]}`}</p></div>
      <div className="space-y-2"><label className="text-sm font-medium" htmlFor="github-member-role">{adding ? '添加后的角色' : '新角色'}</label>
        <select id="github-member-role" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={role} disabled={change.isPending || unavailable} onChange={e => { setRole(e.target.value as GithubRole); setError(''); }}>
          {(m.canChangeRole ? (['read', 'triage', 'write', 'maintain', 'admin'] as const) : ['write'] as const).map(value => <option key={value} value={value}>{roleLabels[value]}{adding && value === 'write' ? '（默认）' : ''}</option>)}
        </select><p className="text-xs text-muted-foreground">{roleDescriptions[role]}</p>
      </div>
      <p className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">仅修改 GitHub 仓库访问权限，不改变 EAT 应用身份。会影响同一仓库关联的其他应用；团队或组织继承的权限仍然生效。</p>
      {(error || unavailable) && <p role="alert" className="text-sm text-destructive">{error || '账户、权限或仓库状态已变化，请关闭窗口并重新核验。'}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={change.isPending} onClick={onClose}>取消</Button><Button loading={change.isPending} disabled={unavailable || (!adding && role === m.role)} onClick={() => change.mutate()}>{adding ? '添加到仓库' : '保存角色'}</Button></div>
    </DialogContent>
  </Dialog>;
}
export function MemberActions({ member: m, slug, repository }: { member: GithubMemberInfo; slug: string; repository: string | null }) {
  const [editing, setEditing] = useState(false);
  const canEdit = hasRole(m) ? m.canChangeRole : m.role === 'none' && m.canGrant;
  const waiting = !m.login ? '等待本人关联' : m.needsAuthorization ? '等待本人授权' : '等待核验';
  return <>
    {!m.login || m.needsAuthorization || m.role === 'unknown' || (!!m.roleError && !hasRole(m)) ? <span className="text-xs text-muted-foreground">{waiting}</span>
      : canEdit ? <Button size="sm" variant="outline" disabled={processing(m) || m.orgState !== 'active' || !!m.roleError} onClick={() => setEditing(true)}>
        {m.state === 'verifying' ? '核验中…' : m.state === 'pending' ? (m.operation === 'role' ? '修改中…' : '添加中…') : hasRole(m) ? '修改角色' : '添加到仓库'}
      </Button> : <span className="text-xs text-muted-foreground">仅可查看</span>}
    {editing && <MemberRoleDialog member={m} slug={slug} repository={repository} onClose={() => setEditing(false)} />}
  </>;
}
