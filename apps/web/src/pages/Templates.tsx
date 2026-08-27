import type { EnvironmentInfo, McpConfigInfo, SetTemplateItemsRequest, SkillInfo, TemplateInfo } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Empty, Form, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { api, ApiError, getStoredUser } from '../api';

const TYPE_LABEL: Record<string, string> = { skill: 'Skill', mcp_config: 'MCP', environment: '环境' };

export function TemplatesPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const [creating, setCreating] = useState(false);
  const [editingItems, setEditingItems] = useState<TemplateInfo | null>(null);

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<TemplateInfo[]>('GET', '/api/templates') });
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<SkillInfo[]>('GET', '/api/skills'), enabled: isAdmin });
  const mcpConfigs = useQuery({ queryKey: ['mcp-configs'], queryFn: () => api<McpConfigInfo[]>('GET', '/api/mcp-configs'), enabled: isAdmin });
  const envs = useQuery({ queryKey: ['envs'], queryFn: () => api<EnvironmentInfo[]>('GET', '/api/envs'), enabled: isAdmin });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['templates'] });

  const create = useMutation({
    mutationFn: (v: { name: string; description: string }) => api('POST', '/api/templates', v),
    onSuccess: () => {
      message.success('模板已创建，接着为它配置条目');
      setCreating(false);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '创建失败'),
  });

  const setItems = useMutation({
    mutationFn: (v: { id: string } & SetTemplateItemsRequest) => api('PUT', `/api/templates/${v.id}/items`, { items: v.items }),
    onSuccess: () => {
      message.success('条目已保存');
      setEditingItems(null);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : '保存失败'),
  });

  const select = useMutation({
    mutationFn: (t: TemplateInfo) => api('POST', t.selectedByMe ? '/api/templates/deselect' : `/api/templates/${t.id}/select`, {}),
    onSuccess: (_d, t) => {
      message.success(t.selectedByMe ? '已取消选用' : '已选用，本地 eat sync 即可获得模板内容');
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/templates/${id}`),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
  });

  return (
    <Card
      title="角色模板"
      extra={isAdmin && <Button type="primary" onClick={() => setCreating(true)}>新建模板</Button>}
    >
      <Typography.Paragraph type="secondary">
        模板是管理员预定义的「能力套餐」（一组 Skill + MCP 配置 + 环境引用）。选用后，模板里的 Skill 与 MCP
        配置自动进入你的同步范围（eat sync 落地），不想要的条目可以单独退订。
      </Typography.Paragraph>
      {(templates.data ?? []).length === 0 && <Empty description="还没有模板" />}
      <Space direction="vertical" style={{ width: '100%' }}>
        {(templates.data ?? []).map((t) => (
          <Card key={t.id} size="small" type="inner"
            title={<>{t.name} {t.selectedByMe && <Tag color="green">已选用</Tag>}</>}
            extra={
              <Space>
                <Button size="small" type={t.selectedByMe ? 'default' : 'primary'} onClick={() => select.mutate(t)}>
                  {t.selectedByMe ? '取消选用' : '选用'}
                </Button>
                {isAdmin && <Button size="small" onClick={() => setEditingItems(t)}>配置条目</Button>}
                {isAdmin && <Button size="small" danger onClick={() => remove.mutate(t.id)}>删除</Button>}
              </Space>
            }
          >
            {t.description && <Typography.Paragraph type="secondary">{t.description}</Typography.Paragraph>}
            {t.items.length === 0 ? (
              <Typography.Text type="secondary">（空模板）</Typography.Text>
            ) : (
              t.items.map((i) => (
                <Tag key={`${i.itemType}:${i.itemId}`}>
                  {TYPE_LABEL[i.itemType]}: {i.slug}
                </Tag>
              ))
            )}
          </Card>
        ))}
      </Space>

      <Modal title="新建模板" open={creating} onCancel={() => setCreating(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" onFinish={(v: { name: string; description: string }) => create.mutate(v)}>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="运营 / 测试 / 客服…" />
          </Form.Item>
          <Form.Item name="description" label="说明" initialValue="">
            <Input.TextArea rows={2} placeholder="适用于哪类岗位、包含什么能力" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block>创建</Button>
        </Form>
      </Modal>

      <Modal
        title={`配置条目：${editingItems?.name}`}
        open={editingItems !== null}
        onCancel={() => setEditingItems(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          initialValues={{
            skills: editingItems?.items.filter((i) => i.itemType === 'skill').map((i) => i.itemId) ?? [],
            mcp: editingItems?.items.filter((i) => i.itemType === 'mcp_config').map((i) => i.itemId) ?? [],
            envs: editingItems?.items.filter((i) => i.itemType === 'environment').map((i) => i.itemId) ?? [],
          }}
          onFinish={(v: { skills: string[]; mcp: string[]; envs: string[] }) =>
            editingItems &&
            setItems.mutate({
              id: editingItems.id,
              items: [
                ...v.skills.map((id) => ({ itemType: 'skill' as const, itemId: id })),
                ...v.mcp.map((id) => ({ itemType: 'mcp_config' as const, itemId: id })),
                ...v.envs.map((id) => ({ itemType: 'environment' as const, itemId: id })),
              ],
            })
          }
        >
          <Form.Item name="skills" label="Skill">
            <Select mode="multiple" optionFilterProp="label" options={(skills.data ?? []).map((s) => ({ value: s.id, label: `${s.slug} — ${s.name}` }))} />
          </Form.Item>
          <Form.Item name="mcp" label="MCP 配置">
            <Select mode="multiple" optionFilterProp="label" options={(mcpConfigs.data ?? []).map((c) => ({ value: c.id, label: `${c.slug} — ${c.name}` }))} />
          </Form.Item>
          <Form.Item name="envs" label="环境引用（展示引导用，不代表授权）">
            <Select mode="multiple" optionFilterProp="label" options={(envs.data ?? []).map((e) => ({ value: e.id, label: `${e.slug} — ${e.name}` }))} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={setItems.isPending} block>保存</Button>
        </Form>
      </Modal>
    </Card>
  );
}
