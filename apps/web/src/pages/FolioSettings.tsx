import { useEffect, useRef } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
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
import type { z } from '../lib/zod';
import { DokployAppPicker } from '../components/dokploy-app-picker';
import { Field, firstErrorMessage } from '../components/form';
import {
  SettingsActions,
  SettingsGroup,
  SettingsLoadError,
  SettingsLoading,
  SettingsSection,
} from '../components/settings';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Checkbox } from '../components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

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
  ossAccessKeyId: '',
  ossAccessKeySecret: '',
  dnsAccessKeyId: '',
  dnsAccessKeySecret: '',
};
const formValues = (r: SiteSettingsInfo): UpdateSiteSettings => ({
  ...r,
  platformUrl: r.platformUrl || window.location.origin,
  ossAccessKeyId: '',
  ossAccessKeySecret: '',
  dnsAccessKeyId: '',
  dnsAccessKeySecret: '',
});
export function FolioSettingsCard({ active = true }: { active?: boolean }) {
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: ['site-settings'],
    enabled: active,
    queryFn: () => api<SiteSettingsInfo>('GET', '/api/admin/site-settings'),
    refetchInterval: (q) => (busyStatuses.includes(q.state.data?.status ?? '') ? 1500 : false),
  });
  const form = useForm<z.input<typeof updateSiteSettingsSchema>, unknown, UpdateSiteSettings>({ resolver: zodResolver(updateSiteSettingsSchema), defaultValues: defaults });
  const initialized = useRef(false);
  const {
    register,
    watch,
    reset,
    setValue,
    formState: { isDirty, errors },
  } = form;
  useEffect(() => {
    if (settings.data && (!initialized.current || !isDirty)) {
      reset(formValues(settings.data));
      initialized.current = true;
    }
  }, [settings.data, isDirty, reset]);
  const mode = watch('tlsMode') ?? 'alidns';
  const applicationId = watch('platformApplicationId');
  const domain = watch('domain');
  const target = watch('gatewayTarget');
  const options = useQuery({
    queryKey: ['site-tls-options', applicationId],
    queryFn: () =>
      api<SiteTlsOptions>('GET', `/api/admin/site-settings/tls-options/${encodeURIComponent(applicationId)}`),
    enabled: active && !!applicationId && ['certificate', 'resolver'].includes(mode),
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
      toast.success('Folio 配置已保存');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const action = useMutation({
    mutationFn: (name: 'enable' | 'disable') =>
      api<SiteSettingsInfo>('POST', `/api/admin/site-settings/${name}`),
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
  if (!r)
    return (
      <SettingsSection title="基础发布" description="配置 Folio 的访问入口、私有 OSS 与 HTTPS 证书。">
        {settings.isError ? (
          <SettingsLoadError error={settings.error} retry={() => void settings.refetch()} />
        ) : (
          <SettingsLoading />
        )}
      </SettingsSection>
    );
  return (
    <SettingsSection
      title="基础发布"
      description="配置一次，成员即可发布静态网页。文件存入私有 OSS，共享 HTTPS 入口与证书由 Dokploy 的 Traefik 承载。"
      status={<Badge variant={r.enabled ? 'default' : 'secondary'}>{statuses[r.status]}</Badge>}
    >
      <form
        className="settings-form"
        onSubmit={form.handleSubmit(
          (values) => save.mutate(values),
          // 字段旁边能显示的都显示了；底部再汇总第一条，覆盖没有报错位置的开关类字段
          (errs) => form.setError('root', { message: firstErrorMessage(errs) }),
        )}
      >
        <fieldset
          disabled={frozen || save.isPending || action.isPending}
          className="min-w-0 [&_input:disabled]:opacity-100 [&_select:disabled]:opacity-100"
        >
          <SettingsGroup title="访问入口" description="配置独立的发布域名，以及承载 EAT 服务的部署应用。">
            <Field
              required
              label="EAT 控制台 HTTPS 地址"
              htmlFor="site-platformUrl" error={errors.platformUrl?.message}
              hint="用于 Folio 登录和评论，默认填写当前控制台地址，无需修改环境变量。"
            >
              <Input
                id="site-platformUrl"
                {...register('platformUrl')}
                placeholder="https://eat.example.com"
                required
              />
            </Field>
            <Field
              required
              label="发布域名后缀"
              htmlFor="site-domain" error={errors.domain?.message}
              hint="应与控制台域名分开，例如 demo.sites.example.com"
            >
              <Input id="site-domain" {...register('domain')} placeholder="sites.example.com" required />
            </Field>
            <Field
              required
              label="部署入口 IP / 主机名"
              htmlFor="site-gatewayTarget" error={errors.gatewayTarget?.message}
              hint="填写 Dokploy 所在服务器入口，域名应关闭 CDN / Cloudflare 代理。"
            >
              <Input
                id="site-gatewayTarget"
                {...register('gatewayTarget')}
                placeholder="203.0.113.10"
                required
              />
            </Field>
            <Field
              className="settings-span"
              label="EAT 应用"
              htmlFor="site-eat-app" error={errors.platformApplicationId?.message}
              required
              hint="选择在 Dokploy 中运行 EAT 控制台的应用，也可手动填写 Application ID。"
            >
              <div className="flex flex-wrap gap-2">
                <Input
                  id="site-eat-app"
                  aria-describedby="site-eat-app-description"
                  className="min-w-0 flex-1"
                  {...register('platformApplicationId')}
                  placeholder="选择 EAT 应用，或填写 Application ID"
                  required
                />
                <DokployAppPicker
                  value={applicationId}
                  onPick={(app) =>
                    setValue('platformApplicationId', app.applicationId, {
                      shouldDirty: true,
                    })
                  }
                />
              </div>
            </Field>
            <Field required label="EAT 容器端口" htmlFor="site-upstreamPort" error={errors.upstreamPort?.message}>
              <Input
                id="site-upstreamPort"
                type="number"
                {...register('upstreamPort', { valueAsNumber: true })}
                min={1}
                max={65535}
                required
              />
            </Field>
            <Field
              label="EAT 内部地址（可选）"
              htmlFor="site-upstreamUrl" error={errors.upstreamUrl?.message}
              hint="需要自定义时填写 Traefik 能访问的服务根地址。"
            >
              <Input
                id="site-upstreamUrl"
                {...register('upstreamUrl')}
                placeholder="留空自动使用所选应用的容器地址"
              />
            </Field>
          </SettingsGroup>
          <SettingsGroup
            title="文件存储"
            description="发布文件存入私有 OSS Bucket，凭证留空会保留已保存的值。"
          >
            <Field required label="OSS 地域" htmlFor="site-ossRegion" error={errors.ossRegion?.message}>
              <Input id="site-ossRegion" {...register('ossRegion')} placeholder="oss-cn-hangzhou" required />
            </Field>
            <Field required label="私有 OSS Bucket" htmlFor="site-ossBucket" error={errors.ossBucket?.message}>
              <Input id="site-ossBucket" {...register('ossBucket')} required />
            </Field>
            <Field label="OSS AccessKey ID" htmlFor="site-ossAccessKeyId" error={errors.ossAccessKeyId?.message}>
              <Input
                id="site-ossAccessKeyId"
                type="password"
                autoComplete="new-password"
                {...register('ossAccessKeyId')}
                placeholder={
                  r?.ossAccessKeyIdMasked ? `已保存 ${r.ossAccessKeyIdMasked}，留空保留` : 'AccessKey ID'
                }
              />
            </Field>
            <Field label="OSS AccessKey Secret" htmlFor="site-ossAccessKeySecret" error={errors.ossAccessKeySecret?.message}>
              <Input
                id="site-ossAccessKeySecret"
                type="password"
                autoComplete="new-password"
                {...register('ossAccessKeySecret')}
                placeholder={r?.hasOssSecret ? '已保存，留空保留' : 'AccessKey Secret'}
              />
            </Field>
          </SettingsGroup>
          <SettingsGroup
            title="HTTPS 与证书"
            description="选择自动签发或复用已有证书，保留当前服务的证书管理方式。"
          >
            <Field label="HTTPS 证书方式" htmlFor="site-tlsMode" error={errors.tlsMode?.message}>
              <Controller
                control={form.control}
                name="tlsMode"
                render={({ field }) => (
                  <Select
                    name={field.name}
                    value={field.value}
                    onValueChange={(value) => {
                      if (value) field.onChange(value);
                    }}
                    disabled={!!frozen || save.isPending || action.isPending}
                  >
                    <SelectTrigger id="site-tlsMode" ref={field.ref} onBlur={field.onBlur}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="settings-select-menu">
                      <SelectItem value="alidns">阿里云 DNS：自动签发与续期</SelectItem>
                      <SelectItem value="cloudflare">Cloudflare：自动签发与续期</SelectItem>
                      <SelectItem value="certificate">复用 Dokploy 中已有的泛域名证书</SelectItem>
                      <SelectItem value="resolver">复用已有 DNS 证书解析器</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            {['alidns', 'cloudflare'].includes(mode) && (
              <>
                <Field required label="证书联系邮箱" htmlFor="site-acmeEmail" error={errors.acmeEmail?.message}>
                  <Input id="site-acmeEmail" type="email" {...register('acmeEmail')} required />
                </Field>
                {mode === 'alidns' && (
                  <Field label="DNS AccessKey ID" htmlFor="site-dnsAccessKeyId" error={errors.dnsAccessKeyId?.message}>
                    <Input
                      id="site-dnsAccessKeyId"
                      type="password"
                      autoComplete="new-password"
                      {...register('dnsAccessKeyId')}
                      placeholder={
                        r?.tlsMode === mode && r.dnsAccessKeyIdMasked
                          ? `已保存 ${r.dnsAccessKeyIdMasked}，留空保留`
                          : '具有目标域名 DNS 权限的 AccessKey ID'
                      }
                    />
                  </Field>
                )}
                <Field
                  label={mode === 'alidns' ? 'DNS AccessKey Secret' : 'Cloudflare API Token'}
                  htmlFor="site-dnsAccessKeySecret" error={errors.dnsAccessKeySecret?.message}
                >
                  <Input
                    id="site-dnsAccessKeySecret"
                    type="password"
                    autoComplete="new-password"
                    {...register('dnsAccessKeySecret')}
                    placeholder={r?.tlsMode === mode && r.hasDnsSecret ? '已保存，留空保留' : 'DNS 凭证'}
                  />
                </Field>
                <p className="text-xs text-muted-foreground settings-span">
                  {mode === 'alidns'
                    ? '需要读取域名区域和 DNS 记录，以及新增、删除 TXT 记录的权限。'
                    : 'Token 需要目标区域的 Zone Read 与 DNS Edit 权限。'}{' '}
                  DNS 凭证与 OSS 凭证独立，加密保存后由 EAT 配置到 Traefik，自动完成证书申请和续期。
                </p>
                <label className="settings-toggle settings-span" htmlFor="site-autoDns">
                  <Controller
                    control={form.control}
                    name="autoDns"
                    render={({ field }) => (
                      <Checkbox
                        id="site-autoDns"
                        name={field.name}
                        checked={field.value}
                        onCheckedChange={(value) => field.onChange(value === true)}
                        onBlur={field.onBlur}
                        disabled={!!frozen || save.isPending || action.isPending}
                      />
                    )}
                  />
                  自动添加 *.{domain || 'Folio 域名'} → {target || '部署入口'}{' '}
                  的解析（仅在不存在时添加，不覆盖已有记录）
                </label>
              </>
            )}
            {mode === 'certificate' && (
              <>
                <Field
                  required
                  label="已有泛域名证书"
                  htmlFor="site-certificateId"
                  error={form.formState.errors.certificateId?.message}
                >
                  <Controller
                    control={form.control}
                    name="certificateId"
                    render={({ field, fieldState }) => (
                      <Select
                        name={field.name}
                        value={field.value}
                        onValueChange={(value) => {
                          if (value) field.onChange(value);
                        }}
                        disabled={!!frozen || save.isPending || action.isPending || options.isLoading}
                      >
                        <SelectTrigger
                          id="site-certificateId"
                          ref={field.ref}
                          onBlur={field.onBlur}
                          aria-required="true"
                          aria-invalid={!!fieldState.error}
                          aria-describedby={fieldState.error ? 'site-certificateId-description' : undefined}
                        >
                          <SelectValue
                            placeholder={options.isLoading ? '正在读取…' : '请选择 EAT 所在服务器上的证书'}
                          />
                        </SelectTrigger>
                        <SelectContent className="settings-select-menu">
                          {options.data?.certificates.map((c) => (
                            <SelectItem value={c.id} key={c.id}>
                              {c.name} · {c.domains} · 到期 {c.expiresAt.slice(0, 10)}
                            </SelectItem>
                          ))}
                          {!options.data?.certificates.length && (
                            <p className="px-2.5 py-2 text-sm text-muted-foreground">暂无可用证书</p>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
                <p className="text-xs text-muted-foreground settings-span">
                  证书需覆盖 *.{domain || 'Folio 域名'}，并已在 Dokploy 中安装。续期和证书更新由原有流程负责。
                </p>
              </>
            )}
            {mode === 'resolver' && (
              <Field
                required
                label="已有 DNS 证书解析器"
                htmlFor="site-resolverName"
                error={form.formState.errors.resolverName?.message}
              >
                <Controller
                  control={form.control}
                  name="resolverName"
                  render={({ field, fieldState }) => (
                    <Select
                      name={field.name}
                      value={field.value}
                      onValueChange={(value) => {
                        if (value) field.onChange(value);
                      }}
                      disabled={!!frozen || save.isPending || action.isPending || options.isLoading}
                    >
                      <SelectTrigger
                        id="site-resolverName"
                        ref={field.ref}
                        onBlur={field.onBlur}
                        aria-required="true"
                        aria-invalid={!!fieldState.error}
                        aria-describedby={fieldState.error ? 'site-resolverName-description' : undefined}
                      >
                        <SelectValue placeholder={options.isLoading ? '正在读取…' : '请选择 DNS 解析器'} />
                      </SelectTrigger>
                      <SelectContent className="settings-select-menu">
                        {options.data?.resolvers.map((name) => (
                          <SelectItem value={name} key={name}>
                            {name}
                          </SelectItem>
                        ))}
                        {!options.data?.resolvers.length && (
                          <p className="px-2.5 py-2 text-sm text-muted-foreground">暂无可用 DNS 解析器</p>
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            )}
            {options.error && ['certificate', 'resolver'].includes(mode) && (
              <p role="alert" className="text-sm text-destructive settings-span">
                {options.error.message}
              </p>
            )}
          </SettingsGroup>
        </fieldset>
        <SettingsActions
          pending={save.isPending}
          dirty={isDirty}
          saved={save.isSuccess}
          disabled={!!frozen || action.isPending}
          error={save.error?.message ?? form.formState.errors.root?.message}
        />
      </form>
      <div className="settings-info">
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
          disabled={!r?.configured || r.enabled || working || isDirty || save.isPending || action.isPending}
          loading={action.isPending && action.variables === 'enable'}
          onClick={() => action.mutate('enable')}
        >
          检查并启用
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={
            !r?.configured || working || r.status === 'disabled' || action.isPending || save.isPending
          }
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
        <ol aria-label="Folio 启用检查" className="space-y-3">
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
      {action.error && (
        <p role="alert" className="settings-notice text-destructive">
          {action.error.message}
        </p>
      )}
    </SettingsSection>
  );
}
