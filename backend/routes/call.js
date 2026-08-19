import express from 'express';
import {
  initiateOutboundCall,
  submitDisposition,
  updateAgentBreakStatus,
  getAgentBucket,
  reassignAbsenteeBucket,
  triggerLanguageTransfer,
  setAgentReady,
  setAgentOffline
} from '../controllers/callController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { injectTenantContext } from '../middleware/rls.js';
import { requireTenantFeature } from '../middleware/tenantFeature.js';

const router = express.Router();

router.use(authenticateToken);
router.use(injectTenantContext);
// Every route in this file is part of the live-agent product. A client on an outbound-only plan
// has no agents at all, so none of it should be reachable with their token - gated once here
// rather than route-by-route so a new agent endpoint added later is covered by default instead
// of silently shipping ungated.
router.use(requireTenantFeature('agentsEnabled'));

// Agent features
router.post('/dial', authorizeRoles(['agent']), initiateOutboundCall);
router.post('/disposition', authorizeRoles(['agent']), submitDisposition);
router.post('/break', authorizeRoles(['agent']), updateAgentBreakStatus);
router.get('/bucket', authorizeRoles(['agent']), getAgentBucket);
router.post('/transfer-language', authorizeRoles(['agent']), triggerLanguageTransfer);
router.post('/ready', authorizeRoles(['agent']), setAgentReady);
// Called when the softphone goes away (tab closed / SIP unregistered). Not a break and not a
// logout - see setAgentOffline() for why both of those would be wrong here.
router.post('/offline', authorizeRoles(['agent']), setAgentOffline);

// Supervisor (TL / Mentor / Client Admin) features
router.post('/reassign-bucket', authorizeRoles(['team_leader', 'mentor', 'client_admin']), reassignAbsenteeBucket);

export default router;
