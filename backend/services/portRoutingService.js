import pool from '../config/database.js';

// Chooses which SIM port each outbound call goes out on, and tells the caller which number that
// port carries.
//
// The gateway will happily pick a port itself, but it never reports which one it used - so a
// client asking "which of my numbers did this call come from?" could not be answered. Instead we
// choose the port and encode it as a dialling prefix the gateway maps back to that exact port,
// which means the answer is known before the call is even placed.
//
// Prefix format is a fixed three characters: '8' followed by the two-digit port number, so
// port 0 is 800 and port 12 is 812. Fixed width on purpose - a variable-length scheme like
// '8' + port would make 81 (port 1) a prefix of 812 (port 12), and the gateway's longest-match
// behaviour is not worth relying on. The leading 8 cannot collide with the numbers we dial,
// which are always country-code first.
//
// The matching gateway configuration is one IP->Tel routing rule per port:
//   Destination Prefix = 800, Destination = port-0, Digits to be Deleted = 3

export const PORT_PREFIX_LENGTH = 3;

export function prefixForPort(portNumber) {
  return `8${String(portNumber).padStart(2, '0')}`;
}

// Round-robin position per tenant, so consecutive calls spread across that client's ports
// instead of hammering the lowest-numbered one. In memory only: a restart just resets the
// starting point, which costs nothing.
const cursorByTenant = new Map();

/**
 * Picks the next port for a tenant's outbound call.
 *
 * @returns {Promise<{portNumber:number, simNumber:string|null, prefix:string}|null>}
 *   null when the tenant has no ports allocated - the caller must treat that as "cannot place
 *   this call" rather than dialling without a prefix, because a call with no prefix goes out on
 *   whichever port the gateway feels like and is then unattributable.
 */
export async function pickPortForTenant(tenantId) {
  const { rows } = await pool.query(`
    SELECT port_number, sim_number
      FROM gateway_ports
     WHERE tenant_id = $1
     ORDER BY port_number
  `, [tenantId]);

  if (rows.length === 0) return null;

  const next = (cursorByTenant.get(tenantId) ?? 0) % rows.length;
  cursorByTenant.set(tenantId, next + 1);
  const chosen = rows[next];

  return {
    portNumber: chosen.port_number,
    simNumber: chosen.sim_number || null,
    prefix: prefixForPort(chosen.port_number)
  };
}

/**
 * Records the mobile number of the SIM in a port. Operator-only; the gateway cannot tell us this,
 * so it is entered by whoever physically fits the SIM.
 */
export async function setPortSimNumber(gatewayId, portNumber, simNumber) {
  const { rows } = await pool.query(`
    UPDATE gateway_ports SET sim_number = $3
     WHERE gateway_id = $1 AND port_number = $2
    RETURNING port_number, sim_number, tenant_id
  `, [gatewayId, portNumber, simNumber || null]);
  return rows[0] || null;
}
