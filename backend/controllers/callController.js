import { executeTenantQuery } from '../config/database.js';
import asteriskService from '../services/asteriskService.js';
import routingService from '../services/routingService.js';
import { syncAgentQueueMembership } from '../services/queueMembershipService.js';

// Initiate outbound call (click-to-dial for Agents)
export async function initiateOutboundCall(req, res) {
  const { customerNumber, campaignId, bucketId } = req.body;
  const agentId = req.user.id;
  const tenantId = req.tenantId;

  if (!customerNumber) {
    return res.status(400).json({ error: 'Customer phone number is required' });
  }

  try {
    // 1. Create a Call log registry
    const callResult = await executeTenantQuery(tenantId, `
      INSERT INTO calls (tenant_id, campaign_id, caller_number, callee_number, agent_id, direction, status)
      VALUES ($1, $2, 'AgentSoftphone', $3, $4, 'outbound', 'ringing')
      RETURNING *
    `, [tenantId, campaignId || null, customerNumber, agentId]);
    
    const call = callResult.rows[0];

    // If originating from an assigned bucket, link it
    if (bucketId) {
      await executeTenantQuery(tenantId, `
        UPDATE buckets SET call_id = $1 WHERE id = $2
      `, [call.id, bucketId]);
    }

    // 2. Lock agent state to 'offline' (on-call) during dial
    await executeTenantQuery(tenantId, `
      UPDATE agent_profiles SET current_status = 'offline', last_status_change = NOW() WHERE user_id = $1
    `, [agentId]);
    syncAgentQueueMembership(agentId, 'offline', tenantId).catch(() => {});

    // 3. Dial outbound using Asterisk AMI
    const channel = `PJSIP/${agentId}`;
    const context = 'outbound-dial-context';
    const trunk = 'ClientTrunk'; // Real trunk mapped via database rules in custom configurations

    // Trigger call async
    asteriskService.originateCall(
      channel,
      customerNumber,
      context,
      1,
      { CALL_ID: call.id, TENANT_ID: tenantId },
      customerNumber
    ).catch(err => console.error('Outbound Asterisk Dial failed:', err.message));

    res.json({
      message: 'Call initiated',
      callId: call.id
    });
  } catch (error) {
    console.error('initiateOutboundCall failed:', error);
    res.status(500).json({ error: 'Failed to dial call' });
  }
}

// Post-Call disposition submission (mandatory block release)
export async function submitDisposition(req, res) {
  const { callId, dispositionCode, comments, bucketId } = req.body;
  const agentId = req.user.id;
  const tenantId = req.tenantId;

  if (!callId || !dispositionCode) {
    return res.status(400).json({ error: 'Call ID and disposition code are required' });
  }

  try {
    // 1. Resolve disposition ID
    const dispResult = await executeTenantQuery(tenantId, `
      SELECT id, is_resolved FROM dispositions WHERE tenant_id = $1 AND code = $2
    `, [tenantId, dispositionCode]);

    if (dispResult.rows.length === 0) {
      return res.status(404).json({ error: 'Disposition code invalid for this tenant' });
    }

    const disposition = dispResult.rows[0];

    // 2. Update call record with disposition
    await executeTenantQuery(tenantId, `
      UPDATE calls 
      SET disposition_id = $1, status = 'completed', end_time = NOW(), duration = EXTRACT(EPOCH FROM (NOW() - start_time))
      WHERE id = $2
    `, [disposition.id, callId]);

    // 3. Update active bucket status if linked
    if (bucketId) {
      const bucketStatus = disposition.is_resolved ? 'resolved' : 'pending';
      await executeTenantQuery(tenantId, `
        UPDATE buckets 
        SET status = $1, is_sla_breached = (CASE WHEN NOW() > sla_deadline THEN TRUE ELSE FALSE END)
        WHERE id = $2
      `, [bucketStatus, bucketId]);
    }

    // 4. Release Agent: Set agent status back to 'idle' so they can take the next call
    await executeTenantQuery(tenantId, `
      UPDATE agent_profiles
      SET current_status = 'idle', last_status_change = NOW()
      WHERE user_id = $1
    `, [agentId]);
    syncAgentQueueMembership(agentId, 'idle', tenantId).catch(() => {});

    res.json({ message: 'Disposition submitted successfully, agent set to idle.' });
  } catch (error) {
    console.error('submitDisposition failed:', error);
    res.status(500).json({ error: 'Failed to record disposition' });
  }
}

// Log agent breaks (Lunch, Tea, etc.)
export async function updateAgentBreakStatus(req, res) {
  const { status, breakType } = req.body; // status: 'break' or 'idle'
  const agentId = req.user.id;
  const tenantId = req.tenantId;

  try {
    const profileResult = await executeTenantQuery(tenantId, `
      SELECT id, current_status FROM agent_profiles WHERE user_id = $1
    `, [agentId]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent profile not found' });
    }

    const profile = profileResult.rows[0];

    if (status === 'break') {
      if (!breakType) {
        return res.status(400).json({ error: 'Break type is required (tea, lunch, etc.)' });
      }

      // Log break start timesheet
      await executeTenantQuery(tenantId, `
        INSERT INTO agent_breaks (agent_profile_id, break_type)
        VALUES ($1, $2)
      `, [profile.id, breakType]);

      // Set agent profile status to 'break'
      await executeTenantQuery(tenantId, `
        UPDATE agent_profiles SET current_status = 'break', last_status_change = NOW() WHERE user_id = $1
      `, [agentId]);
      syncAgentQueueMembership(agentId, 'break', tenantId).catch(() => {});

      res.json({ message: `Agent went on ${breakType} break` });

    } else if (status === 'idle') {
      // Close open break timesheet logs
      await executeTenantQuery(tenantId, `
        UPDATE agent_breaks 
        SET end_time = NOW() 
        WHERE agent_profile_id = $1 AND end_time IS NULL
      `, [profile.id]);

      // Set agent profile status back to 'idle'
      await executeTenantQuery(tenantId, `
        UPDATE agent_profiles SET current_status = 'idle', last_status_change = NOW() WHERE user_id = $1
      `, [agentId]);
      syncAgentQueueMembership(agentId, 'idle', tenantId).catch(() => {});

      res.json({ message: 'Agent returned to idle' });
    } else {
      res.status(400).json({ error: 'Invalid status requested' });
    }

  } catch (error) {
    console.error('updateAgentBreakStatus failed:', error);
    res.status(500).json({ error: 'Failed to update break status' });
  }
}

// Fetch assigned outbound daily call bucket for the agent
export async function getAgentBucket(req, res) {
  const agentId = req.user.id;
  const tenantId = req.tenantId;

  try {
    const result = await executeTenantQuery(tenantId, `
      SELECT id, customer_number, customer_name, assigned_time, sla_deadline, status, is_sla_breached,
             (CASE WHEN NOW() > sla_deadline AND status = 'pending' THEN TRUE ELSE FALSE END) as live_sla_breached
      FROM buckets
      WHERE agent_id = $1 AND status = 'pending'
      ORDER BY sla_deadline ASC
    `, [agentId]);

    res.json(result.rows);
  } catch (error) {
    console.error('getAgentBucket failed:', error);
    res.status(500).json({ error: 'Failed to retrieve agent bucket' });
  }
}

// Re-assign absent agent calls bucket to another agent (TL/Supervisor feature)
export async function reassignAbsenteeBucket(req, res) {
  const { absentAgentId, targetAgentId } = req.body;
  const tenantId = req.tenantId;

  if (!absentAgentId || !targetAgentId) {
    return res.status(400).json({ error: 'Both absent agent ID and target agent ID are required' });
  }

  try {
    // Verify absent agent is indeed offline or holiday
    const absentProfile = await executeTenantQuery(tenantId, `
      SELECT current_status FROM agent_profiles WHERE user_id = $1
    `, [absentAgentId]);

    if (absentProfile.rows.length > 0 && absentProfile.rows[0].current_status === 'idle') {
      return res.status(400).json({ error: 'Selected absent agent is active and currently idle.' });
    }

    // Shift all pending calls from absent agent to target agent
    const result = await executeTenantQuery(tenantId, `
      UPDATE buckets
      SET agent_id = $1, assigned_time = NOW()
      WHERE agent_id = $2 AND status = 'pending'
      RETURNING id
    `, [targetAgentId, absentAgentId]);

    res.json({
      message: `Shifted ${result.rows.length} pending calls to target agent successfully.`,
      count: result.rows.length
    });
  } catch (error) {
    console.error('reassignAbsenteeBucket failed:', error);
    res.status(500).json({ error: 'Failed to reassign bucket' });
  }
}

// Language/Abuse protection transfer click
export async function triggerLanguageTransfer(req, res) {
  const { callId, targetLanguage } = req.body;
  const agentId = req.user.id;
  const tenantId = req.tenantId;

  if (!callId || !targetLanguage) {
    return res.status(400).json({ error: 'Call ID and target language are required' });
  }

  try {
    // Get agent profile info
    const profileResult = await executeTenantQuery(tenantId, `
      SELECT id, daily_transfer_count, is_temporary_blocked FROM agent_profiles WHERE user_id = $1
    `, [agentId]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent profile not found' });
    }

    const profile = profileResult.rows[0];

    // Check if agent block threshold has been hit
    if (profile.is_temporary_blocked || profile.daily_transfer_count >= 3) {
      // Auto Lock and notify TL
      await executeTenantQuery(tenantId, `
        UPDATE agent_profiles SET is_temporary_blocked = TRUE WHERE id = $1
      `, [profile.id]);

      // Trigger realtime Socket escalation to TL/Supervisor
      if (global.io) {
        // Query TL reporting hierarchy
        const tlResult = await executeTenantQuery(tenantId, `SELECT parent_id FROM users WHERE id = $1`, [agentId]);
        if (tlResult.rows.length > 0 && tlResult.rows[0].parent_id) {
          global.io.to(tlResult.rows[0].parent_id).emit('supervisor_warning', {
            type: 'ABUSE_TRANSFER_ATTEMPT',
            agentId,
            message: `Agent transfer limit breached (3 times). Button blocked.`
          });
        }
      }

      return res.status(403).json({ error: 'Language transfer blocked. Daily limit (3) exceeded. Supervisor notified.' });
    }

    // Proceed with dynamic escalation routing: find an active agent with the requested language
    const languageAgentResult = await executeTenantQuery(tenantId, `
      SELECT ap.user_id 
      FROM agent_profiles ap
      JOIN users u ON u.id = ap.user_id
      WHERE u.tenant_id = $1 
        AND ap.current_status = 'idle' 
        AND ap.current_language = $2 
        AND ap.user_id != $3
      LIMIT 1
    `, [tenantId, targetLanguage, agentId]);

    if (languageAgentResult.rows.length === 0) {
      return res.status(404).json({ error: `No active idle agents speak ${targetLanguage}` });
    }

    const targetAgentId = languageAgentResult.rows[0].user_id;

    // Increment transfer count
    await executeTenantQuery(tenantId, `
      UPDATE agent_profiles 
      SET daily_transfer_count = daily_transfer_count + 1 
      WHERE id = $1
    `, [profile.id]);

    // Update active call agent mapping
    await executeTenantQuery(tenantId, `
      UPDATE calls SET agent_id = $1, status = 'ringing' WHERE id = $2
    `, [targetAgentId, callId]);

    // Redirect trunk/channel via Asterisk AMI
    const channel = `PJSIP/${targetAgentId}`;
    asteriskService.originateCall(
      channel,
      'LanguageTransferRoute',
      'incoming-webrtc-context',
      1,
      { CALL_ID: callId, TENANT_ID: tenantId },
      'LanguageTransfer'
    ).catch(err => console.error('Language transfer redirect failed:', err.message));

    // Release current agent back to idle
    await executeTenantQuery(tenantId, `
      UPDATE agent_profiles SET current_status = 'idle', last_status_change = NOW() WHERE user_id = $1
    `, [agentId]);
    syncAgentQueueMembership(agentId, 'idle', tenantId).catch(() => {});

    res.json({ message: 'Language re-routing initiated successfully.' });

  } catch (error) {
    console.error('triggerLanguageTransfer failed:', error);
    res.status(500).json({ error: 'Failed to process language transfer' });
  }
}

// Moves an agent from 'login' to 'idle' - the missing "go ready" action noted while building
// Workstream 7: login() only ever sets 'login', so without this an agent who just signed in is
// never added to their client's agent queue at all. This is what the softphone's Ready button
// calls; before it was wired up, no agent ever reached 'idle' and every queue stayed empty.
// The counterpart to setAgentReady: the agent's softphone has gone away (tab closed, SIP
// unregistered, shift ended) and they must stop being offered calls.
//
// Deliberately NOT modelled as a break: /break writes an agent_breaks timesheet row, and a closed
// browser tab is not a tea break - recording it as one would quietly corrupt break reporting.
// It's also not a logout: logout bumps token_version and kills every session for the account,
// which is far too destructive for "this one tab closed".
export async function setAgentOffline(req, res) {
  const agentId = req.user.id;
  const tenantId = req.tenantId;

  try {
    const result = await executeTenantQuery(tenantId, `
      UPDATE agent_profiles SET current_status = 'offline', last_status_change = NOW()
       WHERE user_id = $1
      RETURNING id
    `, [agentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Agent profile not found' });
    }

    syncAgentQueueMembership(agentId, 'offline', tenantId).catch(() => {});
    res.json({ message: 'Agent is now offline' });
  } catch (error) {
    console.error('setAgentOffline failed:', error);
    res.status(500).json({ error: 'Failed to set agent offline' });
  }
}

export async function setAgentReady(req, res) {
  const agentId = req.user.id;
  const tenantId = req.tenantId;

  try {
    const result = await executeTenantQuery(tenantId, `
      UPDATE agent_profiles SET current_status = 'idle', last_status_change = NOW() WHERE user_id = $1
      RETURNING id
    `, [agentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Agent profile not found' });
    }

    syncAgentQueueMembership(agentId, 'idle', tenantId).catch(() => {});
    res.json({ message: 'Agent is now idle and ready for calls' });
  } catch (error) {
    console.error('setAgentReady failed:', error);
    res.status(500).json({ error: 'Failed to set agent ready' });
  }
}
