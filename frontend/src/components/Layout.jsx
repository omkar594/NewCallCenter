import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Server, PhoneCall, Workflow, Table, Megaphone,
  BarChart3, LogOut, Phone, Sun, Moon, Search
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';

// Nav is grouped the way the mockup groups it - an operational "Workspace" block and a
// "Guardrails" block for the compliance-flavoured screens - rather than one flat list.
const SUPER_ADMIN_NAV = [
  {
    label: 'Workspace',
    items: [
      { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/admin/onboard', label: 'Onboard client', icon: Users },
      { to: '/admin/ports', label: 'SIM gateways', icon: Server }
    ]
  },
  {
    label: 'Guardrails',
    items: [{ to: '/admin/logs', label: 'Call logs', icon: PhoneCall }]
  }
];

const TENANT_NAV = [
  {
    label: 'Workspace',
    items: [
      { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/app/campaigns', label: 'Campaigns', icon: Megaphone },
      { to: '/app/flows', label: 'IVR flows', icon: Workflow, feature: 'ivrEnabled' },
      { to: '/app/agents', label: 'Softphone & agents', icon: Users, feature: 'agentsEnabled' }
    ]
  },
  {
    label: 'Guardrails',
    items: [
      { to: '/app/lookup-tables', label: 'Lookup tables', icon: Table, feature: 'ivrEnabled' },
      { to: '/app/analytics', label: 'Analytics', icon: BarChart3 }
    ]
  }
];

// Hides nav entries for capabilities this client didn't buy. Purely cosmetic - the same features
// are enforced server-side by backend/middleware/tenantFeature.js, so nothing here is a security
// boundary; it just avoids showing an outbound-only client menus that would only 403.
//
// A missing `features` (super admin, or /me not answered yet) shows everything rather than
// flashing a stripped-down nav that then fills back in.
function navForRole(role, features) {
  if (role === 'super_admin') return SUPER_ADMIN_NAV;
  if (!features) return TENANT_NAV;
  return TENANT_NAV
    .map((group) => ({ ...group, items: group.items.filter((i) => !i.feature || features[i.feature]) }))
    .filter((group) => group.items.length > 0);
}

// The header shows the current screen's name. Deriving it from the nav definition keeps it in
// sync automatically; detail routes that aren't in the nav fall back to their parent's label.
function titleForPath(groups, pathname) {
  const items = groups.flatMap((g) => g.items);
  const exact = items.find((i) => i.to === pathname);
  if (exact) return exact.label;
  const parent = items
    .filter((i) => i.to !== '/app' && i.to !== '/admin' && pathname.startsWith(i.to))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return parent ? parent.label : 'Console';
}

function initials(name) {
  if (!name) return '--';
  const parts = name.trim().split(/[\s_-]+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

export default function Layout() {
  const { user, logout, features } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const groups = navForRole(user?.role, features);

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const now = new Date();
  const dateLine = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="flex h-screen bg-canvas dark:bg-abyss-700">
      <aside className="hidden lg:flex w-[238px] shrink-0 flex-col border-r border-line-strong bg-rail px-4 py-5 dark:border-abyss-300/40 dark:bg-abyss-500">
        <div className="flex items-center gap-3 px-2">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Phone className="h-[18px] w-[18px]" strokeWidth={2.5} />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-rail bg-neon-green dark:border-abyss-500" />
          </span>
          <div>
            <p className="font-display text-[15px] font-bold tracking-[-.4px] text-ink-900 dark:text-white">
              call<span className="text-brand-500">center</span>
            </p>
            <p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-ink-400 dark:text-abyss-100">control plane</p>
          </div>
        </div>

        <div className="mt-8 flex-1 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.label} className="mb-7">
              <p className="px-2 eyebrow">{group.label}</p>
              <nav className="mt-2 space-y-0.5">
                {group.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) =>
                      `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[12px] font-medium transition ${
                        isActive
                          ? 'bg-brand-200 text-brand-700 dark:bg-brand-500/15 dark:text-neon-cyan'
                          : 'text-ink-600 hover:bg-ink-100 dark:text-abyss-50 dark:hover:bg-abyss-400/50 dark:hover:text-white'
                      }`
                    }
                  >
                    <Icon className="h-4 w-4" />
                    <span className="flex-1">{label}</span>
                  </NavLink>
                ))}
              </nav>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-line bg-topbar p-3 dark:border-abyss-300/40 dark:bg-abyss-600">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-neon-green" />
            <span className="text-[11px] font-semibold text-ink-700 dark:text-slate-200">All systems operational</span>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-ink-400 dark:text-abyss-100">
            {user?.tenant_name || 'Platform owner'}
          </p>
          <button
            onClick={handleLogout}
            className="mt-2.5 flex items-center gap-1.5 text-[10px] font-semibold text-ink-400 hover:text-ink-700 dark:text-abyss-100 dark:hover:text-white"
          >
            <LogOut className="h-3 w-3" /> Log out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[68px] shrink-0 items-center justify-between border-b border-line-strong bg-topbar px-5 sm:px-8 dark:border-abyss-300/40 dark:bg-abyss-500">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold text-ink-400 dark:text-abyss-100">{dateLine}</p>
            <h1 className="mt-0.5 truncate font-display text-[20px] font-semibold tracking-[-.5px] text-ink-900 dark:text-white">
              {titleForPath(groups, pathname)}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 md:flex dark:border-abyss-300/40 dark:bg-abyss-600">
              <Search className="h-[15px] w-[15px] text-ink-400" />
              <span className="text-[11px] text-ink-300 dark:text-abyss-100">Search workspace</span>
            </div>
            <button
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="rounded-xl border border-line-strong bg-white p-2.5 text-ink-500 hover:text-brand-600 dark:border-abyss-300/40 dark:bg-abyss-600 dark:text-abyss-50 dark:hover:text-neon-cyan"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <span className="hidden h-8 w-8 items-center justify-center rounded-full bg-brand-200 text-[11px] font-bold text-brand-700 sm:flex dark:bg-brand-500/20 dark:text-neon-cyan">
              {initials(user?.username)}
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1470px] px-5 py-7 sm:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
