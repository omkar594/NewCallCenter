import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Import configs & services
import pool from './config/database.js';
import redis from './config/redis.js';
import asteriskService from './services/asteriskService.js';
import ariService from './services/ariService.js';
import spamService from './services/spamService.js';
import routingService from './services/routingService.js';
import { resyncAllIdleAgents } from './services/queueMembershipService.js';
import { executeTenantQuery } from './config/database.js';

// Import routes
import authRoutes from './routes/auth.js';
import gatewayRoutes from './routes/gateway.js';
import campaignRoutes from './routes/campaign.js';
import callRoutes from './routes/call.js';
import analyticsRoutes from './routes/analytics.js';
import ivrRoutes from './routes/ivr.js';

// Start Outbound Campaign Queue Worker
import './bulkCampaignWorker.js';
// Start Dinstar gateway telemetry poller (previously never imported, so gateway_port_telemetry
// never populated in the deployed process - see plan Workstream 4).
import './dinstarPoller.js';
// Workstream 7: records AMD/DTMF dialplan markers onto campaign_leads for reporting.
import './services/campaignTelemetryListener.js';
// Workstream 8: client-configurable IVR flow engine - registers ARI StasisStart/StasisEnd
// listeners. Side-effect import only; the actual ariService.connect() call happens in
// server.listen()'s callback below, alongside the existing AMI connect.
import './services/ivrFlowEngine.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Expose Socket.io globally for real-time escalations
global.io = io;

// Keep the `campaign_agents` Asterisk queue's membership in sync with Postgres on every AMI
// (re)connect - including after an Asterisk restart, where queues.conf's persistentmembers=no
// means the queue otherwise comes back empty until each agent's next unrelated status change.
asteriskService.on('ami_ready', () => {
  resyncAllIdleAgents().catch((err) => console.error('[QueueMembership] Resync on ami_ready failed:', err.message));
});

// Ensure upload static directories exist on server boot
const uploadsDir = path.resolve(process.cwd(), 'uploads');
const tempUploadsDir = path.resolve(process.cwd(), 'uploads', 'temp');
const audioUploadsDir = path.resolve(process.cwd(), 'uploads', 'campaign_audio');

[uploadsDir, tempUploadsDir, audioUploadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
  }
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/gateways', gatewayRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ivr', ivrRoutes);

// Auto-initialize database tables if missing (essential for cloud hosting like Render).
// Kept in sync with database/schema.sql's voice_campaigns/campaign_leads definitions -
// these two used to drift (different nullability, missing indexes/columns on one side),
// which caused query failures depending on which path had created the tables. If you change
// one, change the other.
async function initSchema() {
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS voice_campaigns (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID DEFAULT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          name VARCHAR(255) NOT NULL,
          allowed_ports VARCHAR(255) DEFAULT 'all',
          audio_url VARCHAR(512),
          status VARCHAR(50) DEFAULT 'pending',
          total_leads INTEGER DEFAULT 0,
          processed_leads INTEGER DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE voice_campaigns ADD COLUMN IF NOT EXISTS tenant_id UUID DEFAULT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

      CREATE TABLE IF NOT EXISTS campaign_leads (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          campaign_id UUID REFERENCES voice_campaigns(id) ON DELETE CASCADE,
          customer_name VARCHAR(255),
          phone_number VARCHAR(50) NOT NULL,
          dial_status VARCHAR(50) DEFAULT 'pending',
          call_duration INTEGER DEFAULT 0,
          attempts INTEGER DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_leads_dial_status ON campaign_leads(dial_status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_leads_campaign_id ON campaign_leads(campaign_id);

      -- Workstream 9: lets a client tag each lead with its own known language (CSV/JSON upload)
      -- so one IVR flow speaks correctly to every customer without a language-selection menu -
      -- see ivrFlowEngine.js's state.languageCode and ttsService.js's PIPER_VOICE_MODELS map.
      ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS language_code VARCHAR(10) DEFAULT 'en-US';

      -- Gateway Telemetry API tables (GET /api/gateways etc.) - these were defined in
      -- database/schema.sql but that file was never actually run against production, only
      -- this function was, so these tables never existed and every gateway-management
      -- endpoint 500'd. Created here the same idempotent way as the campaign tables above.
      CREATE TABLE IF NOT EXISTS tenants (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          name VARCHAR(255) NOT NULL UNIQUE,
          subdomain VARCHAR(100) NOT NULL UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Soft-delete support: deactivating a tenant locks out its logins and releases its ports
      -- without touching any historical data (flows/campaigns/call logs) - see
      -- authController.js's deactivateClient/reactivateClient.
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'deactivated'));

      -- Credit billing: every answered call deducts credits based on connected duration (see
      -- utils/creditCalculator.js). Only super_admin can top up via authController.js's
      -- addCredits - see bulkCampaignWorker.js's finalizeLead for the deduction side.
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS credit_balance INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS gateways (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          name VARCHAR(255) NOT NULL UNIQUE,
          ip_address VARCHAR(100) NOT NULL UNIQUE,
          sn VARCHAR(100) NOT NULL UNIQUE,
          total_ports INTEGER DEFAULT 8,
          status VARCHAR(50) DEFAULT 'online',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS gateway_ports (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          gateway_id UUID NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
          port_number INTEGER NOT NULL CHECK (port_number BETWEEN 0 AND 31),
          tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
          mapped_trunk_name VARCHAR(100),
          status VARCHAR(50) DEFAULT 'idle',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (gateway_id, port_number)
      );

      CREATE TABLE IF NOT EXISTS gateway_port_telemetry (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          gateway_ip VARCHAR(100) NOT NULL,
          port_number INTEGER NOT NULL,
          sim_number VARCHAR(50),
          signal_strength INTEGER DEFAULT 0,
          registration_status VARCHAR(50) NOT NULL DEFAULT 'UNREGISTER',
          call_state VARCHAR(50) DEFAULT 'Idle',
          last_polled TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (gateway_ip, port_number)
      );

      -- Contact Center / Agent-desk tables (routes/auth.js, routes/call.js, routingService.js).
      -- Same root cause as the gateway tables above: schema.sql defines these but was never
      -- actually run against production - only this function was. Without them every agent-desk
      -- endpoint (agent login, /api/calls/*, /api/analytics/*) 500s the same way GET /api/gateways
      -- did, and the press-1-to-agent feature (Workstream 7) needs agent_profiles/users to exist
      -- to function at all.
      INSERT INTO tenants (id, name, subdomain)
      VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Default Tenant', 'default')
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          username VARCHAR(150) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) NOT NULL CHECK (role IN ('super_admin', 'client_admin', 'mentor', 'team_leader', 'agent')),
          parent_id UUID REFERENCES users(id) ON DELETE SET NULL,
          status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_profiles (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          current_status VARCHAR(50) DEFAULT 'offline' CHECK (current_status IN ('offline', 'login', 'idle', 'break', 'holiday')),
          last_status_change TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          current_language VARCHAR(50) DEFAULT 'English',
          daily_transfer_count INTEGER DEFAULT 0,
          is_temporary_blocked BOOLEAN DEFAULT FALSE,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      -- Workstream 7: holds each agent's generated SIP password so /api/auth/me/sip-credentials
      -- can return it without re-generating a new one (and breaking an already-registered
      -- softphone) on every call.
      ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS sip_secret VARCHAR(255);

      CREATE TABLE IF NOT EXISTS agent_breaks (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          agent_profile_id UUID NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          break_type VARCHAR(50) NOT NULL CHECK (break_type IN ('tea', 'lunch', 'meeting', 'other')),
          start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          end_time TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS campaigns (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          type VARCHAR(50) DEFAULT 'outbound' CHECK (type IN ('inbound', 'outbound')),
          status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS dispositions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          code VARCHAR(100) NOT NULL,
          description VARCHAR(255),
          is_resolved BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, code)
      );

      CREATE TABLE IF NOT EXISTS calls (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
          caller_number VARCHAR(50) NOT NULL,
          callee_number VARCHAR(50) NOT NULL,
          agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
          direction VARCHAR(50) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          status VARCHAR(50) DEFAULT 'queued' CHECK (status IN ('queued', 'ringing', 'active', 'completed', 'missed', 'failed')),
          start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          answer_time TIMESTAMP WITH TIME ZONE,
          end_time TIMESTAMP WITH TIME ZONE,
          duration INTEGER DEFAULT 0,
          recording_url VARCHAR(512),
          disposition_id UUID REFERENCES dispositions(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS buckets (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          customer_number VARCHAR(50) NOT NULL,
          customer_name VARCHAR(255),
          assigned_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          sla_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
          status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'escalated')),
          is_sla_breached BOOLEAN DEFAULT FALSE,
          call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS escalations (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
          bucket_id UUID REFERENCES buckets(id) ON DELETE SET NULL,
          from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          reason VARCHAR(255) NOT NULL,
          status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Workstream 7: do-not-call / opt-out compliance
      CREATE TABLE IF NOT EXISTS dnc_numbers (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          phone_number VARCHAR(50) NOT NULL UNIQUE,
          reason VARCHAR(100) DEFAULT 'caller_opt_out',
          source_campaign_id UUID REFERENCES voice_campaigns(id) ON DELETE SET NULL,
          source_lead_id UUID REFERENCES campaign_leads(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_dnc_phone ON dnc_numbers(phone_number);

      -- Credit billing ledger: one row per top-up (positive amount) or per-call deduction
      -- (negative amount, tied to the campaign/lead that earned it) - see
      -- utils/creditCalculator.js and authController.js's addCredits/getCreditTransactions.
      CREATE TABLE IF NOT EXISTS credit_transactions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          type VARCHAR(20) NOT NULL CHECK (type IN ('topup', 'deduction')),
          amount INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          campaign_id UUID REFERENCES voice_campaigns(id) ON DELETE SET NULL,
          lead_id UUID REFERENCES campaign_leads(id) ON DELETE SET NULL,
          note TEXT,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_credit_transactions_tenant ON credit_transactions(tenant_id, created_at DESC);

      ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS amd_status VARCHAR(20);
      ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS dtmf_selected VARCHAR(20);

      -- Workstream 7: Asterisk Realtime Architecture tables for dynamic per-agent SIP endpoints.
      -- res_config_pgsql on the EC2 box reads these directly (see telephony_config/sorcery.conf +
      -- res_pgsql.conf) - column set matches what chan_pjsip's realtime backend expects; cross-
      -- check against the installed Asterisk version's realtime sample config if an endpoint
      -- fails to register after provisioning.
      CREATE TABLE IF NOT EXISTS ps_endpoints (
          id VARCHAR(255) PRIMARY KEY,
          transport VARCHAR(255) DEFAULT 'transport-wss',
          aors VARCHAR(255),
          auth VARCHAR(255),
          context VARCHAR(255) DEFAULT 'incoming-webrtc-context',
          disallow VARCHAR(255) DEFAULT 'all',
          allow VARCHAR(255) DEFAULT 'alaw,ulaw',
          webrtc VARCHAR(5) DEFAULT 'yes',
          ice_support VARCHAR(5) DEFAULT 'yes',
          use_avpf VARCHAR(5) DEFAULT 'yes',
          media_encryption VARCHAR(20) DEFAULT 'dtls',
          dtls_verify VARCHAR(5) DEFAULT 'no',
          dtls_setup VARCHAR(20) DEFAULT 'actpass',
          dtls_auto_generate_cert VARCHAR(5) DEFAULT 'yes',
          rtcp_mux VARCHAR(5) DEFAULT 'yes',
          mailboxes VARCHAR(255),
          direct_media VARCHAR(5) DEFAULT 'no'
      );
      ALTER TABLE ps_endpoints ADD COLUMN IF NOT EXISTS mailboxes VARCHAR(255);
      -- Confirmed live (Workstream 7): must be explicit 'no', not Asterisk's own 'yes' default -
      -- direct_media between a WebRTC (DTLS-SRTP) agent leg and a plain-RTP PSTN leg silently
      -- stalls media negotiation (call shows "Up" but zero RTP packets flow either direction).
      ALTER TABLE ps_endpoints ADD COLUMN IF NOT EXISTS direct_media VARCHAR(5) DEFAULT 'no';
      UPDATE ps_endpoints SET direct_media = 'no' WHERE direct_media IS NULL;
      CREATE TABLE IF NOT EXISTS ps_auths (
          id VARCHAR(255) PRIMARY KEY,
          auth_type VARCHAR(40) DEFAULT 'userpass',
          username VARCHAR(255),
          password VARCHAR(255)
      );
      CREATE TABLE IF NOT EXISTS ps_aors (
          id VARCHAR(255) PRIMARY KEY,
          max_contacts INTEGER DEFAULT 1,
          remove_existing VARCHAR(5) DEFAULT 'yes'
      );

      -- Confirmed live: an AOR being realtime-backed isn't enough on its own - the dynamic
      -- Contact each REGISTER creates also needs somewhere realtime-backed to live, or
      -- res_pjsip_registrar.c fails with "Unable to bind contact ... to AOR" even though
      -- authentication succeeded. Column list is the exact set Asterisk's own INSERT uses
      -- (confirmed from the query it logs on a schema mismatch), not a guess.
      CREATE TABLE IF NOT EXISTS ps_contacts (
          id VARCHAR(255) PRIMARY KEY,
          uri VARCHAR(255),
          expiration_time BIGINT,
          qualify_frequency INTEGER,
          outbound_proxy VARCHAR(255),
          path TEXT,
          user_agent VARCHAR(255),
          qualify_timeout VARCHAR(10),
          reg_server VARCHAR(255),
          authenticate_qualify VARCHAR(5),
          via_addr VARCHAR(255),
          via_port INTEGER,
          call_id VARCHAR(255),
          endpoint VARCHAR(255),
          prune_on_boot VARCHAR(5),
          qualify_2xx_only VARCHAR(5)
      );

      -- Workstream 8: client-configurable IVR flow engine data model. A flow is a tree of nodes
      -- interpreted at call time by ivrFlowEngine.js via ARI - see plan Workstream 8 for the full
      -- node-type list. "tenant" here reuses the existing multi-tenant tenants table rather than
      -- inventing a parallel per-client concept.
      CREATE TABLE IF NOT EXISTS ivr_flows (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          is_active BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ivr_nodes (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          flow_id UUID NOT NULL REFERENCES ivr_flows(id) ON DELETE CASCADE,
          type VARCHAR(30) NOT NULL CHECK (type IN (
              'play', 'menu', 'collect_input', 'lookup', 'branch',
              'transfer_queue', 'sms', 'optout', 'amd_check', 'hangup'
          )),
          -- Marks the single node the engine starts a call on. Enforced one-per-flow below
          -- rather than left implicit, since the engine has no other way to find where to begin.
          is_start BOOLEAN NOT NULL DEFAULT FALSE,
          prompt_id VARCHAR(255),
          config JSONB NOT NULL DEFAULT '{}'::jsonb,
          next_node_id UUID REFERENCES ivr_nodes(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      -- Workstream 9: an explicit "just speak this text" field, always synthesized via TTS
      -- regardless of whether it contains {{variable}} placeholders - prompt_id's existing
      -- {{var}}-detection behavior is unchanged, this is an additive second option so a client
      -- authoring a fixed sentence with no dynamic content doesn't have to fake a variable or
      -- upload audio just to get it spoken. See ivrFlowEngine.js's resolvePromptMedia().
      ALTER TABLE ivr_nodes ADD COLUMN IF NOT EXISTS prompt_text TEXT;
      CREATE INDEX IF NOT EXISTS idx_ivr_nodes_flow_id ON ivr_nodes(flow_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ivr_nodes_one_start_per_flow
          ON ivr_nodes(flow_id) WHERE is_start = true;

      -- Branches out of 'menu' (keyed by DTMF digit) and 'lookup'/'branch' nodes (keyed by a
      -- result like 'found'/'not_found'/'error'). match_value is a plain string in both cases -
      -- the engine interprets it according to the source node's type.
      CREATE TABLE IF NOT EXISTS ivr_node_branches (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          node_id UUID NOT NULL REFERENCES ivr_nodes(id) ON DELETE CASCADE,
          match_value VARCHAR(100) NOT NULL,
          next_node_id UUID NOT NULL REFERENCES ivr_nodes(id) ON DELETE CASCADE,
          UNIQUE (node_id, match_value)
      );
      CREATE INDEX IF NOT EXISTS idx_ivr_node_branches_node_id ON ivr_node_branches(node_id);

      -- Client-hosted lookup tables (CSV-uploaded) for 'lookup' nodes whose source_type is
      -- 'table' rather than a client-owned webhook.
      CREATE TABLE IF NOT EXISTS ivr_lookup_tables (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          key_column VARCHAR(100) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ivr_lookup_rows (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          table_id UUID NOT NULL REFERENCES ivr_lookup_tables(id) ON DELETE CASCADE,
          key_value VARCHAR(255) NOT NULL,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          -- A duplicate key_value within one uploaded table must be a rejected, visible error at
          -- upload time (plan's explicit edge case), not silent last-write-wins - enforced here
          -- so the API can't accidentally skip that check.
          UNIQUE (table_id, key_value)
      );
      CREATE INDEX IF NOT EXISTS idx_ivr_lookup_rows_table_key ON ivr_lookup_rows(table_id, key_value);

      -- Links a campaign to the IVR flow it should run (Workstream 8.8's dialplan entry point
      -- reads this to decide Stasis(ivr_engine,...) vs. the plain campaign-broadcast-context).
      -- NULL means "ordinary single-prompt broadcast campaign", unchanged from before Workstream 8.
      ALTER TABLE voice_campaigns ADD COLUMN IF NOT EXISTS ivr_flow_id UUID REFERENCES ivr_flows(id) ON DELETE SET NULL;
    `);
    console.log('[Database] ✅ Schema and Indexes automatically verified/created.');
  } catch (err) {
    console.warn('[Database] Auto-schema init warning:', err.message);
  }
}
initSchema();

/**
 * Endpoint for Asterisk to verify inbound caller details and initiate ACD routing.
 * Triggers when Dinstar pushes calls to Asterisk.
 * 
 * Route: POST /api/voice/incoming-filter
 */
app.post('/api/voice/incoming-filter', async (req, res) => {
  const { callerNumber, trunkName } = req.body;

  if (!callerNumber || !trunkName) {
    return res.status(400).json({ error: 'callerNumber and trunkName are required' });
  }

  console.log(`[Incoming Call] Received CLI: ${callerNumber} on Trunk: ${trunkName}`);

  try {
    // 1. Spam check
    const isSpam = await spamService.checkIsSpam(callerNumber);
    if (isSpam) {
      console.log(`[Incoming Call] Rejecting spam call from ${callerNumber}`);
      return res.json({ action: 'reject', reason: 'Spam number detected' });
    }

    // 2. Identify Tenant associated with this trunk line
    const portResult = await executeTenantQuery(null, `
      SELECT tenant_id FROM gateway_ports WHERE mapped_trunk_name = $1 LIMIT 1
    `, [trunkName]);

    if (portResult.rows.length === 0 || !portResult.rows[0].tenant_id) {
      console.warn(`[Incoming Call] Trunk ${trunkName} is not allocated to any tenant. Hanging up.`);
      return res.json({ action: 'reject', reason: 'Trunk not configured' });
    }

    const tenantId = portResult.rows[0].tenant_id;

    // 3. Create call log entry (inbound, queued state)
    const callResult = await executeTenantQuery(tenantId, `
      INSERT INTO calls (tenant_id, caller_number, callee_number, direction, status)
      VALUES ($1, $2, 'InboundHotline', 'inbound', 'queued')
      RETURNING id
    `, [tenantId, callerNumber]);

    const callId = callResult.rows[0].id;

    // 4. Trigger ACD Agent Routing in background (longest idle agent)
    // Non-blocking response to Asterisk: tell it to send the call to hold queue while we route
    routingService.routeCallToAgent(tenantId, callId, callerNumber).catch(err => {
      console.error('[ACD] Background routing failed:', err);
    });

    res.json({
      action: 'queue',
      callId: callId,
      message: 'Call accepted and routed to ACD queue'
    });

  } catch (error) {
    console.error('incoming-filter failed:', error);
    res.status(500).json({ error: 'Internal server error handling inbound call' });
  }
});

// NOTE: the /api/campaigns/callback webhook now lives in routes/campaign.js, mounted
// BEFORE the '/:id' route - it used to be registered here, after '/api/campaigns' was
// already mounted, so Express matched it as GET /api/campaigns/:id with id='callback'
// and it was silently unreachable. See routes/campaign.js and campaignController.js.

// App health check
app.get('/health', async (req, res) => {
  // Previously `pool ? 'connected' : ...` and `redis ? 'connected' : ...` only checked that the
  // client objects existed (always true), not that the connections actually work - so this
  // endpoint could report "connected" while Postgres/Redis were both unreachable.
  const [postgresOk, redisOk] = await Promise.all([
    pool.query('SELECT 1').then(() => true).catch(() => false),
    // redis is a Proxy that falls back to a mock lacking .ping() when disconnected, which
    // returns null (not a promise) rather than rejecting - Promise.resolve() normalizes that.
    Promise.resolve(redis.ping ? redis.ping() : null).then((r) => r === 'PONG').catch(() => false)
  ]);

  res.json({
    status: 'healthy',
    timestamp: new Date(),
    connections: {
      postgres: postgresOk ? 'connected' : 'disconnected',
      redis: redisOk ? 'connected' : 'disconnected',
      asterisk_ami: asteriskService.isConnected ? 'connected' : 'disconnected'
    }
  });
});

// Socket.io connection logic for real-time dashboard events
io.on('connection', (socket) => {
  console.log(`Socket client connected: ${socket.id}`);

  // Room subscription based on userId for targeted supervisor escalations
  socket.on('subscribe', (userId) => {
    socket.join(userId);
    console.log(`Socket ${socket.id} subscribed to room: ${userId}`);
  });

  socket.on('disconnect', () => {
    console.log(`Socket client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  console.log(`Contact Center Server running on port ${PORT}`);
  
  // AMI and ARI are independent connections (different ports/protocols) - run them concurrently
  // so a slow/stuck one never delays the other.
  asteriskService.connect();
  ariService.connect();
});
