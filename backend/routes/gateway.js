import express from 'express';
import { getGateways, createGateway, getPortAllocations, allocatePort, getLiveGatewayStatus } from '../controllers/gatewayController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Workstream 9: was entirely zero-auth - anyone unauthenticated could view the full
// port-to-tenant mapping table (including other tenants' names) or reassign any port to any
// tenant. Viewing requires login now (results are tenant-scoped for non-super_admin callers -
// see gatewayController.js's getPortAllocations); allocating a port to a tenant is a
// platform-operator decision, same trust level as POST /api/auth/clients.
router.get('/', authenticateToken, getGateways);
router.post('/', authenticateToken, authorizeRoles(['super_admin']), createGateway);
router.get('/ports', authenticateToken, getPortAllocations);
router.get('/allocations', authenticateToken, getPortAllocations);
router.post('/ports/allocate', authenticateToken, authorizeRoles(['super_admin']), allocatePort);
router.get('/:gatewayId/live', authenticateToken, getLiveGatewayStatus);

export default router;
