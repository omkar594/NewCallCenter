import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Server, PhoneCall, Workflow, Table, Megaphone,
  BarChart3, LogOut, Radio
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

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
  const navigate = useNavigate();
  const nav = navForRole(user?.role);

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex h-screen bg-slate-50">
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-200 flex flex-col">
        <div className="flex items-center gap-2 px-4 py-4 text-white font-semibold text-lg border-b border-slate-800">
          <Radio className="w-5 h-5 text-brand-500" />
          CallCenter
        </div>
        <nav className="flex-1 px-2 py-4 space-y-1">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-slate-800 text-xs text-slate-400">
          <div className="text-slate-200 font-medium truncate">{user?.username}</div>
          <div className="truncate">{user?.tenant_name || 'Platform Owner'}</div>
          <button
            onClick={handleLogout}
            className="mt-3 flex items-center gap-2 text-slate-400 hover:text-white text-xs"
          >
            <LogOut className="w-3.5 h-3.5" />
            Log out
          </button>
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
