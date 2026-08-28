import { Button, Layout, Menu, Space, Typography } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { clearSession, getStoredUser, getToken } from './api';
import { DbsPage } from './pages/Dbs';
import { DevicePage } from './pages/Device';
import { EnvDetailPage } from './pages/EnvDetail';
import { EnvsPage } from './pages/Envs';
import { HelpPage } from './pages/Help';
import { InstallPage } from './pages/Install';
import { McpConfigsPage } from './pages/McpConfigs';
import { ProjectsPage } from './pages/Projects';
import { TemplatesPage } from './pages/Templates';
import { HelpDetailPage } from './pages/HelpDetail';
import { LoginPage } from './pages/Login';
import { RequestsPage } from './pages/Requests';
import { SettingsPage } from './pages/Settings';
import { SkillDetailPage } from './pages/SkillDetail';
import { SkillsPage } from './pages/Skills';
import { UsersPage } from './pages/Users';

function Shell({ children }: { children: React.ReactNode }) {
  const user = getStoredUser();
  const navigate = useNavigate();
  const location = useLocation();
  const first = `/${location.pathname.split('/')[1] ?? ''}`;
  const selected = ['/skills', '/templates', '/mcp', '/db', '/projects', '/requests', '/help', '/device', '/install', '/users', '/settings'].includes(
    first,
  )
    ? first
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
            { key: '/skills', label: 'Skill' },
            { key: '/templates', label: '模板' },
            { key: '/mcp', label: 'MCP' },
            { key: '/db', label: '数据库' },
            { key: '/projects', label: '项目' },
            { key: '/help', label: '求助' },
            { key: '/requests', label: '权限申请' },
            { key: '/device', label: '设备授权' },
            { key: '/install', label: '安装 CLI' },
            ...(user?.role === 'admin'
              ? [
                  { key: '/users', label: '用户' },
                  { key: '/settings', label: '系统设置' },
                ]
              : []),
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
      <Route path="/skills" element={<RequireAuth><SkillsPage /></RequireAuth>} />
      <Route path="/skills/:slug" element={<RequireAuth><SkillDetailPage /></RequireAuth>} />
      <Route path="/templates" element={<RequireAuth><TemplatesPage /></RequireAuth>} />
      <Route path="/mcp" element={<RequireAuth><McpConfigsPage /></RequireAuth>} />
      <Route path="/db" element={<RequireAuth><DbsPage /></RequireAuth>} />
      <Route path="/projects" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
      <Route path="/requests" element={<RequireAuth><RequestsPage /></RequireAuth>} />
      <Route path="/help" element={<RequireAuth><HelpPage /></RequireAuth>} />
      <Route path="/help/:id" element={<RequireAuth><HelpDetailPage /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
      <Route path="/users" element={<RequireAuth><UsersPage /></RequireAuth>} />
      <Route path="/install" element={<RequireAuth><InstallPage /></RequireAuth>} />
      <Route path="/device" element={<RequireAuth><DevicePage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
