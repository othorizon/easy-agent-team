import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GithubAppInfo, GithubCollaborator, GithubCollaboratorsInfo, GithubMemberInfo, GithubRole } from '@eat/shared';
import { toast } from 'sonner';
import { api, getToken } from '../api';
import { MemberActions, memberHint, roleText } from './github';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

const labels: Record<string, string> = { read: 'Read', triage: 'Triage', write: 'Write', maintain: 'Maintain', admin: 'Admin', unknown: '暂未核验', none: '无权限' };
export function useRepositoryCollaborators(slug: string, enabled: boolean) {
  return useQuery({ queryKey: ['github-collaborators', slug, getToken()],
    queryFn: () => api<GithubCollaboratorsInfo>('GET', `/api/apps/${slug}/github/collaborators`),
    enabled, staleTime: 30000, retry: false });
}

/** Prefer the full repository observation after a manual revoke, before the background member cache catches up. */
export function observedMember(member: GithubMemberInfo | undefined, repository?: GithubCollaboratorsInfo) {
  if (!member?.login || !repository || (member.roleCheckedAt && member.roleCheckedAt > repository.checkedAt)) return member;
  const actual = repository.collaborators.find(c => c.userId === member.userId && c.login.toLowerCase() === member.login!.toLowerCase());
  if (!actual && member.role === 'unknown') return member;
  return { ...member, role: actual?.role ?? 'none' as const, roleError: actual?.roleError ?? '', roleCheckedAt: repository.checkedAt };
}
export function ApplicationMemberGithub({ member, enabled }: { member?: GithubMemberInfo; enabled?: boolean }) {
  if (enabled === false) return <span className="text-xs text-muted-foreground">GitHub 接入未启用</span>;
  if (!member) return <span className="text-xs text-muted-foreground">GitHub 状态待核验</span>;
  const hint = member.roleError || (member.role === 'none' || member.role === 'unknown' || !member.login ? memberHint(member) : '');
  return <div className="min-w-0 text-xs text-muted-foreground"><p className="break-words">{member.login && <span className="mr-2 break-all">@{member.login} ·</span>}{roleText(member)}</p>
    {hint && <p className="mt-1 break-words">{hint}</p>}</div>;
}
export function ApplicationMemberAdd({ member, slug, repository }: { member?: GithubMemberInfo; slug: string; repository: string | null }) {
  return member?.login && member.role === 'none' ? <MemberActions member={member} slug={slug} repository={repository} /> : null;
}

function CollaboratorDialog({ slug, info, member, removing, onClose, unavailable }: {
  slug: string; info: GithubCollaboratorsInfo; member: GithubCollaborator; removing: boolean; onClose: () => void; unavailable: boolean;
}) {
  const cache = useQueryClient();
  const [role, setRole] = useState<GithubRole>(member.role === 'unknown' ? 'write' : member.role);
  const [initial] = useState({ githubId: member.githubId, role: member.role, repositoryId: info.repositoryId, repoVersion: info.repoVersion });
  const stale = initial.role !== member.role || initial.repositoryId !== info.repositoryId || initial.repoVersion !== info.repoVersion || !member.direct;
  const blocked = unavailable || stale || !info.canManage || !!member.roleError || member.role === 'unknown';
  const change = useMutation({
    mutationFn: () => api<{ role: string; direct: boolean }>('PUT', `/api/apps/${slug}/github/collaborators/${initial.githubId}`, {
      repositoryId: initial.repositoryId, repoVersion: initial.repoVersion, expectedRole: initial.role, role: removing ? null : role,
    }),
    onSuccess: result => {
      toast.success(removing ? (result.role === 'none' ? '已移除仓库直接授权' : `已移除直接授权，仍有 ${labels[result.role] ?? result.role} 访问权限`)
        : result.role === role ? '仓库角色已更新' : `直接角色已设置，实际权限为 ${labels[result.role] ?? result.role}`);
      onClose();
    },
    onSettled: async () => {
      await Promise.all([cache.invalidateQueries({ queryKey: ['github-collaborators'] }), cache.invalidateQueries({ queryKey: ['github-app'] })]);
    },
  });
  return <Dialog open onOpenChange={open => !open && !change.isPending && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>{removing ? `从仓库移除 @${member.login}？` : '修改仓库角色'}</DialogTitle><DialogDescription>{info.repository}</DialogDescription></DialogHeader>
    <div className="rounded-lg border bg-muted/40 p-3 text-sm"><p className="break-all font-medium">{member.name ? `${member.name} · ` : ''}@{member.login}</p><p className="mt-1 text-xs text-muted-foreground">当前角色：{labels[member.role]} · 直接授权</p></div>
    {removing ? <p className="text-sm leading-relaxed">将撤销该账户在这个 GitHub 仓库中的直接授权。EAT 应用成员身份和原有应用功能保留。</p>
      : <div className="space-y-2"><label htmlFor="github-collaborator-role" className="text-sm font-medium">新角色</label><select id="github-collaborator-role" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={role} disabled={change.isPending || blocked} onChange={e => { setRole(e.target.value as GithubRole); change.reset(); }}>
        {(['read', 'triage', 'write', 'maintain', 'admin'] as const).map(r => <option key={r} value={r}>{labels[r]}</option>)}</select></div>}
    <p className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">此操作影响同一仓库关联的所有应用。团队或组织继承的访问仍可能生效。提交后核验实际权限；直接授权仍存在时，列表继续显示当前角色和操作入口。</p>
    {(change.isError || blocked) && <p role="alert" className="text-sm text-destructive">{change.isError ? change.error.message : '账户、角色或仓库状态已变化，请关闭窗口并刷新后重新确认。'}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={change.isPending} onClick={onClose}>取消</Button><Button variant={removing ? 'destructive' : 'default'} loading={change.isPending} disabled={blocked || (!removing && role === member.role)} onClick={() => change.mutate()}>{removing ? '确认从仓库移除' : '保存角色'}</Button></div>
  </DialogContent></Dialog>;
}

export function GithubRepositoryMembers({ slug, appInfo }: { slug: string; appInfo?: GithubAppInfo }) {
  const cache = useQueryClient();
  const query = useRepositoryCollaborators(slug, !!appInfo?.enabled && appInfo.scope === 'organization');
  const [scope, setScope] = useState('all'), [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ member: GithubCollaborator; removing: boolean } | null>(null);
  const refresh = useMutation({ mutationFn: async () => {
    await api('POST', `/api/apps/${slug}/github/refresh`);
    await Promise.all([cache.invalidateQueries({ queryKey: ['github-app', slug] }), cache.invalidateQueries({ queryKey: ['github-collaborators', slug] })]);
  }, onError: (e: Error) => toast.error(e.message) });
  const info = query.data, rows = info?.collaborators ?? [];
  const latestMemberCheck = appInfo?.members.reduce((latest, m) => m.roleCheckedAt && m.roleCheckedAt > latest ? m.roleCheckedAt : latest, '') ?? '';
  useEffect(() => {
    if (info && !query.isError && latestMemberCheck > info.checkedAt)
      void cache.invalidateQueries({ queryKey: ['github-collaborators', slug] });
  }, [latestMemberCheck, info?.checkedAt, query.isError, cache, slug]);
  const category = (m: GithubCollaborator) => m.relation === 'owner' || m.relation === 'member' ? 'member' : m.relation;
  const matches = rows.filter(m => (scope === 'all' || category(m) === scope) && `${m.login} ${m.name ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = editing && (rows.find(m => m.githubId === editing.member.githubId) ?? editing.member);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-base font-semibold">GitHub 仓库权限 {info && <span className="ml-1 text-sm font-normal text-muted-foreground">{rows.length}</span>}</h3><p className="mt-2 break-all text-xs text-muted-foreground">{info?.repository ?? appInfo?.repository ?? '仓库待核验'} · 展示仓库中所有有权限的用户</p></div><Button size="sm" variant="outline" disabled={!appInfo?.enabled} loading={refresh.isPending || query.isFetching} onClick={() => refresh.mutate()}>刷新 GitHub 状态</Button></div>
    {!appInfo ? <p className="text-sm text-muted-foreground">GitHub 状态待核验</p> : !appInfo.enabled ? <p className="text-sm text-muted-foreground">GitHub 集成未启用，EAT 应用成员权限独立生效。</p> : appInfo.scope !== 'organization' ? <p className="text-sm text-muted-foreground">{appInfo.scope === 'outside' ? '非指定组织仓库，不管理仓库权限。' : '仓库归属待核验，请刷新状态。'}</p> : <>
      {query.isError && <p role="alert" className="text-sm text-destructive">仓库用户列表加载失败：{query.error.message}{info && '。当前显示上次查询结果，请刷新后再操作。'}</p>}
      {!info && query.isPending && <p className="text-sm text-muted-foreground">正在读取仓库用户…</p>}
      {info && <><div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"><div className="flex flex-wrap gap-1" aria-label="仓库用户范围">
        {([['all', '全部'], ['member', '应用成员'], ['eat', '其他 EAT 用户'], ['external', '非 EAT 成员']] as const).map(([value, label]) => <Button key={value} variant={scope === value ? 'secondary' : 'ghost'} size="sm" aria-pressed={scope === value} onClick={() => setScope(value)}>{label} <span className="text-muted-foreground">{value === 'all' ? rows.length : rows.filter(m => category(m) === value).length}</span></Button>)}
      </div><Input className="h-8 xl:w-60" type="search" aria-label="搜索仓库用户" placeholder="搜索姓名或 GitHub 账号" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="overflow-hidden rounded-lg border"><div aria-hidden className="hidden grid-cols-[1fr_1fr_.7fr_1fr_12rem] gap-3 bg-muted/30 px-4 py-3 text-xs text-muted-foreground lg:grid"><span>GitHub 用户</span><span>EAT 身份</span><span>当前角色</span><span>授权方式</span><span className="text-right">操作</span></div>
          {matches.map(m => <section key={m.githubId} aria-label={`@${m.login} 的仓库权限`} className="grid grid-cols-2 items-center gap-3 border-t px-4 py-4 first:border-t-0 lg:grid-cols-[1fr_1fr_.7fr_1fr_12rem]">
            <div className="min-w-0"><p className="break-all text-sm font-medium">@{m.login}</p>{m.name && <p className="mt-1 break-words text-xs text-muted-foreground">{m.name}</p>}</div>
            <div className="text-right lg:text-left"><Badge variant={m.relation === 'external' ? 'outline' : 'secondary'}>{m.relation === 'owner' ? '应用所有者' : m.relation === 'member' ? '应用成员' : m.relation === 'eat' ? 'EAT 用户' : '非 EAT 成员'}</Badge>{m.relation === 'eat' && <p className="mt-1 text-xs text-muted-foreground">非应用成员</p>}</div>
            <div><p className="text-sm">{m.role !== 'unknown' && <span aria-hidden className="mr-1.5 inline-block size-1.5 rounded-full bg-success" />}{labels[m.role]}</p>{m.roleError && <p className="mt-1 break-words text-xs text-muted-foreground">{m.roleError}</p>}</div>
            <p className="text-right text-xs text-muted-foreground lg:text-left">{m.direct ? '直接授权' : '非直接授权'}</p>
            <div className="col-span-2 flex flex-wrap justify-end gap-2 lg:col-span-1">{m.direct && info.canManage ? <><Button size="sm" variant="outline" disabled={query.isError || !!m.roleError || m.role === 'unknown'} onClick={() => setEditing({ member: m, removing: false })}>修改角色</Button><Button size="sm" variant="outline-destructive" disabled={query.isError || !!m.roleError || m.role === 'unknown'} onClick={() => setEditing({ member: m, removing: true })}>从仓库移除</Button></> : <span className="text-xs text-muted-foreground">{m.direct ? '仅可查看' : '需在权限来源处调整'}</span>}</div>
          </section>)}{!matches.length && <p className="p-6 text-center text-sm text-muted-foreground">{rows.length ? '没有匹配的用户' : '仓库中暂无有权限的用户'}</p>}
        </div><p className="text-xs leading-relaxed text-muted-foreground">从仓库移除只撤销直接授权，保留 EAT 应用成员身份；团队或组织继承的访问仍可能生效。<br />非 EAT 成员：当前未关联到 EAT 账户。</p></>}
    </>}
    {editing && selected && info && <CollaboratorDialog slug={slug} info={info} member={selected} removing={editing.removing} onClose={() => setEditing(null)} unavailable={query.isError || !rows.some(m => m.githubId === selected.githubId)} />}
  </div>;
}
