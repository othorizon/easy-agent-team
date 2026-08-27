import type { AiSettingsInfo, UpdateAiSettingsRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Switch, Typography } from 'antd';
import { api, ApiError } from '../api';

/** 系统设置（仅管理员）：平台 AI 接入配置 */
export function SettingsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api<AiSettingsInfo>('GET', '/api/admin/ai-settings'),
  });

  const save = useMutation({
    mutationFn: (v: UpdateAiSettingsRequest) => api('PUT', '/api/admin/ai-settings', v),
    onSuccess: () => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  if (!settings.data) return <Card loading />;
  const s = settings.data;

  return (
    <Card title="平台 AI 接入" style={{ maxWidth: 640 }}>
      <Typography.Paragraph type="secondary">
        采用 OpenAI 接口范式（Chat Completions 兼容），可对接任意兼容网关。当前用于经验沉淀的自动整理；
        沉淀时会把求助问答发送给所配置的模型服务。api_key 加密存储，每次调用的 token 用量会记录。
      </Typography.Paragraph>
      <Form
        layout="vertical"
        key={s.configured ? 'y' : 'n'}
        initialValues={{ apiBaseUrl: s.apiBaseUrl, apiKey: '', model: s.model, enabled: s.enabled }}
        onFinish={(v: UpdateAiSettingsRequest) => save.mutate(v)}
      >
        <Form.Item name="apiBaseUrl" label="API Base URL" rules={[{ required: true, type: 'url' }]}>
          <Input placeholder="https://api.example.com/v1" />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label={s.configured ? `API Key（当前 ${s.apiKeyMasked}，留空保持不变）` : 'API Key'}
          rules={s.configured ? [] : [{ required: true }]}
        >
          <Input.Password placeholder={s.configured ? '留空保持现有 Key' : 'sk-...'} />
        </Form.Item>
        <Form.Item name="model" label="模型" rules={[{ required: true }]}>
          <Input placeholder="模型名称" />
        </Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={save.isPending}>
          保存
        </Button>
      </Form>
    </Card>
  );
}
