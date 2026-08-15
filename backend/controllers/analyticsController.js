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
// Below this, a tenant is surfaced in the low-balance alert/campaign-attention widgets - kept in
// sync by hand with tenant/Dashboard.jsx's own LOW_CREDIT_THRESHOLD (no shared constants module
// between frontend/backend in this codebase).
const LOW_CREDIT_THRESHOLD = 20;

export async function getAdminOverview(req, res) {
  try {
    const [
      tenantsResult, campaignsResult, outcomeResult, trendResult, topTenantsResult,
      lowBalanceResult, portCapacityResult, liveCallsResult, attentionCampaignsResult,
      recentDncResult, recentTopupsResult, recentCancelledResult
    ] = await Promise.all([
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
      // Fetches a 30-day window once; the frontend's Today/14 days/30 days toggle just slices
      // this client-side rather than round-tripping for each range.
      pool.query(`
        SELECT DATE(updated_at) AS day,
               COUNT(*) FILTER (WHERE dial_status = 'answered')::int AS answered,
               COUNT(*) FILTER (WHERE dial_status IN ('busy', 'failed', 'no-answer'))::int AS rejected
        FROM campaign_leads
        WHERE dial_status IN ('answered', 'busy', 'failed', 'no-answer')
          AND updated_at >= NOW() - INTERVAL '30 days'
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
      `),
      pool.query(`SELECT id, name, credit_balance FROM tenants WHERE status = 'active' AND credit_balance <= $1 ORDER BY credit_balance ASC`, [LOW_CREDIT_THRESHOLD]),
      // Single physical Dinstar gateway (not a fleet) - "capacity" here means how many of its
      // allocated ports are currently registered and reachable, per the same telemetry
      // dinstarPoller.js keeps live and getMaxConcurrentCalls() already relies on.
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM gateway_ports)::int AS total_ports,
          (SELECT COUNT(*) FROM gateway_port_telemetry
             WHERE registration_status = 'REGISTER_OK' AND last_polled > NOW() - INTERVAL '90 seconds')::int AS registered_ports
      `),
      // Cross-tenant version of campaignController.js's getLiveCalls - same "currently
      // processing" definition, just without the tenant filter.
      pool.query(`
        SELECT cl.id AS lead_id, cl.customer_name, cl.phone_number, t.name AS tenant_name,
               vc.name AS campaign_name, cl.updated_at AS dispatched_at
        FROM campaign_leads cl
        JOIN voice_campaigns vc ON vc.id = cl.campaign_id
        JOIN tenants t ON t.id = vc.tenant_id
        WHERE cl.dial_status = 'processing'
        ORDER BY cl.updated_at ASC
        LIMIT 8
      `),
      // "Needs attention" = paused mid-run, or a tenant low on balance with a still-active
      // campaign that could stall on them next.
      pool.query(`
        SELECT vc.id, vc.name, vc.status, vc.total_leads, vc.processed_leads, t.id AS tenant_id, t.name AS tenant_name, t.credit_balance
        FROM voice_campaigns vc
        JOIN tenants t ON t.id = vc.tenant_id
        WHERE vc.status = 'paused' OR (vc.status IN ('running', 'preparing') AND t.credit_balance <= $1)
        ORDER BY vc.updated_at DESC
        LIMIT 6
      `, [LOW_CREDIT_THRESHOLD]),
      pool.query(`
        SELECT 'dnc' AS type, dn.created_at AS at, t.name AS tenant_name, NULL::text AS detail
        FROM dnc_numbers dn
        LEFT JOIN campaign_leads cl ON cl.id = dn.source_lead_id
        LEFT JOIN voice_campaigns vc ON vc.id = cl.campaign_id
        LEFT JOIN tenants t ON t.id = vc.tenant_id
        ORDER BY dn.created_at DESC
        LIMIT 5
      `),
      pool.query(`
        SELECT 'topup' AS type, ct.created_at AS at, t.name AS tenant_name, ct.amount::text AS detail
        FROM credit_transactions ct
        JOIN tenants t ON t.id = ct.tenant_id
        WHERE ct.type = 'topup'
        ORDER BY ct.created_at DESC
        LIMIT 5
      `),
      // A campaign auto-cancelled by finalizeLead's zero-balance guard (bulkCampaignWorker.js) is
      // a genuine safety event worth surfacing, not a manual pause - both share status='cancelled'
      // with no stored reason, so this can't distinguish "ran out of credit" from "cancelled for
      // some other reason" - shown as a general cancellation event rather than overclaiming why.
      pool.query(`
        SELECT 'cancelled' AS type, vc.updated_at AS at, t.name AS tenant_name, vc.name AS detail
        FROM voice_campaigns vc
        JOIN tenants t ON t.id = vc.tenant_id
        WHERE vc.status = 'cancelled'
        ORDER BY vc.updated_at DESC
        LIMIT 5
      `)
    ]);

    const recentActivity = [...recentDncResult.rows, ...recentTopupsResult.rows, ...recentCancelledResult.rows]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 6);

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
      topTenants: topTenantsResult.rows,
      lowBalanceClients: lowBalanceResult.rows,
      portCapacity: portCapacityResult.rows[0],
      liveCalls: liveCallsResult.rows,
      attentionCampaigns: attentionCampaignsResult.rows,
      recentActivity
    });
  } catch (error) {
    console.error('getAdminOverview failed:', error);
    res.status(500).json({ error: 'Failed to compile admin overview' });
  }
}
