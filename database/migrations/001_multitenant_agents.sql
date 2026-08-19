-- =========================================================================
-- 001 - Multi-tenant agent architecture
-- =========================================================================
--
-- Idempotent on purpose: there is no migration runner in this project (database/setupDb.js
-- builds from scratch via schema.sql), so this file has to be safe to run repeatedly and safe
-- to run against the LIVE Render database that already holds real tenants and agents.
--
-- What it does:
--   1. Per-client capability flags, so an outbound-only client cannot create agents or receive
--      inbound calls.
--   2. Per-client Asterisk queue name, so Client A's caller can never be answered by Client B's
--      agent. Previously every tenant's agents were added to a single global 'campaign_agents'
--      queue - a cross-tenant call leak that was only latent because no agent ever reached
--      'idle' (the softphone never called POST /api/calls/ready).
--   3. The two Asterisk realtime queue families. Asterisk has no AMI command to create a queue,
--      so per-tenant queues can only come from realtime - the same res_config_pgsql connection
--      that already serves ps_endpoints/ps_auths/ps_aors (see telephony_config/extconfig.conf).

BEGIN;

-- --- 1. Capability flags -------------------------------------------------
--
-- agents_enabled / inbound_enabled default to FALSE deliberately. This mirrors the reasoning
-- already written into createClient() about mandatory port assignment: a capability nobody
-- explicitly granted should be off, not on. ivr_enabled defaults TRUE because every existing
-- client already builds IVR flows and turning it off would be a regression, not a default.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS agents_enabled   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inbound_enabled  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ivr_enabled      BOOLEAN NOT NULL DEFAULT true;

-- --- 2. Per-tenant queue name -------------------------------------------
--
-- Stored rather than derived so there is exactly one authoritative source. Derived from the
-- tenant UUID (not the subdomain) because the subdomain is user-supplied and could contain
-- characters Asterisk treats specially in a queue name, and because a renamed subdomain must
-- never silently repoint an existing queue.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS agent_queue_name VARCHAR(80);

-- --- 3. Asterisk realtime queue families --------------------------------
--
-- Column names are fixed by app_queue's realtime schema - do NOT rename them to match this
-- project's conventions or Asterisk will silently fail to resolve the queue.
CREATE TABLE IF NOT EXISTS queues (
    name             VARCHAR(128) PRIMARY KEY,
    musicclass       VARCHAR(128),
    strategy         VARCHAR(128),
    timeout          INTEGER,
    retry            INTEGER,
    maxlen           INTEGER,
    joinempty        VARCHAR(128),
    leavewhenempty   VARCHAR(128),
    ringinuse        VARCHAR(5),
    setinterfacevar  VARCHAR(5)
);

-- Deliberately stays EMPTY. Membership is 100% dynamic via AMI QueueAdd/QueueRemove driven by
-- backend/services/queueMembershipService.js, matching queues.conf's persistentmembers=no -
-- Postgres agent_profiles.current_status is the single source of truth for who is available.
-- Asterisk still requires this family to resolve when queues are realtime, so the table must
-- exist even though nothing writes to it.
CREATE TABLE IF NOT EXISTS queue_members (
    uniqueid    SERIAL PRIMARY KEY,
    queue_name  VARCHAR(128),
    interface   VARCHAR(128),
    membername  VARCHAR(128),
    penalty     INTEGER,
    paused      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_queue_members_queue_name ON queue_members(queue_name);

-- --- 4. Backfill existing tenants ---------------------------------------

UPDATE tenants
   SET agent_queue_name = 'agents_' || replace(id::text, '-', '')
 WHERE agent_queue_name IS NULL;

ALTER TABLE tenants ALTER COLUMN agent_queue_name SET NOT NULL;

-- Anyone already running agents keeps them - the FALSE default above must not silently switch
-- off a client who is live today.
UPDATE tenants t
   SET agents_enabled = true
 WHERE NOT t.agents_enabled
   AND EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.role = 'agent');

-- Create the realtime queue row for every existing tenant. Settings are copied verbatim from
-- the old static [campaign_agents] block in telephony_config/queues.conf so behaviour is
-- identical - only the isolation changes.
INSERT INTO queues (name, musicclass, strategy, timeout, retry, maxlen,
                    joinempty, leavewhenempty, ringinuse, setinterfacevar)
SELECT t.agent_queue_name, 'default', 'leastrecent', 20, 3, 0,
       'no', 'yes', 'no', 'yes'
  FROM tenants t
ON CONFLICT (name) DO NOTHING;

-- --- 5. Make the invariant self-enforcing -------------------------------
--
-- "This tenant has no queue" is not a recoverable state - it means that client's callers reach
-- nobody. A trigger guarantees it at the database level, so seed data, manual INSERTs and any
-- future onboarding path get it for free and it can never be forgotten in application code.
CREATE OR REPLACE FUNCTION tenant_provision_queue() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.agent_queue_name IS NULL THEN
        NEW.agent_queue_name := 'agents_' || replace(NEW.id::text, '-', '');
    END IF;

    INSERT INTO queues (name, musicclass, strategy, timeout, retry, maxlen,
                        joinempty, leavewhenempty, ringinuse, setinterfacevar)
    VALUES (NEW.agent_queue_name, 'default', 'leastrecent', 20, 3, 0,
            'no', 'yes', 'no', 'yes')
    ON CONFLICT (name) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_provision_queue ON tenants;
CREATE TRIGGER trg_tenant_provision_queue
    BEFORE INSERT ON tenants
    FOR EACH ROW EXECUTE FUNCTION tenant_provision_queue();

COMMIT;
