import express from 'express';
import { login, logout, createAgent, getAgents, getMySipCredentials, createClient, getClients } from '../controllers/authController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', login);
router.post('/logout', authenticateToken, logout);

// Workstream 9: client (tenant) onboarding - platform-operator only. Each client is a fully
// isolated tenant_id; see createClient()'s comment in the controller for why that's enough to
// support "many clients, each with their own flow" with zero code changes per client.
router.post('/clients', authenticateToken, authorizeRoles(['super_admin']), createClient);
router.get('/clients', authenticateToken, authorizeRoles(['super_admin']), getClients);

// Workstream 7: agent provisioning + softphone credential fetch.
router.post('/agents', authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader']), createAgent);
router.get('/agents', authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader', 'mentor']), getAgents);
router.get('/me/sip-credentials', authenticateToken, getMySipCredentials);

export default router;
