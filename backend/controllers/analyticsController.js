import { executeTenantQuery } from '../config/database.js';

// Get comprehensive live stats dashboard for Client Admin & Team Leaders
export async function getLiveMetrics(req, res) {
  const tenantId = req.tenantId;

  try {
    // 1. Live Agent status counts
    const agentStatusesResult = await executeTenantQuery(tenantId, `
      SELECT ap.current_status, COUNT(*) as count
      FROM agent_profiles ap
      JOIN users u ON u.id = ap.user_id
      WHERE u.tenant_id = $1
      GROUP BY ap.current_status
    `, [tenantId]);

    const agentStatusCounts = {
      login: 0,
      idle: 0,
      break: 0,
      offline: 0,
      holiday: 0
    };

    agentStatusesResult.rows.forEach(r => {
      if (r.current_status in agentStatusCounts) {
        agentStatusCounts[r.current_status] = parseInt(r.count);
      }
    });

    // 2. Conversion count today
    const conversionsResult = await executeTenantQuery(tenantId, `
      SELECT COUNT(*) as count
      FROM calls c
      JOIN dispositions d ON d.id = c.disposition_id
      WHERE c.tenant_id = $1 
        AND c.created_at >= CURRENT_DATE
        AND d.is_resolved = TRUE
    `, [tenantId]);

    const todayConversions = parseInt(conversionsResult.rows[0].count || 0);

    // 3. Active queue volume (calls with status queued or ringing)
    const queueVolumeResult = await executeTenantQuery(tenantId, `
      SELECT COUNT(*) as count
      FROM calls
      WHERE tenant_id = $1 AND status IN ('queued', 'ringing')
    `, [tenantId]);

    const activeQueueVolume = parseInt(queueVolumeResult.rows[0].count || 0);

    // 4. SLA breaches count (unresolved calls in buckets beyond deadline)
    const slaBreachResult = await executeTenantQuery(tenantId, `
      SELECT COUNT(*) as count
      FROM buckets
      WHERE tenant_id = $1 
        AND status = 'pending' 
        AND NOW() > sla_deadline
    `, [tenantId]);

    const slaBreaches = parseInt(slaBreachResult.rows[0].count || 0);

    // 5. Missed calls today
    const missedTodayResult = await executeTenantQuery(tenantId, `
      SELECT COUNT(*) as count
      FROM calls
      WHERE tenant_id = $1 
        AND status = 'missed' 
        AND created_at >= CURRENT_DATE
    `, [tenantId]);

    const missedCallsToday = parseInt(missedTodayResult.rows[0].count || 0);

    // 6. Get details of live agent statuses
    const agentDetailsResult = await executeTenantQuery(tenantId, `
      SELECT u.username, u.role, ap.current_status, ap.last_status_change, ap.current_language, ap.daily_transfer_count, ap.is_temporary_blocked
      FROM users u
      JOIN agent_profiles ap ON ap.user_id = u.id
      WHERE u.tenant_id = $1 AND u.role = 'agent'
      ORDER BY ap.current_status DESC, u.username
    `, [tenantId]);

    res.json({
      agentStatusCounts,
      todayConversions,
      activeQueueVolume,
      slaBreaches,
      missedCallsToday,
      agentsList: agentDetailsResult.rows
    });

  } catch (error) {
    console.error('getLiveMetrics failed:', error);
    res.status(500).json({ error: 'Failed to compile analytics metrics' });
  }
}

// Get master logs for reports (Super Admin and Client Admin only). injectTenantContext sets
// req.tenantId = null for super_admin specifically to bypass RLS (see middleware/rls.js) - but
// `WHERE c.tenant_id = $1` with $1 = null never matches anything in SQL (NULL isn't equal to
// NULL via `=`), so super_admin always got zero rows here instead of the global view the null
// was meant to produce. Skip the tenant filter entirely when tenantId is null, same pattern
// gatewayController.js's getPortAllocations already uses for its isSuperAdmin branch.
export async function getCallLogs(req, res) {
  const tenantId = req.tenantId;

  try {
    const result = await executeTenantQuery(tenantId, `
      SELECT c.id, c.caller_number, c.callee_number, c.direction, c.status, c.start_time, c.duration, c.recording_url,
             u.username as agent_name, d.code as disposition_code, d.description as disposition_desc
      FROM calls c
      LEFT JOIN users u ON u.id = c.agent_id
      LEFT JOIN dispositions d ON d.id = c.disposition_id
      ${tenantId ? 'WHERE c.tenant_id = $1' : ''}
      ORDER BY c.start_time DESC
      LIMIT 100
    `, tenantId ? [tenantId] : []);

    res.json(result.rows);
  } catch (error) {
    console.error('getCallLogs failed:', error);
    res.status(500).json({ error: 'Failed to retrieve call logs' });
  }
}
