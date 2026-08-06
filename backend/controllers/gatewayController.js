import pool, { executeTenantQuery } from '../config/database.js';
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

// Workstream 9: sets a tenant's port allocation to EXACTLY the given list in one call, so
// "give this client another port" and "take one away" are the same operation - just a longer or
// shorter portNumbers array - instead of the caller juggling individual gateway_ports.id UUIDs
// one at a time via allocatePort() above.
export async function setTenantPorts(req, res) {
  const { tenantId } = req.params;
  const { portNumbers, gatewayId } = req.body;

  if (!Array.isArray(portNumbers)) {
    return res.status(400).json({ error: 'portNumbers is required (an array - pass [] to clear all ports)' });
  }
  const requestedPorts = portNumbers.map(Number);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let resolvedGatewayId = gatewayId;
    if (!resolvedGatewayId) {
      const gatewaysResult = await client.query('SELECT id FROM gateways');
      if (gatewaysResult.rows.length !== 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: gatewaysResult.rows.length === 0
            ? 'No gateway exists to assign ports from'
            : 'Multiple gateways exist - gatewayId is required'
        });
      }
      resolvedGatewayId = gatewaysResult.rows[0].id;
    }

    // Allocate first, before deallocating anything - if a requested port turns out to belong to
    // someone else, this rolls back with the tenant's CURRENT allocation still fully intact,
    // rather than leaving them with fewer ports than they started with.
    const allocateResult = await client.query(
      `UPDATE gateway_ports SET tenant_id = $1, mapped_trunk_name = 'DinstarTrunk'
       WHERE gateway_id = $2 AND port_number = ANY($3) AND (tenant_id = $1 OR tenant_id IS NULL)
       RETURNING port_number`,
      [tenantId, resolvedGatewayId, requestedPorts]
    );
    if (allocateResult.rows.length < requestedPorts.length) {
      await client.query('ROLLBACK');
      const granted = allocateResult.rows.map((r) => r.port_number);
      const unavailable = requestedPorts.filter((p) => !granted.includes(p));
      return res.status(400).json({
        error: `Port(s) ${unavailable.join(', ')} don't exist on this gateway or are already allocated to another client`
      });
    }

    // Now release anything this tenant held that ISN'T in the new list.
    await client.query(
      `UPDATE gateway_ports SET tenant_id = NULL, mapped_trunk_name = NULL
       WHERE gateway_id = $1 AND tenant_id = $2 AND port_number != ALL($3)`,
      [resolvedGatewayId, tenantId, requestedPorts]
    );

    const finalResult = await client.query(
      `SELECT port_number FROM gateway_ports WHERE gateway_id = $1 AND tenant_id = $2 ORDER BY port_number`,
      [resolvedGatewayId, tenantId]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Port allocation updated',
      tenantId,
      ports: finalResult.rows.map((r) => r.port_number)
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('setTenantPorts failed:', error.message);
    res.status(500).json({ error: 'Failed to update port allocation' });
  } finally {
    client.release();
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
