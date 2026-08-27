import type { McpConfigInfo, UpsertMcpConfigRequest } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, ApiError, getStoredUser } from '../api';

type FormValues = {
  slug: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command?: string;
  argsText?: string;
  url?: string;
  envPairs?: Array<{ key: string; value: string }>;
  visibility: 'team' | 'private';
};

export function McpConfigsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [editing, setEditing] = useState<McpConfigInfo | 'new' | null>(null);
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');

  const configs = useQuery({ queryKey: ['mcp-configs'], queryFn: () => api<McpConfigInfo[]>('GET', '/api/mcp-configs') });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['mcp-configs'] });

  const upsert = useMutation({
    mutationFn: (v: UpsertMcpConfigRequest) => api('POST', '/api/mcp-configs', v),
    onSuccess: () => {
      message.success('已保存');
      setEditing(null);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const toggleSubscribe = useMutation({
    mutationFn: (c: McpConfigInfo) => api(c.subscribed ? 'DELETE' : 'POST', `/api/mcp-configs/${c.slug}/subscribe`),
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api('DELETE', `/api/mcp-configs/${slug}`),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
  });

  function openEdit(c: McpConfigInfo | 'new') {
    setTransport(c === 'new' ? 'stdio' : c.transport);
    setEditing(c);
  }

  function toPayload(v: FormValues): UpsertMcpConfigRequest {
    return {
      slug: v.slug,
      name: v.name,
      description: v.description ?? '',
      transport: v.transport,
      command: v.transport === 'stdio' ? v.command : undefined,
      args: v.transport === 'stdio' && v.argsText ? v.argsText.split(/\s+/).filter(Boolean) : [],
      url: v.transport === 'http' ? v.url : undefined,
      headers: {},
      env: Object.fromEntries((v.envPairs ?? []).filter((p) => p?.key).map((p) => [p.key, p.value ?? ''])),
      visibility: v.visibility,
    };
  }

  const initial = (c: McpConfigInfo | 'new'): Partial<FormValues> =>
    c === 'new'
      ? { transport: 'stdio', visibility: 'team', envPairs: [] }
      : {
          slug: c.slug,
          name: c.name,
          description: c.description,
          transport: c.transport,
          command: c.command ?? '',
          argsText: c.args.join(' '),
          url: c.url ?? '',
          envPairs: Object.entries(c.env).map(([key, value]) => ({ key, value })),
          visibility: c.visibility,
        };

  return (
    <Card title="MCP 配置" extra={<Button type="primary" onClick={() => openEdit('new')}>新建配置</Button>}>
      <Typography.Paragraph type="secondary">
        团队共享的 MCP Server 配置。敏感值写成引用 <Typography.Text code>{'${env:环境slug/KEY}'}</Typography.Text>
        ——订阅后 <Typography.Text code>eat sync</Typography.Text> 会按你的权限渲染出可用配置（无权限的引用保留占位并提示申请）。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        loading={configs.isLoading}
        dataSource={configs.data ?? []}
        pagination={false}
        columns={[
          { title: '配置', dataIndex: 'slug', render: (s: string, c) => <><Typography.Text code>{s}</Typography.Text> {c.name}</> },
          { title: '说明', dataIndex: 'description', ellipsis: true },
          { title: '传输', dataIndex: 'transport', width: 80 },
          { title: '作者', dataIndex: 'ownerName', width: 100 },
          {
            title: '可见性',
            dataIndex: 'visibility',
            width: 85,
            render: (v: string) => (v === 'private' ? <Tag>私有</Tag> : <Tag color="blue">团队</Tag>),
          },
          {
            title: '操作',
            width: 210,
            render: (_: unknown, c: McpConfigInfo) => (
              <Space>
                <Button size="small" type={c.subscribed ? 'default' : 'primary'} onClick={() => toggleSubscribe.mutate(c)}>
                  {c.subscribed ? '退订' : '订阅'}
                </Button>
                {(c.ownerId === me?.id || me?.role === 'admin') && (
                  <>
                    <Button size="small" onClick={() => openEdit(c)}>编辑</Button>
                    <Button size="small" danger onClick={() => remove.mutate(c.slug)}>删除</Button>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing === 'new' ? '新建 MCP 配置' : `编辑 ${editing?.slug}`}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        footer={null}
        width={620}
        destroyOnHidden
      >
        {editing !== null && (
          <Form layout="vertical" initialValues={initial(editing)} onFinish={(v: FormValues) => upsert.mutate(toPayload(v))}>
            <Form.Item name="slug" label="标识（slug）" rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母、数字、连字符' }]}>
              <Input disabled={editing !== 'new'} placeholder="internal-api" />
            </Form.Item>
            <Form.Item name="name" label="名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="description" label="说明（这个 MCP 能做什么）" initialValue="">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="transport" label="传输方式" rules={[{ required: true }]}>
              <Segmented options={[{ label: 'stdio（本地命令）', value: 'stdio' }, { label: 'http', value: 'http' }]} onChange={(v) => setTransport(v as 'stdio' | 'http')} />
            </Form.Item>
            {transport === 'stdio' ? (
              <>
                <Form.Item name="command" label="命令" rules={[{ required: true }]}>
                  <Input placeholder="npx" style={{ fontFamily: 'monospace' }} />
                </Form.Item>
                <Form.Item name="argsText" label="参数（空格分隔）">
                  <Input placeholder="-y some-mcp-server" style={{ fontFamily: 'monospace' }} />
                </Form.Item>
              </>
            ) : (
              <Form.Item name="url" label="URL" rules={[{ required: true }]}>
                <Input placeholder="https://mcp.internal.example.com/sse" style={{ fontFamily: 'monospace' }} />
              </Form.Item>
            )}
            <Form.Item label={<>环境变量（值可写 <Typography.Text code>{'${env:slug/KEY}'}</Typography.Text> 引用）</>}>
              <Form.List name="envPairs">
                {(fields, { add, remove: rm }) => (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {fields.map((field) => (
                      <Space key={field.key} align="baseline">
                        <Form.Item name={[field.name, 'key']} noStyle rules={[{ required: true }]}>
                          <Input placeholder="API_TOKEN" style={{ width: 180, fontFamily: 'monospace' }} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'value']} noStyle>
                          <Input placeholder={'${env:internal/API_TOKEN}'} style={{ width: 280, fontFamily: 'monospace' }} />
                        </Form.Item>
                        <Button size="small" onClick={() => rm(field.name)}>删</Button>
                      </Space>
                    ))}
                    <Button size="small" onClick={() => add()}>+ 添加变量</Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>
            <Form.Item name="visibility" label="可见性">
              <Segmented options={[{ label: '团队可见', value: 'team' }, { label: '私有', value: 'private' }]} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={upsert.isPending} block>保存</Button>
          </Form>
        )}
      </Modal>
    </Card>
  );
}
