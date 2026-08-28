import type { HelperInfo, HelpRequestInfo, HelpTargets, UpsertHelperProfileRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';

export const HELP_STATUS_TAG: Record<string, JSX.Element> = {
  open: <Tag color="orange">等待回复</Tag>,
  answered: <Tag color="blue">已回复</Tag>,
  resolved: <Tag color="green">已解决</Tag>,
  closed: <Tag>已关闭</Tag>,
};

type MyProfile =
  | { registered: false }
  | { registered: true; description: string; webhookUrl: string; hasWebhookSecret: boolean; available: boolean };

export function HelpPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);

  const profile = useQuery({ queryKey: ['helper-me'], queryFn: () => api<MyProfile>('GET', '/api/helpers/me') });
  const targets = useQuery({ queryKey: ['help-targets'], queryFn: () => api<HelpTargets>('GET', '/api/helpers') });
  const inbox = useQuery({ queryKey: ['help-inbox'], queryFn: () => api<HelpRequestInfo[]>('GET', '/api/help-requests/inbox') });
  const mine = useQuery({ queryKey: ['help-mine'], queryFn: () => api<HelpRequestInfo[]>('GET', '/api/help-requests/mine') });

  const saveProfile = useMutation({
    mutationFn: (v: UpsertHelperProfileRequest) => api<MyProfile>('PUT', '/api/helpers/me', v),
    onSuccess: () => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['helper-me'] });
      void queryClient.invalidateQueries({ queryKey: ['help-targets'] });
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const createRequest = useMutation({
    mutationFn: (v: { title: string; description: string; tried: string; target: string }) => {
      const [kind, value] = v.target.split(':', 2);
      return api('POST', '/api/help-requests', {
        title: v.title,
        description: v.description,
        tried: v.tried,
        ...(kind === 'helper' ? { helperUserId: value } : { skillSlug: value }),
      });
    },
    onSuccess: () => {
      message.success('求助已发出');
      setAsking(false);
      void queryClient.invalidateQueries({ queryKey: ['help-mine'] });
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '发起失败'),
  });

  const requestColumns = (dir: 'in' | 'out') => [
    {
      title: '标题',
      dataIndex: 'title',
      render: (t: string, r: HelpRequestInfo) => <Link to={`/help/${r.id}`}>{t}</Link>,
    },
    {
      title: dir === 'in' ? '求助者' : '被求助者',
      width: 120,
      render: (_: unknown, r: HelpRequestInfo) => (dir === 'in' ? r.requesterName : r.helperName),
    },
    {
      title: '关联 skill',
      dataIndex: 'skillSlug',
      width: 140,
      render: (s: string | null) => (s ? <Typography.Text code>{s}</Typography.Text> : '—'),
    },
    { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => HELP_STATUS_TAG[s] },
    { title: '更新时间', dataIndex: 'updatedAt', width: 150, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="我的可求助登记">
        <Typography.Paragraph type="secondary">
          登记后，其他成员（和他们的 AI）遇到你擅长的问题时会来求助。「能力描述」会被 AI 读取用于选择求助对象，请写清楚擅长领域。
        </Typography.Paragraph>
        {profile.data && (
          <Form
            layout="vertical"
            key={profile.data.registered ? 'y' : 'n'}
            initialValues={
              profile.data.registered
                ? profile.data
                : { description: '', webhookUrl: '', available: true, webhookSecret: '' }
            }
            onFinish={(v: UpsertHelperProfileRequest) => saveProfile.mutate(v)}
          >
            <Form.Item name="description" label="能力描述（AI 会读取）" rules={[{ required: true }]}>
              <Input.TextArea rows={2} placeholder="例如：熟悉支付对账、内部 ERP 系统、部署流程" />
            </Form.Item>
            <Form.Item name="webhookUrl" label="飞书机器人 Webhook 地址（可选：新求助/新回复会推送到该飞书群）">
              <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
            </Form.Item>
            <Form.Item
              name="webhookSecret"
              label="飞书加签密钥（可选：机器人开启「签名校验」时，从飞书复制粘贴到这里）"
              extra={
                profile.data.registered && profile.data.hasWebhookSecret
                  ? '已配置加签密钥；留空保持不变，重新填写则覆盖'
                  : '机器人未开加签则留空'
              }
            >
              <Input.Password placeholder="飞书机器人安全设置里的签名密钥" autoComplete="new-password" />
            </Form.Item>
            <Form.Item name="available" label="接单状态（关闭 = 勿扰，不出现在候选名单）" valuePropName="checked">
              <Switch checkedChildren="可接单" unCheckedChildren="勿扰" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={saveProfile.isPending}>
              {profile.data.registered ? '更新登记' : '登记为可求助者'}
            </Button>
          </Form>
        )}
      </Card>

      <Card
        title="找我的求助"
        extra={
          <Button type="primary" onClick={() => setAsking(true)}>
            发起求助
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={inbox.isLoading}
          dataSource={inbox.data ?? []}
          pagination={false}
          locale={{ emptyText: '暂无' }}
          columns={requestColumns('in')}
        />
      </Card>

      <Card title="我发起的求助">
        <Table
          rowKey="id"
          loading={mine.isLoading}
          dataSource={mine.data ?? []}
          pagination={false}
          locale={{ emptyText: '暂无。AI 也可以通过 MCP 的 create_help_request 替你发起。' }}
          columns={requestColumns('out')}
        />
      </Card>

      <Modal title="发起求助" open={asking} onCancel={() => setAsking(false)} footer={null} width={560} destroyOnHidden>
        <Form layout="vertical" onFinish={(v: { title: string; description: string; tried: string; target: string }) => createRequest.mutate(v)}>
          <Form.Item name="target" label="求助对象" rules={[{ required: true, message: '请选择求助对象' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={[
                {
                  label: '可求助的人',
                  options: (targets.data?.helpers ?? []).map((h: HelperInfo) => ({
                    value: `helper:${h.userId}`,
                    label: `${h.name} — ${h.description}`,
                  })),
                },
                {
                  label: '按 skill 求助（问题与某个 skill 相关时优先）',
                  options: (targets.data?.skillAuthors ?? []).map((s) => ({
                    value: `skill:${s.skillSlug}`,
                    label: `${s.skillName}（作者 ${s.authorName}）`,
                  })),
                },
              ]}
            />
          </Form.Item>
          <Form.Item name="title" label="问题标题" rules={[{ required: true }]}>
            <Input placeholder="一句话说清问题" />
          </Form.Item>
          <Form.Item name="description" label="问题描述" rules={[{ required: true }]}>
            <Input.TextArea rows={4} placeholder="背景、报错信息、AI 卡在哪一步（不要粘贴密钥）" />
          </Form.Item>
          <Form.Item name="tried" label="已经尝试过什么" rules={[{ required: true, message: '请说明已尝试的办法' }]}>
            <Input.TextArea rows={2} placeholder="例如：搜过经验库、看过某文档" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createRequest.isPending} block>
            发出
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
