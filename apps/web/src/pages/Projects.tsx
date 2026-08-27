import type { CreateProjectRequest, DeploymentInfo, ProjectInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, ApiError, getStoredUser } from '../api';

const STATUS_TAG: Record<string, JSX.Element> = {
  deploying: <Tag color="blue">部署中</Tag>,
  success: <Tag color="green">成功</Tag>,
  failed: <Tag color="red">失败</Tag>,
};

interface UserRow {
  id: string;
  name: string;
  email: string;
}

export function ProjectsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<ProjectInfo | null>(null);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectInfo[]>('GET', '/api/projects') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('GET', '/api/users') });
  const deployments = useQuery({
    queryKey: ['deployments', viewing?.slug],
    queryFn: () => api<DeploymentInfo[]>('GET', `/api/projects/${viewing!.slug}/deployments`),
    enabled: viewing !== null,
    refetchInterval: 10_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['projects'] });

  const create = useMutation({
    mutationFn: (v: CreateProjectRequest) => api('POST', '/api/projects', v),
    onSuccess: () => {
      message.success('项目已创建');
      setCreating(false);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const addMember = useMutation({
    mutationFn: (v: { slug: string; userId: string }) => api('POST', `/api/projects/${v.slug}/members`, { userId: v.userId }),
    onSuccess: () => {
      message.success('已添加成员');
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '添加失败'),
  });

  const removeMember = useMutation({
    mutationFn: (v: { slug: string; userId: string }) => api('DELETE', `/api/projects/${v.slug}/members/${v.userId}`),
    onSuccess: () => {
      message.success('已移除');
      invalidate();
    },
  });

  const canManage = (p: ProjectInfo) => me?.role === 'admin' || p.ownerId === me?.id;

  return (
    <Card title="部署项目" extra={<Button type="primary" onClick={() => setCreating(true)}>创建项目</Button>}>
      <Typography.Paragraph type="secondary">
        项目绑定 Dokploy 上的应用。部署从本地发起：项目目录里运行{' '}
        <Typography.Text code>eat deploy {'<slug>'}</Typography.Text>
        ——CLI 会先做本地密钥扫描（含平台密钥指纹匹配），通过后才触发 Dokploy 部署；AI 也可经 MCP 的 trigger_deploy 自助部署。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        loading={projects.isLoading}
        dataSource={projects.data ?? []}
        pagination={false}
        locale={{ emptyText: '暂无项目' }}
        columns={[
          {
            title: '项目',
            dataIndex: 'slug',
            render: (s: string, p) => (
              <a onClick={() => setViewing(p)}>
                <Typography.Text code>{s}</Typography.Text> {p.name}
              </a>
            ),
          },
          { title: 'Dokploy 应用', dataIndex: 'dokployApplicationId', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: 'Owner', dataIndex: 'ownerName', width: 100 },
          {
            title: '成员',
            render: (_: unknown, p: ProjectInfo) => (p.members.length > 0 ? p.members.map((m) => m.name).join('、') : '—'),
          },
          {
            title: '我可部署',
            dataIndex: 'canDeploy',
            width: 90,
            render: (v: boolean) => (v ? <Tag color="green">是</Tag> : <Tag>否</Tag>),
          },
        ]}
      />

      <Modal title="创建项目" open={creating} onCancel={() => setCreating(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" onFinish={(v: CreateProjectRequest) => create.mutate(v)}>
          <Form.Item name="slug" label="标识（slug）" rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母、数字、连字符' }]}>
            <Input placeholder="crm-tool" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="CRM 小工具" />
          </Form.Item>
          <Form.Item name="dokployApplicationId" label="Dokploy Application ID" rules={[{ required: true }]}>
            <Input placeholder="在 Dokploy 控制台的应用详情里查看" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="repoUrl" label="仓库地址（可选）" initialValue="">
            <Input placeholder="https://git.example.com/crm" />
          </Form.Item>
          <Form.Item name="description" label="说明" initialValue="">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>创建</Button>
        </Form>
      </Modal>

      <Modal
        title={viewing && <>项目 <Typography.Text code>{viewing.slug}</Typography.Text></>}
        open={viewing !== null}
        onCancel={() => setViewing(null)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        {viewing && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {canManage(viewing) && (
              <div>
                <Typography.Text strong>成员管理</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  {viewing.members.map((m) => (
                    <Tag key={m.userId} closable onClose={() => removeMember.mutate({ slug: viewing.slug, userId: m.userId })}>
                      {m.name}
                    </Tag>
                  ))}
                  <Select
                    size="small"
                    style={{ width: 220 }}
                    placeholder="添加成员…"
                    value={null}
                    showSearch
                    optionFilterProp="label"
                    options={(users.data ?? [])
                      .filter((u) => u.id !== viewing.ownerId && !viewing.members.some((m) => m.userId === u.id))
                      .map((u) => ({ value: u.id, label: `${u.name} <${u.email}>` }))}
                    onSelect={(userId) => {
                      if (typeof userId === 'string') addMember.mutate({ slug: viewing.slug, userId });
                    }}
                  />
                </div>
              </div>
            )}
            <div>
              <Typography.Text strong>部署历史</Typography.Text>
              <Table
                rowKey="id"
                size="small"
                style={{ marginTop: 8 }}
                loading={deployments.isLoading}
                dataSource={deployments.data ?? []}
                pagination={false}
                locale={{ emptyText: '暂无部署。项目目录运行 eat deploy 发起。' }}
                columns={[
                  { title: '时间', dataIndex: 'createdAt', width: 150, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
                  { title: '状态', dataIndex: 'status', width: 90, render: (s: string) => STATUS_TAG[s] },
                  { title: '触发人', dataIndex: 'triggeredByName', width: 100 },
                  {
                    title: '检查',
                    render: (_: unknown, d: DeploymentInfo) =>
                      d.report ? `扫描 ${d.report.scannedFiles} 文件 / ${d.report.findings.length} 问题` : '—',
                  },
                  { title: '备注', dataIndex: 'error', ellipsis: true, render: (v: string | null) => v ?? '—' },
                ]}
              />
            </div>
          </Space>
        )}
      </Modal>
    </Card>
  );
}
