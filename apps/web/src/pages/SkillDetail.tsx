import type { SkillDetail, SkillVersionInfo, UpdateSkillRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, getStoredUser } from '../api';

export function SkillDetailPage() {
  const { slug = '' } = useParams();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = getStoredUser();
  const [editing, setEditing] = useState(false);

  const skill = useQuery({
    queryKey: ['skill', slug],
    queryFn: () => api<SkillDetail>('GET', `/api/skills/${slug}`),
  });
  const versions = useQuery({
    queryKey: ['skill-versions', slug],
    queryFn: () => api<SkillVersionInfo[]>('GET', `/api/skills/${slug}/versions`),
  });

  const canManage = skill.data && me && (skill.data.ownerId === me.id || me.role === 'admin');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['skill', slug] });
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
  };

  const update = useMutation({
    mutationFn: (v: UpdateSkillRequest) => api('PATCH', `/api/skills/${slug}`, v),
    onSuccess: () => {
      message.success('已保存');
      setEditing(false);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const toggleSubscribe = useMutation({
    mutationFn: () => api(skill.data?.subscribed ? 'DELETE' : 'POST', `/api/skills/${slug}/subscribe`),
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/skills/${slug}`),
    onSuccess: () => {
      message.success('已删除');
      navigate('/skills');
    },
  });

  if (!skill.data) return <Card loading />;
  const s = skill.data;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title={
          <>
            <Typography.Text code>{s.slug}</Typography.Text> {s.name}{' '}
            {s.visibility === 'private' ? <Tag>私有</Tag> : <Tag color="blue">团队可见</Tag>}
            {s.allowHelp && <Tag color="orange">允许求助</Tag>}
            {s.source === 'experience' && <Tag color="purple">经验沉淀</Tag>}
          </>
        }
        extra={
          <Space>
            <Button loading={toggleSubscribe.isPending} onClick={() => toggleSubscribe.mutate()}>
              {s.subscribed ? '退订' : '订阅'}
            </Button>
            {canManage && <Button onClick={() => setEditing(true)}>编辑元信息</Button>}
            {canManage && (
              <Popconfirm title="删除后订阅者本地的副本会在下次 sync 时移除，确认删除？" onConfirm={() => remove.mutate()}>
                <Button danger>删除</Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        <Descriptions size="small" column={2}>
          <Descriptions.Item label="作者">{s.ownerName}</Descriptions.Item>
          <Descriptions.Item label="当前版本">v{s.currentVersion}</Descriptions.Item>
          <Descriptions.Item label="触发描述" span={2}>
            {s.description || '（未填写）'}
          </Descriptions.Item>
          {s.files.length > 0 && (
            <Descriptions.Item label="附属文件" span={2}>
              {s.files.map((f) => (
                <Tag key={f.path} style={{ fontFamily: 'monospace' }}>
                  {f.path}
                  {f.executable ? ' ⚙' : ''}
                </Tag>
              ))}
            </Descriptions.Item>
          )}
        </Descriptions>
        <Typography.Title level={5} style={{ marginTop: 16 }}>
          SKILL.md
        </Typography.Title>
        <pre
          style={{
            background: '#f6f6f6',
            padding: 16,
            borderRadius: 8,
            overflowX: 'auto',
            maxHeight: 480,
            whiteSpace: 'pre-wrap',
          }}
        >
          {s.content}
        </pre>
      </Card>

      <Card title="版本历史">
        <Table
          rowKey="version"
          loading={versions.isLoading}
          dataSource={versions.data ?? []}
          pagination={false}
          columns={[
            { title: '版本', dataIndex: 'version', width: 80, render: (v: number) => `v${v}` },
            { title: '说明', dataIndex: 'changelog', render: (v: string) => v || '—' },
            { title: '提交人', dataIndex: 'createdBy', width: 110 },
            { title: '时间', dataIndex: 'createdAt', width: 160, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
          ]}
        />
      </Card>

      <Modal title="编辑元信息" open={editing} onCancel={() => setEditing(false)} footer={null} destroyOnHidden>
        <Form
          layout="vertical"
          initialValues={{
            name: s.name,
            description: s.description,
            private: s.visibility === 'private',
            allowHelp: s.allowHelp,
          }}
          onFinish={(v: { name: string; description: string; private: boolean; allowHelp: boolean }) =>
            update.mutate({
              name: v.name,
              description: v.description,
              visibility: v.private ? 'private' : 'team',
              allowHelp: v.allowHelp,
            })
          }
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="触发描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="private" label="可见性">
            <Segmented
              options={[
                { label: '团队可见', value: false },
                { label: '私有', value: true },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="allowHelp"
            label="允许求助（开启后，使用者的 AI 可以就这个 skill 向你发起求助——求助功能随 P1 上线）"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={update.isPending} block>
            保存
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
