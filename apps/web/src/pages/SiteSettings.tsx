import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  updateSiteSettingsSchema,
  type SiteSettingsInfo,
  type SiteTlsOptions,
  type UpdateSiteSettings,
} from '@eat/shared';
import { api } from '../api';
import { DokployAppPicker } from '../components/dokploy-app-picker';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';

const statuses: Record<string, string> = {
  disabled: '未启用',
  checking: '正在检查',
  provisioning: '正在配置入口',
  verifying: '正在验证 HTTPS',
  enabled: '已启用',
  disabling: '正在停用',
  failed: '需要处理',
};
const busyStatuses = ['checking', 'provisioning', 'verifying', 'disabling'];
const defaults: UpdateSiteSettings = {
  domain: '',
  platformUrl: window.location.origin,
  ossRegion: 'oss-cn-hangzhou',
  ossBucket: '',
  tlsMode: 'alidns',
  acmeEmail: '',
  certificateId: '',
  resolverName: '',
  platformApplicationId: '',
  upstreamUrl: '',
  upstreamPort: 3000,
  gatewayTarget: '',
  autoDns: false,
};
const formValues = (r: SiteSettingsInfo): UpdateSiteSettings => ({
  ...r,
  platformUrl: r.platformUrl || window.location.origin,
  ossAccessKeyId: '',
  ossAccessKeySecret: '',
  dnsAccessKeyId: '',
  dnsAccessKeySecret: '',
});
const selectClass = 'h-9 w-full rounded-md border bg-background px-2 text-sm';

export function SiteSettingsCard() {
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: ['site-settings'],
    queryFn: () => api<SiteSettingsInfo>('GET', '/api/admin/site-settings'),
    refetchInterval: (q) => (busyStatuses.includes(q.state.data?.status ?? '') ? 1500 : false),
  });
  const form = useForm<UpdateSiteSettings>({ defaultValues: defaults });
  const {
    register,
    watch,
    reset,
    setValue,
    formState: { isDirty },
  } = form;
  useEffect(() => {
    if (settings.data && !isDirty) reset(formValues(settings.data));
  }, [settings.data, isDirty, reset]);
  const mode = watch('tlsMode');
  const applicationId = watch('platformApplicationId');
  const domain = watch('domain');
  const target = watch('gatewayTarget');
  const options = useQuery({
    queryKey: ['site-tls-options', applicationId],
    queryFn: () =>
      api<SiteTlsOptions>('GET', `/api/admin/site-settings/tls-options/${encodeURIComponent(applicationId)}`),
    enabled: !!applicationId && ['certificate', 'resolver'].includes(mode),
    retry: false,
  });
  const r = settings.data;
  const working = busyStatuses.includes(r?.status ?? '');
  const frozen = working || r?.enabled;
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['site-settings'] });
    void cache.invalidateQueries({ queryKey: ['sites-capability'] });
    void cache.invalidateQueries({ queryKey: ['sites'] });
  };
  const save = useMutation({
    mutationFn: (body: UpdateSiteSettings) => api<SiteSettingsInfo>('PUT', '/api/admin/site-settings', body),
    onSuccess: (data) => {
      reset(formValues(data));
      cache.setQueryData(['site-settings'], data);
      refresh();
      toast.success('静态网站配置已保存');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const action = useMutation({
    mutationFn: (name: 'enable' | 'disable') => api<SiteSettingsInfo>('POST', `/api/admin/site-settings/${name}`),
    onSuccess: (data) => {
      cache.setQueryData(['site-settings'], data);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  useEffect(() => {
    if (r?.status === 'enabled' || r?.status === 'disabled' || r?.status === 'failed')
      void cache.invalidateQueries({ queryKey: ['sites-capability'] });
  }, [r?.status, cache]);
  return (
    <Card id="static-sites">
      <CardContent className="space-y-5 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">静态网站发布</h2>
          <Badge variant={r?.enabled ? 'default' : 'secondary'}>{statuses[r?.status ?? 'disabled']}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          管理员配置一次，成员即可发布。文件存入私有 OSS；共享 HTTPS 入口和证书由部署后台的 Traefik 承载。
        </p>
        {settings.isLoading && <p className="text-sm">正在读取配置…</p>}
        {settings.error && (
          <p role="alert" className="text-sm text-destructive">
            {settings.error.message}
          </p>
        )}
        <form
          onSubmit={form.handleSubmit((values) => {
            const parsed = updateSiteSettingsSchema.safeParse(values);
            if (!parsed.success) {
              toast.error(parsed.error.issues[0].message);
              return;
            }
            save.mutate(parsed.data);
          })}
        >
          <fieldset
            disabled={frozen || save.isPending || action.isPending}
            className="grid min-w-0 gap-4 sm:grid-cols-2 [&_input:disabled]:opacity-100 [&_select:disabled]:opacity-100"
          >
            <label className="space-y-1 text-sm sm:col-span-2">
              EAT 控制台 HTTPS 地址
              <Input {...register('platformUrl')} placeholder="https://eat.example.com" required />
              <span className="text-xs text-muted-foreground">
                用于网站登录和评论，默认填写当前控制台地址，无需修改环境变量。
              </span>
            </label>
            <label className="space-y-1 text-sm">
              站点域名后缀
              <Input {...register('domain')} placeholder="sites.example.com" required />
              <span className="text-xs text-muted-foreground">应与控制台域名分开，例如 demo.sites.example.com</span>
            </label>
            <label className="space-y-1 text-sm">
              部署入口 IP / 主机名
              <Input {...register('gatewayTarget')} placeholder="203.0.113.10" required />
              <span className="text-xs text-muted-foreground">
                填写 Dokploy 所在服务器入口，域名应关闭 CDN / Cloudflare 代理。
              </span>
            </label>
            <div className="space-y-1 text-sm sm:col-span-2">
              <label htmlFor="site-eat-app">EAT 应用（在 Dokploy 中运行的控制台服务）</label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="site-eat-app"
                  className="min-w-0 flex-1"
                  {...register('platformApplicationId')}
                  placeholder="选择 EAT 应用，或填写 Application ID"
                  required
                />
                <DokployAppPicker
                  value={applicationId}
                  onPick={(app) => setValue('platformApplicationId', app.applicationId, { shouldDirty: true })}
                />
              </div>
            </div>
            <label className="space-y-1 text-sm">
              EAT 容器端口
              <Input
                type="number"
                {...register('upstreamPort', { valueAsNumber: true })}
                min={1}
                max={65535}
                required
              />
            </label>
            <label className="space-y-1 text-sm">
              EAT 内部地址（可选）
              <Input {...register('upstreamUrl')} placeholder="留空自动使用所选应用的容器地址" />
              <span className="text-xs text-muted-foreground">需要自定义时填写 Traefik 能访问的服务根地址。</span>
            </label>
            <label className="space-y-1 text-sm">
              OSS 地域
              <Input {...register('ossRegion')} placeholder="oss-cn-hangzhou" required />
            </label>
            <label className="space-y-1 text-sm">
              私有 OSS Bucket
              <Input {...register('ossBucket')} required />
            </label>
            <label className="space-y-1 text-sm">
              OSS AccessKey ID
              <Input
                type="password"
                autoComplete="new-password"
                {...register('ossAccessKeyId')}
                placeholder={r?.ossAccessKeyIdMasked ? `已保存 ${r.ossAccessKeyIdMasked}，留空保留` : 'AccessKey ID'}
              />
            </label>
            <label className="space-y-1 text-sm">
              OSS AccessKey Secret
              <Input
                type="password"
                autoComplete="new-password"
                {...register('ossAccessKeySecret')}
                placeholder={r?.hasOssSecret ? '已保存，留空保留' : 'AccessKey Secret'}
              />
            </label>
            <label className="space-y-1 text-sm sm:col-span-2">
              HTTPS 证书方式
              <select className={selectClass} {...register('tlsMode')}>
                <option value="alidns">阿里云 DNS：自动签发与续期</option>
                <option value="cloudflare">Cloudflare：自动签发与续期</option>
                <option value="certificate">复用 Dokploy 中已有的泛域名证书</option>
                <option value="resolver">复用已有 DNS 证书解析器</option>
              </select>
            </label>
            {['alidns', 'cloudflare'].includes(mode) && (
              <>
                <label className="space-y-1 text-sm">
                  证书联系邮箱
                  <Input type="email" {...register('acmeEmail')} required />
                </label>
                {mode === 'alidns' && (
                  <label className="space-y-1 text-sm">
                    DNS AccessKey ID
                    <Input
                      type="password"
                      autoComplete="new-password"
                      {...register('dnsAccessKeyId')}
                      placeholder={
                        r?.tlsMode === mode && r.dnsAccessKeyIdMasked
                          ? `已保存 ${r.dnsAccessKeyIdMasked}，留空保留`
                          : '具有目标域名 DNS 权限的 AccessKey ID'
                      }
                    />
                  </label>
                )}
                <label className="space-y-1 text-sm">
                  {mode === 'alidns' ? 'DNS AccessKey Secret' : 'Cloudflare API Token'}
                  <Input
                    type="password"
                    autoComplete="new-password"
                    {...register('dnsAccessKeySecret')}
                    placeholder={r?.tlsMode === mode && r.hasDnsSecret ? '已保存，留空保留' : 'DNS 凭证'}
                  />
                </label>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  {mode === 'alidns'
                    ? '需要读取域名区域和 DNS 记录，以及新增、删除 TXT 记录的权限。'
                    : 'Token 需要目标区域的 Zone Read 与 DNS Edit 权限。'}{' '}
                  DNS 凭证与 OSS 凭证独立，加密保存后由 EAT 配置到 Traefik，自动完成证书申请和续期。
                </p>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" {...register('autoDns')} />
                  自动添加 *.{domain || '站点域名'} → {target || '部署入口'} 的解析（仅在不存在时添加，不覆盖已有记录）
                </label>
              </>
            )}
            {mode === 'certificate' && (
              <>
                <label className="space-y-1 text-sm sm:col-span-2">
                  已有泛域名证书
                  <select className={selectClass} {...register('certificateId')} required>
                    <option value="">{options.isLoading ? '正在读取…' : '请选择 EAT 所在服务器上的证书'}</option>
                    {options.data?.certificates.map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name} · {c.domains} · 到期 {c.expiresAt.slice(0, 10)}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  证书需覆盖 *.{domain || '站点域名'}，并已在 Dokploy 中安装。续期和证书更新由原有流程负责。
                </p>
              </>
            )}
            {mode === 'resolver' && (
              <label className="space-y-1 text-sm sm:col-span-2">
                已有 DNS 证书解析器
                <select className={selectClass} {...register('resolverName')} required>
                  <option value="">{options.isLoading ? '正在读取…' : '请选择 DNS 解析器'}</option>
                  {options.data?.resolvers.map((name) => (
                    <option value={name} key={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {options.error && ['certificate', 'resolver'].includes(mode) && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {options.error.message}
              </p>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" variant="outline" loading={save.isPending} disabled={!isDirty}>
                保存配置
              </Button>
            </div>
          </fieldset>
        </form>
        <div className="rounded-md border p-3 text-sm space-y-2">
          <p>
            DNS 记录：
            <code className="break-all">
              *.{domain || 'sites.example.com'} → {target || 'Dokploy 入口'}
            </code>
          </p>
          <p className="text-xs text-muted-foreground">
            未勾选自动添加时，请在 DNS 控制台手动添加 A / AAAA / CNAME。启用时会验证多个随机子域名及实际 HTTPS
            访问。首次配置自动证书会重载共享 Traefik。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={!r?.configured || r.enabled || working || isDirty || save.isPending}
            loading={action.isPending && action.variables === 'enable'}
            onClick={() => action.mutate('enable')}
          >
            检查并启用
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!r?.configured || working || r.status === 'disabled'}
            loading={action.isPending && action.variables === 'disable'}
            onClick={() => action.mutate('disable')}
          >
            停用并清理入口
          </Button>
          {isDirty && <span className="text-xs text-muted-foreground">请先保存配置</span>}
          {r?.enabled && (
            <span className="text-xs text-muted-foreground">修改配置前先停用；历史版本和评论会保留。</span>
          )}
        </div>
        {!!r?.checks.length && (
          <ol aria-label="静态网站启用检查" className="space-y-3">
            {r.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2 text-sm">
                {check.status === 'running' ? (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                ) : check.status === 'passed' ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0">
                  <p>{check.name}</p>
                  <p className="break-words text-xs text-muted-foreground">{check.message}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
        {r?.lastError && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {r.lastError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
