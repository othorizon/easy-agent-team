import { App, Button, Card, Form, Input, Result, Typography } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';

/** CLI 设备码授权确认页：eat login 引导用户到 /device 输入代码 */
export function DevicePage() {
  const { message } = App.useApp();
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onFinish(values: { userCode: string; tokenName?: string }) {
    setLoading(true);
    try {
      await api('POST', '/api/auth/device/approve', {
        userCode: values.userCode.toUpperCase().trim(),
        tokenName: values.tokenName || undefined,
      });
      setDone(true);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '授权失败');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <Result
        status="success"
        title="授权成功"
        subTitle="回到终端即可，CLI 会自动完成登录。此页面可以关闭。"
        extra={<Button onClick={() => setDone(false)}>继续授权其他设备</Button>}
      />
    );
  }

  return (
    <Card style={{ maxWidth: 480, margin: '48px auto' }}>
      <Typography.Title level={4}>设备授权</Typography.Title>
      <Typography.Paragraph type="secondary">
        在终端运行 <Typography.Text code>eat login</Typography.Text> 后，把终端里显示的代码输入到这里，
        即为该设备上的 CLI / MCP 授权访问你的账号。
      </Typography.Paragraph>
      <Form
        layout="vertical"
        onFinish={onFinish}
        initialValues={{ userCode: params.get('code') ?? '' }}
      >
        <Form.Item
          name="userCode"
          label="设备代码"
          rules={[{ required: true, message: '请输入终端显示的代码' }]}
        >
          <Input placeholder="例如 AB2C-3DEF" style={{ fontFamily: 'monospace', letterSpacing: 2 }} autoFocus />
        </Form.Item>
        <Form.Item name="tokenName" label="设备备注（可选，便于以后在 Token 列表辨认）">
          <Input placeholder="例如 我的工作笔记本" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} block>
          确认授权
        </Button>
      </Form>
    </Card>
  );
}
