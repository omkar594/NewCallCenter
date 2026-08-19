import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import ProtectedRoute, { homeForRole } from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';

import SuperAdminDashboard from './pages/superadmin/Dashboard.jsx';
import OnboardClient from './pages/superadmin/OnboardClient.jsx';
import TenantDetail from './pages/superadmin/TenantDetail.jsx';
import GatewayPorts from './pages/superadmin/GatewayPorts.jsx';
import SuperAdminCallLogs from './pages/superadmin/CallLogs.jsx';

import TenantDashboard from './pages/tenant/Dashboard.jsx';
import Flows from './pages/tenant/Flows.jsx';
import FlowEditor from './pages/tenant/FlowEditor.jsx';
import LookupTables from './pages/tenant/LookupTables.jsx';
import Campaigns from './pages/tenant/Campaigns.jsx';
import CampaignDetail from './pages/tenant/CampaignDetail.jsx';
import CampaignWizard from './pages/tenant/CampaignWizard.jsx';
import Agents from './pages/tenant/Agents.jsx';
import Analytics from './pages/tenant/Analytics.jsx';

import Softphone from './pages/agent/Softphone.jsx';

const TENANT_ROLES = ['client_admin', 'team_leader', 'mentor'];

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={homeForRole(user.role)} replace /> : <Login variant="client" />} />
      {/* Separate URL from /login (see Login.jsx) so an admin bookmark/link never doubles as the
          client-facing sign-in page, and a client account can't accidentally land here either -
          Login.jsx itself rejects a role/variant mismatch rather than this route just trusting it. */}
      <Route path="/admin/login" element={user ? <Navigate to={homeForRole(user.role)} replace /> : <Login variant="admin" />} />

      <Route element={<ProtectedRoute roles={['super_admin']} />}>
        <Route element={<Layout />}>
          <Route path="/admin" element={<SuperAdminDashboard />} />
          <Route path="/admin/onboard" element={<OnboardClient />} />
          <Route path="/admin/tenants/:tenantId" element={<TenantDetail />} />
          {/* Reuses the tenant's own CampaignDetail component - it reads tenantId from the URL
              (see CampaignDetail.jsx) and appends it as ?tenantId= on its API calls, which
              getCampaignReport now supports for super_admin. */}
          <Route path="/admin/tenants/:tenantId/campaigns/:campaignId" element={<CampaignDetail />} />
          <Route path="/admin/ports" element={<GatewayPorts />} />
          <Route path="/admin/logs" element={<SuperAdminCallLogs />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute roles={TENANT_ROLES} />}>
        <Route element={<Layout />}>
          <Route path="/app" element={<TenantDashboard />} />
          <Route path="/app/flows" element={<Flows />} />
          <Route path="/app/flows/new" element={<FlowEditor />} />
          <Route path="/app/flows/:flowId" element={<FlowEditor />} />
          <Route path="/app/lookup-tables" element={<LookupTables />} />
          <Route path="/app/campaigns" element={<Campaigns />} />
          <Route path="/app/campaigns/new" element={<CampaignWizard />} />
          <Route path="/app/campaigns/:campaignId" element={<CampaignDetail />} />
          <Route path="/app/agents" element={<Agents />} />
          <Route path="/app/analytics" element={<Analytics />} />
        </Route>
      </Route>

      {/* The softphone now uses the same session as every other page. It used to sit outside
          ProtectedRoute with its own login form and its own in-memory JWT, which meant an agent
          logged in at /login, got redirected here, and was immediately asked for their password a
          second time. The memory-only token was a deliberate tradeoff in the original standalone
          page (a refresh forced re-login); one login was judged the better trade for agents who
          use this all day. It has no Layout: an agent needs the phone, not the nav rail. */}
      <Route element={<ProtectedRoute roles={['agent']} />}>
        <Route path="/softphone" element={<Softphone />} />
      </Route>

      <Route path="/" element={<Navigate to={user ? homeForRole(user.role) : '/login'} replace />} />
      <Route path="*" element={<Navigate to={user ? homeForRole(user.role) : '/login'} replace />} />
    </Routes>
  );
}
