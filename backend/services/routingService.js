import { executeTenantQuery } from '../config/database.js';
import asteriskService from './asteriskService.js';
import redis from '../config/redis.js';
import { syncAgentQueueMembership } from './queueMembershipService.js';

// Holds live routing state mapping callId to active dialing parameters
const activeRoutingSessions = new Map();

/**
 * Service to execute intelligent routing logic for contact center calls.
 */
class RoutingService {
  constructor() {
    // Listen to Asterisk events to coordinate Ring Next and Escalations
    asteriskService.on('ami_event', (event) => this.handleAsteriskEvent(event));
  }

  /**
   * Main entrypoint to route an incoming call for a tenant.
   * Finds the longest-idle agent and originates a call.
   * 
   * @param {string} tenantId - Tenant ID
   * @param {string} callId - Call ID inside calls table
   * @param {string} customerNumber - Customer number (CLI)
   * @param {Array<string>} skippedAgentIds - Agents already tried for this call (avoids loops)
   */
  async routeCallToAgent(tenantId, callId, customerNumber, skippedAgentIds = []) {
    try {
      console.log(`[ACD] Routing Call ${callId} for Tenant ${tenantId}. Customer: ${customerNumber}. Skipped: ${skippedAgentIds.length}`);
      
      // Find all online & idle agents for this tenant
      // Filter out skipped agents (agents who didn't pick up)
      let query = `
        SELECT u.id, u.username, ap.current_status, ap.last_status_change 
        FROM users u
        JOIN agent_profiles ap ON ap.user_id = u.id
        WHERE u.tenant_id = $1 
          AND u.role = 'agent' 
          AND ap.current_status = 'idle'
      `;
      const params = [tenantId];

      if (skippedAgentIds.length > 0) {
        query += ` AND u.id NOT IN (${skippedAgentIds.map((_, i) => `$${i + 2}`).join(',')})`;
        params.push(...skippedAgentIds);
      }

      // Order by last_status_change ascending to get the longest idle agent
      query += ` ORDER BY ap.last_status_change ASC LIMIT 1`;

      const result = await executeTenantQuery(tenantId, query, params);

      if (result.rows.length === 0) {
        console.log(`[ACD] No idle agents available for tenant ${tenantId}. Escalating immediately.`);
        await this.escalateMissedCall(tenantId, callId, null, 'No agents available in queue');
        return false;
      }

      const agent = result.rows[0];
      console.log(`[ACD] Selected agent ${agent.username} (${agent.id}) - Idle since: ${agent.last_status_change}`);

      // Set agent profile status to 'ringing' in database so they aren't assigned another call
      await executeTenantQuery(tenantId,
        `UPDATE agent_profiles SET current_status = 'offline', last_status_change = NOW() WHERE user_id = $1`,
        [agent.id]
      );
      syncAgentQueueMembership(agent.id, 'offline', tenantId).catch(() => {});
      
      // Update call record to bind this agent
      await executeTenantQuery(tenantId,
        `UPDATE calls SET agent_id = $1, status = 'ringing' WHERE id = $2`,
        [agent.id, callId]
      );

      // Track routing session state
      const routingSession = {
        callId,
        tenantId,
        customerNumber,
        agentId: agent.id,
        agentUsername: agent.username,
        skippedAgents: [...skippedAgentIds, agent.id],
        answered: false,
        timer: null
      };

      activeRoutingSessions.set(agent.id, routingSession);

      // Trigger WebRTC ring via Asterisk
      // In WebRTC configuration, agents register as pjsip endpoints matching their user ID (e.g. user_id)
      const channel = `PJSIP/${agent.id}`;
      console.log(`[ACD] Dialing agent channel: ${channel}`);
      
      // Set a 15-second Ring-Next SLA timeout
      routingSession.timer = setTimeout(() => {
        this.handleRingTimeout(agent.id);
      }, 15000);

      await asteriskService.originateCall(
        channel,
        customerNumber, // Dialplan extension maps to bridging the customer number
        'incoming-webrtc-context',
        1,
        { CALL_ID: callId, TENANT_ID: tenantId },
        customerNumber
      );

      return true;
    } catch (error) {
      console.error('[ACD] Call routing failed:', error);
      return false;
    }
  }

  /**
   * Handle Asterisk event feedback to check answer or hangup states.
   */
  async handleAsteriskEvent(event) {
    // Check if channel bridge happens (call answered)
    if (event.Event === 'BridgeEnter') {
      const channel = event.Channel1 || '';
      // Extract agent ID from channel name (e.g. PJSIP/agent-uuid-peer -> agent-uuid)
      const agentId = this.extractAgentIdFromChannel(channel);
      if (agentId && activeRoutingSessions.has(agentId)) {
        const session = activeRoutingSessions.get(agentId);
        clearTimeout(session.timer);
        session.answered = true;
        
        console.log(`[ACD] Call ${session.callId} answered by Agent ${session.agentUsername}`);
        
        // Update database: Agent active, call answered
        await executeTenantQuery(session.tenantId,
          `UPDATE agent_profiles SET current_status = 'offline', last_status_change = NOW() WHERE user_id = $1`,
          [agentId]
        );
        syncAgentQueueMembership(agentId, 'offline', session.tenantId).catch(() => {});
        await executeTenantQuery(session.tenantId,
          `UPDATE calls SET status = 'active', answer_time = NOW() WHERE id = $1`,
          [session.callId]
        );
        
        activeRoutingSessions.delete(agentId);
      }
    }
    
    // Check if channel hung up before answering
    if (event.Event === 'Hangup') {
      const channel = event.Channel || '';
      const agentId = this.extractAgentIdFromChannel(channel);
      if (agentId && activeRoutingSessions.has(agentId)) {
        console.log(`[ACD] Agent channel hung up or busy. Routing to next agent.`);
        this.handleRingTimeout(agentId);
      }
    }
  }

  /**
   * Handler when agent fails to pick up in 15 seconds.
   */
  async handleRingTimeout(agentId) {
    if (!activeRoutingSessions.has(agentId)) return;
    
    const session = activeRoutingSessions.get(agentId);
    activeRoutingSessions.delete(agentId);
    clearTimeout(session.timer);

    console.log(`[ACD] Ring SLA timeout (15s) reached for agent ${session.agentUsername}`);

    // Update database: Set agent back to idle (or mark them absent/missed status), log missed count
    await executeTenantQuery(session.tenantId,
      `UPDATE agent_profiles SET current_status = 'idle', last_status_change = NOW() WHERE user_id = $1`,
      [agentId]
    );
    syncAgentQueueMembership(agentId, 'idle', session.tenantId).catch(() => {});

    // Cancel Asterisk originate channel
    await asteriskService.hangupChannel(`PJSIP/${agentId}`);

    // Attempt to route to the NEXT longest idle agent
    const success = await this.routeCallToAgent(session.tenantId, session.callId, session.customerNumber, session.skippedAgents);
    
    // If routing next failed (e.g. no more idle agents), trigger missed escalation
    if (!success) {
      await this.escalateMissedCall(session.tenantId, session.callId, agentId, 'Agent did not answer and no other agents are available');
    }
  }

  /**
   * Escalates a missed call to the TL or Mentor according to hierarchy.
   */
  async escalateMissedCall(tenantId, callId, agentId, reason) {
    try {
      console.log(`[Escalation] Escalating missed call ${callId} for agent ${agentId || 'none'}. Reason: ${reason}`);
      
      // Update call status to missed
      await executeTenantQuery(tenantId,
        `UPDATE calls SET status = 'missed', end_time = NOW() WHERE id = $1`,
        [callId]
      );

      let supervisorId = null;

      if (agentId) {
        // Find Agent's parent (TL) status
        const tlResult = await executeTenantQuery(tenantId, `
          SELECT u.id, ap.current_status 
          FROM users u
          JOIN agent_profiles ap ON ap.user_id = u.id
          WHERE u.id = (SELECT parent_id FROM users WHERE id = $1)
        `, [agentId]);

        if (tlResult.rows.length > 0) {
          const tl = tlResult.rows[0];
          // If TL is active/login/idle, they receive the escalation.
          if (tl.current_status !== 'holiday' && tl.current_status !== 'offline') {
            supervisorId = tl.id;
          } else {
            // TL is absent, look up Mentor (TL's parent)
            const mentorResult = await executeTenantQuery(tenantId, `
              SELECT u.id 
              FROM users u
              WHERE u.id = (SELECT parent_id FROM users WHERE id = $1)
            `, [tl.id]);
            
            if (mentorResult.rows.length > 0) {
              supervisorId = mentorResult.rows[0].id;
              console.log(`[Escalation] TL is absent. Escalating directly to Mentor: ${supervisorId}`);
            }
          }
        }
      }

      if (!supervisorId) {
        // Fallback: Find any active TL or Client Admin for this tenant
        const fallbackResult = await executeTenantQuery(tenantId, `
          SELECT id FROM users WHERE tenant_id = $1 AND role = 'team_leader' LIMIT 1
        `, [tenantId]);
        if (fallbackResult.rows.length > 0) {
          supervisorId = fallbackResult.rows[0].id;
        }
      }

      // Record escalation in Database
      await executeTenantQuery(tenantId, `
        INSERT INTO escalations (tenant_id, call_id, from_user_id, to_user_id, reason)
        VALUES ($1, $2, $3, $4, $5)
      `, [tenantId, callId, agentId, supervisorId, reason]);

      // Emit realtime alert to the active socket server room for this supervisor
      // This will be processed by the SocketServer module
      if (global.io && supervisorId) {
        global.io.to(supervisorId).emit('escalation_alert', {
          callId,
          agentId,
          reason,
          timestamp: new Date()
        });
        console.log(`[Escalation] Socket alert sent to Supervisor ${supervisorId}`);
      }

    } catch (err) {
      console.error('[Escalation] Failed to escalate call:', err);
    }
  }

  extractAgentIdFromChannel(channel) {
    // Channel name format: PJSIP/agentId-00000abc or PJSIP/agentId
    const match = channel.match(/PJSIP\/([a-f0-9\-]{36})/i);
    return match ? match[1] : null;
  }
}

const routingService = new RoutingService();
export default routingService;
