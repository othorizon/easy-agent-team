import type { ConnectionTestResult, LlmAccountInfo, LlmSettingsInfo, LlmSettingsRequest } from '@eat/shared';
import { formatDateTime, llmAmountToQuota, llmDisplayQuota } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { Field } from '../components/form';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';

const SETTINGS = '/api/admin/llm-gateway-settings';
export function LlmGatewaySettingsCard() {
  const settings = useQuery({
    queryKey: ['llm-settings'],
    queryFn: () => api<LlmSettingsInfo>('GET', SETTINGS),
  });
  const balance = useQuery({
    queryKey: ['llm-account'],
    queryFn: () => api<LlmAccountInfo>('GET', `${SETTINGS}/account`),
    enabled: !!settings.data?.configured,
    refetchInterval: 30000,
    retry: false,
  });
  return (
    <Card>
      <CardContent>
        <h2 className="mb-1 text-sm font-semibold">LLM API 网关设置</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          连接团队的 New API 公共账户，为每位成员分配一把模型 API Key。建议使用专用普通账户的系统访问令牌。
        </p>
        {settings.isError && <p className="text-sm text-destructive">{settings.error.message}</p>}
        {settings.data ? (
          <GatewayForm key={settings.data.updatedAt ?? 'new'} settings={settings.data} />
        ) : (
          !settings.isError && <p>正在加载配置…</p>
        )}
        {settings.data?.configured && (
          <div className="mt-5 rounded-lg border p-3 text-sm" aria-live="polite">
            <p className="font-medium">
              公共账户：{settings.data.accountName} · #{settings.data.accountId}
            </p>
            {balance.data && (
              <>
                <p className="mt-2">
                  账户剩余额度：
                  <strong>{llmDisplayQuota(balance.data.remainingQuota, balance.data.currency)}</strong>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  最近更新：{formatDateTime(balance.data.checkedAt)}。分配个人 Key 额度不会为此钱包充值。
                </p>
              </>
            )}
            {balance.isError && <p className="mt-2 text-destructive">连接异常：{balance.error.message}</p>}
            <Button
              className="mt-2"
              type="button"
              variant="outline"
              size="sm"
              loading={balance.isFetching}
              onClick={() => void balance.refetch()}
            >
              刷新账户余额
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GatewayForm({ settings }: { settings: LlmSettingsInfo }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(settings.apiUrl);
  const [token, setToken] = useState('');
  const [gift, setGift] = useState(
    settings.currency
      ? String((settings.defaultQuota / settings.currency.quotaPerUnit) * settings.currency.exchangeRate)
      : '0',
  );
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const values = (): LlmSettingsRequest => ({
    apiUrl: url.trim(),
    accessToken: token,
    defaultQuota: settings.currency ? llmAmountToQuota(gift, settings.currency) : 0,
  });
  const save = useMutation({
    mutationFn: async () => api('PUT', SETTINGS, values()),
    onSuccess: () => {
      setToken('');
      toast.success('网关设置已保存');
      void qc.invalidateQueries({ queryKey: ['llm-settings'] });
      void qc.invalidateQueries({ queryKey: ['llm-account'] });
    },
    onError: (e) => toast.error(e.message),
  });
  const test = useMutation({
    mutationFn: async () => api<ConnectionTestResult>('POST', `${SETTINGS}/test`, values()),
    onSuccess: setTestResult,
    onError: (e) => toast.error(e.message),
  });
  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field
        label="New API URL"
        htmlFor="llm-url"
        required
        hint="填写站点根地址，例如 https://newapi.example.com，不需要加 /v1。"
      >
        <Input
          id="llm-url"
          type="url"
          required
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setTestResult(null);
          }}
          placeholder="https://newapi.example.com"
        />
      </Field>
      <Field
        label="系统访问令牌"
        htmlFor="llm-token"
        required={!settings.configured}
        hint={
          settings.configured
            ? `当前 ${settings.accessTokenMasked}；留空保持不变`
            : '在 New API 的“安全与访问”中生成，不是调用模型的 API Key。'
        }
      >
        <Input
          id="llm-token"
          type="password"
          autoComplete="new-password"
          required={!settings.configured}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setTestResult(null);
          }}
        />
      </Field>
      <Field
        label={`默认赠送额度${settings.currency ? `（${settings.currency.currency}）` : ''}`}
        htmlFor="llm-gift"
        hint={
          settings.currency
            ? '仅在用户首次申请 Key 时发放。0 表示不赠送，修改不会影响已申请用户。'
            : '首次保存连接后可按账户币种配置赠送金额；初始为 0。'
        }
      >
        <Input
          id="llm-gift"
          inputMode="decimal"
          value={gift}
          disabled={!settings.currency}
          onChange={(e) => setGift(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button loading={save.isPending}>保存</Button>
        <Button type="button" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
          测试连接
        </Button>
      </div>
      {testResult && (
        <p role="status" className={`text-sm ${testResult.ok ? 'text-success' : 'text-destructive'}`}>
          {testResult.message}（{testResult.latencyMs}ms）
        </p>
      )}
    </form>
  );
}
