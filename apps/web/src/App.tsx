import { Button, Layout, Menu, Space, Typography } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { clearSession, getStoredUser, getToken } from './api';
import { DevicePage } from './pages/Device';
import { EnvDetailPage } from './pages/EnvDetail';
import { EnvsPage } from './pages/Envs';
import { LoginPage } from './pages/Login';
import { RequestsPage } from './pages/Requests';

function Shell({ children }: { children: React.ReactNode }) {
  const user = getStoredUser();
  const navigate = useNavigate();
  const location = useLocation();
  const selected = location.pathname.startsWith('/requests')
    ? '/requests'
    : location.pathname.startsWith('/device')
      ? '/device'
      : '/';
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Typography.Text strong style={{ color: '#fff', fontSize: 16, whiteSpace: 'nowrap' }}>
          🎛️ easy-agent-team
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          onClick={(e) => navigate(e.key)}
          style={{ flex: 1, minWidth: 0 }}
          items={[
            { key: '/', label: '环境变量' },
            { key: '/requests', label: '权限申请' },
            { key: '/device', label: '设备授权' },
          ]}
        />
        <Space>
          <Typography.Text style={{ color: 'rgba(255,255,255,0.75)' }}>
            {user?.name}
            {user?.role === 'admin' ? '（管理员）' : ''}
          </Typography.Text>
          <Button
            size="small"
            onClick={() => {
              clearSession();
              navigate('/login');
            }}
          >
            退出
          </Button>
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 24, maxWidth: 1100, width: '100%', margin: '0 auto' }}>
        {children}
      </Layout.Content>
    </Layout>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken()) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><EnvsPage /></RequireAuth>} />
      <Route path="/envs/:slug" element={<RequireAuth><EnvDetailPage /></RequireAuth>} />
      <Route path="/requests" element={<RequireAuth><RequestsPage /></RequireAuth>} />
      <Route path="/device" element={<RequireAuth><DevicePage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
