import type {
  AiSettingsInfo,
  ConnectionTestResult,
  DokployProject,
  DokploySettingsInfo,
  DokploySshKey,
  TestAiSettingsRequest,
  TestDokploySettingsRequest,
  UpdateAiSettingsRequest,
  UpdateDokploySettingsRequest,
} from '@eat/shared';
import { DOMAIN_SUFFIX_REGEX, normalizeDomainSuffix } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, Cloud, Globe2, LockKeyhole, Network, Server } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, getStoredUser } from '../api';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import {
  SettingsActions,
  SettingsGroup,
  SettingsLoadError,
  SettingsLoading,
  SettingsSection,
  SettingsTestResult,
} from '../components/settings';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { FolioSettingsCard } from './FolioSettings';
import { FolioCdnSettings } from './FolioCdnSettings';
import { LlmGatewaySettingsCard } from './LlmGatewaySettings';
import './settings.css';

const NONE = '__none__';
const categories = [
  {
    group: 'AI 与模型',
    items: [
      { id: 'platform-ai', label: '平台 AI', icon: BrainCircuit },
      { id: 'llm-gateway', label: 'LLM API 网关', icon: Network },
    ],
  },
  {
    group: '应用托管',
    items: [{ id: 'deployment', label: '部署接入', icon: Server }],
  },
  {
    group: 'Folio 发布',
    items: [
      { id: 'folio', label: '基础发布', icon: Globe2 },
      { id: 'folio-cdn', label: 'CDN 加速', icon: Cloud },
    ],
  },
];
const ids = categories.flatMap((g) => g.items.map((item) => item.id));

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const selected = params.get('section');
  const active =
    selected && ids.includes(selected) ? selected : hash === '#static-sites' ? 'folio' : 'platform-ai';
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    setVisited((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [active]);
  const mounted = [...new Set([...visited, active])];
  const select = (id: string) => {
    if (id === active) return;
    const next = new URLSearchParams(params);
    next.set('section', id);
    setParams(next);
    window.scrollTo(0, 0);
  };
  if (getStoredUser()?.role !== 'admin')
    return (
      <div className="space-y-4">
        <PageHeader title="系统设置" description="只有管理员可以查看和修改系统设置。" />
        <Button asChild variant="outline">
          <Link to="/">返回控制台</Link>
        </Button>
      </div>
    );
  return (
    <div className="settings-surface">
      <PageHeader title="系统设置" description="管理平台服务与发布能力，按需配置，独立保存。" />
      <div className="settings-layout">
        <aside className="settings-desktop-nav">
          <nav aria-label="设置分类">
            {categories.map((group) => (
              <div key={group.group} className="settings-nav-group">
                <p>{group.group}</p>
                {group.items.map(({ id, label, icon: Icon }) => (
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
            ))}
          </nav>
          <p className="settings-nav-note">
            <LockKeyhole className="mb-2 size-4" aria-hidden="true" />
            仅管理员可管理
            <br />
            密钥加密存储，留空保留原值。
          </p>
        </aside>
        <div className="settings-mobile-nav">
          <label htmlFor="settings-category">设置分类</label>
          <select id="settings-category" value={active} onChange={(e) => select(e.target.value)}>
            {categories.map((group) => (
              <optgroup key={group.group} label={group.group}>
                {group.items.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="settings-workspace">
          {mounted.map((id) => (
            <div key={id} hidden={active !== id} data-settings-panel={id}>
              {id === 'platform-ai' && <AiSettingsCard active={active === id} />}
              {id === 'llm-gateway' && <LlmGatewaySettingsCard active={active === id} />}
              {id === 'deployment' && <DokploySettingsCard active={active === id} />}
              {id === 'folio' && <FolioSettingsCard active={active === id} />}
              {id === 'folio-cdn' && <FolioCdnSettings active={active === id} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AiSettingsCard({ active }: { active: boolean }) {
  const settings = useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api<AiSettingsInfo>('GET', '/api/admin/ai-settings'),
    enabled: active,
  });
  return (
    <SettingsSection
      title="平台 AI"
      description="将求助问答自动整理成团队经验。整理时会将问答内容发送至所配置的模型服务。"
    >
      {settings.data ? (
        <AiForm settings={settings.data} />
      ) : settings.isError ? (
        <SettingsLoadError error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        <SettingsLoading />
      )}
    </SettingsSection>
  );
}
function AiForm({ settings }: { settings: AiSettingsInfo }) {
  const cache = useQueryClient();
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const testVersion = useRef(0);
  const {
    register,
    handleSubmit,
    control,
    trigger,
    getValues,
    reset,
    formState: { errors, isDirty },
  } = useForm<UpdateAiSettingsRequest>({
    defaultValues: {
      apiBaseUrl: settings.apiBaseUrl,
      apiKey: '',
      model: settings.model,
      enabled: settings.enabled,
    },
  });
  const save = useMutation({
    mutationFn: (v: UpdateAiSettingsRequest) => api<AiSettingsInfo>('PUT', '/api/admin/ai-settings', v),
    onSuccess: (data) => {
      cache.setQueryData(['ai-settings'], data);
      reset({
        apiBaseUrl: data.apiBaseUrl,
        apiKey: '',
        model: data.model,
        enabled: data.enabled,
      });
      toast.success('平台 AI 设置已保存');
    },
  });
  const test = useMutation({
    mutationFn: (v: TestAiSettingsRequest) =>
      api<ConnectionTestResult>('POST', '/api/admin/ai-settings/test', v),
  });
  async function runTest() {
    if (!(await trigger(['apiBaseUrl', 'apiKey', 'model']))) return;
    const version = ++testVersion.current;
    const { apiBaseUrl, apiKey, model } = getValues();
    try {
      const result = await test.mutateAsync({
        apiBaseUrl,
        apiKey: apiKey ?? '',
        model,
      });
      if (version === testVersion.current) setTestResult(result);
    } catch (e) {
      if (version === testVersion.current)
        setTestResult({
          ok: false,
          message: (e as Error).message,
          latencyMs: 0,
        });
    }
  }
  return (
    <form className="settings-form" onSubmit={handleSubmit((v) => save.mutate(v))}>
      <fieldset
        disabled={save.isPending}
        onChange={() => {
          testVersion.current++;
          setTestResult(null);
        }}
      >
        <SettingsGroup
          title="模型连接"
          description="支持 OpenAI Chat Completions 兼容接口。与成员自行调用的 LLM API 网关分别配置。"
        >
          <Field
            className="settings-span"
            label="API Base URL"
            htmlFor="ai-url"
            required
            error={errors.apiBaseUrl?.message}
            hint="填写兼容服务的 API 根地址，通常以 /v1 结尾。"
          >
            <Input
              id="ai-url"
              placeholder="https://api.example.com/v1"
              aria-invalid={!!errors.apiBaseUrl}
              {...register('apiBaseUrl', {
                required: '请输入 API Base URL',
                pattern: rules.url,
              })}
            />
          </Field>
          <Field
            label="API Key"
            htmlFor="ai-key"
            required={!settings.configured}
            error={errors.apiKey?.message}
            hint={
              settings.configured
                ? `已保存 ${settings.apiKeyMasked}，留空保留`
                : '由模型服务提供，用于平台自动整理。'
            }
          >
            <Input
              id="ai-key"
              type="password"
              autoComplete="new-password"
              placeholder={settings.configured ? '留空保留现有 Key' : '输入 API Key'}
              aria-invalid={!!errors.apiKey}
              {...register('apiKey', settings.configured ? {} : { required: '请输入 API Key' })}
            />
          </Field>
          <Field
            label="模型名称"
            htmlFor="ai-model"
            required
            error={errors.model?.message}
            hint="填写该服务提供的模型 ID。"
          >
            <Input
              id="ai-model"
              placeholder="模型名称"
              aria-invalid={!!errors.model}
              {...register('model', { required: '请输入模型名称' })}
            />
          </Field>
          <label className="settings-toggle settings-span" htmlFor="ai-enabled">
            <Controller
              control={control}
              name="enabled"
              render={({ field }) => (
                <Switch id="ai-enabled" checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
            <span>
              启用平台 AI<small>允许平台使用此模型整理团队经验。</small>
            </span>
          </label>
        </SettingsGroup>
      </fieldset>
      <SettingsActions
        pending={save.isPending}
        dirty={isDirty}
        saved={save.isSuccess}
        error={save.error?.message}
      >
        <Button
          type="button"
          variant="outline"
          loading={test.isPending}
          disabled={save.isPending}
          onClick={() => void runTest()}
        >
          测试连接
        </Button>
      </SettingsActions>
      <SettingsTestResult result={testResult} />
    </form>
  );
}

function DokploySettingsCard({ active }: { active: boolean }) {
  const settings = useQuery({
    queryKey: ['dokploy-settings'],
    queryFn: () => api<DokploySettingsInfo>('GET', '/api/admin/dokploy-settings'),
    enabled: active,
  });
  return (
    <SettingsSection
      title="部署接入"
      description="连接 Dokploy，供成员创建应用、触发部署并查看日志。私有仓库使用所选 SSH Key 拉取。"
    >
      {settings.data ? (
        <DokployForm active={active} settings={settings.data} />
      ) : settings.isError ? (
        <SettingsLoadError error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        <SettingsLoading />
      )}
    </SettingsSection>
  );
}

function DokployForm({ settings, active }: { settings: DokploySettingsInfo; active: boolean }) {
  const cache = useQueryClient();
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const testVersion = useRef(0);
  const {
    register,
    handleSubmit,
    control,
    trigger,
    getValues,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty },
  } = useForm<UpdateDokploySettingsRequest>({
    defaultValues: {
      apiUrl: settings.apiUrl,
      apiToken: '',
      enabled: settings.enabled,
      projectId: settings.projectId,
      environmentId: settings.environmentId,
      sshKeyId: settings.sshKeyId,
      domainSuffix: settings.domainSuffix,
      domainHttps: settings.domainHttps,
    },
  });
  // 项目 / 环境 / SSH key 清单从 Dokploy 现拉：要先保存并启用地址与 token 才拉得到，拉不到时退回手填 id
  const projects = useQuery({
    queryKey: ['dokploy-projects'],
    queryFn: () => api<DokployProject[]>('GET', '/api/admin/dokploy/projects'),
    enabled: active && settings.configured && settings.enabled,
    retry: false,
  });
  const sshKeys = useQuery({
    queryKey: ['dokploy-ssh-keys'],
    queryFn: () => api<DokploySshKey[]>('GET', '/api/admin/dokploy/ssh-keys'),
    enabled: active && settings.configured && settings.enabled,
    retry: false,
  });
  const projectId = watch('projectId');
  const domainSuffix = normalizeDomainSuffix(watch('domainSuffix') ?? '');
  const domainHttps = watch('domainHttps');
  const environments = (projects.data ?? []).find((p) => p.projectId === projectId)?.environments ?? [];
  const listsUnavailable = !settings.configured || !settings.enabled;
  const listError = projects.error?.message ?? sshKeys.error?.message ?? null;

  const save = useMutation({
    mutationFn: (v: UpdateDokploySettingsRequest) =>
      api<DokploySettingsInfo>('PUT', '/api/admin/dokploy-settings', v),
    onSuccess: (data) => {
      cache.setQueryData(['dokploy-settings'], data);
      void cache.invalidateQueries({ queryKey: ['dokploy-projects'] });
      void cache.invalidateQueries({ queryKey: ['dokploy-ssh-keys'] });
      reset({
        apiUrl: data.apiUrl,
        apiToken: '',
        enabled: data.enabled,
        projectId: data.projectId,
        environmentId: data.environmentId,
        sshKeyId: data.sshKeyId,
        domainSuffix: data.domainSuffix,
        domainHttps: data.domainHttps,
      });
      toast.success('部署设置已保存');
    },
  });
  const test = useMutation({
    mutationFn: (v: TestDokploySettingsRequest) =>
      api<ConnectionTestResult>('POST', '/api/admin/dokploy-settings/test', v),
  });
  async function runTest() {
    if (!(await trigger(['apiUrl', 'apiToken']))) return;
    const version = ++testVersion.current;
    const { apiUrl, apiToken } = getValues();
    try {
      const result = await test.mutateAsync({
        apiUrl,
        apiToken: apiToken ?? '',
      });
      if (version === testVersion.current) setTestResult(result);
    } catch (e) {
      if (version === testVersion.current)
        setTestResult({
          ok: false,
          message: (e as Error).message,
          latencyMs: 0,
        });
    }
  }
  return (
    <form className="settings-form" onSubmit={handleSubmit((v) => save.mutate(v))}>
      <fieldset
        disabled={save.isPending}
        onChange={() => {
          testVersion.current++;
          setTestResult(null);
        }}
      >
        <SettingsGroup title="连接配置" description="先保存并启用连接，再选择创建应用的项目与环境。">
          <Field
            className="settings-span"
            label="API 地址"
            htmlFor="dokploy-url"
            required
            error={errors.apiUrl?.message}
            hint="如 https://dokploy.example.com/api"
          >
            <Input
              id="dokploy-url"
              placeholder="https://dokploy.example.com/api"
              className="font-mono"
              aria-invalid={!!errors.apiUrl}
              {...register('apiUrl', {
                required: '请输入 API 地址',
                pattern: rules.url,
              })}
            />
          </Field>
          <Field
            label="API Token"
            htmlFor="dokploy-token"
            required={!settings.configured}
            error={errors.apiToken?.message}
            hint={
              settings.configured ? `当前 ${settings.apiTokenMasked}，留空保持不变` : 'Dokploy 控制台生成'
            }
          >
            <Input
              id="dokploy-token"
              type="password"
              autoComplete="new-password"
              placeholder={settings.configured ? '留空保持现有 Token' : 'Dokploy 控制台生成'}
              aria-invalid={!!errors.apiToken}
              {...register('apiToken', settings.configured ? {} : { required: '请输入 API Token' })}
            />
          </Field>
          <label className="settings-toggle settings-span" htmlFor="dokploy-enabled">
            <Controller
              control={control}
              name="enabled"
              render={({ field }) => (
                <Switch
                  id="dokploy-enabled"
                  aria-label="启用部署接入"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <span>
              启用部署接入<small>允许成员通过平台创建和部署应用。</small>
            </span>
          </label>
        </SettingsGroup>
        <SettingsGroup
          title="应用创建位置"
          description="新应用将创建在所选项目与环境中。SSH Key 可留空，此时只支持公开仓库。"
        >
          <Field
            label="Dokploy 项目"
            htmlFor="dokploy-project"
            hint={settings.projectId && !projects.data ? `当前 ${settings.projectId}` : undefined}
          >
            {projects.data ? (
              <Select
                value={projectId || undefined}
                onValueChange={(v) => {
                  if (!v) return;
                  setValue('projectId', v, { shouldDirty: true });
                  // 换项目后原来的环境多半不属于新项目：能自动选默认环境就选，否则清空让人重选
                  const envs = (projects.data ?? []).find((p) => p.projectId === v)?.environments ?? [];
                  setValue('environmentId', (envs.find((e) => e.isDefault) ?? envs[0])?.environmentId ?? '', {
                    shouldDirty: true,
                  });
                }}
              >
                <SelectTrigger id="dokploy-project">
                  <SelectValue placeholder="选择项目…" />
                </SelectTrigger>
                <SelectContent>
                  {projects.data.map((p) => (
                    <SelectItem key={p.projectId} value={p.projectId}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="dokploy-project"
                className="font-mono"
                placeholder="projectId"
                {...register('projectId')}
              />
            )}
          </Field>
          <Field
            label="环境"
            htmlFor="dokploy-env"
            hint={
              projects.data && projectId && environments.length === 0
                ? '该项目没有环境（Dokploy 版本过旧？），无法自助建应用'
                : undefined
            }
          >
            {projects.data ? (
              <Controller
                control={control}
                name="environmentId"
                render={({ field }) => (
                  <Select
                    value={field.value || undefined}
                    onValueChange={(v) => {
                      if (v) field.onChange(v);
                    }}
                    disabled={environments.length === 0}
                  >
                    <SelectTrigger id="dokploy-env">
                      <SelectValue placeholder="选择环境…" />
                    </SelectTrigger>
                    <SelectContent>
                      {environments.map((e) => (
                        <SelectItem key={e.environmentId} value={e.environmentId}>
                          {e.name}
                          {e.isDefault ? '（默认）' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            ) : (
              <Input
                id="dokploy-env"
                className="font-mono"
                placeholder="environmentId"
                {...register('environmentId')}
              />
            )}
          </Field>
          <Field label="SSH key" htmlFor="dokploy-ssh" hint="可留空">
            {sshKeys.data ? (
              <Controller
                control={control}
                name="sshKeyId"
                render={({ field }) => (
                  <Select
                    value={field.value || NONE}
                    onValueChange={(v) => {
                      if (v) field.onChange(v === NONE ? '' : v);
                    }}
                  >
                    <SelectTrigger id="dokploy-ssh">
                      <SelectValue placeholder="不绑定" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>不绑定（仅公开仓库）</SelectItem>
                      {sshKeys.data.map((k) => (
                        <SelectItem key={k.sshKeyId} value={k.sshKeyId}>
                          {k.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            ) : (
              <Input
                id="dokploy-ssh"
                className="font-mono"
                placeholder="sshKeyId（可空）"
                {...register('sshKeyId')}
              />
            )}
          </Field>

          {listsUnavailable && (
            <p className="settings-info settings-span">保存并启用连接后可读取选项，也可直接填写 ID。</p>
          )}
          {listError && (
            <p role="alert" className="settings-info settings-span text-destructive">
              清单读取失败：{listError}。可以手动填写 ID。
            </p>
          )}
        </SettingsGroup>
        <SettingsGroup
          title="自动分配域名"
          description="仅影响之后新建的应用。请先将通配 DNS 记录指向 Dokploy 入口；留空后缀则不自动分配。"
        >
          <Field
            label="域名后缀"
            htmlFor="dokploy-domain-suffix"
            error={errors.domainSuffix?.message}
            hint={
              domainSuffix
                ? `示例：${domainHttps ? 'https' : 'http'}://crm-tool.${domainSuffix}`
                : '如 apps.example.com；可留空'
            }
          >
            <Input
              id="dokploy-domain-suffix"
              className="font-mono"
              placeholder="apps.example.com"
              aria-invalid={!!errors.domainSuffix}
              {...register('domainSuffix', {
                validate: (v) =>
                  !v ||
                  DOMAIN_SUFFIX_REGEX.test(normalizeDomainSuffix(v)) ||
                  '需为合法主机名，如 apps.example.com（不含协议与路径）',
              })}
            />
          </Field>
          <label className="settings-toggle settings-span" htmlFor="dokploy-domain-https">
            <Controller
              control={control}
              name="domainHttps"
              render={({ field }) => (
                <Switch id="dokploy-domain-https" checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
            <span>
              启用 HTTPS
              <small>Let's Encrypt 签发，需在 Dokploy 的 Web Server 设置里配好证书邮箱。</small>
            </span>
          </label>
        </SettingsGroup>
      </fieldset>
      <SettingsActions
        pending={save.isPending}
        dirty={isDirty}
        saved={save.isSuccess}
        error={save.error?.message}
      >
        <Button
          type="button"
          variant="outline"
          onClick={() => void runTest()}
          loading={test.isPending}
          disabled={save.isPending}
        >
          测试连接
        </Button>
      </SettingsActions>
      <SettingsTestResult result={testResult} />
      <p className="settings-info">
        {settings.provisioningReady
          ? '自助创建应用已就绪'
          : '自助创建应用未就绪：请启用接入并选择项目与环境。'}
      </p>
    </form>
  );
}
