import type { DistillRequest, HelpRequestDetail } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Space, Switch, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, getStoredUser } from '../api';
import { HELP_STATUS_TAG } from './Help';

export function HelpDetailPage() {
  const { id = '' } = useParams();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = getStoredUser();
  const [distilling, setDistilling] = useState(false);

  const detail = useQuery({
    queryKey: ['help', id],
    queryFn: () => api<HelpRequestDetail>('GET', `/api/help-requests/${id}`),
    refetchInterval: 15_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['help', id] });

  const reply = useMutation({
    mutationFn: (content: string) => api('POST', `/api/help-requests/${id}/reply`, { content }),
    onSuccess: invalidate,
    onError: (err) => message.error(err instanceof ApiError ? err.message : '回复失败'),
  });
  const resolve = useMutation({
    mutationFn: () => api('POST', `/api/help-requests/${id}/resolve`, {}),
    onSuccess: () => {
      message.success('已标记解决');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/help-requests/${id}`),
    onSuccess: () => {
      message.success('已删除');
      void queryClient.invalidateQueries({ queryKey: ['help-mine'] });
      void queryClient.invalidateQueries({ queryKey: ['help-inbox'] });
      navigate('/help');
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '删除失败'),
  });
  const distill = useMutation({
    mutationFn: (v: DistillRequest) => api('POST', `/api/help-requests/${id}/distill`, v),
    onSuccess: (res: unknown) => {
      const r = res as { skillSlug: string; aiUsed: boolean };
      message.success(`已沉淀为经验 ${r.skillSlug}${r.aiUsed ? '（AI 整理）' : '（模板生成）'}`);
      setDistilling(false);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '沉淀失败'),
  });

  const [form] = Form.useForm<{ content: string }>();
  if (!detail.data) return <Card loading />;
  const r = detail.data;
  const isHelper = me?.id === r.helperId;
  const isRequester = me?.id === r.requesterId;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title={
          <>
            {HELP_STATUS_TAG[r.status]} {r.title}
          </>
        }
        extra={
          <Space>
            {(isRequester || isHelper) && r.status !== 'resolved' && r.status !== 'closed' && (
              <Button onClick={() => resolve.mutate()} loading={resolve.isPending}>
                标记已解决
              </Button>
            )}
            {isHelper && r.status === 'resolved' && !r.experienceSkillSlug && (
              <Button type="primary" onClick={() => setDistilling(true)}>
                沉淀为经验
              </Button>
            )}
            {(isRequester || me?.role === 'admin') && !r.experienceSkillSlug && (
              <Popconfirm
                title="删除这条求助？"
                description="对话记录将一并删除，不可恢复"
                okButtonProps={{ danger: true }}
                onConfirm={() => remove.mutate()}
              >
                <Button danger loading={remove.isPending}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          {r.requesterName} 向 {r.helperName} 求助
          {r.skillSlug && (
            <>
              ，关联 skill <Typography.Text code>{r.skillSlug}</Typography.Text>
            </>
          )}
          {r.experienceSkillSlug && (
            <>
              ，已沉淀为经验 <Link to={`/skills/${r.experienceSkillSlug}`}><Typography.Text code>{r.experienceSkillSlug}</Typography.Text></Link>
            </>
          )}
        </Typography.Paragraph>
        <Typography.Paragraph>
          <strong>问题：</strong>
          {r.description}
        </Typography.Paragraph>
        <Typography.Paragraph>
          <strong>已尝试：</strong>
          {r.tried}
        </Typography.Paragraph>
      </Card>

      <Card title="对话">
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {r.messages.length === 0 && <Typography.Text type="secondary">还没有回复</Typography.Text>}
          {r.messages.map((m) => (
            <div key={m.id}>
              <Typography.Text strong>{m.senderName}</Typography.Text>{' '}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {m.createdAt.slice(0, 16).replace('T', ' ')}
              </Typography.Text>
              {m.senderId === r.helperId && <Tag style={{ marginLeft: 8 }}>被求助者</Tag>}
              <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{m.content}</Typography.Paragraph>
            </div>
          ))}
          {r.status !== 'closed' && (
            <Form
              form={form}
              onFinish={(v) => {
                reply.mutate(v.content);
                form.resetFields();
              }}
            >
              <Form.Item name="content" rules={[{ required: true, message: '写点内容再发送' }]}>
                <Input.TextArea rows={3} placeholder="回复 / 追问…" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={reply.isPending}>
                发送
              </Button>
            </Form>
          )}
        </Space>
      </Card>

      <Modal title="沉淀为经验" open={distilling} onCancel={() => setDistilling(false)} footer={null} destroyOnHidden>
        <Typography.Paragraph type="secondary">
          经验会以 Skill 的形式进入选定成员的 Skill 库（下次 eat sync 落地）。内容默认由平台 AI 从问答整理成草稿，之后你可以随时在 Skill 页修改——只有你（被求助者）有修改权。
        </Typography.Paragraph>
        <Form
          layout="vertical"
          initialValues={{ public: false, grantedToRequester: true, grantedToHelper: false, useAi: true }}
          onFinish={(v: DistillRequest) => distill.mutate(v)}
        >
          <Form.Item name="public" label="公开到团队经验库（否则仅求助双方可见）" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="grantedToRequester" label={`沉淀给求助者（${r.requesterName}）`} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="grantedToHelper" label="沉淀给我自己" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="useAi" label="用平台 AI 整理草稿（未配置或失败时回退为模板）" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="slug"
            label="经验标识（可选，默认自动生成）"
            rules={[{ pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母、数字、连字符' }]}
          >
            <Input placeholder="exp-duizhang" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={distill.isPending} block>
            沉淀
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
