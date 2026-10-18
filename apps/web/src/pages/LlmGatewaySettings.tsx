import type { ConnectionTestResult, LlmAccountInfo, LlmSettingsInfo, LlmSettingsRequest } from '@eat/shared';
import { formatDateTime, llmAmountToQuota, llmDisplayQuota } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { Field } from '../components/form';
import {
  SettingsActions,
  SettingsGroup,
  SettingsLoadError,
  SettingsLoading,
  SettingsSection,
  SettingsTestResult,
} from '../components/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

const SETTINGS = '/api/admin/llm-gateway-settings';
export function LlmGatewaySettingsCard({ active = true }: { active?: boolean }) {
  const settings = useQuery({
    queryKey: ['llm-settings'],
    queryFn: () => api<LlmSettingsInfo>('GET', SETTINGS),
    enabled: active,
  });
  const balance = useQuery({
    queryKey: ['llm-account'],
    queryFn: () => api<LlmAccountInfo>('GET', `${SETTINGS}/account`),
    enabled: active && !!settings.data?.configured,
    refetchInterval: 30000,
    retry: false,
  });
  return (
    <SettingsSection
      title="LLM API 网关"
      description="连接 New API 公共账户，让管理员和成员申请各自的模型 Key。个人额度与公共账户钱包分别管理。"
      status={
        <Badge variant="secondary">
          {balance.isError
            ? '连接异常'
            : balance.data
              ? '已连接'
              : !settings.data
                ? '正在读取'
                : settings.data.configured
                  ? '已配置'
                  : '未配置'}
        </Badge>
      }
    >
      {settings.data ? (
        <GatewayForm settings={settings.data} />
      ) : settings.isError ? (
        <SettingsLoadError error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        <SettingsLoading />
      )}
      {settings.data?.configured && (
        <div className="settings-status" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium">
              公共账户 · {settings.data.accountName} · #{settings.data.accountId}
            </h3>
            <Button
              type="button"
              variant="outline"
              loading={balance.isFetching}
              onClick={() => void balance.refetch()}
            >
              刷新账户余额
            </Button>
          </div>
          {balance.data && (
            <>
              <p className="mt-3">
                账户剩余额度：
                <strong className="tabular-nums">
                  {llmDisplayQuota(balance.data.remainingQuota, balance.data.currency)}
                </strong>
              </p>
              <p className="text-xs text-muted-foreground">
                更新于 {formatDateTime(balance.data.checkedAt)} · 分配个人 Key 额度不会为此钱包充值。
              </p>
            </>
          )}
          {balance.isError && (
            <p role="alert" className="text-destructive">
              连接异常：{balance.error.message}
            </p>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

const amount = (settings: LlmSettingsInfo) =>
  settings.currency
    ? String((settings.defaultQuota / settings.currency.quotaPerUnit) * settings.currency.exchangeRate)
    : '0';
function GatewayForm({ settings }: { settings: LlmSettingsInfo }) {
  const cache = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const testVersion = useRef(0);
  const [url, setUrl] = useState(settings.apiUrl);
  const [token, setToken] = useState('');
  const [gift, setGift] = useState(amount(settings));
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const values = (): LlmSettingsRequest => ({
    apiUrl: url.trim(),
    accessToken: token,
    defaultQuota: settings.currency ? llmAmountToQuota(gift, settings.currency) : 0,
  });
  let dirty = true;
  try {
    dirty = url.trim() !== settings.apiUrl || token !== '' || values().defaultQuota !== settings.defaultQuota;
  } catch {
    /* Invalid edits still count as unsaved. */
  }
  const save = useMutation({
    mutationFn: () => api<LlmSettingsInfo>('PUT', SETTINGS, values()),
    onSuccess: (data) => {
      setToken('');
      setUrl(data.apiUrl);
      setGift(amount(data));
      cache.setQueryData(['llm-settings'], data);
      void cache.invalidateQueries({ queryKey: ['llm-account'] });
      toast.success('网关设置已保存');
    },
  });
  const test = useMutation({
    mutationFn: () => api<ConnectionTestResult>('POST', `${SETTINGS}/test`, values()),
  });
  const edit = () => {
    testVersion.current++;
    setTestResult(null);
  };
  async function runTest() {
    if (!form.current?.reportValidity()) return;
    const version = ++testVersion.current;
    try {
      const result = await test.mutateAsync();
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
    <form
      ref={form}
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset disabled={save.isPending}>
        <SettingsGroup
          title="连接配置"
          description="使用专用普通账户的系统访问令牌，保存时自动识别绑定账户。"
        >
          <Field
            className="settings-span"
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
                edit();
              }}
              placeholder="https://newapi.example.com"
            />
          </Field>
          <Field
            className="settings-span"
            label="系统访问令牌"
            htmlFor="llm-token"
            required={!settings.configured}
            hint={
              settings.configured
                ? `已保存 ${settings.accessTokenMasked}，留空保留`
                : '在 New API 的“安全与访问”中生成，与调用模型的 API Key 不同。'
            }
          >
            <Input
              id="llm-token"
              type="password"
              autoComplete="new-password"
              required={!settings.configured}
              value={token}
              placeholder={settings.configured ? '留空保留现有令牌' : '输入系统访问令牌'}
              onChange={(e) => {
                setToken(e.target.value);
                edit();
              }}
            />
          </Field>
        </SettingsGroup>
        <SettingsGroup
          title="首次申请赠送"
          description="仅影响之后首次申请 Key 的用户；个人赠送配置优先于全局配置。"
        >
          <Field
            label={`默认赠送额度${settings.currency ? `（${settings.currency.currency}）` : ''}`}
            htmlFor="llm-gift"
            hint={
              settings.currency
                ? '0 表示不赠送，修改不会影响已申请用户。'
                : '先保存连接，再按识别到的币种配置。初始额度为 0。'
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
        </SettingsGroup>
      </fieldset>
      <SettingsActions
        pending={save.isPending}
        dirty={dirty}
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
