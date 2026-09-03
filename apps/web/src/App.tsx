import {
  Database,
  Download,
  KeyRound,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  Menu,
  MonitorSmartphone,
  Plug,
  Rocket,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { clearSession, getStoredUser, getToken } from './api';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from './components/ui/sheet';
import { cn } from './lib/utils';
import { DbsPage } from './pages/Dbs';
import { DevicePage } from './pages/Device';
import { EnvDetailPage } from './pages/EnvDetail';
import { EnvsPage } from './pages/Envs';
import { HelpPage } from './pages/Help';
import { HelpDetailPage } from './pages/HelpDetail';
import { InstallPage } from './pages/Install';
import { LoginPage } from './pages/Login';
import { McpConfigsPage } from './pages/McpConfigs';
import { AppsPage } from './pages/Apps';
import { RequestsPage } from './pages/Requests';
import { SettingsPage } from './pages/Settings';
import { SkillDetailPage } from './pages/SkillDetail';
import { SkillsPage } from './pages/Skills';
import { TemplatesPage } from './pages/Templates';
import { UsersPage } from './pages/Users';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 详情页路径前缀，用于高亮父级菜单 */
  match?: string[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: '能力分发',
    items: [
      { to: '/', label: '环境变量', icon: KeyRound, match: ['/envs'] },
      { to: '/skills', label: 'Skill', icon: Sparkles },
      { to: '/mcp', label: 'MCP 配置', icon: Plug },
      { to: '/templates', label: '角色模板', icon: LayoutGrid },
    ],
  },
  {
    label: '协作',
    items: [
      { to: '/help', label: '求助', icon: LifeBuoy },
      { to: '/requests', label: '权限申请', icon: ShieldCheck },
    ],
  },
  {
    label: '资源',
    items: [
      { to: '/db', label: '数据库', icon: Database },
      { to: '/apps', label: '应用', icon: Rocket },
    ],
  },
  {
    label: '接入',
    items: [
      { to: '/install', label: '安装 CLI', icon: Download },
      { to: '/device', label: '设备授权', icon: MonitorSmartphone },
    ],
  },
];

const ADMIN_GROUP: NavGroup = {
  label: '管理',
  items: [
    { to: '/users', label: '用户', icon: Users },
    { to: '/settings', label: '系统设置', icon: Settings },
  ],
};

function isActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/' || (item.match ?? []).some((m) => pathname.startsWith(m));
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 px-2 outline-none">
      <span className="flex size-7 items-center justify-center rounded-lg bg-primary font-mono text-sm font-bold text-primary-foreground">
        e
      </span>
      <span className="text-[15px] font-semibold tracking-tight">easy-agent-team</span>
    </Link>
  );
}

function NavList({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-2 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/70">
            {group.label}
          </div>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(item, pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={onNavigate}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    active
                      ? 'bg-primary/8 font-medium text-primary'
                      : 'text-foreground/70 hover:bg-accent hover:text-foreground',
                  )}
                >
                  <item.icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function UserMenu({ compact }: { compact?: boolean }) {
  const user = getStoredUser();
  const navigate = useNavigate();
  const initial = (user?.name ?? '?').slice(0, 1).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            aria-label="账号菜单"
            className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer"
          >
            {initial}
          </button>
        ) : (
          <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initial}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                {user?.name}
                {user?.role === 'admin' && <Badge variant="secondary" className="px-1.5 text-[10px]">管理员</Badge>}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
            </span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={compact ? 'bottom' : 'top'} className="w-52">
        <DropdownMenuLabel>
          <div className="text-sm font-medium text-foreground">{user?.name}</div>
          <div className="truncate">{user?.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onSelect={() => {
            clearSession();
            navigate('/login');
          }}
        >
          <LogOut />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const user = getStoredUser();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const groups = user?.role === 'admin' ? [...NAV_GROUPS, ADMIN_GROUP] : NAV_GROUPS;

  return (
    <div className="min-h-dvh">
      {/* 桌面侧边栏 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center border-b px-3">
          <Brand />
        </div>
        <NavList groups={groups} />
        <div className="border-t p-2">
          <UserMenu />
        </div>
      </aside>

      {/* 移动端顶栏 */}
      <header className="sticky top-0 z-30 flex h-13 items-center gap-1 border-b bg-background/90 px-3 backdrop-blur lg:hidden">
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="打开导航">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" aria-describedby={undefined}>
            <div className="flex h-14 items-center border-b px-3">
              <SheetTitle asChild>
                <Brand />
              </SheetTitle>
            </div>
            <NavList groups={groups} onNavigate={() => setMobileNavOpen(false)} />
          </SheetContent>
        </Sheet>
        <div className="flex-1">
          <Brand />
        </div>
        <UserMenu compact />
      </header>

      {/* 内容区 */}
      <main className="lg:pl-60">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-8">{children}</div>
      </main>
    </div>
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
      <Route path="/apps" element={<RequireAuth><AppsPage /></RequireAuth>} />
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
