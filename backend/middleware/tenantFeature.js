import { getTenantTelephony } from '../services/tenantQueueService.js';

// Enforces what a client actually bought.
//
// The platform is sold per client, and not every client buys the same thing - some want outbound
// broadcast campaigns only, with no live agents and no inbound calls at all. Hiding those menus
// in the frontend is a UX nicety; this middleware is the actual control, because the API is
// reachable directly with any valid token regardless of what the UI renders.
//
// Deliberately fails CLOSED: if the tenant can't be resolved, access is denied rather than
// allowed. An unresolvable tenant means we cannot say what they bought, and guessing "yes" on a
// capability the client may not have paid for - and which spends real money on live calls - is
// the wrong direction to guess in.
const FEATURE_LABELS = {
  agentsEnabled: 'Live agents',
  inboundEnabled: 'Inbound calling',
  ivrEnabled: 'IVR flows'
};

export function requireTenantFeature(feature) {
  if (!(feature in FEATURE_LABELS)) {
    throw new Error(`Unknown tenant feature: ${feature}`);
  }

  return async function tenantFeatureGuard(req, res, next) {
    // Super admin operates across tenants and is not itself a customer of any plan, so plan
    // gating doesn't apply - role authorization (authorizeRoles) is what restricts them.
    if (req.user?.role === 'super_admin') return next();

    const tenantId = req.tenantId || req.user?.tenant_id;
    if (!tenantId) {
      return res.status(403).json({ error: 'No tenant context for this request' });
    }

    try {
      const telephony = await getTenantTelephony(tenantId);
      if (!telephony) {
        return res.status(403).json({ error: 'Tenant not found' });
      }
      if (!telephony[feature]) {
        return res.status(403).json({
          error: `${FEATURE_LABELS[feature]} is not enabled on your plan. Contact your account manager to add it.`,
          feature
        });
      }
      return next();
    } catch (err) {
      console.error(`[TenantFeature] Failed to check '${feature}':`, err.message);
      return res.status(503).json({ error: 'Unable to verify plan features right now' });
    }
  };
}
