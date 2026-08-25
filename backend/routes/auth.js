import express from 'express';
import { login, logout, getMe, createAgent, getAgents, getMySipCredentials, createClient, getClients, updateClientFeatures, createApiKey, listApiKeys, revokeApiKey, deactivateClient, reactivateClient, addCredits, getCreditTransactions, getMyCredits } from '../controllers/authController.js';
import { requireTenantFeature } from '../middleware/tenantFeature.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', login);
router.post('/logout', authenticateToken, logout);
// Re-reads the account and its tenant's plan features. Features are handed out at login, so
// without this a client whose plan the Super Admin just changed would keep the old menus until
// their 12h token expired.
router.get('/me', authenticateToken, getMe);

// Workstream 9: client (tenant) onboarding - platform-operator only. Each client is a fully
// isolated tenant_id; see createClient()'s comment in the controller for why that's enough to
// support "many clients, each with their own flow" with zero code changes per client.
router.post('/clients', authenticateToken, authorizeRoles(['super_admin']), createClient);
router.get('/clients', authenticateToken, authorizeRoles(['super_admin']), getClients);
// Change what a client's plan includes after onboarding - a client upgrading from outbound-only
// to live agents shouldn't require re-onboarding them.
// API keys for the public call-control API. Operator-only: a key placed on this endpoint can
// spend a client's credits on live calls.
router.get('/clients/:tenantId/api-keys', authenticateToken, authorizeRoles(['super_admin']), listApiKeys);
router.post('/clients/:tenantId/api-keys', authenticateToken, authorizeRoles(['super_admin']), createApiKey);
router.delete('/clients/:tenantId/api-keys/:keyId', authenticateToken, authorizeRoles(['super_admin']), revokeApiKey);
router.patch('/clients/:tenantId/features', authenticateToken, authorizeRoles(['super_admin']), updateClientFeatures);
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
// requireTenantFeature sits AFTER authorizeRoles on purpose: "you're not allowed to do this at
// all" should win over "your plan doesn't include this", so a client_admin probing an admin-only
// route can't learn anything about another tenant's plan from the error they get back.
router.post('/agents', authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader']), requireTenantFeature('agentsEnabled'), createAgent);
router.get('/agents', authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader', 'mentor']), requireTenantFeature('agentsEnabled'), getAgents);
router.get('/me/sip-credentials', authenticateToken, requireTenantFeature('agentsEnabled'), getMySipCredentials);

export default router;
