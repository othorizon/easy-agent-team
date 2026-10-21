import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GithubSettingsInfo, GithubSetupStart, GithubConnectionState, UpdateGithubSettings } from '@eat/shared';
import { toast } from 'sonner';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Confirm } from '../components/confirm';
import { Input, Textarea } from '../components/ui/input';
import { Field } from '../components/form';
import { SettingsSection, SettingsLoading, SettingsLoadError } from '../components/settings';

export function GithubSettings({ active }: { active: boolean }) {
  const query = useQuery({ queryKey: ['github-settings'], queryFn: () => api<GithubSettingsInfo>('GET', '/api/settings/github'), enabled: active });
  return <SettingsSection title="GitHub 接入" description="关联用户身份，协助加入指定组织和管理应用仓库权限。部署继续使用现有 Dokploy 接入。">
    {query.data ? <div className="space-y-6"><GithubWizard settings={query.data} /><GithubForm key={`${query.data.appId}:${query.data.installationId}:${query.data.enabled}`} settings={query.data} /></div> : query.isError ? <SettingsLoadError error={query.error} retry={() => void query.refetch()} /> : <SettingsLoading />}
  </SettingsSection>;
}
const connectionLabels: Record<GithubConnectionState, string> = {
  unconfigured: '尚未初始化', app_ready: 'App 已创建，待安装', connected: '组织已连接',
  uninstalled: '未安装到组织', app_unavailable: 'App 或凭据不可用', error: '连接待修复',
};
function GithubWizard({ settings }: { settings: GithubSettingsInfo }) {
  const cache = useQueryClient(), checkedApp = useRef('');
  const [organization, setOrganization] = useState(settings.organization);
  const [name, setName] = useState(`EAT ${settings.organization || 'Team'}`);
  const [error, setError] = useState('');
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['github-settings'] });
    void cache.invalidateQueries({ queryKey: ['github-account'] });
    void cache.invalidateQueries({ queryKey: ['github-app'] });
  };
  const onError = (e: Error) => { setError(e.message); refresh(); };
  const initialize = useMutation({ mutationFn: (replaceExisting: boolean) => api<GithubSetupStart>('POST', '/api/settings/github/initialize', {
    organization: settings.appId ? settings.organization : organization, name, replaceExisting,
  }), onSuccess: r => {
    // GitHub's Manifest flow requires a browser POST, not an OAuth redirect or a server-side installation.
    const form = document.createElement('form'); form.method = 'POST'; form.action = r.url;
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'manifest'; input.value = JSON.stringify(r.manifest);
    form.appendChild(input); document.body.appendChild(form); form.submit();
  }, onError });
  const install = useMutation({ mutationFn: () => api<{ url: string }>('POST', '/api/settings/github/install'),
    onSuccess: r => window.location.assign(r.url), onError });
  const check = useMutation({ mutationFn: () => api<{ message: string }>('POST', '/api/settings/github/check'),
    onSuccess: r => { setError(''); toast.success(r.message); }, onError, onSettled: refresh });
  const enable = useMutation({ mutationFn: (enabled: boolean) => api('POST', '/api/settings/github/enabled', { enabled }),
    onSuccess: () => { setError(''); refresh(); }, onError });
  useEffect(() => {
    if (settings.appId && settings.installationId && checkedApp.current !== settings.appId) {
      checkedApp.current = settings.appId; check.mutate();
    }
  }, [settings.appId, settings.installationId, check.mutate]);
  const busy = initialize.isPending || install.isPending || enable.isPending || check.isPending;
  const result = new URLSearchParams(location.search).get('github_setup');
  const state = settings.connectionState ?? (settings.appId ? 'app_ready' : 'unconfigured');
  return <div className="max-w-2xl space-y-4 rounded-lg border p-4 sm:p-5">
    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">连接 GitHub 组织</h3>
      <Badge variant={state === 'connected' ? 'success' : 'outline'}>{connectionLabels[state]}</Badge>
      {settings.appId && <Badge variant={settings.enabled ? 'success' : 'outline'}>{settings.enabled ? '接入已启用' : '接入已关闭'}</Badge>}
    </div>
    <p className="text-sm text-muted-foreground">由 GitHub 组织 Owner 完成。先创建本 EAT 使用的 GitHub App，再将它安装到组织；普通用户只需在个人中心关联 GitHub。</p>
    <ol className="grid gap-2 text-sm sm:grid-cols-3">
      <li className="rounded bg-muted p-2">1. {settings.appId ? 'App 已初始化' : '创建 GitHub App'}</li>
      <li className="rounded bg-muted p-2">2. {state === 'connected' ? '组织安装已核验' : '安装到指定组织'}</li>
      <li className="rounded bg-muted p-2">3. {settings.enabled ? '用户可关联账户' : '启用用户关联'}</li>
    </ol>
    {result === 'created' && <p role="status" className="text-sm">App 已创建，配置已安全保存。请继续安装到组织。</p>}
    {result === 'installed' && <p role="status" className="text-sm">组织安装已核验，GitHub 接入已启用。</p>}
    {result === 'requested' && <p role="status" className="text-sm">安装申请待组织 Owner 批准；批准后检查连接并启用接入。</p>}
    {result === 'failed' && <p role="alert" className="text-sm text-destructive">回调未完成、已过期或配置发生变化。若 App 已创建，请从高级设置接入；若组织已安装，请检查连接；否则重新开始。</p>}
    {(error || settings.connectionError) && <p role="alert" className="text-sm text-destructive break-words">{error || settings.connectionError}</p>}
    {!settings.appId ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); setError(''); initialize.mutate(false); }}>
      <Field label="GitHub 组织名称" htmlFor="github-wizard-org"><Input id="github-wizard-org" value={organization} onChange={e => setOrganization(e.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9-]{0,38}" placeholder="例如 eat-team" /></Field>
      <Field label="GitHub App 名称" htmlFor="github-wizard-name"><Input id="github-wizard-name" value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></Field>
      <p className="text-xs text-muted-foreground">将跳转 GitHub 确认创建。权限和回调地址自动填写，密钥自动加密保存。</p>
      <Button type="submit" disabled={busy} loading={initialize.isPending}>初始化 GitHub App</Button>
    </form> : <>
      <p className="text-sm break-all">组织：{settings.organization} · App：{settings.appSlug || settings.appId}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} loading={install.isPending} onClick={() => { setError(''); install.mutate(); }}>{settings.installationId ? '重新安装到组织' : '安装到组织'}</Button>
        <Button variant="outline" disabled={busy} loading={check.isPending} onClick={() => check.mutate()}>检查连接</Button>
        <Button variant="outline" disabled={busy || (!settings.enabled && state !== 'connected')} loading={enable.isPending} onClick={() => enable.mutate(!settings.enabled)}>{settings.enabled ? '关闭接入' : '启用接入'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">仅卸载组织中的 App 时，点击重新安装即可，无需重新初始化。请选择全部仓库并确认所需权限。</p>
      {settings.checkedAt && <p className="text-xs text-muted-foreground">最近核验：{new Date(settings.checkedAt).toLocaleString()}</p>}
      <details className="border-t pt-3" open={state === 'app_unavailable' ? true : undefined}>
        <summary className="cursor-pointer text-sm">App 已被删除？重新初始化</summary>
        <div className="mt-3 space-y-3"><p className="text-sm text-muted-foreground">只有 App 本身已删除或确认需要更换时使用。新 App 仍绑定 {settings.organization}；EAT 用户、应用、成员和现有仓库权限保留，旧凭据清除，待执行操作取消，用户需要重新授权。</p>
          <Field label="新 GitHub App 名称" htmlFor="github-replacement-name"><Input id="github-replacement-name" value={name} onChange={e => setName(e.target.value)} maxLength={100} /></Field>
          <Confirm title="重新初始化 GitHub App？" description="确认旧 App 已删除或需要更换。新 App 创建成功后，所有用户的旧 GitHub 凭据将清除，待执行操作取消；用户需要重新授权。仅卸载组织安装时请取消，使用重新安装。" confirmText="继续创建新 App" onConfirm={() => initialize.mutate(true)}>
            <Button variant="outline-destructive" disabled={busy || !name.trim()} loading={initialize.isPending}>重新初始化 GitHub App</Button>
          </Confirm>
        </div>
      </details>
    </>}
  </div>;
}
function GithubForm({ settings }: { settings: GithubSettingsInfo }) {
  const cache = useQueryClient();
  const [form, setForm] = useState<UpdateGithubSettings>({ enabled: settings.enabled, organization: settings.organization,
    appId: settings.appId, clientId: settings.clientId, installationId: settings.installationId, clientSecret: '', privateKey: '' });
  const [checkResult, setCheckResult] = useState('');
  const onError = (e: Error) => toast.error(e.message);
  const save = useMutation({ mutationFn: () => api('PUT', '/api/settings/github', form), onSuccess: () => {
    setForm(f => ({ ...f, clientSecret: '', privateKey: '' })); setCheckResult('');
    void cache.invalidateQueries({ queryKey: ['github-settings'] }); void cache.invalidateQueries({ queryKey: ['github-account'] });
    void cache.invalidateQueries({ queryKey: ['github-app'] }); toast.success('GitHub 设置已保存');
  }, onError });
  const check = useMutation({ mutationFn: () => api<{ message: string }>('POST', '/api/settings/github/check'),
    onSuccess: r => setCheckResult(r.message), onError: e => setCheckResult(e.message), onSettled: () => void cache.invalidateQueries({ queryKey: ['github-settings'] }) });
  const cleanup = useQuery({ queryKey: ['github-cleanup'], queryFn: () => api<{ grants: { repository: string; login: string; error: string }[]; task: { state: string; error: string; notification: string } | null }>('GET', '/api/settings/github/cleanup'), refetchInterval: 10000 });
  const retry = useMutation({ mutationFn: () => api('POST', '/api/settings/github/cleanup'), onSuccess: () => void cleanup.refetch(), onError });
  return <div className="space-y-6"><details className="rounded-lg border p-4"><summary className="cursor-pointer font-medium">高级设置：手动配置已有 GitHub App</summary><p className="my-3 text-sm text-muted-foreground">已有 App 可在此接入或轮换密钥。卸载后可在上方重新安装；App 被删除后请使用重新初始化。</p><form className="max-w-2xl space-y-4" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />启用 GitHub 接入</label>
    <p className="text-sm text-muted-foreground">App 需安装到指定组织的全部仓库，并授予 Members write、Administration write。首次配置建议关闭接入，保存并检查通过后再启用。</p>
    {([['organization','组织名称'],['appId','App ID'],['clientId','Client ID'],['installationId','Installation ID']] as const).map(([key,label]) => <Field key={key} label={label} htmlFor={`github-${key}`}>
      <Input id={`github-${key}`} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} required />
    </Field>)}
    <Field label={`Client Secret${settings.hasClientSecret ? '（已配置，留空保留）' : ''}`} htmlFor="github-secret"><Input id="github-secret" type="password" autoComplete="new-password" value={form.clientSecret} onChange={e => setForm({ ...form, clientSecret: e.target.value })} /></Field>
    <Field label={`App 私钥${settings.hasPrivateKey ? '（已配置，留空保留）' : ''}`} htmlFor="github-key"><Textarea id="github-key" rows={5} className="font-mono" value={form.privateKey} onChange={e => setForm({ ...form, privateKey: e.target.value })} /></Field>
    <Field label="Authorization callback URL" htmlFor="github-callback"><Input id="github-callback" readOnly value={settings.callbackUrl} /></Field>
    <Field label="Setup URL（安装回调）" htmlFor="github-setup-callback"><Input id="github-setup-callback" readOnly value={settings.setupCallbackUrl} /></Field>
    <p className="text-xs text-muted-foreground">在已有 App 的 GitHub 设置中配置以上地址，关闭安装时请求用户授权，并开启安装更新后跳转 Setup URL。</p>
    <div className="flex flex-wrap gap-2"><Button type="submit" loading={save.isPending}>保存设置</Button><Button type="button" variant="outline" loading={check.isPending} onClick={() => check.mutate()}>检查已保存的连接</Button></div>
    {checkResult && <p role="status" className="text-sm">{checkResult}</p>}
  </form></details>
  <div className="space-y-2 border-t pt-4"><h3 className="font-medium">待处理的仓库撤权</h3><p className="text-sm text-muted-foreground">只回收 EAT 管理的授权。来源不明确或在 GitHub 中发生变更的权限需要管理员核对。</p>
    {cleanup.isError && <p className="text-destructive">撤权状态加载失败</p>}
    {cleanup.data?.task?.notification && <p className="text-sm">{cleanup.data.task.notification}</p>}
    {cleanup.data?.grants.map(g => <div key={`${g.repository}:${g.login}`} className="rounded border p-2 text-sm"><p>{g.repository} · @{g.login}</p><p className="text-destructive">{g.error}</p></div>)}
    {cleanup.data?.grants.length === 0 && <p className="text-sm text-muted-foreground">没有待人工处理的撤权</p>}
    <Button variant="outline" disabled={!settings.enabled} loading={retry.isPending} onClick={() => retry.mutate()}>重新检查并重试撤权</Button>
  </div></div>;
}
