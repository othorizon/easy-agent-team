import type { LoginResponse, RegistrationSettings } from '@eat/shared';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, setSession } from '../api';

export function LoginPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [registration, setRegistration] = useState<RegistrationSettings | null>(null);

  useEffect(() => {
    api<RegistrationSettings>('GET', '/api/auth/registration')
      .then(setRegistration)
      .catch(() => setRegistration(null));
  }, []);

  const suffixes = registration?.allowedEmailSuffixes ?? [];

  async function onFinish(values: { name?: string; email: string; password: string }) {
    setLoading(true);
    try {
      const res =
        mode === 'register'
          ? await api<LoginResponse>('POST', '/api/auth/register', values)
          : await api<LoginResponse>('POST', '/api/auth/login', { email: values.email, password: values.password });
      setSession(res.token, res.user);
      navigate(params.get('next') ?? '/', { replace: true });
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : mode === 'register' ? '注册失败' : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={4} style={{ textAlign: 'center' }}>
          🎛️ easy-agent-team
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          团队 AI 能力集中管理与分发平台
        </Typography.Paragraph>
        <Form key={mode} layout="vertical" onFinish={onFinish}>
          {mode === 'register' && (
            <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
              <Input autoFocus placeholder="张三" />
            </Form.Item>
          )}
          <Form.Item
            name="email"
            label="邮箱"
            extra={mode === 'register' && suffixes.length > 0 ? `仅允许 ${suffixes.join(' / ')} 后缀的邮箱` : undefined}
            rules={[
              { required: true, type: 'email' },
              ...(mode === 'register' && suffixes.length > 0
                ? [
                    {
                      validator: (_: unknown, v: string) =>
                        !v || suffixes.some((s) => v.toLowerCase().endsWith(s))
                          ? Promise.resolve()
                          : Promise.reject(new Error(`仅允许 ${suffixes.join(' / ')} 后缀的邮箱`)),
                    },
                  ]
                : []),
            ]}
          >
            <Input autoFocus={mode === 'login'} placeholder={suffixes.length > 0 ? `you${suffixes[0]}` : 'you@team.com'} />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={mode === 'register' ? [{ required: true, min: 8, message: '至少 8 位' }] : [{ required: true }]}
          >
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {mode === 'register' ? '注册并登录' : '登录'}
          </Button>
        </Form>
        {registration?.enabled && (
          <Typography.Paragraph style={{ textAlign: 'center', marginTop: 16, marginBottom: 0 }}>
            {mode === 'login' ? (
              <>
                没有账号？<Typography.Link onClick={() => setMode('register')}>注册</Typography.Link>
              </>
            ) : (
              <>
                已有账号？<Typography.Link onClick={() => setMode('login')}>登录</Typography.Link>
              </>
            )}
          </Typography.Paragraph>
        )}
      </Card>
    </div>
  );
}
