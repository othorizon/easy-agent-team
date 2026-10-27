import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  FEISHU_APP_SCOPES,
  FEISHU_APP_SUBSCRIPTIONS,
  FEISHU_CONSOLE_URL,
  NOTIFICATION_CHANNELS,
  feishuAppConsoleUrl,
  feishuAppCredentialsSchema,
  feishuScopeApplyUrl,
  type FeishuAppCredentials,
  type FeishuScopeApplyResult,
  type FeishuScopeStatus,
  type FeishuSettingsInfo,
  type NotificationChannel,
} from '@eat/shared';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  Info,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Tip } from '../components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { CodeBlock, CopyButton } from '../components/code';
import { Confirm } from '../components/confirm';
import { Field } from '../components/form';
import { SettingsActions, SettingsGroup, SettingsLoadError, SettingsLoading, SettingsSection } from '../components/settings';
import { formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';

const KEY = ['feishu-settings'];
const scopeLabel: Record<FeishuScopeStatus, [string, 'success' | 'warning' | 'destructive']> = {
  granted: ['已开通', 'success'],
  pending: ['待管理员审核', 'warning'],
  missing: ['未添加', 'destructive'],
};

/** 系统设置 →「飞书通知」：通知渠道单选 + 飞书自建应用的安装、检查与权限申请（决策 92） */
export function FeishuSettings({ active }: { active: boolean }) {
  const query = useQuery({ queryKey: KEY, queryFn: () => api<FeishuSettingsInfo>('GET', '/api/settings/feishu'), enabled: active });
  const s = query.data;
  return (
    <SettingsSection
      title="飞书通知"
      description="选择成员个人通知的投递方式。自建应用渠道由机器人私聊推送，审批卡片在飞书里直接同意或驳回，处理后卡片自动更新。"
      status={
        s && (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{s.channel === 'app' ? '使用自建应用' : '使用 Webhook'}</Badge>
            {s.appId && <Badge variant={s.ready ? 'success' : 'warning'}>{s.ready ? '应用已就绪' : '应用待完善'}</Badge>}
          </div>
        )
      }
    >
      {s ? (
        <>
          <ChannelGroup settings={s} />
          {s.appId && <AppStatus settings={s} active={active} />}
          <SetupGuide settings={s} />
          <CredentialsForm key={`${s.appId}:${s.hasAppSecret}`} settings={s} />
        </>
      ) : query.isError ? (
        <SettingsLoadError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SettingsLoading />
      )}
    </SettingsSection>
  );
}

function Notice({ tone, title, children }: { tone: 'error' | 'warning' | 'success' | 'info'; title?: ReactNode; children?: ReactNode }) {
  const Icon = { error: AlertCircle, warning: AlertTriangle, success: CheckCircle2, info: Info }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'settings-span flex gap-2.5 rounded-md border px-3.5 py-3 text-sm',
        {
          error: 'border-destructive/30 bg-destructive/5',
          warning: 'border-warning/40 bg-warning/10',
          success: 'border-success/30 bg-success/5',
          info: 'bg-muted/50',
        }[tone],
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', {
          error: 'text-destructive',
          warning: 'text-warning',
          success: 'text-success',
          info: 'text-muted-foreground',
        }[tone])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1 break-words leading-relaxed">
        {title && <p className={cn('font-medium', tone === 'error' && 'text-destructive')}>{title}</p>}
        {children && <div className="text-foreground/80">{children}</div>}
      </div>
    </div>
  );
}

function ExternalLinkText({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">
      {children}
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function ChannelGroup({ settings }: { settings: FeishuSettingsInfo }) {
  const cache = useQueryClient();
  const change = useMutation({
    mutationFn: (channel: NotificationChannel) => api<FeishuSettingsInfo>('PUT', '/api/settings/feishu/channel', { channel }),
    onSuccess: (data) => {
      cache.setQueryData(KEY, data);
      void cache.invalidateQueries({ queryKey: ['account'] });
      void cache.invalidateQueries({ queryKey: ['users'] });
      toast.success(data.channel === 'app' ? '已切换为飞书自建应用渠道' : '已切换为 Webhook 渠道');
    },
    onError: (e: Error) => {
      toast.error(e.message);
      void cache.invalidateQueries({ queryKey: KEY });
    },
  });
  const options: { value: NotificationChannel; hint: ReactNode; confirm: ReactNode }[] = [
    {
      value: 'webhook',
      hint: '每位成员在自己的飞书群里添加自定义机器人并完成验证码验证。卡片按钮只能跳转网页处理。',
      confirm:
        '切换后个人通知改回各成员的飞书群 Webhook 发送，未配置 Webhook 的成员将收不到通知。成员的飞书绑定保留，可随时切回；已发出的审批卡片仍可在飞书里处理。',
    },
    {
      value: 'app',
      hint: (
        <>
          管理员安装一个企业自建应用，成员私聊机器人发送绑定码即可。通知卡片可交互、可更新，审批无需打开网页。
          {settings.appId && (
            <span className="mt-1 block text-foreground/80">
              已绑定 {settings.boundUsers} / {settings.activeUsers} 名成员
            </span>
          )}
        </>
      ),
      confirm: `切换后所有个人通知改由机器人私聊发送。目前已绑定 ${settings.boundUsers} / ${settings.activeUsers} 名成员，未绑定的成员在绑定前收不到通知；若开启了「强制配置飞书通知」，他们下次访问时会被引导完成绑定。成员的 Webhook 配置保留，可随时切回。`,
    },
  ];
  return (
    <SettingsGroup title="通知渠道" description="两种渠道互斥，同一时间全平台只用一种。切换不会清除另一种渠道下成员已完成的配置。">
      <div role="radiogroup" aria-label="通知渠道" className="settings-span grid gap-3 sm:grid-cols-2">
        {options.map((o) => {
          const current = settings.channel === o.value;
          const blocked = o.value === 'app' && !settings.ready;
          const card = (
            <button
              type="button"
              role="radio"
              aria-checked={current}
              disabled={change.isPending || (blocked && !current)}
              className={cn(
                'flex h-full w-full flex-col items-start gap-1.5 rounded-lg border p-4 text-left transition-colors',
                current ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-accent/50 cursor-pointer',
                blocked && !current && 'cursor-not-allowed opacity-60 hover:bg-transparent',
              )}
            >
              <span className="flex w-full items-center gap-2 text-sm font-medium">
                {current ? (
                  <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                {NOTIFICATION_CHANNELS[o.value]}
                {current && (
                  <Badge variant="default" className="ml-auto">
                    使用中
                  </Badge>
                )}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">{o.hint}</span>
            </button>
          );
          if (current) return <div key={o.value}>{card}</div>;
          if (blocked)
            return (
              <Tip key={o.value} content="自建应用检查全部通过后才能切换">
                <span tabIndex={0} className="block">
                  {card}
                </span>
              </Tip>
            );
          return (
            <Confirm
              key={o.value}
              title={`切换为「${NOTIFICATION_CHANNELS[o.value]}」？`}
              description={o.confirm}
              confirmText="确认切换"
              destructive={false}
              onConfirm={() => change.mutate(o.value)}
            >
              {card}
            </Confirm>
          );
        })}
      </div>
      {!settings.ready && settings.channel === 'webhook' && settings.appId && (
        <Notice tone="info" title="切换到自建应用前还需要完成">
          <ul className="list-disc space-y-0.5 pl-5">
            {settings.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Notice>
      )}
      {settings.channel === 'app' && !settings.ready && (
        <Notice tone="error" title="自建应用当前不可用，通知可能发送失败">
          <ul className="list-disc space-y-0.5 pl-5">
            {settings.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Notice>
      )}
    </SettingsGroup>
  );
}

function StatusRow({ ok, title, children }: { ok: boolean | null; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3 px-3.5 py-3 text-sm">
      {ok === null ? (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="未检查" />
      ) : ok ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="通过" />
      ) : (
        <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="未通过" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{children}</div>}
      </div>
    </li>
  );
}

function AppStatus({ settings, active }: { settings: FeishuSettingsInfo; active: boolean }) {
  const cache = useQueryClient();
  const checked = useRef('');
  const [applyResult, setApplyResult] = useState<FeishuScopeApplyResult | null>(null);
  const check = useMutation({
    mutationFn: (_: { silent: boolean }) => api<FeishuSettingsInfo>('POST', '/api/settings/feishu/check'),
    onSuccess: (data, v) => {
      cache.setQueryData(KEY, data);
      if (!v.silent) toast[data.ready ? 'success' : 'info'](data.ready ? '检查通过，应用已就绪' : '检查完成，还有未完成的项目');
    },
    onError: (e: Error, v) => {
      if (!v.silent) toast.error(e.message);
    },
  });
  const apply = useMutation({
    mutationFn: () => api<FeishuScopeApplyResult>('POST', '/api/settings/feishu/scopes/apply'),
    onSuccess: (r) => {
      setApplyResult(r);
      void cache.invalidateQueries({ queryKey: KEY });
      toast[r.applied ? 'success' : 'info'](r.message);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  // 打开页面时静默检查一次（与 GitHub 接入一致），只有手动点击才弹结果
  useEffect(() => {
    if (active && settings.appId && settings.hasAppSecret && checked.current !== settings.appId) {
      checked.current = settings.appId;
      check.mutate({ silent: true });
    }
  }, [active, settings.appId, settings.hasAppSecret, check.mutate]);
  const c = settings.check;
  const scopes = c?.scopes ?? [];
  const missing = scopes.filter((s) => s.status === 'missing').map((s) => s.scope);
  const pending = scopes.some((s) => s.status === 'pending');
  const scopeIssue = !!c?.credentialsOk && (!!c.scopesError || missing.length > 0 || pending);
  // 还没添加的权限只能去开发者后台开通；已添加待审核的可以直接由应用向企业管理员申请
  const consoleUrl = c?.scopesError
    ? feishuScopeApplyUrl(settings.appId, FEISHU_APP_SCOPES.map((s) => s.scope))
    : missing.length
      ? feishuScopeApplyUrl(settings.appId, missing)
      : null;
  return (
    <SettingsGroup title="应用状态" description="检查凭据、机器人能力、权限授权与请求地址。权限或版本有变化后重新检查。">
      <div className="settings-span flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-4">
        {settings.botAvatarUrl ? (
          <img src={settings.botAvatarUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-5" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{settings.botName ?? '飞书自建应用'}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{settings.appId}</p>
        </div>
        <ExternalLinkText href={feishuAppConsoleUrl(settings.appId)}>打开开发者后台</ExternalLinkText>
      </div>
      <ul className="settings-span divide-y rounded-lg border" aria-label="检查项">
        <StatusRow ok={c ? c.credentialsOk : null} title="App ID 与 App Secret">
          {!c ? '尚未检查' : c.credentialsOk ? '凭据有效' : c.error}
        </StatusRow>
        <StatusRow ok={c?.credentialsOk ? c.botActive : null} title="机器人能力">
          {!c?.credentialsOk ? '凭据通过后检查' : c.botActive ? '已开启并启用' : c.error}
        </StatusRow>
        <StatusRow ok={c?.credentialsOk ? !scopeIssue : null} title="应用权限">
          {!c?.credentialsOk ? (
            '凭据通过后检查'
          ) : c.scopesError ? (
            `无法查询权限状态：${c.scopesError}`
          ) : (
            <ul className="mt-1 space-y-1">
              {scopes.map((s) => (
                <li key={s.scope} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Badge variant={scopeLabel[s.status][1]}>{scopeLabel[s.status][0]}</Badge>
                  <span className="text-foreground/90">{s.name}</span>
                  <code className="font-mono">{s.scope}</code>
                  <span className="basis-full">{s.purpose}</span>
                </li>
              ))}
            </ul>
          )}
        </StatusRow>
        <StatusRow ok={!!settings.callbackVerifiedAt} title="请求地址">
          {settings.callbackVerifiedAt
            ? `已通过验证 · ${formatDateTime(settings.callbackVerifiedAt)}${settings.lastEventAt ? `；最近收到事件 ${formatDateTime(settings.lastEventAt)}` : ''}`
            : '在开发者后台「事件与回调」保存请求地址后，飞书会发起验证，EAT 自动应答并记录'}
        </StatusRow>
      </ul>
      {applyResult && !applyResult.applied && applyResult.consoleUrl && (
        <Notice tone="warning" title="还有权限需要在开发者后台添加">
          在打开的页面里确认开通，再到「版本管理与发布」创建版本并发布，审核通过后回来检查。
        </Notice>
      )}
      <div className="settings-span flex flex-wrap items-center gap-2">
        <Button variant={settings.ready ? 'outline' : 'default'} loading={check.isPending} onClick={() => check.mutate({ silent: false })}>
          检查状态
        </Button>
        {scopeIssue &&
          (consoleUrl && !pending ? (
            <Button asChild variant="outline">
              <a href={consoleUrl} target="_blank" rel="noreferrer">
                申请权限
                <ExternalLink />
              </a>
            </Button>
          ) : (
            <Button variant="outline" loading={apply.isPending} onClick={() => apply.mutate()}>
              申请权限
            </Button>
          ))}
        {scopeIssue && consoleUrl && pending && (
          <Button asChild variant="ghost">
            <a href={consoleUrl} target="_blank" rel="noreferrer">
              在开发者后台添加缺少的权限
              <ExternalLink />
            </a>
          </Button>
        )}
        {c && <span className="text-xs text-muted-foreground">最近检查：{formatDateTime(c.checkedAt)}</span>}
      </div>
    </SettingsGroup>
  );
}

function Copyable({ value, label }: { value: string; label: string }) {
  return (
    <span className="mt-1.5 flex w-fit max-w-full items-center gap-1 rounded-md border bg-muted/60 py-1 pr-1 pl-2.5">
      <code aria-label={label} className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[13px]">
        {value}
      </code>
      <CopyButton text={value} />
    </span>
  );
}

function SetupGuide({ settings }: { settings: FeishuSettingsInfo }) {
  const steps: [string, ReactNode][] = [
    [
      '创建企业自建应用',
      <>
        打开 <ExternalLinkText href={FEISHU_CONSOLE_URL}>飞书开发者后台</ExternalLinkText>，点「创建企业自建应用」，名称建议「EAT 通知」。
        进入应用后在「添加应用能力」里添加 <b>机器人</b>。
      </>,
    ],
    [
      '导入所需权限',
      <>
        在「权限管理」点「批量导入/导出权限」，粘贴下面的 JSON 并确认开通：
        <span className="relative mt-1.5 block">
          <CodeBlock className="pr-10 text-xs">{settings.scopesImportJson}</CodeBlock>
          <CopyButton text={settings.scopesImportJson} className="absolute top-2 right-2" />
        </span>
        <span className="mt-1 block">
          {FEISHU_APP_SCOPES.map((s) => `${s.name}：${s.purpose}`).join('；')}。
        </span>
      </>,
    ],
    [
      '填写凭据',
      <>
        「凭证与基础信息」里复制 App ID、App Secret；「事件与回调 → 加密策略」里复制 Verification Token，并生成 Encrypt Key（必填：审批走卡片回调，必须能验签）。填到下方表单保存。
      </>,
    ],
    [
      '配置请求地址与订阅',
      <>
        保存后回到「事件与回调」：「事件配置」和「回调配置」的订阅方式都选「将事件 / 回调发送至开发者服务器」，请求地址都填：
        <Copyable value={settings.callbackUrl} label="请求地址" />
        <span className="mt-1.5 block">
          然后添加{' '}
          {FEISHU_APP_SUBSCRIPTIONS.map((s, i) => (
            <span key={s.key}>
              {i > 0 && '、'}
              {s.kind}「{s.name}」<code className="font-mono">{s.key}</code>
            </span>
          ))}
          。保存地址时飞书会发起验证，EAT 自动应答。
        </span>
      </>,
    ],
    [
      '发布版本',
      <>
        在「版本管理与发布」创建版本，可用范围选择需要接收通知的成员（建议全员），提交发布；企业管理员审核通过后生效。之后改了权限或能力都要重新发布。
      </>,
    ],
    ['检查并切换', '回到这里点「检查状态」，全部通过后在上方把通知渠道切换为自建应用。成员在个人中心生成绑定码，私聊发给机器人即可完成绑定。'],
  ];
  return (
    <Collapsible defaultOpen={!settings.ready} className="settings-group">
      <div className="settings-group-heading !mb-0">
        <h3>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-2 text-left">
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            安装指引
          </CollapsibleTrigger>
        </h3>
        <p className="pl-6">在飞书开发者后台创建应用并带上所需权限，约 5 分钟。需要飞书企业管理员审核版本发布。</p>
      </div>
      <CollapsibleContent className="pt-5 sm:pl-6">
        <ol className="space-y-4">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-muted-foreground">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{title}</p>
                <div className="mt-1 leading-relaxed text-muted-foreground">{body}</div>
              </div>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CredentialsForm({ settings }: { settings: FeishuSettingsInfo }) {
  const cache = useQueryClient();
  const configured = !!settings.appId && settings.hasAppSecret;
  const defaults: FeishuAppCredentials = { appId: settings.appId, appSecret: '', verificationToken: '', encryptKey: '' };
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<FeishuAppCredentials>({
    // 已配置过的应用：密钥类字段留空表示保留；首次配置或更换 App ID 时必须填全（服务端同样校验）
    resolver: zodResolver(
      feishuAppCredentialsSchema.superRefine((v, ctx) => {
        if (configured && v.appId === settings.appId) return;
        for (const key of ['appSecret', 'verificationToken', 'encryptKey'] as const) {
          if (!v[key]) ctx.addIssue({ code: 'custom', path: [key], message: '请填写' });
        }
      }),
    ),
    defaultValues: defaults,
  });
  const save = useMutation({
    mutationFn: (v: FeishuAppCredentials) => api<FeishuSettingsInfo>('PUT', '/api/settings/feishu/app', v),
    onSuccess: (data) => {
      cache.setQueryData(KEY, data);
      reset({ appId: data.appId, appSecret: '', verificationToken: '', encryptKey: '' });
      toast.success(data.check?.credentialsOk ? '已保存并完成检查' : '已保存，但凭据未通过校验');
    },
  });
  const changingApp = configured && watch('appId') !== settings.appId;
  const secret = (key: 'appSecret' | 'verificationToken' | 'encryptKey', label: string, has: boolean, hint: string) => (
    <Field
      label={label}
      htmlFor={`feishu-${key}`}
      required={!has || changingApp}
      error={errors[key]?.message}
      hint={has && !changingApp ? '已配置，留空保持不变' : hint}
    >
      <Input
        id={`feishu-${key}`}
        type="password"
        autoComplete="new-password"
        placeholder={has && !changingApp ? '留空保持现有值' : undefined}
        {...register(key)}
      />
    </Field>
  );
  return (
    <SettingsGroup title="应用凭据" description="密钥加密保存，不会回显。保存后自动检查一次。">
      <form className="settings-span settings-form" onSubmit={handleSubmit((v) => save.mutate(v))}>
        <fieldset disabled={save.isPending} className="settings-fields">
          <Field label="App ID" htmlFor="feishu-appId" required error={errors.appId?.message} hint="「凭证与基础信息」里以 cli_ 开头的 ID">
            <Input id="feishu-appId" className="font-mono" placeholder="cli_xxxxxxxxxxxxxxxx" {...register('appId')} />
          </Field>
          {secret('appSecret', 'App Secret', settings.hasAppSecret, '「凭证与基础信息」里的 App Secret')}
          {secret('verificationToken', 'Verification Token', settings.hasVerificationToken, '「事件与回调 → 加密策略」')}
          {secret('encryptKey', 'Encrypt Key', settings.hasEncryptKey, '「事件与回调 → 加密策略」，为空时先点「重置」生成')}
          {changingApp && (
            <Notice tone="warning" title="更换应用">
              所有成员需要用新应用重新绑定；使用自建应用渠道时不能直接更换，请先切回 Webhook 渠道。
            </Notice>
          )}
        </fieldset>
        <SettingsActions pending={save.isPending} dirty={isDirty} saved={save.isSuccess} error={save.error?.message} label="保存并检查" />
      </form>
      {configured && (
        <p className="settings-span flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-success" aria-hidden="true" />
          请求地址：<code className="break-all font-mono">{settings.callbackUrl}</code>
          <CopyButton text={settings.callbackUrl} />
        </p>
      )}
    </SettingsGroup>
  );
}
