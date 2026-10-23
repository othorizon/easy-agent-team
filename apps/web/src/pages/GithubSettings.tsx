import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { githubSettingsSchema, type GithubSettingsInfo, type GithubSetupStart, type GithubConnectionState, type UpdateGithubSettings } from '@eat/shared';
import { AlertCircle, AlertTriangle, Check, CheckCircle2, ChevronRight, ExternalLink, Info } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Tip } from '../components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Confirm } from '../components/confirm';
import { CopyButton } from '../components/code';
import { Input, Textarea } from '../components/ui/input';
import { Field } from '../components/form';
import { SettingsSection, SettingsGroup, SettingsActions, SettingsLoading, SettingsLoadError } from '../components/settings';
import { formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';

const connectionLabels: Record<GithubConnectionState, string> = {
  unconfigured: '尚未初始化', app_ready: '待安装到组织', connected: '组织已连接',
  uninstalled: '未安装到组织', app_unavailable: 'App 或凭据不可用', private: 'App 为私有', error: '连接待修复',
};
const connectionVariant: Record<GithubConnectionState, 'success' | 'warning' | 'destructive' | 'outline'> = {
  unconfigured: 'outline', app_ready: 'warning', connected: 'success',
  uninstalled: 'warning', app_unavailable: 'destructive', private: 'destructive', error: 'destructive',
};
const stateOf = (s: GithubSettingsInfo): GithubConnectionState => s.connectionState ?? (s.appId ? 'app_ready' : 'unconfigured');

export function GithubSettings({ active }: { active: boolean }) {
  const query = useQuery({ queryKey: ['github-settings'], queryFn: () => api<GithubSettingsInfo>('GET', '/api/settings/github'), enabled: active });
  const s = query.data;
  return <SettingsSection title="GitHub 接入" description="关联成员的 GitHub 身份，邀请其加入指定组织，并管理应用仓库权限。部署仍使用部署接入中的配置。"
    status={s && <div className="flex flex-wrap gap-1.5">
      <Badge variant={connectionVariant[stateOf(s)]}>{connectionLabels[stateOf(s)]}</Badge>
      {s.appId && <Badge variant={s.enabled ? 'success' : 'outline'}>{s.enabled ? '接入已启用' : '接入已关闭'}</Badge>}
    </div>}>
    {s ? <>
      <GithubConnection settings={s} />
      <GithubAdvanced key={`${s.appId}:${s.installationId}:${s.enabled}`} settings={s} />
      {s.appId && <GithubCleanup enabled={s.enabled} active={active} />}
      {s.appId && <GithubReinitialize settings={s} />}
    </> : query.isError ? <SettingsLoadError error={query.error} retry={() => void query.refetch()} /> : <SettingsLoading />}
  </SettingsSection>;
}

function useRefreshGithub() {
  const cache = useQueryClient();
  return () => {
    void cache.invalidateQueries({ queryKey: ['github-settings'] });
    void cache.invalidateQueries({ queryKey: ['github-account'] });
    void cache.invalidateQueries({ queryKey: ['github-app'] });
  };
}

// GitHub's Manifest flow requires a browser POST, not an OAuth redirect or a server-side installation.
function submitManifest(r: GithubSetupStart) {
  const form = document.createElement('form'); form.method = 'POST'; form.action = r.url;
  const input = document.createElement('input'); input.type = 'hidden'; input.name = 'manifest'; input.value = JSON.stringify(r.manifest);
  form.appendChild(input); document.body.appendChild(form); form.submit();
}

function Notice({ tone, title, children, action }: { tone: 'error' | 'warning' | 'success' | 'info'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = { error: AlertCircle, warning: AlertTriangle, success: CheckCircle2, info: Info }[tone];
  return <div role={tone === 'error' ? 'alert' : 'status'} className={cn('settings-span flex gap-2.5 rounded-md border px-3.5 py-3 text-sm', {
    error: 'border-destructive/30 bg-destructive/5', warning: 'border-warning/40 bg-warning/10',
    success: 'border-success/30 bg-success/5', info: 'bg-muted/50',
  }[tone])}>
    <Icon className={cn('mt-0.5 size-4 shrink-0', { error: 'text-destructive', warning: 'text-warning', success: 'text-success', info: 'text-muted-foreground' }[tone])} aria-hidden="true" />
    <div className="min-w-0 flex-1 space-y-1 break-words leading-relaxed">
      {title && <p className={cn('font-medium', tone === 'error' && 'text-destructive')}>{title}</p>}
      {children && <div className="text-foreground/80">{children}</div>}
      {action && <div className="flex flex-wrap gap-2 pt-1.5">{action}</div>}
    </div>
  </div>;
}

function Steps({ settings }: { settings: GithubSettingsInfo }) {
  const done = [!!settings.appId, stateOf(settings) === 'connected', settings.enabled];
  const current = done.indexOf(false);
  const steps = [
    ['创建 GitHub App', '在组织下创建 EAT 专用的 App'],
    ['安装到组织', '选择全部仓库并确认权限'],
    ['启用用户关联', '成员在个人中心关联 GitHub'],
  ];
  return <ol className="settings-span grid gap-2 sm:grid-cols-3" aria-label="接入进度">
    {steps.map(([title, hint], i) => <li key={title} aria-current={i === current ? 'step' : undefined}
      className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5', i === current && 'border-primary/40 bg-primary/5')}>
      <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium',
        done[i] ? 'bg-success text-white' : i === current ? 'bg-primary text-primary-foreground' : 'border text-muted-foreground')}>
        {done[i] ? <Check className="size-3.5" aria-label="已完成" /> : i + 1}
      </span>
      <span className="min-w-0">
        <span className={cn('block text-sm font-medium', !done[i] && i !== current && 'text-muted-foreground')}>{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </li>)}
  </ol>;
}

function ExternalLinkText({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">
    {children}<ExternalLink className="size-3 shrink-0" aria-hidden="true" />
  </a>;
}

function GithubConnection({ settings }: { settings: GithubSettingsInfo }) {
  const refresh = useRefreshGithub(), checkedApp = useRef('');
  const [organization, setOrganization] = useState(settings.organization);
  const [name, setName] = useState(`EAT ${settings.organization || 'Team'}`);
  const [error, setError] = useState('');
  const onError = (e: Error) => { setError(e.message); refresh(); };
  const initialize = useMutation({ mutationFn: () => api<GithubSetupStart>('POST', '/api/settings/github/initialize', { organization, name, replaceExisting: false }),
    onSuccess: submitManifest, onError });
  const install = useMutation({ mutationFn: () => api<{ url: string }>('POST', '/api/settings/github/install'),
    onSuccess: r => window.location.assign(r.url), onError });
  // The automatic check on open is silent; only an explicit click reports success.
  const check = useMutation({ mutationFn: (_: { silent: boolean }) => api<{ message: string }>('POST', '/api/settings/github/check'),
    onSuccess: (r, v) => { setError(''); if (!v.silent) toast.success(r.message); }, onError: e => setError(e.message), onSettled: refresh });
  const enable = useMutation({ mutationFn: (enabled: boolean) => api('POST', '/api/settings/github/enabled', { enabled }),
    onSuccess: (_, enabled) => { setError(''); refresh(); toast.success(enabled ? 'GitHub 接入已启用' : 'GitHub 接入已关闭'); }, onError });
  useEffect(() => {
    if (settings.appId && settings.installationId && checkedApp.current !== settings.appId) {
      checkedApp.current = settings.appId; check.mutate({ silent: true });
    }
  }, [settings.appId, settings.installationId, check.mutate]);
  const busy = initialize.isPending || install.isPending || enable.isPending || check.isPending;
  const result = new URLSearchParams(location.search).get('github_setup');
  const state = stateOf(settings);
  const appSettingsUrl = settings.appSlug
    ? `https://github.com/organizations/${encodeURIComponent(settings.organization)}/settings/apps/${encodeURIComponent(settings.appSlug)}`
    : `https://github.com/organizations/${encodeURIComponent(settings.organization)}/settings/apps`;
  const message = error || settings.connectionError;

  const notices = <>
    {result === 'created' && <Notice tone="success" title="App 已创建，配置已加密保存">下一步：安装到组织。</Notice>}
    {result === 'installed' && <Notice tone="success" title="组织安装已核验，GitHub 接入已启用" />}
    {result === 'requested' && <Notice tone="warning" title="安装申请待组织 Owner 批准">批准后回到这里点「检查连接」，通过后启用接入。</Notice>}
    {result === 'failed' && <Notice tone="error" title="回调未完成、已过期或配置发生变化">若 App 已创建，请在高级设置中手动接入；若组织已安装，请检查连接；否则重新开始。</Notice>}
    {state === 'private' ? <Notice tone="error" title="App 为私有，组织外的用户无法关联 GitHub"
      action={<>
        <Button asChild size="sm"><a href={settings.appSlug ? `${appSettingsUrl}/advanced` : appSettingsUrl} target="_blank" rel="noreferrer">打开 GitHub App 设置<ExternalLink /></a></Button>
        <Button size="sm" variant="outline" loading={check.isPending} disabled={busy} onClick={() => check.mutate({ silent: false })}>已改为公开，重新检查</Button>
      </>}>
      GitHub 只允许组织成员授权私有 App，尚未加入组织的用户点「关联 GitHub」会看到 404。请在 App 设置的 <b>Advanced</b> 中点 <b>Make public</b>。
      公开只表示其他账户也能看到和授权这个 App，不会获得本组织的任何权限。
    </Notice> : message && <Notice tone="error" title="连接检查未通过">{message}</Notice>}
  </>;

  if (!settings.appId) return <SettingsGroup title="初始化 GitHub App" description="需要同时是 EAT 管理员和 GitHub 组织 Owner。将跳转到 GitHub 确认创建，权限与回调地址自动填写，密钥加密保存。">
    <Steps settings={settings} />
    {notices}
    <form className="settings-span settings-fields" onSubmit={e => { e.preventDefault(); setError(''); initialize.mutate(); }}>
      <Field label="GitHub 组织名称" htmlFor="github-wizard-org" required hint="组织 URL 中的名称，例如 github.com/eat-team 中的 eat-team">
        <Input id="github-wizard-org" value={organization} onChange={e => setOrganization(e.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9\-]{0,38}" placeholder="eat-team" />
      </Field>
      <Field label="GitHub App 名称" htmlFor="github-wizard-name" required hint="在 GitHub 上全局唯一，重名时可在 GitHub 页面修改">
        <Input id="github-wizard-name" value={name} onChange={e => setName(e.target.value)} required maxLength={100} />
      </Field>
      <div className="settings-span"><Button type="submit" disabled={busy} loading={initialize.isPending}>初始化 GitHub App</Button></div>
    </form>
  </SettingsGroup>;

  // A private App gets its primary action inside the notice; the other failures make 检查连接 the next step.
  const connected = state === 'connected', broken = ['error', 'app_unavailable'].includes(state);
  const needsInstall = !settings.installationId || state === 'app_ready' || state === 'uninstalled';
  const installButton = <Button key="install" variant={needsInstall ? 'default' : 'outline'} disabled={busy} loading={install.isPending}
    onClick={() => { setError(''); install.mutate(); }}>{settings.installationId ? '重新安装到组织' : '安装到组织'}</Button>;
  const checkButton = <Button key="check" variant={broken ? 'default' : 'outline'} disabled={busy} loading={check.isPending}
    onClick={() => check.mutate({ silent: false })}>检查连接</Button>;
  const enableButton = settings.enabled
    ? <Confirm key="enable" title="关闭 GitHub 接入？" description="停止邀请、仓库授权与撤权等后台工作，成员无法新关联 GitHub。EAT 其他功能不受影响；重新启用后会继续核验待执行的任务。"
      confirmText="关闭接入" onConfirm={() => enable.mutate(false)}><Button variant="outline-destructive" disabled={busy} loading={enable.isPending}>关闭接入</Button></Confirm>
    : <Tip key="enable" content={connected ? undefined : '检查连接通过后才能启用'}><span tabIndex={connected ? undefined : 0} className="inline-flex">
      <Button variant={connected ? 'default' : 'outline'} disabled={busy || !connected} loading={enable.isPending} onClick={() => enable.mutate(true)}>启用接入</Button>
    </span></Tip>;
  const actions = connected && !settings.enabled ? [enableButton, checkButton, installButton]
    : needsInstall && !broken && state !== 'private' ? [installButton, checkButton, enableButton] : [checkButton, installButton, enableButton];

  return <SettingsGroup title="连接状态" description="由 GitHub 组织 Owner 完成。普通成员只需在个人中心关联自己的 GitHub 账户。">
    <Steps settings={settings} />
    {notices}
    <dl className="settings-span grid gap-x-6 gap-y-3 rounded-lg bg-muted/50 p-4 text-sm sm:grid-cols-2">
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">组织</dt>
        <dd className="mt-0.5"><ExternalLinkText href={`https://github.com/${encodeURIComponent(settings.organization)}`}>{settings.organization}</ExternalLinkText></dd></div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">GitHub App</dt>
        <dd className="mt-0.5">{settings.appSlug
          ? <ExternalLinkText href={appSettingsUrl}>{settings.appSlug}</ExternalLinkText>
          : <span className="font-mono">App ID {settings.appId}</span>}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">Installation ID</dt>
        <dd className="mt-0.5 font-mono">{settings.installationId || <span className="font-sans text-muted-foreground">尚未安装</span>}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">最近核验</dt>
        <dd className="mt-0.5">{settings.checkedAt ? formatDateTime(settings.checkedAt) : <span className="text-muted-foreground">尚未核验</span>}</dd></div>
    </dl>
    <div className="settings-span space-y-2">
      <div className="flex flex-wrap gap-2">{actions}</div>
      {needsInstall && <p className="text-xs text-muted-foreground">安装时请选择 <b>All repositories</b> 并确认权限。仅从组织卸载了 App 时重新安装即可，不必重新初始化。</p>}
    </div>
  </SettingsGroup>;
}

function CollapsibleGroup({ title, description, defaultOpen, children }: { title: string; description: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return <Collapsible defaultOpen={defaultOpen} className="settings-group">
    <div className="settings-group-heading !mb-0">
      <h3><CollapsibleTrigger className="group flex cursor-pointer items-center gap-2 text-left">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />{title}
      </CollapsibleTrigger></h3>
      <p className="pl-6">{description}</p>
    </div>
    <CollapsibleContent className="pt-5 sm:pl-6">{children}</CollapsibleContent>
  </Collapsible>;
}

function ReadonlyUrl({ id, label, value }: { id: string; label: string; value: string }) {
  return <Field label={label} htmlFor={id} className="settings-span">
    <div className="relative">
      <Input id={id} readOnly value={value} className="pr-10 font-mono text-xs" onFocus={e => e.currentTarget.select()} />
      <CopyButton text={value} className="absolute top-1/2 right-2 -translate-y-1/2" />
    </div>
  </Field>;
}

function GithubAdvanced({ settings }: { settings: GithubSettingsInfo }) {
  const cache = useQueryClient();
  const defaults: UpdateGithubSettings = { enabled: settings.enabled, organization: settings.organization,
    appId: settings.appId, clientId: settings.clientId, installationId: settings.installationId, clientSecret: '', privateKey: '' };
  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<UpdateGithubSettings>({
    resolver: zodResolver(githubSettingsSchema), defaultValues: defaults });
  const save = useMutation({ mutationFn: (v: UpdateGithubSettings) => api('PUT', '/api/settings/github', { ...v, enabled: settings.enabled }), onSuccess: (_, v) => {
    reset({ ...v, clientSecret: '', privateKey: '' });
    void cache.invalidateQueries({ queryKey: ['github-settings'] }); void cache.invalidateQueries({ queryKey: ['github-account'] });
    void cache.invalidateQueries({ queryKey: ['github-app'] });
    toast.success('GitHub 设置已保存，请在上方检查连接');
  } });
  const text = (key: 'organization' | 'appId' | 'clientId' | 'installationId', label: string) =>
    <Field label={label} htmlFor={`github-${key}`} required error={errors[key]?.message}>
      <Input id={`github-${key}`} className={key === 'organization' ? undefined : 'font-mono'} aria-invalid={!!errors[key]} {...register(key)} />
    </Field>;
  return <CollapsibleGroup title="高级设置：手动配置已有 App"
    description="接入已在 GitHub 创建的 App，或轮换 Client Secret 与私钥。App 需公开（Make public），安装到组织的全部仓库，并授予 Members 与 Administration 写权限。">
    <form className="settings-form" onSubmit={handleSubmit(v => save.mutate(v))}>
      <fieldset disabled={save.isPending} className="settings-fields">
        {text('organization', '组织名称')}
        {text('appId', 'App ID')}
        {text('clientId', 'Client ID')}
        {text('installationId', 'Installation ID')}
        <Field className="settings-span" label="Client Secret" htmlFor="github-secret" error={errors.clientSecret?.message}
          hint={settings.hasClientSecret ? '已配置，留空保持不变' : undefined}>
          <Input id="github-secret" type="password" autoComplete="new-password" placeholder={settings.hasClientSecret ? '留空保持现有 Secret' : undefined} {...register('clientSecret')} />
        </Field>
        <Field className="settings-span" label="App 私钥（PEM）" htmlFor="github-key" error={errors.privateKey?.message}
          hint={settings.hasPrivateKey ? '已配置，留空保持不变' : '在 App 设置页 Private keys 处生成并下载'}>
          <Textarea id="github-key" rows={4} className="font-mono text-xs" placeholder={settings.hasPrivateKey ? '留空保持现有私钥' : '-----BEGIN RSA PRIVATE KEY-----'} {...register('privateKey')} />
        </Field>
        <ReadonlyUrl id="github-callback" label="Callback URL" value={settings.callbackUrl} />
        <ReadonlyUrl id="github-setup-callback" label="Setup URL（安装后跳转）" value={settings.setupCallbackUrl} />
        <p className="settings-span text-xs leading-relaxed text-muted-foreground">将以上两个地址填到 App 的 GitHub 设置中：关闭「安装时请求用户授权」，开启「安装更新后跳转 Setup URL」。</p>
      </fieldset>
      <SettingsActions pending={save.isPending} dirty={isDirty} saved={save.isSuccess} error={save.error?.message} label="保存配置" />
    </form>
  </CollapsibleGroup>;
}

type Cleanup = { grants: { repository: string; login: string; error: string }[]; task: { state: string; error: string; notification: string } | null };
function GithubCleanup({ enabled, active }: { enabled: boolean; active: boolean }) {
  const cleanup = useQuery({ queryKey: ['github-cleanup'], queryFn: () => api<Cleanup>('GET', '/api/settings/github/cleanup'),
    enabled: active, refetchInterval: active ? 10000 : false });
  const retry = useMutation({ mutationFn: () => api('POST', '/api/settings/github/cleanup'), onSuccess: () => void cleanup.refetch(), onError: (e: Error) => toast.error(e.message) });
  const grants = cleanup.data?.grants ?? [];
  return <SettingsGroup title="待处理的仓库撤权" description="只回收 EAT 管理的直接授权。来源无法确认，或在 GitHub 上被改动过的权限，需要管理员在 GitHub 核对后重新检查。">
    {cleanup.isError && <Notice tone="error" title="撤权状态加载失败" />}
    {cleanup.data?.task?.notification && <Notice tone="warning">{cleanup.data.task.notification}</Notice>}
    {cleanup.data && (grants.length === 0
      ? <p className="settings-span flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4 text-success" aria-hidden="true" />没有需要人工处理的撤权</p>
      : <ul className="settings-span divide-y rounded-lg border">
        {grants.map(g => <li key={`${g.repository}:${g.login}`} className="px-3.5 py-2.5 text-sm">
          <p className="break-all"><span className="font-mono">{g.repository}</span><span className="text-muted-foreground"> · @{g.login}</span></p>
          <p className="mt-0.5 text-xs text-destructive">{g.error}</p>
        </li>)}
      </ul>)}
    <div className="settings-span">
      <Tip content={enabled ? undefined : '接入关闭时不处理撤权'}><span tabIndex={enabled ? undefined : 0} className="inline-flex">
        <Button variant="outline" disabled={!enabled} loading={retry.isPending} onClick={() => retry.mutate()}>重新检查并重试撤权</Button>
      </span></Tip>
    </div>
  </SettingsGroup>;
}

function GithubReinitialize({ settings }: { settings: GithubSettingsInfo }) {
  const refresh = useRefreshGithub();
  const [name, setName] = useState(`EAT ${settings.organization || 'Team'}`);
  const initialize = useMutation({ mutationFn: () => api<GithubSetupStart>('POST', '/api/settings/github/initialize', {
    organization: settings.organization, name, replaceExisting: true }), onSuccess: submitManifest,
    onError: (e: Error) => { toast.error(e.message); refresh(); } });
  return <CollapsibleGroup title="App 已被删除？重新初始化" defaultOpen={stateOf(settings) === 'app_unavailable' || undefined}
    description="只在 App 本身已在 GitHub 删除、或确认需要更换时使用。仅从组织卸载了 App 时，用上方的「重新安装到组织」。">
    <div className="space-y-4">
      <Notice tone="warning">新 App 仍绑定 {settings.organization}。EAT 用户、应用、成员和现有仓库权限保留；所有用户的旧 GitHub 凭据会清除、待执行操作取消，用户需要重新授权。</Notice>
      <Field label="新 GitHub App 名称" htmlFor="github-replacement-name" className="max-w-md">
        <Input id="github-replacement-name" value={name} onChange={e => setName(e.target.value)} maxLength={100} />
      </Field>
      <Confirm title="重新初始化 GitHub App？" description="确认旧 App 已删除或需要更换。新 App 创建成功后，所有用户的旧 GitHub 凭据将清除，待执行操作取消；用户需要重新授权。仅卸载组织安装时请取消，使用重新安装。" confirmText="继续创建新 App" onConfirm={() => initialize.mutate()}>
        <Button variant="outline-destructive" disabled={initialize.isPending || !name.trim()} loading={initialize.isPending}>重新初始化 GitHub App</Button>
      </Confirm>
    </div>
  </CollapsibleGroup>;
}
