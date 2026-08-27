import type { AccessRequestInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, DatePicker, Modal, Space, Table, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { api, ApiError } from '../api';

const STATUS_TAG: Record<string, JSX.Element> = {
  pending: <Tag color="orange">待审批</Tag>,
  approved: <Tag color="green">已批准</Tag>,
  rejected: <Tag color="red">已驳回</Tag>,
};

export function RequestsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState<AccessRequestInfo | null>(null);

  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<AccessRequestInfo[]>('GET', '/api/access-requests/inbox'),
  });
  const mine = useQuery({
    queryKey: ['mine-requests'],
    queryFn: () => api<AccessRequestInfo[]>('GET', '/api/access-requests/mine'),
  });

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected'; grantExpiresAt?: Dayjs }) =>
      api('POST', `/api/access-requests/${v.id}/decision`, {
        decision: v.decision,
        grantExpiresAt: v.grantExpiresAt?.toISOString(),
      }),
    onSuccess: () => {
      message.success('已处理');
      setApproving(null);
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['mine-requests'] });
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const requestColumns = [
    { title: '环境', dataIndex: 'environmentSlug', render: (s: string) => <Typography.Text code>{s}</Typography.Text> },
    {
      title: '变量',
      dataIndex: 'keys',
      render: (keys: string[]) => keys.map((k) => (
        <Typography.Text code key={k} style={{ marginRight: 4 }}>{k}</Typography.Text>
      )),
    },
    { title: '理由', dataIndex: 'reason', ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 90, render: (s: string) => STATUS_TAG[s] },
    { title: '时间', dataIndex: 'createdAt', width: 150, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="待我审批">
        <Table
          rowKey="id"
          loading={inbox.isLoading}
          dataSource={inbox.data ?? []}
          pagination={false}
          locale={{ emptyText: '没有待审批的申请' }}
          columns={[
            { title: '申请人', dataIndex: 'requesterName', width: 110 },
            ...requestColumns,
            {
              title: '操作',
              width: 150,
              render: (_: unknown, row: AccessRequestInfo) => (
                <Space>
                  <Button size="small" type="primary" onClick={() => setApproving(row)}>
                    批准
                  </Button>
                  <Button size="small" danger onClick={() => decide.mutate({ id: row.id, decision: 'rejected' })}>
                    驳回
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title="我发起的申请">
        <Table
          rowKey="id"
          loading={mine.isLoading}
          dataSource={mine.data ?? []}
          pagination={false}
          locale={{ emptyText: '暂无申请。CLI 里 eat env request 或 AI 通过 MCP 也可以发起。' }}
          columns={requestColumns}
        />
      </Card>

      <Modal
        title={`批准 ${approving?.requesterName} 的申请`}
        open={approving !== null}
        onCancel={() => setApproving(null)}
        footer={null}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          {approving?.environmentSlug}: {approving?.keys.join(', ')}
        </Typography.Paragraph>
        <ApproveForm
          loading={decide.isPending}
          onSubmit={(expiresAt) =>
            approving && decide.mutate({ id: approving.id, decision: 'approved', grantExpiresAt: expiresAt })
          }
        />
      </Modal>
    </Space>
  );
}

function ApproveForm({ loading, onSubmit }: { loading: boolean; onSubmit: (expiresAt?: Dayjs) => void }) {
  const [expiresAt, setExpiresAt] = useState<Dayjs | undefined>();
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div>
        授权有效期（不填为永久）：
        <DatePicker showTime style={{ width: '100%', marginTop: 8 }} onChange={(v) => setExpiresAt(v ?? undefined)} />
      </div>
      <Button type="primary" block loading={loading} onClick={() => onSubmit(expiresAt)}>
        确认批准
      </Button>
    </Space>
  );
}
