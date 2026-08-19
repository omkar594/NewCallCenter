import asteriskService from './asteriskService.js';
import { executeTenantQuery } from '../config/database.js';
import { getQueueName } from './tenantQueueService.js';

// Keeps each tenant's OWN Asterisk queue in sync with agent_profiles.current_status, so Queue()
// in the dialplan always rings whoever Postgres currently considers idle *for that client*.
// Postgres stays the single source of truth; Asterisk's queue membership is just a mirror of it,
// rebuilt on every AMI reconnect (see resyncAllIdleAgents below) rather than persisted
// independently in Asterisk's own AstDB (queues.conf sets persistentmembers=no for exactly this
// reason).
//
// There used to be one module-level QUEUE_NAME ('campaign_agents') shared by every tenant, which
// meant an agent of Client B was a valid answer target for a caller of Client A. The queue name
// is now always derived from the agent's tenant, and there is deliberately NO fallback default -
// if the tenant can't be resolved, the agent is left out of every queue rather than dropped into
// a shared one.
//
// Callers must never let a sync failure fail the HTTP request it's attached to - this is why
// every call site wraps this in try/catch, and why this function itself never rethrows.
export async function syncAgentQueueMembership(agentId, newStatus, tenantId) {
  try {
    const queueName = await getQueueName(tenantId);
    if (!queueName) {
      // Tenant unknown, deactivated, or agents not enabled on their plan. Nothing to add them
      // to - and substituting a default queue here is precisely the cross-tenant bug being fixed.
      console.warn(`[QueueMembership] No queue for tenant ${tenantId} (agent ${agentId}) - skipping`);
      return;
    }

    const interfaceName = `PJSIP/${agentId}`;
    if (newStatus === 'idle') {
      await asteriskService.queueAdd(queueName, interfaceName, { MemberName: agentId });
    } else {
      await asteriskService.queueRemove(queueName, interfaceName);
    }
  } catch (err) {
    // "already a member" / "not found" AMI errors are expected here and harmless - queue
    // membership is treated as idempotent. If AMI isn't connected at all yet, this agent just
    // gets picked up by resyncAllIdleAgents() on the next successful connect instead.
    console.warn(`[QueueMembership] sync failed for agent ${agentId} -> ${newStatus}: ${err.message}`);
  }
}

// Re-adds every currently-idle agent to THEIR OWN tenant's queue. Call this once per AMI
// 'ami_ready' event (fresh connect, or reconnect after an Asterisk restart) so a restarted PBX -
// which comes back with empty queues - converges back to whatever Postgres says right away,
// instead of staying empty until each agent's next unrelated status change.
//
// The previous version selected agent_profiles alone with executeTenantQuery(null, ...) and added
// every idle agent in the database to the single shared queue. That made the resync itself a
// cross-tenant mixer: after any Asterisk restart, every client's agents were pooled together.
// Joining users/tenants here is what makes the resync tenant-correct, and the flag/status filters
// stop a deactivated or outbound-only client's agents being resurrected into a queue at all.
export async function resyncAllIdleAgents() {
  try {
    const result = await executeTenantQuery(null, `
      SELECT ap.user_id, u.tenant_id
        FROM agent_profiles ap
        JOIN users u   ON u.id = ap.user_id
        JOIN tenants t ON t.id = u.tenant_id
       WHERE ap.current_status = 'idle'
         AND t.agents_enabled = true
         AND t.status = 'active'
    `);

    for (const row of result.rows) {
      await syncAgentQueueMembership(row.user_id, 'idle', row.tenant_id);
    }
    console.log(`[QueueMembership] Resynced ${result.rows.length} idle agent(s) into their tenant queues.`);
  } catch (err) {
    console.warn('[QueueMembership] resyncAllIdleAgents failed:', err.message);
  }
}
