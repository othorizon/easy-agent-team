import type { RegistrationSettings } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, ApiError, getStoredUser } from '../api';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
}

/** 用户管理（仅管理员）：建号、改角色、禁用/启用、重置密码 */
export function UsersPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('GET', '/api/users') });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['users'] });
  const onError = (err: unknown) => message.error(err instanceof ApiError ? err.message : '操作失败');

  const create = useMutation({
    mutationFn: (v: { name: string; email: string; password: string; role: 'admin' | 'member' }) =>
      api('POST', '/api/users', v),
    onSuccess: () => {
      message.success('用户已创建，请把平台地址和初始密码告知对方');
      setCreating(false);
      invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: (v: { id: string; role?: 'admin' | 'member'; status?: 'active' | 'disabled' }) =>
      api('PATCH', `/api/users/${v.id}`, { role: v.role, status: v.status }),
    onSuccess: (_d, v) => {
      message.success(v.status === 'disabled' ? '已禁用（其全部 Token 已吊销）' : '已更新');
      invalidate();
    },
    onError,
  });

  const resetPassword = useMutation({
    mutationFn: (v: { id: string; password: string }) => api('POST', `/api/users/${v.id}/password`, { password: v.password }),
    onSuccess: () => {
      message.success('密码已重置（其全部 Token 已吊销，需重新登录）');
      setResetting(null);
    },
    onError,
  });

  const registration = useQuery({
    queryKey: ['registration-settings'],
    queryFn: () => api<RegistrationSettings>('GET', '/api/admin/registration-settings'),
  });
  const saveRegistration = useMutation({
    mutationFn: (v: RegistrationSettings) => api('PUT', '/api/admin/registration-settings', v),
    onSuccess: () => {
      message.success('注册设置已保存');
      void queryClient.invalidateQueries({ queryKey: ['registration-settings'] });
    },
    onError,
  });

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <Card title="开放注册">
      <Typography.Paragraph type="secondary">
        开启后登录页出现「注册」入口，任何能访问平台的人都可自助注册为<strong>成员</strong>账号。
        可用邮箱后缀限制注册范围（如 @your-company.com）；留空表示任意邮箱都可注册。
      </Typography.Paragraph>
      {registration.data && (
        <Form
          layout="inline"
          initialValues={registration.data}
          onFinish={(v: RegistrationSettings) => saveRegistration.mutate({ ...v, allowedEmailSuffixes: v.allowedEmailSuffixes ?? [] })}
        >
          <Form.Item name="enabled" label="开放注册" valuePropName="checked">
            <Switch checkedChildren="开" unCheckedChildren="关" />
          </Form.Item>
          <Form.Item name="allowedEmailSuffixes" label="允许的邮箱后缀" style={{ minWidth: 360 }}>
            <Select
              mode="tags"
              tokenSeparators={[',', ' ']}
              placeholder="回车添加，如 @example.com；留空 = 任意邮箱"
              open={false}
              suffixIcon={null}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saveRegistration.isPending}>
            保存
          </Button>
        </Form>
      )}
    </Card>

    <Card title="用户管理" extra={<Button type="primary" onClick={() => setCreating(true)}>新建用户</Button>}>
      <Typography.Paragraph type="secondary">
        账号由管理员创建后线下告知初始密码。禁用立即生效（吊销全部 Token）；重置密码同样会吊销 Token，强制重新登录。
        不能修改自己的角色或状态，避免锁死唯一管理员。
      </Typography.Paragraph>
      <Table<UserRow>
        rowKey="id"
        size="small"
        loading={users.isLoading}
        dataSource={users.data ?? []}
        pagination={false}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '邮箱', dataIndex: 'email' },
          {
            title: '角色',
            dataIndex: 'role',
            width: 140,
            render: (role: UserRow['role'], row) =>
              row.id === me?.id ? (
                <Tag color={role === 'admin' ? 'gold' : undefined}>{role === 'admin' ? '管理员' : '成员'}（我）</Tag>
              ) : (
                <Select<UserRow['role']>
                  size="small"
                  value={role}
                  style={{ width: 96 }}
                  onChange={(v) => update.mutate({ id: row.id, role: v })}
                  options={[
                    { value: 'admin', label: '管理员' },
                    { value: 'member', label: '成员' },
                  ]}
                />
              ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (s: UserRow['status']) => (s === 'active' ? <Tag color="green">正常</Tag> : <Tag color="red">已禁用</Tag>),
          },
          {
            title: '操作',
            width: 200,
            render: (_: unknown, row) =>
              row.id === me?.id ? null : (
                <Space>
                  <Button size="small" onClick={() => setResetting(row)}>重置密码</Button>
                  {row.status === 'active' ? (
                    <Popconfirm
                      title={`禁用 ${row.name}？其全部 Token 将被吊销`}
                      onConfirm={() => update.mutate({ id: row.id, status: 'disabled' })}
                    >
                      <Button size="small" danger>禁用</Button>
                    </Popconfirm>
                  ) : (
                    <Button size="small" onClick={() => update.mutate({ id: row.id, status: 'active' })}>启用</Button>
                  )}
                </Space>
              ),
          },
        ]}
      />

      <Modal title="新建用户" open={creating} onCancel={() => setCreating(false)} footer={null} destroyOnHidden>
        <Form
          layout="vertical"
          initialValues={{ role: 'member' }}
          onFinish={(v: { name: string; email: string; password: string; role: 'admin' | 'member' }) => create.mutate(v)}
        >
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input placeholder="张三" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
            <Input placeholder="zhangsan@example.com" />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
            <Input.Password placeholder="至少 8 位，创建后线下告知对方" />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select
              options={[
                { value: 'member', label: '成员' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>
            创建
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`重置密码：${resetting?.name ?? ''}`}
        open={resetting !== null}
        onCancel={() => setResetting(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          onFinish={(v: { password: string }) => resetting && resetPassword.mutate({ id: resetting.id, password: v.password })}
        >
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={resetPassword.isPending} block>
            重置
          </Button>
        </Form>
      </Modal>
    </Card>
    </Space>
  );
}
