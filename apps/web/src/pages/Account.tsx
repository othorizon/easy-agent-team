import { GithubAccountPanel } from '../components/github';
import type { AccountInfo, NotificationSettings, UpdateAccountRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
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
const FEISHU_DOC = 'https://www.feishu.cn/hc/zh-CN/articles/360024984973-%E5%9C%A8%E7%BE%A4%E7%BB%84%E4%B8%AD%E4%BD%BF%E7%94%A8%E6%9C%BA%E5%99%A8%E4%BA%BA';
const onError = (error: Error) => toast.error(error.message);

export function AccountPage({ completion = false }: { completion?: boolean }) {
  const client = useQueryClient();
  const [params] = useSearchParams();
  const token = getToken();
  const account = useQuery({
    queryKey: ['account', token], queryFn: () => api<AccountInfo>('GET', '/api/account'),
    enabled: !!token, refetchOnMount: 'always', refetchOnWindowFocus: true, refetchInterval: completion ? 30_000 : false,
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
    }, onError,
  });
  if (!token) return <Navigate to="/login" replace />;
  if (account.isError) return <div className="p-8 space-y-4"><p>个人资料加载失败：{account.error.message}</p><Button onClick={() => void account.refetch()}>重试</Button></div>;
  if (!account.data) return <p className="p-8 text-muted-foreground">正在加载个人资料…</p>;
  const data = account.data;
  const next = params.get('next') ?? '/';
  const safeNext = next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') &&
    !next.startsWith('/complete-profile') && !next.startsWith('/login') ? next : '/';
  if (completion && !data.onboarding.required) {
    if (account.isFetching) return <p className="p-8 text-muted-foreground">正在检查账号状态…</p>;
    return <Navigate to={safeNext} replace />;
  }
  return (
    <div className={completion ? 'mx-auto w-full max-w-2xl space-y-6 px-4 py-10' : 'max-w-3xl space-y-6'}>
      <PageHeader
        title={completion ? '完善个人资料' : '用户中心'}
        description={completion ? '管理员要求完成以下配置后进入平台。已完成的项目无需重复填写。' : '管理个人资料、密码和平台通知。'}
        actions={completion ? <Button variant="ghost" onClick={() => { clearSession(); location.href = '/login'; }}>退出登录</Button> : undefined}
      />
      {(!completion || data.onboarding.requireBio) && (
        completion && data.onboarding.bioComplete
          ? <Card><CardContent className="flex items-center justify-between py-5"><span>个人简介</span><Badge variant="success">已完成</Badge></CardContent></Card>
          : <ProfileForm key={data.id} data={data} completion={completion} pending={update.isPending} onSave={(v) => update.mutate(v)} />
      )}
      {(!completion || data.onboarding.requireNotification) && (
        completion && data.onboarding.notificationComplete
          ? <Card><CardContent className="flex items-center justify-between py-5"><span>飞书通知</span><Badge variant="success">已验证</Badge></CardContent></Card>
          : <NotificationForm settings={data.notification} completion={completion} onSaved={refresh} />
      )}
      {!completion && <GithubAccountPanel />}
      {!completion && <PasswordForm />}
    </div>
  );
}

function ProfileForm({ data, completion, pending, onSave }: {
  data: AccountInfo; completion: boolean; pending: boolean; onSave: (v: UpdateAccountRequest) => void;
}) {
  const [name, setName] = useState(data.name);
  const [bio, setBio] = useState(data.bio);
  const [allowHelp, setAllowHelp] = useState(data.allowHelp);
  return <Card>
    <CardHeader><CardTitle>{completion ? '个人简介' : '个人资料'}</CardTitle></CardHeader>
    <CardContent>
      <form className="space-y-5" onSubmit={(e) => {
        e.preventDefault();
        if (completion && !bio.trim()) return toast.error('请填写个人简介');
        onSave(completion ? { bio } : { name, bio, allowHelp });
      }}>
        {!completion && <Field label="姓名" htmlFor="account-name" required>
          <Input id="account-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>}
        <Field label="个人简介" htmlFor="account-bio" hint={BIO_HINT} required={completion}>
          <Textarea id="account-bio" rows={6} maxLength={2000} required={completion} value={bio}
            placeholder="例如：负责订单与支付系统，擅长数据分析、对账排查和后端开发。" onChange={(e) => setBio(e.target.value)} />
          <p className="text-right text-xs text-muted-foreground">{bio.length} / 2000</p>
        </Field>
        {!completion && <Field label="允许被求助" hint="填写个人简介后自动进入 AI 求助候选名单；关闭后进入勿扰状态。">
          <Switch checked={allowHelp} onCheckedChange={setAllowHelp} aria-label="允许被求助" />
        </Field>}
        <Button type="submit" loading={pending}>保存{completion ? '个人简介' : '个人资料'}</Button>
      </form>
    </CardContent>
  </Card>;
}

function NotificationForm({ settings, completion, onSaved }: {
  settings: NotificationSettings; completion: boolean; onSaved: () => Promise<void>;
}) {
  const [url, setUrl] = useState(settings.webhookUrl);
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [preferences, setPreferences] = useState({
    notifyHelp: settings.notifyHelp, notifyReply: settings.notifyReply, notifyMention: settings.notifyMention,
  });
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const send = useMutation({
    mutationFn: () => api<{ challengeId: string; retryAfter: number }>('POST', '/api/account/notification/code', {
      webhookUrl: url.trim(), ...(clearSecret ? { webhookSecret: '' } : secret.trim() ? { webhookSecret: secret.trim() } : {}),
    }),
    onSuccess: (result) => {
      setChallenge(result.challengeId); setCode('');
      setNow(Date.now()); setRetryAt(Date.now() + result.retryAfter * 1000);
      toast.success('验证码已发送至飞书群，10 分钟内有效');
    }, onError,
  });
  const verify = useMutation({
    mutationFn: () => api('POST', '/api/account/notification/verify', { challengeId: challenge, code }),
    onSuccess: async () => {
      setChallenge(null); setCode(''); setSecret(''); setClearSecret(false);
      await onSaved(); toast.success('飞书通知已验证并启用');
    }, onError,
  });
  const savePreferences = useMutation({
    mutationFn: () => api('PUT', '/api/account/notification/preferences', preferences),
    onSuccess: async () => { await onSaved(); toast.success('通知偏好已保存'); }, onError,
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', '/api/account/notification'),
    onSuccess: async () => {
      setUrl(''); setSecret(''); setCode(''); setChallenge(null); setClearSecret(false);
      await onSaved(); toast.success('飞书通知配置已移除');
    }, onError,
  });
  const busy = send.isPending || verify.isPending || remove.isPending;
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return <Card>
    <CardHeader><CardTitle className="flex items-center justify-between">飞书通知
      <Badge variant={settings.verified ? 'success' : 'outline'}>{settings.verified ? '已验证' : settings.webhookUrl ? '待验证' : '未配置'}</Badge>
    </CardTitle></CardHeader>
    <CardContent className="space-y-5">
      <div className="rounded-lg bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">
        在飞书群中打开「设置 → 群机器人 → 添加机器人」，选择「自定义机器人」，创建后复制 Webhook 地址。
        如启用了签名校验，请同时填写加签密钥；使用关键词校验时，请允许关键词「EAT」。
        验证码会发送到该群，请回到此处填写。
        <a className="ml-1 text-primary underline underline-offset-4" href={FEISHU_DOC} target="_blank" rel="noreferrer">查看飞书官方说明</a>
      </div>
      <p className="text-sm text-muted-foreground">此配置用于整个平台的个人通知，包括求助、回复和 Folio 评论提及。</p>
      <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault(); setChallenge(null); send.mutate();
      }}>
        <Field label="飞书 Webhook 地址" htmlFor="notification-url" required>
          <Input id="notification-url" type="url" required maxLength={500} disabled={busy} value={url}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            onChange={(e) => { setUrl(e.target.value); setChallenge(null); }} />
        </Field>
        <Field label="加签密钥（可选）" htmlFor="notification-secret"
          hint={settings.hasWebhookSecret && url.trim() === settings.webhookUrl ? '已保存密钥；地址不变时，留空保留原值。' : '仅在机器人开启签名校验时填写。'}>
          <Input id="notification-secret" type="password" autoComplete="new-password" maxLength={200}
            disabled={busy || clearSecret} value={secret} onChange={(e) => { setSecret(e.target.value); setChallenge(null); }} />
        </Field>
        {settings.hasWebhookSecret && url.trim() === settings.webhookUrl && <Field label="移除已保存的加签密钥">
          <Switch checked={clearSecret} disabled={busy} aria-label="移除已保存的加签密钥"
            onCheckedChange={(v) => { setClearSecret(v); setChallenge(null); }} />
        </Field>}
        <Button type="submit" variant="outline" loading={send.isPending} disabled={busy || remaining > 0}>
          {remaining > 0 ? `${remaining} 秒后可重新发送` : '发送验证码'}
        </Button>
      </form>
      {challenge && <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); verify.mutate(); }}>
        <Field label="验证码" htmlFor="notification-code" hint="10 分钟内有效，最多尝试 5 次。" required>
          <Input id="notification-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
            required maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位数字" />
        </Field>
        <Button type="submit" loading={verify.isPending} disabled={busy || !/^\d{6}$/.test(code)}>验证并启用</Button>
      </form>}
      {settings.verified && <p className="text-sm text-muted-foreground">更换地址或密钥后需重新验证；验证成功前继续使用原配置。</p>}
      {!completion && <>
        <div className="space-y-4 border-t pt-5">
          {([['notifyHelp', '接收求助通知'], ['notifyReply', '接收回复通知'], ['notifyMention', '接收 Folio 评论 @ 通知']] as const).map(([key, label]) =>
            <Field key={key} label={label}><Switch aria-label={label} checked={preferences[key]}
              onCheckedChange={(value) => setPreferences((p) => ({ ...p, [key]: value }))} /></Field>)}
          <Button variant="outline" loading={savePreferences.isPending} onClick={() => savePreferences.mutate()}>保存通知偏好</Button>
        </div>
        {settings.webhookUrl && <Confirm title="移除飞书通知配置？" description="移除后将停止接收飞书通知。如果管理员要求配置通知，你需要重新完成验证才能访问平台。"
          confirmText="移除" onConfirm={() => remove.mutate()} destructive>
          <Button variant="outline-destructive" disabled={busy}>移除通知配置</Button>
        </Confirm>}
      </>}
    </CardContent>
  </Card>;
}

function PasswordForm() {
  const [oldPassword, setOldPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const change = useMutation({
    mutationFn: () => api('POST', '/api/account/password', { oldPassword, password }),
    onSuccess: () => {
      clearSession(); toast.success('密码已修改，请重新登录'); location.href = '/login';
    }, onError,
  });
  return <Card>
    <CardHeader><CardTitle>修改密码</CardTitle></CardHeader>
    <CardContent><form className="space-y-4" onSubmit={(e) => {
      e.preventDefault();
      if (password !== confirmation) return toast.error('两次输入的新密码不一致');
      change.mutate();
    }}>
      <Field label="原密码" htmlFor="old-password" required><Input id="old-password" type="password" autoComplete="current-password" required
        value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} /></Field>
      <Field label="新密码" htmlFor="new-password" required hint="至少 8 位。修改后所有登录凭证失效，网站和 CLI / MCP 需要重新登录或配置凭证。">
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={72}
          value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label="确认新密码" htmlFor="confirm-password" required><Input id="confirm-password" type="password" autoComplete="new-password" required
        value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>
      <Button type="submit" loading={change.isPending}>修改密码</Button>
    </form></CardContent>
  </Card>;
}
