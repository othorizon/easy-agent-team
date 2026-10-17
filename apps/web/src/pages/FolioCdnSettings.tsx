import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  updateSiteCdnSchema,
  type SiteCdnInfo,
  type UpdateSiteCdn,
  type SiteSettingsInfo,
} from '@eat/shared';
import { api } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';

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
export function FolioCdnSettings({ folio }: { folio?: SiteSettingsInfo }) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['site-cdn'],
    queryFn: () => api<SiteCdnInfo>('GET', '/api/admin/site-settings/cdn'),
    refetchInterval: 5000,
  });
  const form = useForm<UpdateSiteCdn>({
    defaultValues: {
      enabled: false,
      scope: 'overseas',
      credentialSource: 'independent',
      autoDns: false,
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
  return (
    <section aria-label="阿里云 CDN" className="min-w-0 space-y-4 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">阿里云 CDN</h3>
        <Badge variant={r?.connected ? 'default' : 'secondary'}>{statusNames[r?.status ?? 'disabled']}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        复用 Folio
        域名、部署入口与源站证书。仅公开静态资源进入共享缓存，每次命中前重新检查访问权限；普通成员发布无需增加操作。
      </p>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
      <form
        onSubmit={form.handleSubmit((v) => {
          const p = updateSiteCdnSchema.safeParse(v);
          if (p.success) save.mutate(p.data);
          else toast.error(p.error.issues[0].message);
        })}
        className="space-y-4"
      >
        <fieldset disabled={save.isPending || retry.isPending} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" {...register('enabled')} />
            启用 CDN（保存后检查接入）
          </label>
          <label className="space-y-1 text-sm">
            加速区域
            <select
              aria-label="CDN 加速区域"
              {...register('scope')}
              className="h-9 w-full rounded-md border bg-background px-2"
            >
              <option value="domestic">中国内地</option>
              <option value="global">全球</option>
              <option value="overseas">全球但不含中国内地</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            凭证来源
            <select
              aria-label="CDN 凭证来源"
              {...register('credentialSource')}
              className="h-9 w-full rounded-md border bg-background px-2"
            >
              <option value="independent">独立 RAM AccessKey</option>
              <option value="alidns" disabled={folio?.tlsMode !== 'alidns'}>
                显式复用 AliDNS 凭证（仍需 CDN 权限）
              </option>
            </select>
          </label>
          {source === 'independent' && (
            <>
              <label className="space-y-1 text-sm">
                CDN AccessKey ID
                <Input
                  {...register('accessKeyId')}
                  autoComplete="off"
                  placeholder={r?.accessKeyIdMasked || 'RAM AccessKey ID'}
                />
              </label>
              <label className="space-y-1 text-sm">
                CDN AccessKey Secret
                <Input
                  {...register('accessKeySecret')}
                  type="password"
                  autoComplete="new-password"
                  placeholder={r?.hasSecret ? '已保存，留空保留' : 'RAM AccessKey Secret'}
                />
              </label>
            </>
          )}
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-1" {...register('autoDns')} />
            自动管理 Folio DNS（迁移当前直连记录；发现外部修改时暂停）
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            首次需要实名认证、开通 CDN 和 RAM 授权；区域包含中国内地时需要 ICP 备案。证书签发免费，CDN 流量与
            HTTPS 请求按云服务规则计费。
          </p>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              type="submit"
              variant="outline"
              disabled={!isDirty || !folio?.configured}
              loading={save.isPending}
            >
              保存 CDN 配置
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!r?.updatedAt || isDirty}
              loading={retry.isPending}
              onClick={() => retry.mutate()}
            >
              重新检查 / 恢复
            </Button>
          </div>
        </fieldset>
      </form>
      {r && (
        <div aria-live="polite" className="min-w-0 space-y-2 rounded-md border p-3 text-sm">
          <p>
            配置意愿：{r.enabled ? '开启' : '关闭'} · 实际接入：{r.connected ? '已验证接入' : '未确认接入'}
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
            <p>DNS 传播等待至：{new Date(r.drainUntil).toLocaleString()}；期间保留 CDN 与证书。</p>
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
    </section>
  );
}
