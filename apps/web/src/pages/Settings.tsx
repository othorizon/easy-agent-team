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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { Field, rules } from '../components/form';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';

/** Radix Select 不接受空字符串作为选项值，「不绑定」用哨兵值代替 */
const NONE = '__none__';

/** 系统设置（仅管理员）：平台 AI 接入 + Dokploy 接入 */
export function SettingsPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="系统设置" description="平台级接入配置，仅管理员可见。密钥均加密存储。" />
      <AiSettingsCard />
      <DokploySettingsCard />
    </div>
  );
}

/** 连通性测试结果展示（两张卡片共用） */
function TestResultAlert({ result }: { result: ConnectionTestResult | null }) {
  if (!result) return null;
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm',
        result.ok
          ? 'border-success/30 bg-success/8 text-success'
          : 'border-destructive/30 bg-destructive/8 text-destructive',
      )}
    >
      {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
      <span>{result.ok ? `${result.message}（耗时 ${result.latencyMs}ms）` : result.message}</span>
    </div>
  );
}

function AiSettingsCard() {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const settings = useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api<AiSettingsInfo>('GET', '/api/admin/ai-settings'),
  });

  const save = useMutation({
    mutationFn: (v: UpdateAiSettingsRequest) => api('PUT', '/api/admin/ai-settings', v),
    onSuccess: () => {
      toast.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const test = useMutation({
    mutationFn: (v: TestAiSettingsRequest) => api<ConnectionTestResult>('POST', '/api/admin/ai-settings/test', v),
    onSuccess: (r) => setTestResult(r),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '测试请求失败'),
  });

  return (
    <Card>
      <CardContent>
        <h2 className="mb-1 text-sm font-semibold">平台 AI 接入</h2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          采用 OpenAI 接口范式（Chat Completions 兼容），可对接任意兼容网关。当前用于经验沉淀的自动整理；
          沉淀时会把求助问答发送给所配置的模型服务。api_key 加密存储，每次调用的 token 用量会记录。
        </p>
        {!settings.data ? (
          <TableSkeleton rows={2} />
        ) : (
          <AiForm
            key={settings.data.configured ? 'configured' : 'new'}
            settings={settings.data}
            savePending={save.isPending}
            testPending={test.isPending}
            testResult={testResult}
            onSave={(v) => save.mutate(v)}
            onTest={(v) => {
              setTestResult(null);
              test.mutate(v);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AiForm({
  settings,
  savePending,
  testPending,
  testResult,
  onSave,
  onTest,
}: {
  settings: AiSettingsInfo;
  savePending: boolean;
  testPending: boolean;
  testResult: ConnectionTestResult | null;
  onSave: (v: UpdateAiSettingsRequest) => void;
  onTest: (v: TestAiSettingsRequest) => void;
}) {
  const { register, handleSubmit, control, trigger, getValues, formState: { errors } } = useForm<UpdateAiSettingsRequest>({
    defaultValues: { apiBaseUrl: settings.apiBaseUrl, apiKey: '', model: settings.model, enabled: settings.enabled },
  });

  async function runTest() {
    if (!(await trigger(['apiBaseUrl', 'apiKey', 'model']))) return;
    const v = getValues();
    onTest({ apiBaseUrl: v.apiBaseUrl, apiKey: v.apiKey ?? '', model: v.model });
  }

  return (
    <form className="flex max-w-xl flex-col gap-4" onSubmit={handleSubmit(onSave)}>
      <Field label="API Base URL" htmlFor="ai-url" required error={errors.apiBaseUrl?.message}>
        <Input
          id="ai-url"
          placeholder="https://api.example.com/v1"
          className="font-mono"
          aria-invalid={!!errors.apiBaseUrl}
          {...register('apiBaseUrl', { required: '请输入 API Base URL', pattern: rules.url })}
        />
      </Field>
      <Field
        label="API Key"
        htmlFor="ai-key"
        required={!settings.configured}
        error={errors.apiKey?.message}
        hint={settings.configured ? `当前 ${settings.apiKeyMasked}，留空保持不变` : undefined}
      >
        <Input
          id="ai-key"
          type="password"
          autoComplete="new-password"
          placeholder={settings.configured ? '留空保持现有 Key' : 'sk-...'}
          aria-invalid={!!errors.apiKey}
          {...register('apiKey', settings.configured ? {} : { required: '请输入 API Key' })}
        />
      </Field>
      <Field label="模型" htmlFor="ai-model" required error={errors.model?.message}>
        <Input id="ai-model" placeholder="模型名称" className="font-mono" aria-invalid={!!errors.model} {...register('model', { required: '请输入模型名称' })} />
      </Field>
      <Field label="启用">
        <Controller
          control={control}
          name="enabled"
          render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={savePending}>
          保存
        </Button>
        <Button type="button" variant="outline" onClick={() => void runTest()} loading={testPending}>
          测试连接
        </Button>
      </div>
      <TestResultAlert result={testResult} />
    </form>
  );
}

function DokploySettingsCard() {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const settings = useQuery({
    queryKey: ['dokploy-settings'],
    queryFn: () => api<DokploySettingsInfo>('GET', '/api/admin/dokploy-settings'),
  });

  const save = useMutation({
    mutationFn: (v: UpdateDokploySettingsRequest) => api('PUT', '/api/admin/dokploy-settings', v),
    onSuccess: () => {
      toast.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['dokploy-settings'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const test = useMutation({
    mutationFn: (v: TestDokploySettingsRequest) => api<ConnectionTestResult>('POST', '/api/admin/dokploy-settings/test', v),
    onSuccess: (r) => setTestResult(r),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '测试请求失败'),
  });

  return (
    <Card>
      <CardContent>
        <h2 className="mb-1 text-sm font-semibold">Dokploy 接入</h2>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          部署托管挂载 Dokploy：平台通过其 API 建应用、触发部署与查询状态。API Token 加密存储。
          成员自助创建的应用会建在下面选定的 Dokploy 项目 / 环境下并绑定所选 SSH key（key 需先在 Dokploy 里创建）。
        </p>
        {!settings.data ? (
          <TableSkeleton rows={2} />
        ) : (
          <DokployForm
            key={`${settings.data.configured ? 'configured' : 'new'}-${settings.data.enabled}-${settings.data.projectId}-${settings.data.environmentId}-${settings.data.sshKeyId}`}
            settings={settings.data}
            savePending={save.isPending}
            testPending={test.isPending}
            testResult={testResult}
            onSave={(v) => save.mutate(v)}
            onTest={(v) => {
              setTestResult(null);
              test.mutate(v);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function DokployForm({
  settings,
  savePending,
  testPending,
  testResult,
  onSave,
  onTest,
}: {
  settings: DokploySettingsInfo;
  savePending: boolean;
  testPending: boolean;
  testResult: ConnectionTestResult | null;
  onSave: (v: UpdateDokploySettingsRequest) => void;
  onTest: (v: TestDokploySettingsRequest) => void;
}) {
  const { register, handleSubmit, control, trigger, getValues, watch, setValue, formState: { errors } } = useForm<UpdateDokploySettingsRequest>({
    defaultValues: {
      apiUrl: settings.apiUrl,
      apiToken: '',
      enabled: settings.enabled,
      projectId: settings.projectId,
      environmentId: settings.environmentId,
      sshKeyId: settings.sshKeyId,
    },
  });
  // 项目 / 环境 / SSH key 清单从 Dokploy 现拉：要先保存并启用地址与 token 才拉得到，拉不到时退回手填 id
  const projects = useQuery({
    queryKey: ['dokploy-projects'],
    queryFn: () => api<DokployProject[]>('GET', '/api/admin/dokploy/projects'),
    enabled: settings.configured && settings.enabled,
    retry: false,
  });
  const sshKeys = useQuery({
    queryKey: ['dokploy-ssh-keys'],
    queryFn: () => api<DokploySshKey[]>('GET', '/api/admin/dokploy/ssh-keys'),
    enabled: settings.configured && settings.enabled,
    retry: false,
  });
  const projectId = watch('projectId');
  const environments = (projects.data ?? []).find((p) => p.projectId === projectId)?.environments ?? [];
  const listsUnavailable = !settings.configured || !settings.enabled;
  const listError = projects.error instanceof ApiError ? projects.error.message : sshKeys.error instanceof ApiError ? sshKeys.error.message : null;

  async function runTest() {
    if (!(await trigger(['apiUrl', 'apiToken']))) return;
    const v = getValues();
    onTest({ apiUrl: v.apiUrl, apiToken: v.apiToken ?? '' });
  }

  return (
    <form className="flex max-w-xl flex-col gap-4" onSubmit={handleSubmit(onSave)}>
      <Field label="API 地址" htmlFor="dokploy-url" required error={errors.apiUrl?.message} hint="如 https://dokploy.example.com/api">
        <Input
          id="dokploy-url"
          placeholder="https://dokploy.example.com/api"
          className="font-mono"
          aria-invalid={!!errors.apiUrl}
          {...register('apiUrl', { required: '请输入 API 地址', pattern: rules.url })}
        />
      </Field>
      <Field
        label="API Token"
        htmlFor="dokploy-token"
        required={!settings.configured}
        error={errors.apiToken?.message}
        hint={settings.configured ? `当前 ${settings.apiTokenMasked}，留空保持不变` : 'Dokploy 控制台生成'}
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
      <Field label="启用">
        <Controller
          control={control}
          name="enabled"
          render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />}
        />
      </Field>

      <div className="rounded-md border px-3 py-3">
        <h3 className="text-sm font-medium">自助创建应用的落点（决策 31）</h3>
        <p className="mt-1 mb-3 text-xs leading-relaxed text-muted-foreground">
          成员自助创建的应用建在这个 Dokploy 项目 / 环境下；SSH key 用于拉取私有仓库，留空则只能建公开仓库的应用。
          {listsUnavailable && ' 先保存并启用上面的地址与 Token，才能从 Dokploy 拉取清单；也可直接手填 id。'}
          {listError && ` 清单读取失败：${listError}，可手填 id。`}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Dokploy 项目" htmlFor="dokploy-project" hint={settings.projectId && !projects.data ? `当前 ${settings.projectId}` : undefined}>
            {projects.data ? (
              <Select
                value={projectId || undefined}
                onValueChange={(v) => {
                  setValue('projectId', v, { shouldDirty: true });
                  // 换项目后原来的环境多半不属于新项目：能自动选默认环境就选，否则清空让人重选
                  const envs = (projects.data ?? []).find((p) => p.projectId === v)?.environments ?? [];
                  setValue('environmentId', (envs.find((e) => e.isDefault) ?? envs[0])?.environmentId ?? '', { shouldDirty: true });
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
              <Input id="dokploy-project" className="font-mono" placeholder="projectId" {...register('projectId')} />
            )}
          </Field>
          <Field label="环境" htmlFor="dokploy-env" hint={projects.data && projectId && environments.length === 0 ? '该项目没有环境（Dokploy 版本过旧？），无法自助建应用' : undefined}>
            {projects.data ? (
              <Controller
                control={control}
                name="environmentId"
                render={({ field }) => (
                  <Select value={field.value || undefined} onValueChange={field.onChange} disabled={environments.length === 0}>
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
              <Input id="dokploy-env" className="font-mono" placeholder="environmentId" {...register('environmentId')} />
            )}
          </Field>
          <Field label="SSH key" htmlFor="dokploy-ssh" hint="可留空">
            {sshKeys.data ? (
              <Controller
                control={control}
                name="sshKeyId"
                render={({ field }) => (
                  <Select value={field.value || NONE} onValueChange={(v) => field.onChange(v === NONE ? '' : v)}>
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
              <Input id="dokploy-ssh" className="font-mono" placeholder="sshKeyId（可空）" {...register('sshKeyId')} />
            )}
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={savePending}>
          保存
        </Button>
        <Button type="button" variant="outline" onClick={() => void runTest()} loading={testPending}>
          测试连接
        </Button>
        {settings.provisioningReady ? (
          <span className="text-xs text-success">自助创建应用已就绪</span>
        ) : (
          <span className="text-xs text-muted-foreground">自助创建应用未就绪：需启用并选好项目与环境</span>
        )}
      </div>
      <TestResultAlert result={testResult} />
    </form>
  );
}
