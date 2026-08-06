import { executeTenantQuery } from '../config/database.js';
import DinstarService from '../services/dinstarService.js';

const DEFAULT_TENANT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

// Get list of all gateways (Super Admin only)
export async function getGateways(req, res) {
  try {
    const result = await executeTenantQuery(null, 'SELECT * FROM gateways ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('getGateways failed:', error);
    res.status(500).json({ error: 'Failed to retrieve gateways' });
  }
}

// Add a new gateway (Super Admin only)
export async function createGateway(req, res) {
  const { name, ip_address, sn, total_ports } = req.body;
  
  if (!name || !ip_address || !sn) {
    return res.status(400).json({ error: 'Name, IP address, and Serial Number are required' });
  }

  try {
    const result = await executeTenantQuery(null, `
      INSERT INTO gateways (name, ip_address, sn, total_ports)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name, ip_address, sn, total_ports || 8]);

    const newGateway = result.rows[0];

    // Seed unassigned ports for this gateway
    for (let i = 0; i < newGateway.total_ports; i++) {
      await executeTenantQuery(null, `
        INSERT INTO gateway_ports (gateway_id, port_number)
        VALUES ($1, $2)
      `, [newGateway.id, i]);
    }

    res.status(201).json(newGateway);
  } catch (error) {
    console.error('createGateway failed:', error);
    res.status(500).json({ error: 'Failed to create gateway' });
  }
}

// Get all ports and their tenant mappings. super_admin sees every port across every tenant
// (needed to actually do allocation); anyone else only ever sees ports allocated to their own
// tenant - this doubles as the "what are my ports" view, no separate endpoint needed.
export async function getPortAllocations(req, res) {
  const isSuperAdmin = req.user?.role === 'super_admin';
  const callerTenantId = req.user?.tenant_id || DEFAULT_TENANT_ID;
  try {
    const result = await executeTenantQuery(null, `
      SELECT gp.id, gp.port_number, gp.mapped_trunk_name, gp.status, g.name as gateway_name, g.ip_address, t.name as tenant_name, gp.tenant_id
      FROM gateway_ports gp
      JOIN gateways g ON g.id = gp.gateway_id
      LEFT JOIN tenants t ON t.id = gp.tenant_id
      ${isSuperAdmin ? '' : 'WHERE gp.tenant_id = $1'}
      ORDER BY g.name, gp.port_number
    `, isSuperAdmin ? [] : [callerTenantId]);
    res.json(result.rows);
  } catch (error) {
    console.error('getPortAllocations failed:', error);
    res.status(500).json({ error: 'Failed to retrieve port allocations' });
  }
}

// Map a port to a client (tenant) with an Asterisk Trunk name (Super Admin allocation logic)
export async function allocatePort(req, res) {
  const { portId, tenantId, mappedTrunkName } = req.body;

  if (!portId) {
    return res.status(400).json({ error: 'Port identifier is required' });
  }

  try {
    // If tenantId is provided as empty string or null, it represents deallocation
    const targetTenant = tenantId ? tenantId : null;
    const targetTrunk = tenantId ? mappedTrunkName : null;

    const result = await executeTenantQuery(null, `
      UPDATE gateway_ports 
      SET tenant_id = $1, mapped_trunk_name = $2 
      WHERE id = $3 
      RETURNING *
    `, [targetTenant, targetTrunk, portId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Port allocation record not found' });
    }

    res.json({
      message: 'Port allocated successfully',
      port: result.rows[0]
    });
  } catch (error) {
    console.error('allocatePort failed:', error);
    res.status(500).json({ error: 'Failed to allocate port' });
  }
}

// Query real-time port information from the physical Dinstar hardware gateway
export async function getLiveGatewayStatus(req, res) {
  const { gatewayId } = req.params;

  try {
    const gatewayResult = await executeTenantQuery(null, 'SELECT * FROM gateways WHERE id = $1', [gatewayId]);
    if (gatewayResult.rows.length === 0) {
      return res.status(404).json({ error: 'Gateway not found' });
    }

    const gateway = gatewayResult.rows[0];
    const service = new DinstarService(gateway.ip_address, process.env.DINSTAR_API_USER, process.env.DINSTAR_API_PASS);

    let livePorts;
    try {
      livePorts = await service.getPortsInfo();
    } catch (gatewayError) {
      // Surface hardware unreachability as a real error (502) instead of silently
      // returning fabricated port data - see plan Workstream 4.
      console.error('Dinstar gateway unreachable:', gatewayError.message);
      return res.status(502).json({ error: `Dinstar gateway unreachable: ${gatewayError.message}` });
    }

    res.json({
      gatewayId: gateway.id,
      name: gateway.name,
      ip: gateway.ip_address,
      live_ports: livePorts
    });
  } catch (error) {
    console.error('getLiveGatewayStatus failed:', error);
    res.status(500).json({ error: 'Failed to query live Dinstar status' });
  }
}
