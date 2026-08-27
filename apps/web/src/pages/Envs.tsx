import type { CreateEnvironmentRequest, EnvironmentInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Table, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';

export function EnvsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const envs = useQuery({
    queryKey: ['envs'],
    queryFn: () => api<EnvironmentInfo[]>('GET', '/api/envs'),
  });

  const create = useMutation({
    mutationFn: (values: CreateEnvironmentRequest) => api('POST', '/api/envs', values),
    onSuccess: () => {
      message.success('环境已创建');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['envs'] });
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  return (
    <Card
      title="环境"
      extra={
        <Button type="primary" onClick={() => setCreating(true)}>
          新建环境
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        环境是变量的分组（如「内部服务」「测试数据库」）。变量默认对全员可见 key 与备注，值需要授权才能读取。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        loading={envs.isLoading}
        dataSource={envs.data ?? []}
        pagination={false}
        columns={[
          {
            title: '环境',
            dataIndex: 'slug',
            render: (slug: string, row) => (
              <Link to={`/envs/${slug}`}>
                <Typography.Text code>{slug}</Typography.Text> {row.name}
              </Link>
            ),
          },
          { title: '备注', dataIndex: 'description', ellipsis: true },
          { title: 'Owner', dataIndex: 'ownerName', width: 120 },
          { title: '变量数', dataIndex: 'variableCount', width: 90 },
        ]}
      />
      <Modal
        title="新建环境"
        open={creating}
        onCancel={() => setCreating(false)}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" onFinish={(v: CreateEnvironmentRequest) => create.mutate(v)}>
          <Form.Item
            name="slug"
            label="标识（slug）"
            rules={[
              { required: true },
              { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母、数字、连字符' },
            ]}
          >
            <Input placeholder="internal-services" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="内部服务" />
          </Form.Item>
          <Form.Item name="description" label="备注（供人和 AI 理解这个环境的用途）" initialValue="">
            <Input.TextArea rows={2} placeholder="公司内部服务相关的密钥与配置" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>
            创建
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}
