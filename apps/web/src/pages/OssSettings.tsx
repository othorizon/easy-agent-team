import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OssSettingsInfo, UpdateOssSettings } from '@eat/shared';
import { api } from '../api';
import {
  SettingsSection,
  SettingsGroup,
  SettingsActions,
  SettingsLoading,
  SettingsLoadError,
} from '../components/settings';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Confirm } from '../components/confirm';

export function OssSettingsCard({ active }: { active: boolean }) {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['oss-settings'],
    queryFn: () => api<OssSettingsInfo>('GET', '/api/admin/oss-settings'),
    enabled: active,
    refetchInterval: (q) =>
      active &&
      (q.state.data?.status === 'checking' ||
        q.state.data?.checks.some(
          (c) => c.name === '清理本次测试资源' && c.status === 'failed',
        ))
        ? 2000
        : false,
  });
  const [form, setForm] = useState<UpdateOssSettings>();
  const [dirty, setDirty] = useState(false);
  const [bound, setBound] = useState<{ domain: string; status: string }[]>();
  useEffect(() => {
    if (query.data && !dirty)
      setForm({
        bucket: query.data.bucket,
        region: query.data.region,
        accessKeyId: '',
        accessKeySecret: '',
        customDomainsEnabled: query.data.customDomainsEnabled,
        domains: query.data.domains,
      });
  }, [query.data, dirty]);
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['oss-settings'] });
    void cache.invalidateQueries({ queryKey: ['oss'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api<OssSettingsInfo>('PUT', '/api/admin/oss-settings', form),
    onSuccess: (data) => {
      setDirty(false);
      cache.setQueryData(['oss-settings'], data);
      refresh();
    },
  });
  const action = useMutation({
    mutationFn: (kind: string) =>
      api<OssSettingsInfo>('POST', `/api/admin/oss-settings/${kind}`),
    onSuccess: refresh,
  });
  const domains = useMutation({
    mutationFn: () =>
      api<{ domain: string; status: string }[]>(
        'GET',
        '/api/admin/oss-settings/domains',
      ),
    onSuccess: setBound,
  });
  const patch = (v: Partial<UpdateOssSettings>) => {
    setForm((f) => ({ ...f!, ...v }));
    setDirty(true);
    save.reset();
  };
  const data = query.data;
  const busy =
    data?.status === 'checking' || save.isPending || action.isPending;
  const listed = [
    ...new Set([
      ...(bound ?? []).map((d) => d.domain),
      ...(form?.domains ?? []).map((d) => d.domain),
    ]),
  ];
  return (
    <SettingsSection
      title="OSS 存储"
      description="为团队成员分配独立目录。申请经管理员批准后开通，每位成员共用一组访问凭证。"
      status={
        <Badge>
          {
            {
              enabled: '已启用',
              disabled: '未启用',
              checking: '检查中',
              failed: '检查失败',
            }[data?.status ?? 'disabled']
          }
        </Badge>
      }
    >
      {query.isError ? (
        <SettingsLoadError
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : !data || !form ? (
        <SettingsLoading />
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <SettingsGroup
              title="阿里云接入"
              description={
                data.locationLocked
                  ? '已创建云资源，Bucket 和地域已锁定。管理凭证需停用后更换，留空保留原值。'
                  : '先保存配置，再执行权限检查并启用。AK/SK 加密保存。'
              }
            >
              <label className="block space-y-2">
                Bucket
                <Input
                  aria-label="Bucket"
                  required
                  value={form.bucket}
                  disabled={
                    busy || data.locationLocked || data.status === 'enabled'
                  }
                  onChange={(e) => patch({ bucket: e.target.value })}
                  placeholder="team-storage"
                />
              </label>
              <label className="block space-y-2">
                地域
                <Input
                  aria-label="地域"
                  required
                  value={form.region}
                  disabled={
                    busy || data.locationLocked || data.status === 'enabled'
                  }
                  onChange={(e) => patch({ region: e.target.value })}
                  placeholder="cn-beijing"
                />
              </label>
              <label className="block space-y-2">
                AccessKey ID
                <Input
                  aria-label="AccessKey ID"
                  autoComplete="off"
                  value={form.accessKeyId}
                  disabled={busy || data.status === 'enabled'}
                  placeholder={
                    data.accessKeyIdMasked || '填写管理 AccessKey ID'
                  }
                  onChange={(e) => patch({ accessKeyId: e.target.value })}
                />
              </label>
              <label className="block space-y-2">
                AccessKey Secret
                <Input
                  aria-label="AccessKey Secret"
                  type="password"
                  autoComplete="new-password"
                  value={form.accessKeySecret}
                  disabled={busy || data.status === 'enabled'}
                  placeholder={
                    data.hasSecret
                      ? '已保存，留空保留'
                      : '填写管理 AccessKey Secret'
                  }
                  onChange={(e) => patch({ accessKeySecret: e.target.value })}
                />
              </label>
            </SettingsGroup>
            <SettingsGroup
              title="可用域名"
              description="官方 OSS 域名始终展示。可选择多个已绑定域名；CDN 状态由管理员标记，回源与访问规则在阿里云控制台配置。"
            >
              <label className="flex items-center justify-between gap-4">
                展示自定义域名
                <Switch
                  checked={form.customDomainsEnabled}
                  disabled={busy}
                  onCheckedChange={(v) => patch({ customDomainsEnabled: v })}
                  aria-label="展示自定义域名"
                />
              </label>
              <Button
                type="button"
                variant="outline"
                loading={domains.isPending}
                disabled={!data.configured || dirty || busy}
                onClick={() => domains.mutate()}
              >
                读取已绑定域名
              </Button>
              {dirty && (
                <p className="text-sm text-muted-foreground">
                  保存接入配置后可刷新域名列表。
                </p>
              )}
              {domains.error && (
                <p role="alert" className="text-sm text-destructive">
                  {domains.error.message}
                </p>
              )}
              {bound && !listed.length && (
                <p className="text-sm text-muted-foreground">
                  此 Bucket 没有可选的已绑定域名。
                </p>
              )}
              {listed.map((domain) => {
                const selected = form.domains.find((d) => d.domain === domain);
                const unavailable =
                  !!bound &&
                  !bound.some(
                    (d) => d.domain === domain && d.status === 'Enabled',
                  );
                return (
                  <div
                    key={domain}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <label className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!selected}
                        disabled={busy || (!selected && unavailable)}
                        onChange={(e) =>
                          patch({
                            domains: e.target.checked
                              ? [...form.domains, { domain, cdn: false }]
                              : form.domains.filter((d) => d.domain !== domain),
                          })
                        }
                      />
                      <span className="break-all text-sm">
                        {domain}
                        {unavailable && '（未启用或已解绑）'}
                      </span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      已启用 CDN
                      <Switch
                        aria-label={`${domain} 已启用 CDN`}
                        checked={selected?.cdn ?? false}
                        disabled={!selected || busy}
                        onCheckedChange={(cdn) =>
                          patch({
                            domains: form.domains.map((d) =>
                              d.domain === domain ? { ...d, cdn } : d,
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                );
              })}
            </SettingsGroup>
            <SettingsActions
              pending={save.isPending}
              dirty={dirty}
              saved={save.isSuccess}
              error={save.error?.message}
              disabled={busy}
            />
          </form>
          <SettingsGroup
            title="启用与权限检查"
            description="检查会创建并清理专用测试对象、RAM 用户与策略，验证目录隔离、公开读和密钥管理。不会修改已有对象、Bucket ACL 或 CDN。"
          >
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                loading={data.status === 'checking' || action.isPending}
                disabled={
                  busy || dirty || !data.configured || data.status === 'enabled'
                }
                onClick={() => action.mutate('enable')}
              >
                {data.status === 'failed' ? '重新检查并启用' : '检查并启用'}
              </Button>
              {data.status === 'enabled' && (
                <Confirm
                  title="停用 OSS 功能？"
                  description="将停止新申请、审批、公开读修改和凭证读取。已发出的 AK/SK 与云端文件仍然保留；回收和用户停用同步继续执行。"
                  onConfirm={() => action.mutate('disable')}
                >
                  <Button type="button" variant="outline" disabled={busy}>
                    停用功能
                  </Button>
                </Confirm>
              )}
            </div>
            {(action.error || data.lastError) && (
              <p role="alert" className="break-words text-sm text-destructive">
                {action.error?.message ?? data.lastError}
              </p>
            )}
            <ul aria-live="polite" className="space-y-2 text-sm">
              {data.checks.map((c) => (
                <li key={c.name} className="flex justify-between gap-4">
                  <span>{c.name}</span>
                  <span
                    className={
                      c.status === 'failed'
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {
                      { running: '进行中', passed: '通过', failed: '失败' }[
                        c.status
                      ]
                    }
                  </span>
                </li>
              ))}
            </ul>
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  );
}
