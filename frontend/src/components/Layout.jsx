import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Server, PhoneCall, Workflow, Table, Megaphone,
  BarChart3, LogOut, Radio, Sun, Moon
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';

const SUPER_ADMIN_NAV = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/onboard', label: 'Onboard Client', icon: Users },
  { to: '/admin/ports', label: 'Gateways & Ports', icon: Server },
  { to: '/admin/logs', label: 'Call Logs', icon: PhoneCall }
];

const TENANT_NAV = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/flows', label: 'IVR Flows', icon: Workflow },
  { to: '/app/lookup-tables', label: 'Lookup Tables', icon: Table },
  { to: '/app/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/app/agents', label: 'Agents', icon: Users },
  { to: '/app/analytics', label: 'Analytics', icon: BarChart3 }
];

function navForRole(role) {
  if (role === 'super_admin') return SUPER_ADMIN_NAV;
  return TENANT_NAV;
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const nav = navForRole(user?.role);

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex h-screen bg-[#f3f6f5] dark:bg-abyss-900">
      <aside className="w-60 shrink-0 bg-ink-900 dark:bg-abyss-800 text-ink-200 flex flex-col dark:border-r dark:border-neon-cyan/10">
        <div className="flex items-center gap-2 px-4 py-4 text-white font-semibold text-lg border-b border-ink-700 dark:border-abyss-300/30">
          <Radio className="w-5 h-5 text-brand-400 dark:text-neon-cyan dark:drop-shadow-[0_0_6px_rgba(0,240,255,0.6)]" />
          CallCenter
        </div>
        <nav className="flex-1 px-2 py-4 space-y-1">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-brand-500 text-white dark:bg-neon-cyan/10 dark:text-neon-cyan dark:shadow-[inset_0_0_0_1px_rgba(0,240,255,0.4)]'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-white dark:hover:bg-abyss-300/20'
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-ink-700 dark:border-abyss-300/30 text-xs text-ink-400">
          <div className="text-ink-100 font-medium truncate">{user?.username}</div>
          <div className="truncate">{user?.tenant_name || 'Platform Owner'}</div>
          <div className="mt-3 flex items-center justify-between">
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-ink-400 hover:text-white text-xs"
            >
              <LogOut className="w-3.5 h-3.5" />
              Log out
            </button>
            <button
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex items-center justify-center w-6 h-6 rounded-md text-ink-400 hover:text-white hover:bg-ink-800 dark:hover:bg-abyss-300/20 dark:hover:text-neon-cyan transition-colors"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
