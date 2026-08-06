import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool, { executeTenantQuery } from '../config/database.js';
import { syncAgentQueueMembership } from '../services/queueMembershipService.js';
import { getOrProvisionAgentSipCredentials } from '../services/agentProvisioningService.js';

const DEFAULT_TENANT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

export async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    // Look up user globally (Super Admin check requires no tenant ID filtering at query start)
    const userResult = await executeTenantQuery(null, `
      SELECT u.id, u.username, u.password_hash, u.role, u.tenant_id, u.parent_id, u.status, t.name as tenant_name 
      FROM users u
      LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = $1
    `, [username]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = userResult.rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This user account is inactive' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update agent status to 'login' in database (if user is an agent)
    if (user.role === 'agent') {
      await executeTenantQuery(user.tenant_id, `
        INSERT INTO agent_profiles (user_id, current_status, last_status_change)
        VALUES ($1, 'login', NOW())
        ON CONFLICT (user_id) DO UPDATE SET current_status = 'login', last_status_change = NOW()
      `, [user.id]);
      // 'login' is not 'idle' - not eligible for the campaign_agents queue yet until they
      // explicitly go ready (POST /api/calls/ready).
      syncAgentQueueMembership(user.id, 'login').catch(() => {});
    }

    // Generate JWT token containing roles, parent report hierarchy and tenant mapping
    const token = jwt.sign(
      {
        id: user.id,
        tenant_id: user.tenant_id,
        username: user.username,
        role: user.role,
        parent_id: user.parent_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenant_id: user.tenant_id,
        tenant_name: user.tenant_name
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
}

export async function logout(req, res) {
  const { id, role, tenant_id } = req.user;
  
  try {
    if (role === 'agent') {
      // Set agent profile status to offline
      await executeTenantQuery(tenant_id, `
        UPDATE agent_profiles SET current_status = 'offline', last_status_change = NOW() WHERE user_id = $1
      `, [id]);
      syncAgentQueueMembership(id, 'offline').catch(() => {});
    }
    
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error during logout' });
  }
}

// Workstream 9: onboards a brand-new client as its own isolated tenant, with its first
// client_admin login, in one atomic request. This is what makes "many clients, each with their
// own business scenario" (banking, loan recovery, whatever comes next) actually work in
// practice - every ivr_flows/ivr_nodes/ivr_lookup_tables/voice_campaigns row is already scoped
// by tenant_id (see ivrController.js's resolveTenantId()), so a fresh tenant here is a fully
// isolated client with zero code changes needed on our side to onboard them. Platform-operator
// action only (super_admin) - a client_admin can create their own agents (createAgent below)
// but should never be able to create ANOTHER client's tenant.
export async function createClient(req, res) {
  const { tenantName, subdomain, adminUsername, adminPassword, portNumbers, gatewayId } = req.body;

  if (!tenantName || !subdomain || !adminUsername || !adminPassword) {
    return res.status(400).json({ error: 'tenantName, subdomain, adminUsername, and adminPassword are required' });
  }
  // Workstream 9: port assignment is mandatory at onboarding, not an optional afterthought - a
  // client with zero ports allocated is unrestricted (see campaignController.js's opt-in-only
  // port enforcement), which is the wrong default for a NEW client being deliberately set up.
  if (!Array.isArray(portNumbers) || portNumbers.length === 0) {
    return res.status(400).json({ error: 'portNumbers is required - a non-empty array of SIM port numbers to assign to this client' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Only auto-pick a gateway when there's exactly one - guessing wrong once a second gateway
    // exists would silently assign ports on the wrong physical box.
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

    const tenantResult = await client.query(
      `INSERT INTO tenants (name, subdomain) VALUES ($1, $2) RETURNING id, name, subdomain, created_at`,
      [tenantName, subdomain]
    );
    const tenant = tenantResult.rows[0];

    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, username, password_hash, role)
       VALUES ($1, $2, $3, 'client_admin') RETURNING id, username, role, tenant_id`,
      [tenant.id, adminUsername, passwordHash]
    );
    const admin = userResult.rows[0];

    // Only grants ports that are currently unallocated (tenant_id IS NULL) - if fewer rows come
    // back than requested, some port numbers don't exist on this gateway or already belong to
    // another tenant. Roll back EVERYTHING (tenant + admin + partial grant), not just the ports -
    // a half-onboarded client with fewer ports than asked for is worse than no client at all.
    const portsResult = await client.query(
      `UPDATE gateway_ports SET tenant_id = $1, mapped_trunk_name = 'DinstarTrunk'
       WHERE gateway_id = $2 AND port_number = ANY($3) AND tenant_id IS NULL
       RETURNING port_number`,
      [tenant.id, resolvedGatewayId, portNumbers.map(Number)]
    );
    if (portsResult.rows.length < portNumbers.length) {
      await client.query('ROLLBACK');
      const granted = portsResult.rows.map((r) => r.port_number);
      const unavailable = portNumbers.filter((p) => !granted.includes(Number(p)));
      return res.status(400).json({
        error: `Port(s) ${unavailable.join(', ')} don't exist on this gateway or are already allocated to another client`
      });
    }
    const ports = portsResult.rows.map((r) => r.port_number).sort((a, b) => a - b);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Client onboarded successfully', tenant, admin, ports });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      // Unique violation on tenants.name, tenants.subdomain, or users.username - error.detail
      // names the actual conflicting column/value, more useful to the caller than a generic 409.
      return res.status(409).json({ error: `Onboarding failed - already exists: ${error.detail || error.message}` });
    }
    console.error('createClient failed:', error);
    res.status(500).json({ error: 'Failed to onboard client' });
  } finally {
    client.release();
  }
}

// Lists every onboarded client (tenant) with a quick headcount of their admin logins - mainly
// useful for confirming tenant isolation actually took effect after createClient above.
export async function getClients(req, res) {
  try {
    const result = await pool.query(`
      SELECT t.id, t.name, t.subdomain, t.created_at,
             COUNT(u.id) FILTER (WHERE u.role = 'client_admin') AS admin_count
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('getClients failed:', error);
    res.status(500).json({ error: 'Failed to list clients' });
  }
}

// Workstream 7: there was previously no endpoint anywhere in this codebase that creates an
// agent - only database/seed.sql inserted demo users directly. Admin/TL-gated; creates the
// users + agent_profiles rows (agent starts 'offline', matching every other new-agent state)
// and provisions their SIP endpoint so a softphone can register immediately.
export async function createAgent(req, res) {
  const { username, password, parentId } = req.body;
  const tenantId = req.user?.tenant_id || DEFAULT_TENANT_ID;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await executeTenantQuery(tenantId, `
      INSERT INTO users (tenant_id, username, password_hash, role, parent_id)
      VALUES ($1, $2, $3, 'agent', $4)
      RETURNING id, username, role, tenant_id
    `, [tenantId, username, passwordHash, parentId || null]);

    const agent = userResult.rows[0];

    await executeTenantQuery(tenantId, `
      INSERT INTO agent_profiles (user_id, current_status)
      VALUES ($1, 'offline')
      ON CONFLICT (user_id) DO NOTHING
    `, [agent.id]);

    const credentials = await getOrProvisionAgentSipCredentials(agent.id);

    res.status(201).json({
      message: 'Agent created successfully',
      agent,
      sip: credentials
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('createAgent failed:', error);
    res.status(500).json({ error: 'Failed to create agent' });
  }
}

// Lists agents for the caller's own tenant, joined with their live status - createAgent (above)
// existed with no way to see who you'd already created. team_leader/mentor share this view (same
// roles createAgent already allows) since a TL managing agents needs to see them too, not just
// the client_admin who onboarded the tenant.
export async function getAgents(req, res) {
  const tenantId = req.user?.tenant_id || DEFAULT_TENANT_ID;
  try {
    const result = await executeTenantQuery(tenantId, `
      SELECT u.id, u.username, u.status, u.created_at,
             ap.current_status, ap.last_status_change
      FROM users u
      LEFT JOIN agent_profiles ap ON ap.user_id = u.id
      WHERE u.tenant_id = $1 AND u.role = 'agent'
      ORDER BY u.username
    `, [tenantId]);
    res.json(result.rows);
  } catch (error) {
    console.error('getAgents failed:', error);
    res.status(500).json({ error: 'Failed to list agents' });
  }
}

// Workstream 7: lets the agent softphone (frontend_component/agent_softphone/) fetch its own
// SIP registration credentials right after JWT login, without ever exposing them anywhere
// except this authenticated call. Lazily provisions on first call so pre-existing seed.sql
// agents (created before this feature existed) work without a manual migration step.
export async function getMySipCredentials(req, res) {
  const agentId = req.user.id;

  if (req.user.role !== 'agent') {
    return res.status(403).json({ error: 'Only agents have SIP softphone credentials' });
  }

  try {
    const { sipUsername, sipPassword } = await getOrProvisionAgentSipCredentials(agentId);
    const wssUrl = process.env.ASTERISK_WSS_URL
      || `wss://${process.env.ASTERISK_AMI_HOST || '127.0.0.1'}:8089/ws`;

    res.json({ sipUsername, sipPassword, wssUrl });
  } catch (error) {
    console.error('getMySipCredentials failed:', error);
    res.status(500).json({ error: 'Failed to fetch SIP credentials' });
  }
}
