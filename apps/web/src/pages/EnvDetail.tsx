import type { GrantInfo, UpsertVariableRequest, VariableMeta } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, getStoredUser } from '../api';

interface UserRow {
  id: string;
  name: string;
  email: string;
}

export function EnvDetailPage() {
  const { slug = '' } = useParams();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [editing, setEditing] = useState<VariableMeta | 'new' | null>(null);
  const [granting, setGranting] = useState(false);

  const variables = useQuery({
    queryKey: ['vars', slug],
    queryFn: () => api<VariableMeta[]>('GET', `/api/envs/${slug}/variables`),
  });
  // 授权列表仅 Owner/管理员可查；403 时静默隐藏该区块
  const grants = useQuery({
    queryKey: ['grants', slug],
    queryFn: () => api<GrantInfo[]>('GET', `/api/envs/${slug}/grants`),
    retry: false,
  });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<UserRow[]>('GET', '/api/users'),
  });

  const canManage = !grants.isError;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vars', slug] });
    void queryClient.invalidateQueries({ queryKey: ['grants', slug] });
  };

  const upsert = useMutation({
    mutationFn: (v: UpsertVariableRequest) => api('POST', `/api/envs/${slug}/variables`, v),
    onSuccess: () => {
      message.success('已保存');
      setEditing(null);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const removeVar = useMutation({
    mutationFn: (key: string) => api('DELETE', `/api/envs/${slug}/variables/${key}`),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
  });

  const createGrant = useMutation({
    mutationFn: (v: { userId: string; variableId?: string; expiresAt?: Dayjs }) =>
      api('POST', `/api/envs/${slug}/grants`, {
        userId: v.userId,
        variableId: v.variableId || undefined,
        ...(v.variableId ? {} : { environmentId: grantsEnvId() }),
        expiresAt: v.expiresAt?.toISOString(),
      }),
    onSuccess: () => {
      message.success('已授权');
      setGranting(false);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '授权失败'),
  });

  // 环境级授权需要环境 id：从授权列表或另查；grants 里未必有，简单再查一次环境列表缓存
  const envs = useQuery({
    queryKey: ['envs'],
    queryFn: () => api<Array<{ id: string; slug: string }>>('GET', '/api/envs'),
  });
  function grantsEnvId(): string | undefined {
    return envs.data?.find((e) => e.slug === slug)?.id;
  }

  const revokeGrant = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/grants/${id}`),
    onSuccess: () => {
      message.success('已撤销');
      invalidate();
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title={
          <>
            环境 <Typography.Text code>{slug}</Typography.Text>
          </>
        }
        extra={
          canManage && (
            <Button type="primary" onClick={() => setEditing('new')}>
              新增变量
            </Button>
          )
        }
      >
        <Table
          rowKey="id"
          loading={variables.isLoading}
          dataSource={variables.data ?? []}
          pagination={false}
          columns={[
            {
              title: 'Key',
              dataIndex: 'key',
              render: (k: string) => <Typography.Text code copyable>{k}</Typography.Text>,
            },
            { title: '备注', dataIndex: 'description', ellipsis: true },
            {
              title: '权限',
              dataIndex: 'hasAccess',
              width: 100,
              render: (has: boolean) => (has ? <Tag color="green">可读取</Tag> : <Tag>无权限</Tag>),
            },
            {
              title: '无权限可见',
              dataIndex: 'visibleWithoutPermission',
              width: 110,
              render: (v: boolean) => (v ? '是' : '否'),
            },
            { title: '版本', dataIndex: 'version', width: 70 },
            ...(canManage
              ? [
                  {
                    title: '操作',
                    width: 140,
                    render: (_: unknown, row: VariableMeta) => (
                      <Space>
                        <Button size="small" onClick={() => setEditing(row)}>
                          更新
                        </Button>
                        <Popconfirm title={`删除 ${row.key}？`} onConfirm={() => removeVar.mutate(row.key)}>
                          <Button size="small" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      {canManage && (
        <Card
          title="读取授权"
          extra={<Button onClick={() => setGranting(true)}>新增授权</Button>}
        >
          <Table
            rowKey="id"
            loading={grants.isLoading}
            dataSource={grants.data ?? []}
            pagination={false}
            locale={{ emptyText: '暂无授权。成员发起权限申请后也可在「权限申请」页审批。' }}
            columns={[
              { title: '用户', dataIndex: 'userName' },
              {
                title: '范围',
                render: (_: unknown, g: GrantInfo) =>
                  g.variableKey ? <Typography.Text code>{g.variableKey}</Typography.Text> : <Tag color="blue">整个环境</Tag>,
              },
              {
                title: '有效期',
                dataIndex: 'expiresAt',
                render: (v: string | null) => (v ? v.slice(0, 16).replace('T', ' ') : '永久'),
              },
              {
                title: '操作',
                width: 90,
                render: (_: unknown, g: GrantInfo) => (
                  <Popconfirm title="撤销该授权？" onConfirm={() => revokeGrant.mutate(g.id)}>
                    <Button size="small" danger>
                      撤销
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal
        title={editing === 'new' ? '新增变量' : `更新 ${editing?.key}`}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          initialValues={
            editing && editing !== 'new'
              ? { key: editing.key, description: editing.description, visibleWithoutPermission: editing.visibleWithoutPermission }
              : { visibleWithoutPermission: true }
          }
          onFinish={(v: UpsertVariableRequest) => upsert.mutate(v)}
        >
          <Form.Item
            name="key"
            label="Key"
            rules={[{ required: true }, { pattern: /^[A-Za-z_][A-Za-z0-9_]*$/, message: '字母、数字、下划线，不能以数字开头' }]}
          >
            <Input placeholder="INTERNAL_API_TOKEN" disabled={editing !== 'new'} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="value" label={editing === 'new' ? '值' : '新值（更新会使旧值失效并递增版本）'} rules={[{ required: true }]}>
            <Input.Password placeholder="值会加密存储，读取受审计" />
          </Form.Item>
          <Form.Item name="description" label="备注（AI 会读取，请写清楚这个变量的作用）" initialValue="">
            <Input.TextArea rows={2} placeholder="内部网关的调用令牌，用于 xxx 服务" />
          </Form.Item>
          <Form.Item
            name="visibleWithoutPermission"
            label="无权限时是否可见（关闭后，未授权成员在清单中也看不到该变量）"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={upsert.isPending} block>
            保存
          </Button>
        </Form>
      </Modal>

      <Modal title="新增读取授权" open={granting} onCancel={() => setGranting(false)} footer={null} destroyOnHidden>
        <Form
          layout="vertical"
          onFinish={(v: { userId: string; variableId?: string; expiresAt?: Dayjs }) => createGrant.mutate(v)}
        >
          <Form.Item name="userId" label="授权给" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={(users.data ?? [])
                .filter((u) => u.id !== me?.id)
                .map((u) => ({ value: u.id, label: `${u.name} <${u.email}>` }))}
            />
          </Form.Item>
          <Form.Item name="variableId" label="范围（不选则授权整个环境）">
            <Select
              allowClear
              placeholder="整个环境"
              options={(variables.data ?? []).map((v) => ({ value: v.id, label: v.key }))}
            />
          </Form.Item>
          <Form.Item name="expiresAt" label="有效期（不填为永久）">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createGrant.isPending} block>
            授权
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
