import type { CreateDbInstanceRequest, DbAssignmentInfo, DbInstanceInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, getStoredUser } from '../api';

const STATUS_TAG: Record<string, JSX.Element> = {
  pending: <Tag color="orange">待批准</Tag>,
  active: <Tag color="green">可用</Tag>,
  failed: <Tag color="red">执行失败</Tag>,
  rejected: <Tag>已驳回</Tag>,
  disabled: <Tag color="volcano">已禁用</Tag>,
  deleted: <Tag>已删除</Tag>,
};

export function DbsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const [addingInstance, setAddingInstance] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const instances = useQuery({ queryKey: ['db-instances'], queryFn: () => api<DbInstanceInfo[]>('GET', '/api/db/instances') });
  const mine = useQuery({ queryKey: ['db-mine'], queryFn: () => api<DbAssignmentInfo[]>('GET', '/api/db/assignments/mine') });
  const all = useQuery({
    queryKey: ['db-all'],
    queryFn: () => api<DbAssignmentInfo[]>('GET', '/api/db/assignments'),
    enabled: isAdmin,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['db-instances'] });
    void queryClient.invalidateQueries({ queryKey: ['db-mine'] });
    void queryClient.invalidateQueries({ queryKey: ['db-all'] });
  };

  const addInstance = useMutation({
    mutationFn: (v: CreateDbInstanceRequest) => api('POST', '/api/db/instances', v),
    onSuccess: () => {
      message.success('实例已登记');
      setAddingInstance(false);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '登记失败'),
  });

  const request = useMutation({
    mutationFn: (v: { instanceId: string; dbName: string; purpose: string }) => api('POST', '/api/db/assignments', v),
    onSuccess: () => {
      message.success('申请已提交，等待管理员批准');
      setRequesting(false);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '申请失败'),
  });

  const act = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject' | 'disable' | 'enable' | 'delete' }) =>
      v.action === 'delete'
        ? api('DELETE', `/api/db/assignments/${v.id}`)
        : api('POST', `/api/db/assignments/${v.id}/${v.action}`, {}),
    onSuccess: (res: unknown) => {
      const r = res as DbAssignmentInfo;
      if (r.status === 'failed') message.error(`执行失败：${r.error}`);
      else message.success('已处理');
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const removeInstance = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/db/instances/${id}`),
    onSuccess: () => {
      message.success('实例已删除');
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '删除失败'),
  });

  const assignmentColumns = (admin: boolean) => [
    { title: '库', dataIndex: 'dbName', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '实例', dataIndex: 'instanceName', width: 130 },
    ...(admin ? [{ title: '申请人', dataIndex: 'requesterName', width: 100 }] : []),
    { title: '用途', dataIndex: 'purpose', ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 95, render: (s: string) => STATUS_TAG[s] },
    {
      title: '凭证',
      dataIndex: 'environmentSlug',
      width: 170,
      render: (slug: string | null, r: DbAssignmentInfo) =>
        slug ? (
          <Link to={`/envs/${slug}`}><Typography.Text code>{slug}</Typography.Text></Link>
        ) : r.error ? (
          <Typography.Text type="danger" ellipsis title={r.error}>{r.error}</Typography.Text>
        ) : (
          '—'
        ),
    },
    ...(admin
      ? [
          {
            title: '操作',
            width: 200,
            render: (_: unknown, r: DbAssignmentInfo) => (
              <Space wrap>
                {r.status === 'pending' && (
                  <>
                    <Button size="small" type="primary" onClick={() => act.mutate({ id: r.id, action: 'approve' })} loading={act.isPending}>
                      批准并建库
                    </Button>
                    <Button size="small" onClick={() => act.mutate({ id: r.id, action: 'reject' })}>驳回</Button>
                  </>
                )}
                {r.status === 'active' && <Button size="small" onClick={() => act.mutate({ id: r.id, action: 'disable' })}>禁用</Button>}
                {r.status === 'disabled' && <Button size="small" onClick={() => act.mutate({ id: r.id, action: 'enable' })}>恢复</Button>}
                {['active', 'disabled', 'failed', 'rejected'].includes(r.status) && (
                  <Popconfirm
                    title="删除分配记录？"
                    description={
                      <div style={{ maxWidth: 320 }}>
                        仅删除平台上的记录与凭证环境，<b>不会</b>删除实例上的数据库与账号；
                        如需彻底清理，只能到数据库实例上手动删除。
                      </div>
                    }
                    onConfirm={() => act.mutate({ id: r.id, action: 'delete' })}
                  >
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title="数据库实例"
        extra={isAdmin && <Button type="primary" onClick={() => setAddingInstance(true)}>登记实例</Button>}
      >
        <Typography.Paragraph type="secondary">
          团队共享的数据库实例（面向日常项目，非生产核心）。成员申请后由管理员批准，平台自动建库建号，凭证以环境变量形式下发。
        </Typography.Paragraph>
        <Table
          rowKey="id"
          loading={instances.isLoading}
          dataSource={instances.data ?? []}
          pagination={false}
          locale={{ emptyText: '暂无实例（由管理员登记）' }}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '类型', dataIndex: 'engine', width: 90 },
            { title: '地址', render: (_: unknown, r: DbInstanceInfo) => <Typography.Text code>{r.host}:{r.port}</Typography.Text> },
            { title: '已分配', dataIndex: 'assignmentCount', width: 80 },
            { title: '备注', dataIndex: 'note', ellipsis: true },
            ...(isAdmin
              ? [
                  {
                    title: '操作',
                    width: 90,
                    render: (_: unknown, r: DbInstanceInfo) => (
                      <Popconfirm title="删除实例登记（不影响实例本身）？" onConfirm={() => removeInstance.mutate(r.id)}>
                        <Button size="small" danger>删除</Button>
                      </Popconfirm>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <Card title="我的数据库" extra={<Button type="primary" onClick={() => setRequesting(true)}>申请数据库</Button>}>
        <Table
          rowKey="id"
          loading={mine.isLoading}
          dataSource={mine.data ?? []}
          pagination={false}
          locale={{ emptyText: '暂无。点击"申请数据库"，批准后凭证会出现在你的环境列表里。' }}
          columns={assignmentColumns(false)}
        />
      </Card>

      {isAdmin && (
        <Card title="全部分配（管理员）">
          <Table rowKey="id" loading={all.isLoading} dataSource={all.data ?? []} pagination={false} columns={assignmentColumns(true)} />
        </Card>
      )}

      <Modal title="登记数据库实例" open={addingInstance} onCancel={() => setAddingInstance(false)} footer={null} destroyOnHidden>
        <Form
          layout="vertical"
          initialValues={{ engine: 'postgres', port: 5432, adminPassword: '', note: '' }}
          onFinish={(v: CreateDbInstanceRequest) => addInstance.mutate(v)}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="团队测试 PG" />
          </Form.Item>
          <Form.Item name="engine" label="类型">
            <Segmented options={[{ label: 'PostgreSQL', value: 'postgres' }, { label: 'MySQL（暂不支持自动建库）', value: 'mysql' }]} />
          </Form.Item>
          <Form.Item name="host" label="主机" rules={[{ required: true }]}>
            <Input placeholder="db.internal.example.com" />
          </Form.Item>
          <Form.Item name="port" label="端口" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="adminUser" label="管理账号" rules={[{ required: true }]}>
            <Input placeholder="postgres" />
          </Form.Item>
          <Form.Item name="adminPassword" label="管理密码（加密存储）">
            <Input.Password />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="用途说明" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={addInstance.isPending} block>登记</Button>
        </Form>
      </Modal>

      <Modal title="申请数据库" open={requesting} onCancel={() => setRequesting(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" onFinish={(v: { instanceId: string; dbName: string; purpose: string }) => request.mutate(v)}>
          <Form.Item name="instanceId" label="实例" rules={[{ required: true }]}>
            <Select options={(instances.data ?? []).map((i) => ({ value: i.id, label: `${i.name}（${i.engine} ${i.host}:${i.port}）` }))} />
          </Form.Item>
          <Form.Item
            name="dbName"
            label="库名（也用于生成账号名与凭证环境名）"
            rules={[{ required: true }, { pattern: /^[a-z][a-z0-9_]{2,30}$/, message: '小写字母开头，字母/数字/下划线，3-31 位' }]}
          >
            <Input placeholder="proj_crm" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="purpose" label="用途（给管理员看）" rules={[{ required: true }]}>
            <Input.TextArea rows={2} placeholder="CRM 小工具的数据存储" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={request.isPending} block>提交申请</Button>
        </Form>
      </Modal>
    </Space>
  );
}
