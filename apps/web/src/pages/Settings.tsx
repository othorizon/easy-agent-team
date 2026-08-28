import type {
  AiSettingsInfo,
  ConnectionTestResult,
  DokploySettingsInfo,
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
import { TableSkeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';

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
          部署托管挂载 Dokploy：平台通过其 API 触发部署与查询状态。API Token 加密存储。
        </p>
        {!settings.data ? (
          <TableSkeleton rows={2} />
        ) : (
          <DokployForm
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
  const { register, handleSubmit, control, trigger, getValues, formState: { errors } } = useForm<UpdateDokploySettingsRequest>({
    defaultValues: { apiUrl: settings.apiUrl, apiToken: '', enabled: settings.enabled },
  });

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
