import type { PushSkillRequest, SkillInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Segmented, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';

export function SkillsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<SkillInfo[]>('GET', '/api/skills') });

  const toggleSubscribe = useMutation({
    mutationFn: (s: SkillInfo) =>
      api(s.subscribed ? 'DELETE' : 'POST', `/api/skills/${s.slug}/subscribe`),
    onSuccess: (_data, s) => {
      message.success(s.subscribed ? '已退订' : '已订阅，本地运行 eat sync 即可落地');
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });

  const create = useMutation({
    mutationFn: (v: PushSkillRequest) => api('POST', '/api/skills/push', v),
    onSuccess: () => {
      message.success('Skill 已创建');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  return (
    <Card
      title="Skill"
      extra={
        <Button type="primary" onClick={() => setCreating(true)}>
          创建 Skill
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        订阅后在本地运行 <Typography.Text code>eat sync</Typography.Text> 即落地到{' '}
        <Typography.Text code>~/.claude/skills</Typography.Text>；本地已有的 skill 目录可用{' '}
        <Typography.Text code>eat skill push &lt;目录&gt;</Typography.Text> 上传纳管。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        loading={skills.isLoading}
        dataSource={skills.data ?? []}
        pagination={false}
        columns={[
          {
            title: 'Skill',
            dataIndex: 'slug',
            render: (slug: string, s) => (
              <Link to={`/skills/${slug}`}>
                <Typography.Text code>{slug}</Typography.Text> {s.name}
              </Link>
            ),
          },
          { title: '触发描述', dataIndex: 'description', ellipsis: true },
          { title: '作者', dataIndex: 'ownerName', width: 110 },
          { title: '版本', dataIndex: 'currentVersion', width: 70, render: (v: number) => `v${v}` },
          {
            title: '可见性',
            dataIndex: 'visibility',
            width: 90,
            render: (v: string) => (v === 'private' ? <Tag>私有</Tag> : <Tag color="blue">团队</Tag>),
          },
          {
            title: '订阅',
            width: 100,
            render: (_: unknown, s: SkillInfo) => (
              <Button
                size="small"
                type={s.subscribed ? 'default' : 'primary'}
                loading={toggleSubscribe.isPending}
                onClick={() => toggleSubscribe.mutate(s)}
              >
                {s.subscribed ? '退订' : '订阅'}
              </Button>
            ),
          },
        ]}
      />
      <Modal title="创建 Skill" open={creating} onCancel={() => setCreating(false)} footer={null} width={640} destroyOnHidden>
        <Form
          layout="vertical"
          onFinish={(v: PushSkillRequest & { private?: boolean }) =>
            create.mutate({ ...v, files: [], visibility: v.private ? 'private' : 'team' })
          }
        >
          <Form.Item
            name="slug"
            label="标识（slug，将作为本地目录名）"
            rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母、数字、连字符' }]}
          >
            <Input placeholder="weekly-report" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="运营周报生成" />
          </Form.Item>
          <Form.Item name="description" label="触发描述（AI 靠它判断何时使用这个 skill）" initialValue="">
            <Input.TextArea rows={2} placeholder="根据运营数据生成周报，适用于每周一汇报" />
          </Form.Item>
          <Form.Item name="content" label="SKILL.md 正文" rules={[{ required: true }]}>
            <Input.TextArea rows={10} style={{ fontFamily: 'monospace' }} placeholder={'# 周报生成\n\n步骤……'} />
          </Form.Item>
          <Form.Item name="private" label="可见性" initialValue={false}>
            <Segmented
              options={[
                { label: '团队可见', value: false },
                { label: '私有', value: true },
              ]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>
            创建（v1）
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}
