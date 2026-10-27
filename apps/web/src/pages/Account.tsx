import { GithubAccountPanel } from '../components/github';
import type { AccountInfo, FeishuBindCode, NotificationSettings, UpdateAccountRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Bell, Bot, CheckCircle2, ExternalLink, Github, LockKeyhole, RefreshCw, UserRound } from 'lucide-react';
import { CopyButton } from '../components/code';
import { formatDateTime } from '../lib/format';
import { SettingsSection } from '../components/settings';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import './settings.css';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, clearSession, getToken, setSession } from '../api';
import { Field } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input, Textarea } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';
import { Confirm } from '../components/confirm';

const BIO_HINT = '此内容会用于 AI 查询用户、了解擅长领域并匹配求助对象，请写清楚你的职责与擅长领域。';
const FEISHU_DOC = 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot';
const sections = [
  { id: 'profile', label: '个人资料', icon: UserRound },
  { id: 'notifications', label: '通知设置', icon: Bell },
  { id: 'github', label: 'GitHub 账户', icon: Github },
  { id: 'security', label: '账户安全', icon: LockKeyhole },
];
const onError = (error: Error) => toast.error(error.message);

export function AccountPage({ completion = false }: { completion?: boolean }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get('section');
  const active = sections.some((s) => s.id === selected)
    ? selected!
    : params.has('github')
      ? 'github'
      : 'profile';
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    setVisited((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [active]);
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('section', id);
    setParams(next);
    window.scrollTo(0, 0);
  };
  const token = getToken();
  const account = useQuery({
    queryKey: ['account', token],
    queryFn: () => api<AccountInfo>('GET', '/api/account'),
    enabled: !!token,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: completion ? 30_000 : false,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['account'] }),
      client.invalidateQueries({ queryKey: ['onboarding'] }),
      client.invalidateQueries({ queryKey: ['help-targets'] }),
    ]);
  };
  const update = useMutation({
    mutationFn: (body: UpdateAccountRequest) => api<AccountInfo>('PATCH', '/api/account', body),
    onSuccess: async (data) => {
      if (token) setSession(token, { id: data.id, name: data.name, email: data.email, role: data.role });
      await refresh();
      toast.success('个人资料已保存');
    },
    onError,
  });
  if (!token) return <Navigate to="/login" replace />;
  if (account.isError)
    return (
      <div className="p-8 space-y-4">
        <p>个人资料加载失败：{account.error.message}</p>
        <Button onClick={() => void account.refetch()}>重试</Button>
      </div>
    );
  if (!account.data) return <p className="p-8 text-muted-foreground">正在加载个人资料…</p>;
  const data = account.data;
  const next = params.get('next') ?? '/';
  const safeNext =
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.includes('\\') &&
    !next.startsWith('/complete-profile') &&
    !next.startsWith('/login')
      ? next
      : '/';
  if (completion && !data.onboarding.required) {
    if (account.isFetching) return <p className="p-8 text-muted-foreground">正在检查账号状态…</p>;
    return <Navigate to={safeNext} replace />;
  }
  if (completion)
    return (
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-10">
        <PageHeader
          title="完善个人资料"
          description="管理员要求完成以下配置后进入平台。已完成的项目无需重复填写。"
          actions={
            <Button
              variant="ghost"
              onClick={() => {
                clearSession();
                location.href = '/login';
              }}
            >
              退出登录
            </Button>
          }
        />
        {data.onboarding.requireBio &&
          (data.onboarding.bioComplete ? (
            <Card>
              <CardContent className="flex items-center justify-between py-5">
                <span>个人简介</span>
                <Badge variant="success">已完成</Badge>
              </CardContent>
            </Card>
          ) : (
            <ProfileForm
              key={data.id}
              data={data}
              completion
              pending={update.isPending}
              onSave={(v) => update.mutate(v)}
            />
          ))}
        {data.onboarding.requireNotification &&
          (data.onboarding.notificationComplete ? (
            <Card>
              <CardContent className="flex items-center justify-between py-5">
                <span>{data.notification.channel === 'app' ? '飞书机器人' : '飞书通知'}</span>
                <Badge variant="success">{data.notification.channel === 'app' ? '已绑定' : '已验证'}</Badge>
              </CardContent>
            </Card>
          ) : data.notification.channel === 'app' ? (
            <Card>
              <CardHeader>
                <CardTitle>绑定飞书账号</CardTitle>
              </CardHeader>
              <CardContent>
                <FeishuBindForm settings={data.notification} />
              </CardContent>
            </Card>
          ) : (
            <NotificationForm settings={data.notification} completion onSaved={refresh} />
          ))}
      </div>
    );
  return (
    <div className="settings-surface">
      <PageHeader title="个人中心" description="管理个人资料、通知和账户连接，按需配置，独立保存。" />
      <div className="settings-layout">
        <aside className="settings-desktop-nav">
          <nav aria-label="个人中心分类">
            <div className="settings-nav-group">
              <p>我的账户</p>
              {sections.map(({ id, label, icon: Icon }) => (
                <Link
                  key={id}
                  to={`?section=${id}`}
                  aria-current={active === id ? 'page' : undefined}
                  onClick={(e) => {
                    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
                      e.preventDefault();
                      select(id);
                    }
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span>{label}</span>
                </Link>
              ))}
            </div>
          </nav>
          <div className="settings-nav-note">
            <p className="font-medium text-foreground">{data.name}</p>
            <p className="break-all">{data.email}</p>
            <p>{data.role === 'admin' ? '平台管理员' : '团队成员'}</p>
          </div>
        </aside>
        <div className="settings-mobile-nav">
          <label htmlFor="account-category">个人中心分类</label>
          <Select value={active} onValueChange={select}>
            <SelectTrigger id="account-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sections.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="settings-workspace">
          {[...new Set([...visited, active])].map((id) => (
            <div key={id} hidden={active !== id} data-account-panel={id}>
              {id === 'profile' && (
                <ProfileForm
                  data={data}
                  completion={false}
                  pending={update.isPending}
                  onSave={(v) => update.mutate(v)}
                />
              )}
              {id === 'notifications' && (
                <SettingsSection
                  title="通知设置"
                  description={
                    data.notification.channel === 'app'
                      ? '选择希望收到的消息，并绑定飞书账号。通知由 EAT 机器人私聊发送，审批卡片可直接在飞书里处理。'
                      : '选择希望收到的消息，并绑定个人飞书群。通知偏好只影响你自己的消息。'
                  }
                  status={
                    <Badge variant={data.notification.connected ? 'success' : 'outline'}>
                      {data.notification.connected ? '飞书已连接' : '飞书未连接'}
                    </Badge>
                  }
                >
                  <NotificationPreferencesForm settings={data.notification} onSaved={refresh} />
                  {data.notification.channel === 'app' ? (
                    <section className="py-6" aria-label="绑定飞书账号">
                      <h3 className="mb-1 text-sm font-semibold">绑定飞书账号</h3>
                      <p className="mb-4 text-xs leading-5 text-muted-foreground">
                        此绑定用于整个平台的个人通知，包括权限申请、审批结果、求助、回复和 Folio 评论提及。
                      </p>
                      <FeishuBindForm settings={data.notification} />
                    </section>
                  ) : (
                    <NotificationForm settings={data.notification} completion={false} onSaved={refresh} />
                  )}
                </SettingsSection>
              )}
              {id === 'github' && (
                <SettingsSection
                  title="GitHub 账户"
                  description="关联 GitHub 账户，查看组织加入状态与账户授权。"
                >
                  <div className="py-6">
                    <GithubAccountPanel embedded />
                  </div>
                </SettingsSection>
              )}
              {id === 'security' && <PasswordForm />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AccountSection({
  title,
  description,
  completion = false,
  children,
}: {
  title: string;
  description: string;
  completion?: boolean;
  children: ReactNode;
}) {
  return completion ? (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  ) : (
    <SettingsSection title={title} description={description}>
      <div className="py-6">{children}</div>
    </SettingsSection>
  );
}

function ProfileForm({
  data,
  completion,
  pending,
  onSave,
}: {
  data: AccountInfo;
  completion: boolean;
  pending: boolean;
  onSave: (v: UpdateAccountRequest) => void;
}) {
  const [name, setName] = useState(data.name);
  const [bio, setBio] = useState(data.bio);
  const [allowHelp, setAllowHelp] = useState(data.allowHelp);
  return (
    <AccountSection
      completion={completion}
      title={completion ? '个人简介' : '个人资料'}
      description="让团队了解你的职责、擅长领域和协作偏好。"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (completion && !bio.trim()) return toast.error('请填写个人简介');
          onSave(completion ? { bio } : { name, bio, allowHelp });
        }}
      >
        {!completion && (
          <div className="rounded-lg bg-muted/50 p-4 text-sm">
            <p className="font-medium">登录邮箱</p>
            <p className="mt-1 break-all text-muted-foreground">{data.email}</p>
          </div>
        )}
        {!completion && (
          <Field label="姓名" htmlFor="account-name" required>
            <Input
              id="account-name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field label="个人简介" htmlFor="account-bio" hint={BIO_HINT} required={completion}>
          <Textarea
            id="account-bio"
            rows={6}
            maxLength={2000}
            required={completion}
            value={bio}
            placeholder="例如：负责订单与支付系统，擅长数据分析、对账排查和后端开发。"
            onChange={(e) => setBio(e.target.value)}
          />
          <p className="text-right text-xs text-muted-foreground">{bio.length} / 2000</p>
        </Field>
        {!completion && (
          <Field label="允许被求助" hint="填写个人简介后自动进入 AI 求助候选名单；关闭后进入勿扰状态。">
            <Switch checked={allowHelp} onCheckedChange={setAllowHelp} aria-label="允许被求助" />
          </Field>
        )}
        <Button type="submit" loading={pending}>
          保存{completion ? '个人简介' : '个人资料'}
        </Button>
      </form>
    </AccountSection>
  );
}

function NotificationForm({
  settings,
  completion,
  onSaved,
}: {
  settings: NotificationSettings;
  completion: boolean;
  onSaved: () => Promise<void>;
}) {
  const [url, setUrl] = useState(settings.webhookUrl);
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const send = useMutation({
    mutationFn: () =>
      api<{ challengeId: string; retryAfter: number }>('POST', '/api/account/notification/code', {
        webhookUrl: url.trim(),
        ...(clearSecret ? { webhookSecret: '' } : secret.trim() ? { webhookSecret: secret.trim() } : {}),
      }),
    onSuccess: (result) => {
      setChallenge(result.challengeId);
      setCode('');
      setNow(Date.now());
      setRetryAt(Date.now() + result.retryAfter * 1000);
      toast.success('验证码已发送至飞书群，10 分钟内有效');
    },
    onError,
  });
  const verify = useMutation({
    mutationFn: () => api('POST', '/api/account/notification/verify', { challengeId: challenge, code }),
    onSuccess: async () => {
      setChallenge(null);
      setCode('');
      setSecret('');
      setClearSecret(false);
      await onSaved();
      toast.success('飞书通知已验证并启用');
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', '/api/account/notification'),
    onSuccess: async () => {
      setUrl('');
      setSecret('');
      setCode('');
      setChallenge(null);
      setClearSecret(false);
      await onSaved();
      toast.success('飞书通知配置已移除');
    },
    onError,
  });
  const busy = send.isPending || verify.isPending || remove.isPending;
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <details className="rounded-lg border p-4 sm:p-5" open={completion || !settings.verified}>
      <summary className="cursor-pointer text-sm font-medium">
        {completion
          ? '配置飞书通知'
          : settings.verified
            ? '飞书机器人连接 · 查看或修改'
            : '连接飞书，开始接收通知'}
      </summary>
      <div className="mt-5 space-y-5">
        <div className="rounded-lg bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">创建一个只有自己的飞书群，用来接收 EAT 通知：</p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>点击飞书左上角的「+」，选择「创建群组」，无需添加其他人，直接点击「创建」。</li>
            <li>
              在群内打开「设置 → 群机器人 → 添加机器人」，选择「自定义机器人」，创建后复制 Webhook 地址。
              具体操作见
              <a
                className="text-primary underline underline-offset-4"
                href={FEISHU_DOC}
                target="_blank"
                rel="noreferrer"
              >
                飞书官方文档：添加自定义机器人
              </a>
              。
            </li>
            <li>
              将 Webhook 地址粘贴到下方，点击「发送验证码」，再从飞书群中获取验证码，回到此处填写并完成验证。
            </li>
          </ol>
          <p className="mt-3">
            如启用了签名校验，请同时填写加签密钥；使用关键词校验时，请允许关键词「EAT」。
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          此配置用于整个平台的个人通知，包括权限申请、审批结果、求助、回复和 Folio 评论提及。
        </p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setChallenge(null);
            send.mutate();
          }}
        >
          <Field label="飞书 Webhook 地址" htmlFor="notification-url" required>
            <Input
              id="notification-url"
              type="url"
              required
              maxLength={500}
              disabled={busy}
              value={url}
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
              onChange={(e) => {
                setUrl(e.target.value);
                setChallenge(null);
              }}
            />
          </Field>
          <Field
            label="加签密钥（可选）"
            htmlFor="notification-secret"
            hint={
              settings.hasWebhookSecret && url.trim() === settings.webhookUrl
                ? '已保存密钥；地址不变时，留空保留原值。'
                : '仅在机器人开启签名校验时填写。'
            }
          >
            <Input
              id="notification-secret"
              type="password"
              autoComplete="new-password"
              maxLength={200}
              disabled={busy || clearSecret}
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setChallenge(null);
              }}
            />
          </Field>
          {settings.hasWebhookSecret && url.trim() === settings.webhookUrl && (
            <Field label="移除已保存的加签密钥">
              <Switch
                checked={clearSecret}
                disabled={busy}
                aria-label="移除已保存的加签密钥"
                onCheckedChange={(v) => {
                  setClearSecret(v);
                  setChallenge(null);
                }}
              />
            </Field>
          )}
          <Button type="submit" variant="outline" loading={send.isPending} disabled={busy || remaining > 0}>
            {remaining > 0 ? `${remaining} 秒后可重新发送` : '发送验证码'}
          </Button>
        </form>
        {challenge && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate();
            }}
          >
            <Field label="验证码" htmlFor="notification-code" hint="10 分钟内有效，最多尝试 5 次。" required>
              <Input
                id="notification-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6 位数字"
              />
            </Field>
            <Button type="submit" loading={verify.isPending} disabled={busy || !/^\d{6}$/.test(code)}>
              验证并启用
            </Button>
          </form>
        )}
        {settings.verified && (
          <div className="flex flex-wrap items-center gap-3">
            <TestNotificationButton />
            <p className="text-sm text-muted-foreground">更换地址或密钥后需重新验证；验证成功前继续使用原配置。</p>
          </div>
        )}
        {!completion && (
          <>
            {settings.webhookUrl && (
              <Confirm
                title="移除飞书通知配置？"
                description="移除后将停止接收飞书通知。如果管理员要求配置通知，你需要重新完成验证才能访问平台。"
                confirmText="移除"
                onConfirm={() => remove.mutate()}
                destructive
              >
                <Button variant="outline-destructive" disabled={busy}>
                  移除通知配置
                </Button>
              </Confirm>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function TestNotificationButton() {
  const test = useMutation({
    mutationFn: () => api('POST', '/api/account/notification/test'),
    onSuccess: () => toast.success('测试通知已发送，请在飞书中查看'),
    onError,
  });
  return (
    <Button type="button" variant="outline" size="sm" loading={test.isPending} onClick={() => test.mutate()}>
      发送测试通知
    </Button>
  );
}

/**
 * 飞书自建应用渠道的绑定（决策 92）：打开机器人 → 把绑定码私聊发给它。
 * 绑定码 10 分钟有效、只在本页内存里出现；等待期间每 3 秒刷新一次账号状态，绑上了就自动切到已绑定。
 */
function FeishuBindForm({ settings }: { settings: NotificationSettings }) {
  const client = useQueryClient();
  const app = settings.feishuApp;
  const [code, setCode] = useState<FeishuBindCode | null>(null);
  const [rebinding, setRebinding] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refreshAccount = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['account'] }),
      client.invalidateQueries({ queryKey: ['onboarding'] }),
    ]);
  const generate = useMutation({
    mutationFn: () => api<FeishuBindCode>('POST', '/api/account/notification/feishu/bind-code'),
    onSuccess: (c) => {
      setCode(c);
      setNow(Date.now());
    },
    onError,
  });
  const unbind = useMutation({
    mutationFn: () => api('DELETE', '/api/account/notification/feishu'),
    onSuccess: async () => {
      setCode(null);
      setRebinding(false);
      await refreshAccount();
      toast.success('已解除飞书绑定');
    },
    onError,
  });
  const bound = !!app?.bound;
  const waiting = !!app && (!bound || rebinding);
  const remaining = code ? Math.max(0, Math.ceil((Date.parse(code.expiresAt) - now) / 1000)) : 0;
  const live = remaining > 0;
  useEffect(() => {
    if (waiting && !code && !generate.isPending && !generate.isError) generate.mutate();
  }, [waiting, code, generate.isPending, generate.isError, generate.mutate]);
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);
  useEffect(() => {
    if (!waiting || !live) return;
    const timer = setInterval(() => void refreshAccount(), 3000);
    return () => clearInterval(timer);
  }, [waiting, live]);
  // boundAt 变化 = 刚完成（重新）绑定
  const boundAt = app?.boundAt ?? null;
  const lastBoundAt = useRef(boundAt);
  useEffect(() => {
    if (boundAt && boundAt !== lastBoundAt.current && code) {
      toast.success('飞书账号已绑定，之后的通知会由机器人私聊发送');
      setCode(null);
      setRebinding(false);
    }
    lastBoundAt.current = boundAt;
  }, [boundAt, code]);

  if (!app)
    return (
      <p className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
        管理员还没有完成飞书自建应用的配置，暂时无法绑定。请稍后再来，或联系管理员。
      </p>
    );
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');
  return (
    <div className="space-y-5">
      <a
        href={app.openBotUrl}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
      >
        {app.botAvatarUrl ? (
          <img src={app.botAvatarUrl} alt="" className="size-11 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-6" aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{app.botName ?? 'EAT 通知机器人'}</span>
          <span className="block text-xs text-muted-foreground">飞书机器人 · 点击在飞书中打开对话</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
          打开
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </span>
      </a>
      {bound && !rebinding ? (
        <div className="space-y-4 rounded-lg border border-success/30 bg-success/5 p-4">
          <p className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            <span>
              已绑定飞书账号{app.boundAt && <span className="text-muted-foreground"> · {formatDateTime(app.boundAt)}</span>}
              <span className="mt-0.5 block text-xs text-muted-foreground">通知由机器人私聊发送；换了飞书账号可以重新绑定。</span>
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <TestNotificationButton />
            <Button type="button" variant="outline" size="sm" onClick={() => setRebinding(true)}>
              重新绑定
            </Button>
            <Confirm
              title="解除飞书绑定？"
              description="解除后将不再收到机器人通知。如果管理员要求配置通知，你需要重新绑定才能访问平台。"
              confirmText="解除绑定"
              onConfirm={() => unbind.mutate()}
            >
              <Button type="button" variant="outline-destructive" size="sm" loading={unbind.isPending}>
                解除绑定
              </Button>
            </Confirm>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {app.stale && !rebinding && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              管理员更换了飞书应用，之前的绑定已失效，请重新绑定。
            </p>
          )}
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
            <li>点击上方卡片，在飞书里打开机器人（电脑或手机均可）。</li>
            <li>把下面的绑定码原样发给机器人，绑定会自动完成。</li>
          </ol>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg bg-muted/50 p-4">
            {code && live ? (
              <span className="flex items-center gap-1.5">
                <code aria-label="绑定码" className="font-mono text-2xl font-semibold tracking-[0.12em]">
                  {code.code}
                </code>
                <CopyButton text={code.code} />
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                {generate.isPending ? '正在生成绑定码…' : code ? '绑定码已过期，请重新生成' : '绑定码生成失败，请重试'}
              </span>
            )}
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {code && live ? `${minutes}:${seconds} 后过期` : null}
            </span>
            <Button
              type="button"
              variant={code && !live ? 'default' : 'outline'}
              size="sm"
              className="ml-auto"
              loading={generate.isPending}
              onClick={() => generate.mutate()}
            >
              <RefreshCw />
              重新生成
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {code && live ? '正在等待机器人确认，绑定成功后此页会自动更新。' : '绑定码 10 分钟内有效，过期后重新生成即可。'}
            {rebinding && (
              <button type="button" className="ml-2 text-primary hover:underline" onClick={() => setRebinding(false)}>
                取消重新绑定
              </button>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function NotificationPreferencesForm({
  settings,
  onSaved,
}: {
  settings: NotificationSettings;
  onSaved: () => Promise<void>;
}) {
  const initial = () => ({
    notifyApprovalRequest: settings.notifyApprovalRequest ?? true,
    notifyApprovalResult: settings.notifyApprovalResult ?? true,
    notifyHelp: settings.notifyHelp,
    notifyReply: settings.notifyReply,
    notifyMention: settings.notifyMention,
  });
  const [preferences, setPreferences] = useState(initial);
  const dirty = Object.entries(preferences).some(
    ([key, value]) => value !== initial()[key as keyof typeof preferences],
  );
  const save = useMutation({
    mutationFn: () => api('PATCH', '/api/account/notification/preferences', preferences),
    onSuccess: async () => {
      await onSaved();
      toast.success('通知偏好已保存');
    },
    onError,
  });
  const groups = [
    {
      title: '申请与审批',
      items: [
        [
          'notifyApprovalRequest',
          '待我审批的申请',
          '收到新的权限申请或催办时通知我，可在飞书中快捷同意或进入详情处理。',
        ],
        [
          'notifyApprovalResult',
          '我的申请处理结果',
          '我发起的申请通过或被驳回时通知我，驳回通知包含具体原因。',
        ],
      ],
    },
    {
      title: '团队协作',
      items: [
        ['notifyHelp', '求助通知', '有人向我发起求助时通知我。'],
        ['notifyReply', '回复通知', '我的求助有新回复时通知我。'],
        ['notifyMention', 'Folio 评论提及', '有人在 Folio 评论中 @ 我时通知我。'],
      ],
    },
  ];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {!settings.connected && (
        <p className="settings-notice text-muted-foreground">
          {settings.channel === 'app'
            ? '偏好可以提前保存。在下方绑定飞书账号后，通知才会发送。'
            : '偏好可以提前保存。连接并验证飞书机器人后，通知才会发送。'}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.title} className="settings-group" aria-label={group.title}>
          <h3 className="mb-2 text-sm font-semibold">{group.title}</h3>
          {group.items.map(([key, label, hint]) => (
            <div key={key} className="flex items-center justify-between gap-6 py-4">
              <div>
                <label htmlFor={key} className="text-sm font-medium cursor-pointer">
                  {label}
                </label>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
              </div>
              <Switch
                id={key}
                aria-label={label}
                disabled={save.isPending}
                checked={preferences[key as keyof typeof preferences]}
                onCheckedChange={(value) => setPreferences((p) => ({ ...p, [key]: value }))}
              />
            </div>
          ))}
        </section>
      ))}
      <div className="settings-actions">
        <Button type="submit" loading={save.isPending} disabled={!dirty}>
          保存通知偏好
        </Button>
        <p className="settings-save-state">{dirty ? '有尚未保存的更改' : '偏好已保存'}</p>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const change = useMutation({
    mutationFn: () => api('POST', '/api/account/password', { oldPassword, password }),
    onSuccess: () => {
      clearSession();
      toast.success('密码已修改，请重新登录');
      location.href = '/login';
    },
    onError,
  });
  return (
    <AccountSection title="账户安全" description="定期更新密码，保护你的账户和平台访问凭证。">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== confirmation) return toast.error('两次输入的新密码不一致');
          change.mutate();
        }}
      >
        <Field label="原密码" htmlFor="old-password" required>
          <Input
            id="old-password"
            type="password"
            autoComplete="current-password"
            required
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
          />
        </Field>
        <Field
          label="新密码"
          htmlFor="new-password"
          required
          hint="至少 8 位。修改后所有登录凭证失效，网站和 CLI / MCP 需要重新登录或配置凭证。"
        >
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="确认新密码" htmlFor="confirm-password" required>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </Field>
        <Button type="submit" loading={change.isPending}>
          修改密码
        </Button>
      </form>
      <div className="mt-8 border-t pt-6">
        <h3 className="text-sm font-semibold">已授权设备</h3>
        <p className="mt-2 mb-4 text-sm text-muted-foreground">查看并撤销 CLI 和其他设备的登录授权。</p>
        <Button asChild variant="outline">
          <Link to="/device/authorized">管理已授权设备</Link>
        </Button>
      </div>
    </AccountSection>
  );
}
