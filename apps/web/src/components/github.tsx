import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GithubAccountInfo, GithubAppInfo, GithubMemberInfo, GithubRole } from '@eat/shared';
import { toast } from 'sonner';
import { api, getToken } from '../api';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Confirm } from './confirm';

const orgLabels: Record<string, string> = { unknown: '状态待核验', absent: '未加入组织', pending: '邀请待接受', processing: '加入处理中', active: '已加入组织' };
const taskLabels: Record<string, string> = { pending: '等待处理', waiting: '等待完成前置步骤', succeeded: '已处理', failed: '未完成', cancelled: '已取消', not_requested: '未请求授权', unlinked: '未绑定' };
const roleLabels: Record<string, string> = { unknown: '待核验', none: '无权限', read: 'Read', triage: 'Triage', write: 'Write', maintain: 'Maintain', admin: 'Admin' };
const onError = (e: Error) => toast.error(e.message);

export function GithubAccountPanel({ userId }: { userId?: string }) {
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
        {!userId && d.linked && <Confirm title="解绑 GitHub？" description="清除关联凭据并停止待授权操作，不会自动退出 GitHub 组织。" confirmText="解绑" onConfirm={() => unlink.mutate()}><Button size="sm" variant="outline-destructive">解绑</Button></Confirm>}
      </div>
      {!userId && d.linked && d.orgState === 'absent' && <p className="text-xs text-muted-foreground">暂无有效邀请，请联系管理员发送组织邀请。</p>}
      {d.checkedAt && <p className="text-xs text-muted-foreground">最近核验：{new Date(d.checkedAt).toLocaleString()}</p>}
    </div>;
  })();
  return userId ? content : <Card><CardHeader><CardTitle>GitHub 账户</CardTitle></CardHeader><CardContent>{content}</CardContent></Card>;
}
function useGithubApp(slug: string) {
  return useQuery({ queryKey: ['github-app', slug, getToken()], queryFn: () => api<GithubAppInfo>('GET', `/api/apps/${slug}/github`), refetchInterval: 10000 });
}
export function GithubAppSummary({ slug, compact = false }: { slug: string; compact?: boolean }) {
  const query = useGithubApp(slug), cache = useQueryClient();
  const refresh = useMutation({ mutationFn: () => api('POST', `/api/apps/${slug}/github/refresh`),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['github-app', slug] }), onError });
  if (!query.data) return <p className="mt-1 text-xs text-muted-foreground">{query.isError ? 'GitHub 状态暂不可用' : 'GitHub 状态加载中…'}</p>;
  const d = query.data;
  if (!d.enabled && compact) return null;
  return <div className={`${compact ? 'mt-1 text-xs' : 'rounded-md border p-3 text-sm'} space-y-1`}>
    <div className="flex flex-wrap gap-1.5"><Badge variant={d.scope === 'organization' ? 'success' : 'outline'}>{d.scope === 'organization' ? 'EAT 组织仓库' : d.scope === 'outside' ? '非指定组织仓库' : '仓库归属待核验'}</Badge>
      <span>应用 owner：{d.ownerLogin ? `@${d.ownerLogin} · ${roleLabels[d.ownerRole]}` : 'GitHub 未绑定'}</span>
      {d.ownerIsOrgOwner && <Badge variant="outline">组织 Owner</Badge>}</div>
    {!compact && <><p className="text-muted-foreground break-all">仓库：{d.repository ?? '待核验'} · 所有者：{d.scope === 'organization' ? d.organization : '待核验'}</p>
      {d.checkedAt && <p className="text-xs text-muted-foreground">最近核验：{new Date(d.checkedAt).toLocaleString()}</p>}
      {d.error && <p className="text-destructive">{d.error}</p>}
      {d.enabled && <Button size="sm" variant="outline" loading={refresh.isPending} onClick={() => refresh.mutate()}>刷新 GitHub 状态</Button>}
      <p className="text-xs text-muted-foreground">更换仓库后需重新审批。待核验信息不代表无权限。</p></>}
  </div>;
}
function MemberActions({ member: m, slug }: { member: GithubMemberInfo; slug: string }) {
  const cache = useQueryClient(), [role, setRole] = useState<GithubRole>('write');
  const change = useMutation({ mutationFn: (next?: GithubRole) => api(next ? 'PUT' : 'POST', `/api/apps/${slug}/github/members/${m.userId}/${next ? 'role' : 'retry'}`, next ? { role: next } : undefined),
    onSuccess: () => { toast.success('GitHub 操作已提交'); void cache.invalidateQueries({ queryKey: ['github-app', slug] }); }, onError });
  return <div className="flex flex-wrap gap-2">
    {m.canGrant && <Button size="sm" variant="outline" onClick={() => change.mutate(undefined)} loading={change.isPending}>授予 Write／重试</Button>}
    {m.canChangeRole && <><select aria-label={`选择 ${m.name} 的仓库角色`} className="rounded-md border bg-background px-2 text-sm" value={role} onChange={e => setRole(e.target.value as GithubRole)}>
      {(['read','triage','write','maintain','admin'] as const).map(r => <option key={r} value={r}>{roleLabels[r]}</option>)}</select>
      <Confirm title={`将 ${m.name} 的仓库角色设为 ${roleLabels[role]}？`} description="这会修改整个 GitHub 仓库的直接授权，影响引用同一仓库的其他应用。团队或组织继承权限可能仍然生效。" confirmText="修改角色" destructive={false} onConfirm={() => change.mutate(role)}>
        <Button size="sm" variant="outline" disabled={change.isPending}>修改角色</Button></Confirm></>}
  </div>;
}
export function GithubMembers({ slug }: { slug: string }) {
  const query = useGithubApp(slug);
  if (!query.data?.enabled) return null;
  return <div className="space-y-3"><h3 className="text-sm font-semibold">成员的 GitHub 仓库权限</h3>
    <p className="text-xs text-muted-foreground">EAT 成员权限独立生效。仓库授权未完成时，可由有权限的成员或管理员补操作。</p>
    {query.data.members.map(m => <div key={m.userId} className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{m.name}</span><span>{m.login ? `@${m.login}` : '未绑定 GitHub'}</span>
        <Badge variant="outline">{orgLabels[m.orgState]}</Badge><Badge variant="secondary">{roleLabels[m.role]}</Badge><span className="text-muted-foreground">{taskLabels[m.state] ?? m.state}</span></div>
      {m.error && <p className="text-destructive break-words">{m.error}</p>}{m.notification && <p className="text-xs text-muted-foreground">{m.notification}</p>}
      <MemberActions slug={slug} member={m} />
    </div>)}
  </div>;
}
