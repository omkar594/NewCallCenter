import express from 'express';
import { login, logout, createAgent, getAgents, getMySipCredentials, createClient, getClients, deactivateClient, reactivateClient, addCredits, getCreditTransactions, getMyCredits } from '../controllers/authController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', login);
router.post('/logout', authenticateToken, logout);

// Workstream 9: client (tenant) onboarding - platform-operator only. Each client is a fully
// isolated tenant_id; see createClient()'s comment in the controller for why that's enough to
// support "many clients, each with their own flow" with zero code changes per client.
router.post('/clients', authenticateToken, authorizeRoles(['super_admin']), createClient);
router.get('/clients', authenticateToken, authorizeRoles(['super_admin']), getClients);
// Soft-delete: locks out logins, releases SIM ports, cancels active campaigns - keeps all
// historical data (flows/campaigns/call logs) intact. See authController.js for exactly what
// each does and why.
router.post('/clients/:tenantId/deactivate', authenticateToken, authorizeRoles(['super_admin']), deactivateClient);
router.post('/clients/:tenantId/reactivate', authenticateToken, authorizeRoles(['super_admin']), reactivateClient);

// Credit billing: only super_admin can top up a tenant's balance; a tenant's own users can only
// view their balance/history (getCreditTransactions enforces the tenant match itself, since it's
// also reachable by super_admin for any tenant).
router.post('/clients/:tenantId/credits', authenticateToken, authorizeRoles(['super_admin']), addCredits);
router.get('/clients/:tenantId/credits/transactions', authenticateToken, getCreditTransactions);
router.get('/credits', authenticateToken, getMyCredits);

// Workstream 7: agent provisioning + softphone credential fetch.
router.post('/agents', authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader']), createAgent);
router.get('/agents', authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader', 'mentor']), getAgents);
router.get('/me/sip-credentials', authenticateToken, getMySipCredentials);

export default router;
