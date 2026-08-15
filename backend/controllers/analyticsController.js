import pool, { executeTenantQuery } from '../config/database.js';

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

// Tenant Dashboard overview: credit balance history, per-campaign progress, call-outcome
// breakdown, and a daily trend - the same shape of data as getAdminOverview below but scoped to
// the caller's own tenant (req.tenantId, guaranteed set by injectTenantContext for these roles).
export async function getTenantOverview(req, res) {
  const tenantId = req.tenantId;

  try {
    const [balanceResult, creditHistoryResult, campaignsResult, outcomeResult, trendResult] = await Promise.all([
      executeTenantQuery(tenantId, `SELECT credit_balance FROM tenants WHERE id = $1`, [tenantId]),
      // One point per day - the last balance snapshot that day - rather than every individual
      // transaction, so a campaign with thousands of per-call deductions still renders a clean
      // 14-point line instead of an unreadable sawtooth.
      executeTenantQuery(tenantId, `
        SELECT DISTINCT ON (DATE(created_at)) DATE(created_at) AS day, balance_after
        FROM credit_transactions
        WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
        ORDER BY DATE(created_at), created_at DESC
      `, [tenantId]),
      executeTenantQuery(tenantId, `
        SELECT name, status, total_leads, processed_leads
        FROM voice_campaigns
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 8
      `, [tenantId]),
      executeTenantQuery(tenantId, `
        SELECT cl.dial_status, COUNT(*)::int AS count
        FROM campaign_leads cl
        JOIN voice_campaigns vc ON vc.id = cl.campaign_id
        WHERE vc.tenant_id = $1
        GROUP BY cl.dial_status
      `, [tenantId]),
      executeTenantQuery(tenantId, `
        SELECT DATE(cl.updated_at) AS day,
               COUNT(*) FILTER (WHERE cl.dial_status = 'answered')::int AS answered,
               COUNT(*) FILTER (WHERE cl.dial_status IN ('busy', 'failed', 'no-answer'))::int AS rejected
        FROM campaign_leads cl
        JOIN voice_campaigns vc ON vc.id = cl.campaign_id
        WHERE vc.tenant_id = $1
          AND cl.dial_status IN ('answered', 'busy', 'failed', 'no-answer')
          AND cl.updated_at >= NOW() - INTERVAL '14 days'
        GROUP BY DATE(cl.updated_at)
        ORDER BY day
      `, [tenantId])
    ]);

    const outcomeCounts = { pending: 0, processing: 0, answered: 0, busy: 0, failed: 0, 'no-answer': 0, opted_out: 0 };
    for (const row of outcomeResult.rows) {
      if (row.dial_status in outcomeCounts) outcomeCounts[row.dial_status] = row.count;
    }
    const totalDialed = outcomeCounts.answered + outcomeCounts.busy + outcomeCounts.failed + outcomeCounts['no-answer'];

    res.json({
      creditBalance: balanceResult.rows[0]?.credit_balance ?? 0,
      creditHistory: creditHistoryResult.rows.map((r) => ({ day: r.day, balance: r.balance_after })),
      campaigns: campaignsResult.rows,
      totalDialed,
      outcomeCounts,
      dailyTrend: trendResult.rows.map((r) => ({ day: r.day, answered: r.answered, rejected: r.rejected }))
    });
  } catch (error) {
    console.error('getTenantOverview failed:', error);
    res.status(500).json({ error: 'Failed to compile tenant overview' });
  }
}

// Super Admin's dashboard overview: platform-wide totals + call-outcome breakdown + a daily
// call-volume trend, all sourced from campaign_leads/voice_campaigns (the actual outbound
// broadcast system this app runs) - deliberately NOT the `calls` table getCallLogs above uses,
// which is a separate, architecturally-unrelated inbound/agent-desk flow. pool.query (not
// executeTenantQuery) throughout since every query here is intentionally cross-tenant.
export async function getAdminOverview(req, res) {
  try {
    const [tenantsResult, campaignsResult, outcomeResult, trendResult, topTenantsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM tenants WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM voice_campaigns`),
      pool.query(`
        SELECT dial_status, COUNT(*)::int AS count
        FROM campaign_leads
        GROUP BY dial_status
      `),
      // Daily call-volume trend for the line chart - only genuine dialed OUTCOMES (a lead that's
      // still 'pending'/'processing' hasn't been dialed to completion yet, so it's excluded the
      // same way finalizeLead's connect_attempts logic treats those as not-yet-real-attempts).
      pool.query(`
        SELECT DATE(updated_at) AS day,
               COUNT(*) FILTER (WHERE dial_status = 'answered')::int AS answered,
               COUNT(*) FILTER (WHERE dial_status IN ('busy', 'failed', 'no-answer'))::int AS rejected
        FROM campaign_leads
        WHERE dial_status IN ('answered', 'busy', 'failed', 'no-answer')
          AND updated_at >= NOW() - INTERVAL '14 days'
        GROUP BY DATE(updated_at)
        ORDER BY day
      `),
      pool.query(`
        SELECT t.name, COUNT(cl.id)::int AS dialed
        FROM campaign_leads cl
        JOIN voice_campaigns vc ON vc.id = cl.campaign_id
        JOIN tenants t ON t.id = vc.tenant_id
        WHERE cl.dial_status IN ('answered', 'busy', 'failed', 'no-answer')
        GROUP BY t.name
        ORDER BY dialed DESC
        LIMIT 5
      `)
    ]);

    const outcomeCounts = { pending: 0, processing: 0, answered: 0, busy: 0, failed: 0, 'no-answer': 0, opted_out: 0 };
    for (const row of outcomeResult.rows) {
      if (row.dial_status in outcomeCounts) outcomeCounts[row.dial_status] = row.count;
    }
    const totalDialed = outcomeCounts.answered + outcomeCounts.busy + outcomeCounts.failed + outcomeCounts['no-answer'];

    res.json({
      totalTenants: tenantsResult.rows[0].count,
      totalCampaigns: campaignsResult.rows[0].count,
      totalDialed,
      outcomeCounts,
      dailyTrend: trendResult.rows.map((r) => ({ day: r.day, answered: r.answered, rejected: r.rejected })),
      topTenants: topTenantsResult.rows
    });
  } catch (error) {
    console.error('getAdminOverview failed:', error);
    res.status(500).json({ error: 'Failed to compile admin overview' });
  }
}
