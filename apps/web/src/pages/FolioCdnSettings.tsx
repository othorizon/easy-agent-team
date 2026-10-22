import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  updateSiteCdnSchema,
  type SiteCdnInfo,
  type UpdateSiteCdn,
  type SiteSettingsInfo,
} from '@eat/shared';
import { api } from '../api';
import type { z } from '../lib/zod';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Checkbox } from '../components/ui/checkbox';
import { Switch } from '../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Field, firstErrorMessage } from '../components/form';
import {
  SettingsActions,
  SettingsGroup,
  SettingsLoadError,
  SettingsLoading,
  SettingsSection,
} from '../components/settings';
import { Link } from 'react-router-dom';

const statusNames: Record<string, string> = {
  disabled: '未接入',
  checking: '正在检查',
  awaiting_dns: '等待 DNS',
  provisioning: '正在配置',
  verifying: '正在验证',
  enabled: '已接入',
  draining: '正在退出',
  failed: '需要恢复',
  conflict: '外部修改冲突',
};
export function FolioCdnSettings({ active = true }: { active?: boolean }) {
  const folioQuery = useQuery({
    queryKey: ['site-settings'],
    queryFn: () => api<SiteSettingsInfo>('GET', '/api/admin/site-settings'),
    enabled: active,
  });
  const folio = folioQuery.data;
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['site-cdn'],
    enabled: active,
    queryFn: () => api<SiteCdnInfo>('GET', '/api/admin/site-settings/cdn'),
    refetchInterval: 5000,
  });
  const form = useForm<z.input<typeof updateSiteCdnSchema>, unknown, UpdateSiteCdn>({
    resolver: zodResolver(updateSiteCdnSchema),
    defaultValues: {
      enabled: false,
      scope: 'global',
      credentialSource: 'independent',
      autoDns: false,
      verifyOriginCertificate: false,
      accessKeyId: '',
      accessKeySecret: '',
    },
  });
  const {
    register,
    watch,
    reset,
    formState: { isDirty },
  } = form;
  const r = query.data;
  useEffect(() => {
    if (r && !isDirty) reset({ ...r, accessKeyId: '', accessKeySecret: '' });
  }, [r, isDirty, reset]);
  const saved = (r: SiteCdnInfo) => {
    cache.setQueryData(['site-cdn'], r);
    reset({ ...r, accessKeyId: '', accessKeySecret: '' });
  };
  const save = useMutation({
    mutationFn: (body: UpdateSiteCdn) => api<SiteCdnInfo>('PUT', '/api/admin/site-settings/cdn', body),
    onSuccess: (r) => {
      saved(r);
      toast.success('CDN 配置已保存，后台将检查实际接入状态');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const retry = useMutation({
    mutationFn: () => api<SiteCdnInfo>('POST', '/api/admin/site-settings/cdn/retry'),
    onSuccess: saved,
    onError: (e: Error) => toast.error(e.message),
  });
  const source = watch('credentialSource');
  if (!r)
    return (
      <SettingsSection title="CDN 加速" description="为 Folio 接入阿里云 CDN，加速静态资源访问。">
        {query.isError ? (
          <SettingsLoadError error={query.error} retry={() => void query.refetch()} />
        ) : (
          <SettingsLoading />
        )}
      </SettingsSection>
    );
  return (
    <SettingsSection
      title="CDN 加速"
      description="为 Folio 接入阿里云 CDN，复用发布域名、部署入口与源站证书。保存配置后，系统会检查实际接入状态。"
      status={<Badge variant={r.connected ? 'default' : 'secondary'}>{statusNames[r.status]}</Badge>}
    >
      {!folio?.configured && (
        <p className="settings-info">
          请先在
          <Link to="?section=folio" className="underline underline-offset-4">
            基础发布
          </Link>
          中保存 Folio 配置，再接入 CDN。
        </p>
      )}
      {folioQuery.isError && (
        <SettingsLoadError error={folioQuery.error} retry={() => void folioQuery.refetch()} />
      )}
      <p className="settings-info">
        公开和密码访问的 Folio 静态资源缓存 30 天，HTML 保留入口验证。 改密码、改权限和删除会异步清理 CDN
        缓存。静态文件命中缓存时不检查密码，持有文件链接的人可能直接访问；浏览器已经缓存的文件无法撤回。
      </p>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
      <form
        onSubmit={form.handleSubmit(
          (v) => save.mutate(v),
          (errs) => form.setError('root', { message: firstErrorMessage(errs) }),
        )}
        className="settings-form"
      >
        <fieldset disabled={save.isPending || retry.isPending} className="min-w-0">
          <SettingsGroup
            title="接入配置"
            description="可使用独立 RAM 凭证，或明确选择复用具备 CDN 权限的 AliDNS 凭证。"
          >
            <label className="settings-toggle settings-span" htmlFor="site-cdn-enabled">
              <Controller
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    id="site-cdn-enabled"
                    name={field.name}
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    onBlur={field.onBlur}
                    disabled={save.isPending || retry.isPending}
                  />
                )}
              />
              启用 CDN（保存后检查接入）
            </label>
            <Field label="加速区域" htmlFor="site-scope">
              <Controller
                control={form.control}
                name="scope"
                render={({ field }) => (
                  <Select
                    name={field.name}
                    value={field.value}
                    onValueChange={(value) => {
                      if (value) field.onChange(value);
                    }}
                    disabled={save.isPending || retry.isPending}
                  >
                    <SelectTrigger
                      id="site-scope"
                      ref={field.ref}
                      onBlur={field.onBlur}
                      aria-label="CDN 加速区域"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="settings-select-menu">
                      <SelectItem value="domestic">中国内地</SelectItem>
                      <SelectItem value="global">全球</SelectItem>
                      <SelectItem value="overseas">全球但不含中国内地</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="凭证来源" htmlFor="site-credentialSource">
              <Controller
                control={form.control}
                name="credentialSource"
                render={({ field }) => (
                  <Select
                    name={field.name}
                    value={field.value}
                    onValueChange={(value) => {
                      if (value) field.onChange(value);
                    }}
                    disabled={save.isPending || retry.isPending}
                  >
                    <SelectTrigger
                      id="site-credentialSource"
                      ref={field.ref}
                      onBlur={field.onBlur}
                      aria-label="CDN 凭证来源"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="settings-select-menu">
                      <SelectItem value="independent">独立 RAM AccessKey</SelectItem>
                      <SelectItem value="alidns" disabled={folio?.tlsMode !== 'alidns'}>
                        显式复用 AliDNS 凭证（仍需 CDN 权限）
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            {source === 'independent' && (
              <>
                <Field label="CDN AccessKey ID" htmlFor="site-accessKeyId">
                  <Input
                    id="site-accessKeyId"
                    {...register('accessKeyId')}
                    autoComplete="off"
                    placeholder={r?.accessKeyIdMasked || 'RAM AccessKey ID'}
                  />
                </Field>
                <Field label="CDN AccessKey Secret" htmlFor="site-accessKeySecret">
                  <Input
                    id="site-accessKeySecret"
                    {...register('accessKeySecret')}
                    type="password"
                    autoComplete="new-password"
                    placeholder={r?.hasSecret ? '已保存，留空保留' : 'RAM AccessKey Secret'}
                  />
                </Field>
              </>
            )}
          </SettingsGroup>
          <SettingsGroup
            title="回源与 DNS"
            description="源站仍使用 HTTPS。DNS 管理会迁移当前直连记录，发现外部修改时暂停。"
          >
            <label className="settings-toggle settings-span" htmlFor="site-cdn-verifyOriginCertificate">
              <Controller
                control={form.control}
                name="verifyOriginCertificate"
                render={({ field }) => (
                  <Checkbox
                    id="site-cdn-verifyOriginCertificate"
                    name={field.name}
                    checked={field.value}
                    onCheckedChange={(value) => field.onChange(value === true)}
                    onBlur={field.onBlur}
                    aria-describedby="site-cdn-verifyOriginCertificate-description"
                    disabled={save.isPending || retry.isPending}
                  />
                )}
              />
              <span>
                校验回源证书
                <span
                  id="site-cdn-verifyOriginCertificate-description"
                  className="mt-1 block text-xs text-muted-foreground"
                >
                  关闭后仍使用 HTTPS 回源，但会放宽源站证书身份校验。
                </span>
              </span>
            </label>
            <label className="settings-toggle settings-span" htmlFor="site-cdn-autoDns">
              <Controller
                control={form.control}
                name="autoDns"
                render={({ field }) => (
                  <Checkbox
                    id="site-cdn-autoDns"
                    name={field.name}
                    checked={field.value}
                    onCheckedChange={(value) => field.onChange(value === true)}
                    onBlur={field.onBlur}
                    disabled={save.isPending || retry.isPending}
                  />
                )}
              />
              自动管理 Folio DNS（迁移当前直连记录；发现外部修改时暂停）
            </label>
            <p className="text-xs text-muted-foreground settings-span">
              首次需要实名认证、开通 CDN 和 RAM 授权；区域包含中国内地时需要 ICP 备案。证书签发免费，CDN
              流量与 HTTPS 请求按云服务规则计费。
            </p>
          </SettingsGroup>
        </fieldset>
        <SettingsActions
          pending={save.isPending}
          dirty={isDirty}
          saved={save.isSuccess}
          disabled={!folio?.configured || retry.isPending}
          error={save.error?.message ?? form.formState.errors.root?.message}
        >
          <Button
            type="button"
            variant="outline"
            disabled={!r.updatedAt || isDirty || save.isPending}
            loading={retry.isPending}
            onClick={() => retry.mutate()}
          >
            重新检查 / 恢复
          </Button>
        </SettingsActions>
        {retry.error && (
          <p role="alert" className="settings-notice text-destructive">
            {retry.error.message}
          </p>
        )}
      </form>
      {r && (
        <div aria-live="polite" className="settings-status">
          <p>
            配置意愿：{r.enabled ? '开启' : '关闭'} · 实际接入：
            {r.connected ? '已验证接入' : '未确认接入'}
          </p>
          <p>
            HTTPS 回源 · 回源证书校验：
            {r.verifyOriginCertificate ? '开启' : '关闭'}
          </p>
          {r.phase && <p className="break-words">{r.phase}</p>}
          {r.cname && <p className="break-all">CDN CNAME：{r.cname}</p>}
          <p>
            源站证书到期：
            {r.certificateExpiresAt ? new Date(r.certificateExpiresAt).toLocaleString() : '尚未读取'}
          </p>
          <p>
            CDN 证书同步：
            {r.certificateSyncedAt
              ? new Date(r.certificateSyncedAt).toLocaleString()
              : r.certificateUploaded
                ? '已上传，等待边缘验证'
                : '尚未上传'}
          </p>
          <p>
            缓存维护：
            {r.cacheRefresh.pending ? `刷新未完成（${r.cacheRefresh.pending} 个目录）` : '无待处理任务'}
          </p>
          {r.cacheRefresh.lastCompletedAt && (
            <p>
              最近刷新完成：
              {new Date(r.cacheRefresh.lastCompletedAt).toLocaleString()}
            </p>
          )}
          {r.cacheRefresh.lastError && (
            <p role="alert" className="break-words text-destructive">
              {r.cacheRefresh.lastError}
            </p>
          )}
          {r.cacheRefresh.retryAt && (
            <p className="text-xs text-muted-foreground">
              下次刷新检查：{new Date(r.cacheRefresh.retryAt).toLocaleString()}
              ；可点击“重新检查 / 恢复”重试。
            </p>
          )}
          {r.certificateSyncError && (
            <p role="alert" className="break-words text-destructive">
              {r.certificateSyncError}
            </p>
          )}
          {r.lastError && (
            <p role="alert" className="break-words text-destructive">
              {r.lastError}
            </p>
          )}
          {r.retryAt && (
            <p className="text-xs text-muted-foreground">下次检查：{new Date(r.retryAt).toLocaleString()}</p>
          )}
          {r.drainUntil && (
            <p>
              DNS 传播等待至：{new Date(r.drainUntil).toLocaleString()}
              ；期间保留 CDN 与证书。
            </p>
          )}
          {r.dnsInstructions.length > 0 && (
            <div className="space-y-2">
              <p>
                {r.autoDns
                  ? '系统将自动处理以下 DNS 记录，等待解析生效后继续；无需手动重复添加。'
                  : '请在 DNS 服务商完成以下记录后点击“重新检查 / 恢复”：'}
              </p>
              {r.dnsInstructions.map((d) => (
                <p key={d.name + d.type} className="break-all rounded bg-muted p-2 font-mono text-xs">
                  {d.name} · {d.type} · {d.value}
                </p>
              ))}
              <p className="text-xs text-muted-foreground">
                CNAME 与 A/AAAA 不能共存，Cloudflare 请关闭代理。精确域名记录优先于通配记录，请一并核对。
              </p>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
