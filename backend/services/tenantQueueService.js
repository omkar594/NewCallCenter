import pool, { executeTenantQuery } from '../config/database.js';

// Resolves a tenant's own Asterisk queue, and its capability flags.
//
// Every tenant has exactly one agent queue (tenants.agent_queue_name -> a row in the realtime
// `queues` table). This replaces the single global 'campaign_agents' queue that every tenant's
// agents used to share, which meant Client A's caller pressing 1 could be answered by Client B's
// agent. Isolation is now structural: an agent can only ever be QueueAdd'ed to their own tenant's
// queue, so there is no code path left that could route across tenants.

// tenants.agent_queue_name and the feature flags change at most once per client (at onboarding,
// or when the Super Admin edits the plan), but getQueueName() is called on every single lead
// dispatch. Caching avoids a Postgres round-trip per outbound call.
const cache = new Map();

export function invalidateTenantCache(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * Loads a tenant's queue name + capability flags, memoised.
 * @returns {Promise<{queueName: string, agentsEnabled: boolean, inboundEnabled: boolean, ivrEnabled: boolean, active: boolean}|null>}
 */
export async function getTenantTelephony(tenantId) {
  if (!tenantId) return null;
  if (cache.has(tenantId)) return cache.get(tenantId);

  // Deliberately not tenant-scoped (null): this reads the tenants table itself, which RLS
  // policies are written against users/campaigns/etc, not tenants. The tenantId is always
  // supplied by the server (from a JWT or a lead row), never taken from a request body.
  const result = await executeTenantQuery(null, `
    SELECT agent_queue_name, agents_enabled, inbound_enabled, ivr_enabled, status
      FROM tenants WHERE id = $1
  `, [tenantId]);

  const row = result.rows[0];
  if (!row) return null;

  const value = {
    queueName: row.agent_queue_name,
    agentsEnabled: row.agents_enabled,
    inboundEnabled: row.inbound_enabled,
    ivrEnabled: row.ivr_enabled,
    active: row.status === 'active'
  };
  cache.set(tenantId, value);
  return value;
}

/**
 * The Asterisk queue name for this tenant, or null if the tenant is unknown or has agents
 * disabled. Callers MUST treat null as "no agent routing" rather than substituting a default -
 * falling back to a shared queue name is exactly the cross-tenant leak this service exists to
 * prevent.
 */
export async function getQueueName(tenantId) {
  const t = await getTenantTelephony(tenantId);
  if (!t || !t.agentsEnabled || !t.active) return null;
  return t.queueName;
}

// Settings are copied verbatim from the old static [campaign_agents] block in
// telephony_config/queues.conf, so per-tenant queues behave identically to the shared one they
// replace - only the isolation changes.
const QUEUE_DEFAULTS = {
  musicclass: 'default',
  strategy: 'leastrecent',
  timeout: 20,
  retry: 3,
  maxlen: 0,
  joinempty: 'no',
  leavewhenempty: 'yes',
  ringinuse: 'no',
  setinterfacevar: 'yes'
};

/**
 * Idempotently ensures the realtime `queues` row for a tenant exists.
 *
 * A BEFORE INSERT trigger on tenants already does this for every new tenant (see
 * database/schema.sql), because "this tenant has no queue" means that client's callers reach
 * nobody and is not a state worth being able to reach. This function is the repair path for
 * tenants created before that trigger existed, and lets onboarding join the same transaction.
 *
 * @param {string} tenantId
 * @param {import('pg').PoolClient} [dbClient] - pass the onboarding transaction's client so the
 *   queue row is rolled back with everything else if onboarding fails partway.
 */
export async function ensureTenantQueue(tenantId, dbClient) {
  const runner = dbClient || pool;

  const { rows } = await runner.query(
    `SELECT agent_queue_name FROM tenants WHERE id = $1`, [tenantId]
  );
  const queueName = rows[0]?.agent_queue_name;
  if (!queueName) throw new Error(`Tenant ${tenantId} has no agent_queue_name`);

  await runner.query(`
    INSERT INTO queues (name, musicclass, strategy, timeout, retry, maxlen,
                        joinempty, leavewhenempty, ringinuse, setinterfacevar)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (name) DO NOTHING
  `, [
    queueName, QUEUE_DEFAULTS.musicclass, QUEUE_DEFAULTS.strategy, QUEUE_DEFAULTS.timeout,
    QUEUE_DEFAULTS.retry, QUEUE_DEFAULTS.maxlen, QUEUE_DEFAULTS.joinempty,
    QUEUE_DEFAULTS.leavewhenempty, QUEUE_DEFAULTS.ringinuse, QUEUE_DEFAULTS.setinterfacevar
  ]);

  invalidateTenantCache(tenantId);
  return queueName;
}
