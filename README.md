# Enterprise Standalone Outbound Campaign API Microservice

## Executive Summary & Overview
This standalone repository package delivers a **Pure Backend REST API Microservice** for Automated Voice Broadcasting & Outbound Campaign Management, driving an Asterisk PBX (AWS EC2) over AMI, which routes calls through a Dinstar GSM gateway.

* **Web Console Included**: `frontend/` is a React (Vite, plain JS) app covering the full Super Admin (onboard clients, assign SIM ports, view every tenant) and Client Admin (build IVR flows, upload lookup data, run campaigns, manage agents, analytics) experience, plus a ported WebRTC agent softphone - see `frontend/README` section below. The API itself remains fully usable standalone via Postman/cURL/any custom dashboard too.
* **No Authentication / Login Required** on the campaign/gateway endpoints: zero-auth REST for direct API consumption. **This means anyone with the URL can dial on your account and your Dinstar SIMs** - do not hand this URL out publicly without adding access control first (not included in this build; see the project's remediation plan).
* **Dual Input Modes**: Supports bulk CSV file uploads **AND** manual phone number lists via JSON/text payload.
* **Live Call Tracking & Analytics**: Real call outcomes (`answered`, `busy`, `no-answer`, `failed`, `processing`, `pending`), tracked via real Asterisk AMI events rather than the moment a dial request is merely accepted.
* **Concurrency-aware dialing**: The number of simultaneous calls is gated by how many Dinstar SIM ports are actually registered right now (via `dinstarPoller.js` telemetry), not a hardcoded value.

---

## 1. Zero-Auth REST API Documentation

### A. Create Outbound Campaign
**Endpoint:** `POST /api/campaigns/broadcast`
**Content-Type:** `multipart/form-data`

#### Form Parameters:
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | String | **Yes** | Campaign title (e.g. `July_Promotions`) |
| `broadcastAudio` | File | **Yes**\* | Audio prompt file (`.mp3` or `.wav`, max 25MB) |
| `audioBase64` | String | **Yes**\* | Base64-encoded audio, alternative to `broadcastAudio` |
| `leadsCsv` | File | Optional\*\* | CSV file with a header row - accepts `phone`/`phone_number`/`number`/`mobile` and `name`/`customer_name` columns, in any order |
| `phoneNumbers` | String/Array | Optional\*\* | Manual phone numbers (e.g. `["9324479120", "8422063087"]` or `"9324479120, 8422063087"`) |
| `allowedPorts` | String/Array | Optional | SIM ports to restrict Round-Robin (e.g. `[0, 1]` or `"0, 1"`) - see the note in Section 2 on what this does and doesn't control |

*\*Either `broadcastAudio` OR `audioBase64` must be provided.*
*\*\*Either `leadsCsv` OR `phoneNumbers` must be provided.*

Every uploaded prompt is transcoded to 8kHz/16-bit mono WAV and pushed over SFTP to the Asterisk box's sounds directory before the campaign is created - the API call fails with a clear error if that delivery isn't configured or the Asterisk box is unreachable, rather than silently creating a campaign that will play dead air.

#### Sample cURL Request (CSV Upload + Audio Prompt + Port Selection):
```bash
curl -X POST https://YOUR_RENDER_SERVICE.onrender.com/api/campaigns/broadcast \
  -F "name=Q3_Sales_Campaign" \
  -F "broadcastAudio=@/path/to/prompt.mp3" \
  -F "leadsCsv=@/path/to/leads.csv" \
  -F "allowedPorts=[0, 1]"
```

#### Sample cURL Request (Manual Numbers List + Audio Prompt):
```bash
curl -X POST https://YOUR_RENDER_SERVICE.onrender.com/api/campaigns/broadcast \
  -F "name=VIP_Direct_Call" \
  -F "broadcastAudio=@/path/to/prompt.mp3" \
  -F "phoneNumbers=9324479120, 8422063087, 7304763972" \
  -F "allowedPorts=[0]"
```

#### Sample Response (`201 Created`):
```json
{
  "message": "Outbound campaign initiated successfully",
  "campaignId": "c9d2e7e1-d01e-bf1e-7c6a-7beb6266717d",
  "name": "VIP_Direct_Call",
  "totalLeads": 3,
  "allowedPorts": "0",
  "status": "running"
}
```

---

### B. Get Real-Time Campaign Status & Tracking Report
**Endpoint:** `GET /api/campaigns/:id`

#### Sample Response (`200 OK`):
```json
{
  "campaign": {
    "id": "c9d2e7e1-d01e-bf1e-7c6a-7beb6266717d",
    "name": "VIP_Direct_Call",
    "status": "running",
    "total_leads": 3,
    "processed_leads": 2
  },
  "metrics": {
    "total": 3,
    "answered": 1,
    "busy": 0,
    "noAnswer": 0,
    "failed": 1,
    "processing": 0,
    "pending": 1
  },
  "leads": [
    {
      "id": "lead_123",
      "phone_number": "9324479120",
      "customer_name": "Omkar",
      "dial_status": "answered",
      "attempts": 1,
      "call_duration": 14,
      "updated_at": "2026-07-27T13:25:00Z"
    },
    {
      "id": "lead_124",
      "phone_number": "8422063087",
      "customer_name": "Surabha",
      "dial_status": "failed",
      "attempts": 1,
      "call_duration": 0,
      "updated_at": "2026-07-27T13:26:00Z"
    }
  ]
}
```

`dial_status` is now set from the real Asterisk `OriginateResponse`/`Hangup` events, not from the moment Asterisk merely accepted the dial request - see `backend/bulkCampaignWorker.js`.

---

### C. Get List of All Campaigns
**Endpoint:** `GET /api/campaigns`

#### Sample Response (`200 OK`):
```json
[
  {
    "id": "c9d2e7e1-d01e-bf1e-7c6a-7beb6266717d",
    "name": "VIP_Direct_Call",
    "status": "running",
    "total_leads": 3,
    "answered_count": "1",
    "busy_count": "0",
    "no_answer_count": "0",
    "failed_count": "1",
    "pending_count": "1"
  }
]
```

---

### D. Get Live GSM Gateway Ports Telemetry
**Endpoint:** `GET /api/gateways/ports` (allocation records) and `GET /api/gateways/:gatewayId/live` (live hardware poll)

`GET /api/gateways/ports` returns `gateway_ports` allocation rows (`port_number`, `mapped_trunk_name`, `status`, `gateway_name`). For live registration/call-state per port (`registration_status`, `call_state`, `signal_strength`), query the `gateway_port_telemetry` table directly or use `GET /api/gateways/:gatewayId/live`, which now returns a `502` if the Dinstar gateway is actually unreachable instead of silently returning fabricated port data.

---

## 2. Call Concurrency and Port Selection - what's real and what isn't

- **Concurrency is real.** `bulkCampaignWorker.js` only starts as many simultaneous calls as there are SIM ports currently reporting `REGISTER_OK` in `gateway_port_telemetry` (kept live by `dinstarPoller.js`, polling every 15s). If telemetry is empty (poller hasn't run yet, or the gateway is unreachable), it falls back to a conservative `MAX_CONCURRENT_CALLS` (default `1`) rather than guessing.
- **A given lead's real completion is tracked via Asterisk AMI events** (`OriginateResponse`, then `Hangup`), not assumed the instant the dial request is accepted - this is what fixes the previous bug where a 2nd number would never actually ring because the 1st lead's slot was freed ~50ms after dispatch instead of when the call actually ended.
- **`allowedPorts` is a soft hint, not a hard pin.** It's round-robined and passed to Asterisk as a `TARGET_PORT` channel variable for logging/diagnostics, but the Dinstar gateway - not Asterisk or this codebase - makes the final decision on which physical SIM answers a given call. True per-port pinning would require configuring outbound routing rules on the Dinstar UC2000's own admin panel (e.g. CallerID-prefix-to-port mapping); that's gateway configuration, not something fixable in this repo.
- Daily throughput now scales with however many SIM ports are actually registered, instead of the fixed capacity table this README used to publish (which assumed all ports could be dialed simultaneously with a fixed pacing delay - it wasn't achievable with the previous single-call-at-a-time lock, and a flat multiplier isn't meaningful now that concurrency is dynamic).

---

## 2b. Multi-tenancy: what isolates one client from another

The platform is sold per client. Each client is a `tenant_id`, and isolation is enforced at three
separate levels - not one.

**Data.** Every table carries `tenant_id`, with Postgres row-level security on top. A client's
campaigns, leads, flows, call logs, credits and SIM ports are only ever visible to them.

**Telephony.** Each client has their **own Asterisk queue**, `agents_<tenant uuid>`, stored in the
realtime `queues` table and created automatically when the client is onboarded (a `BEFORE INSERT`
trigger on `tenants`, plus `tenantQueueService.ensureTenantQueue()`). An agent can only ever be
added to their own client's queue, so a caller of Client A cannot be answered by an agent of
Client B. The queue name reaches the dialplan per call, never from static config:

| Path | How the queue name gets there |
| --- | --- |
| Outbound press-1 | `AGENT_QUEUE` channel variable set by `bulkCampaignWorker.js` from the campaign's tenant |
| Inbound | the response body of `GET /api/voice/inbound-route`, which resolves the tenant from `gateway_ports.mapped_trunk_name` |
| IVR `transfer_queue` node | `ivrFlowEngine.js`, from the flow's own `tenant_id` - **never** from the node's client-authored config |

There is deliberately **no default or fallback queue** anywhere in that chain. If a tenant can't be
resolved, the caller gets the "agents unavailable" prompt. A fallback would silently reintroduce
the shared-queue bug this design exists to prevent, and it would do so invisibly.

**Plan.** `tenants` carries `agents_enabled`, `inbound_enabled` and `ivr_enabled`. Outbound
broadcast is the base product and is always available; the rest are per-client toggles set at
onboarding (`POST /api/auth/clients`) and changeable later
(`PATCH /api/auth/clients/:tenantId/features`). They are enforced in the API by
`middleware/tenantFeature.js` — the frontend also hides the corresponding menus, but that is a
convenience, not the control. Both agent and inbound default to **off**: a capability nobody
explicitly granted should not be switched on by omission.

### Agent availability

Two independent things must be true before an agent is sent a call, and they fail for different
reasons:

1. **SIP registration** — the browser's WSS connection to Asterisk. Breaks on WiFi blips, laptop
   sleep, an expired certificate.
2. **Availability** — `agent_profiles.current_status`, which is what actually puts them in their
   client's queue.

Logging in sets status `login`, **not** `idle`. The agent enters the queue only when they press
**Ready** (`POST /api/calls/ready`), and leaves on **Break** (`POST /api/calls/break`) or when the
softphone tab closes (`POST /api/calls/offline`, sent with `keepalive`). An agent whose browser
happens to be open is not the same as an agent sitting at their desk ready to talk to a customer.

Postgres is the single source of truth. `queues.conf` sets `persistentmembers=no`, so after an
Asterisk restart every queue comes back empty and is repopulated from Postgres by
`resyncAllIdleAgents()` on the AMI `ami_ready` event — each agent into their own client's queue.

## 3. Package Directory Structure

```
outbound_campaign_module/
├── README.md                           # Comprehensive REST API Documentation & Setup
├── render.yaml                         # Render Blueprint (reproducible service config)
├── backend/                            # Node.js Express backend
│   ├── server.js                       # Core REST API server; boots the dialer + poller
│   ├── bulkCampaignWorker.js           # Event-driven dialer (AMI-tracked completion, concurrency gate)
│   ├── dinstarPoller.js                # Hardware GSM Port Telemetry Poller
│   ├── package.json                    # Backend dependencies
│   ├── .env.example                    # Environment variable template
│   ├── config/                         # Database & Redis configuration
│   ├── controllers/                    # Campaign creation & report controllers
│   ├── routes/                         # Public Zero-Auth REST API endpoints
│   └── services/                       # asteriskService (AMI), dinstarService, audioTranscoder, audioDeliveryService
├── telephony_config/                   # Asterisk Telephony Engine Settings
│   ├── pjsip.conf                      # PJSIP Trunking to Dinstar Gateway + WebRTC agent transport
│   ├── extensions.conf                 # Dialplan: playback, AMD, DTMF menu, agent-queue transfer
│   ├── amd.conf                        # Answering Machine Detection Config
│   ├── queues.conf                     # queue [general] settings - one queue PER TENANT lives in Postgres (realtime)
│   ├── res_pgsql.conf                  # Asterisk Realtime DB connection (dynamic agent SIP endpoints)
│   ├── sorcery.conf                    # Chains static pjsip.conf + Postgres realtime lookups
│   ├── extconfig.conf                  # Maps ps_endpoints/ps_auths/ps_aors -> the pgsql driver
│   └── http.conf                       # Built-in HTTPS server - actually serves WSS/TLS, not pjsip.conf
├── frontend/                            # React (Vite, plain JS) web console - Super Admin, Client Admin, Agent softphone
│   ├── src/pages/superadmin/            # Onboard clients, adjust SIM ports, drill into any tenant, global call logs
│   ├── src/pages/tenant/                # IVR flow builder, lookup tables, campaigns, agents, analytics
│   ├── src/pages/agent/Softphone.jsx    # Ported WebRTC softphone (JsSIP over WSS) - self-contained login, in-memory token only
│   └── .env.example                     # VITE_API_BASE_URL - which backend this build talks to
└── database/                           # PostgreSQL Schema & Setup Scripts
    ├── schema.sql                      # Database Schema (Campaigns, Leads, Telemetry) - kept in sync with server.js's initSchema()
    ├── seed.sql                        # Sample Test Data
    └── setupDb.js                      # Automated DB Initialization Script
```

---

## 4. Local Development Setup

### Step 1: Database
```bash
cd database
node setupDb.js
```

### Step 2: Configure Environment Variables
Copy `backend/.env.example` to `backend/.env` and fill in real values (never commit `.env` - it's git-ignored). For local dev without a real Asterisk box, set `AMI_MOCK_MODE=true` to exercise the dialer against a built-in AMI simulator instead of a live PBX.

### Step 3: Launch
```bash
cd backend
npm install
npm start
```
`npm start` runs `server.js`, which starts the campaign dialer (`bulkCampaignWorker.js`) and the Dinstar telemetry poller (`dinstarPoller.js`) in-process automatically. **Do not launch either of those files as a separate process** - both now guard against a duplicate instance in the same process, but two separate OS processes would each hold their own lock/poll loop against the same database.

### Step 4: Frontend (Web Console)
```bash
cd frontend
cp .env.example .env.local   # set VITE_API_BASE_URL to your backend (defaults to http://localhost:5000)
npm install
npm run dev
```
Opens on `http://localhost:5173`. Logging in as a `super_admin` lands on the Onboard/Ports/Call-Logs console; `client_admin`/`team_leader`/`mentor` land on the Flows/Campaigns/Agents/Analytics console; an `agent` account should instead go straight to `/softphone`, which has its own self-contained login (see `frontend/src/pages/agent/Softphone.jsx` - deliberately not wired into the rest of the app's persisted auth, matching the standalone tool it was ported from).

---

## 5. Production Deployment (AWS EC2 Asterisk + Render Backend)

### 5.1 Asterisk on EC2
1. Copy `telephony_config/*.conf` into `/etc/asterisk/`, reload (`asterisk -rx "core reload"`).
2. In `telephony_config/extensions.conf`, set the `CAMPAIGN_CALLBACK_BASE` global to your actual Render service URL - used only by the DTMF-9 opt-out webhook (`CURL()` right before that call's `Hangup()`); it is not a mid-call status signal and cannot race the dialer's own AMI event tracking the way an earlier version of this file did.
3. Open port `5038` (AMI) in the EC2 security group, scoped to Render's egress IPs if possible - do not expose AMI to the whole internet.
4. Create a dedicated `campaign-uploader` SSH user, chrooted via `sshd_config`'s `ChrootDirectory /var/lib/asterisk/sounds` + `ForceCommand internal-sftp`, so it can only reach that one directory tree and has no shell access - do not reuse a full-access SSH key for this. `ASTERISK_SOUNDS_DIR` is then set relative to that chroot (`/campaign_audio`, not the full host path). Open port `22` to Render's egress for this user.
5. Confirm the `AMD` module is loaded (`asterisk -rx "module show like amd"`) - `telephony_config/amd.conf` already ships with sane defaults, nothing to tune before first use.
6. Record and deliver three short static prompts to the sounds directory the same way campaign audio is delivered (one-time, manual): `dtmf_menu_options` (menu instructions), `optout_confirmation`, `agents_unavailable`.

### 5.2 Backend on Render
1. Use the included `render.yaml` Blueprint (New > Blueprint in the Render dashboard, pointing at this repo) so the service config (root dir `backend`, build/start commands, health check) is reproducible instead of dashboard-only.
2. Fill in the env vars flagged `sync: false` in `render.yaml` via the Render dashboard - notably `DATABASE_URL`, `ASTERISK_AMI_HOST/USER/PASS`, `DINSTAR_*`, and `ASTERISK_SSH_HOST/USER`.
3. Upload your SSH private key for audio delivery as a Render **Secret File** named `asterisk_deploy_key` (mounted at `/etc/secrets/asterisk_deploy_key`, matching `ASTERISK_SSH_PRIVATE_KEY_PATH`'s default). Never commit this key to the repo.
4. Confirm `/health` reports real connectivity for Postgres, Redis, and Asterisk AMI (this now performs live checks rather than just confirming the client objects exist).

### 5.3 Live-agent transfer setup (Workstream 7)
This is the part of the deploy that needs the most hands-on EC2 work - budget real time for it, it's infrastructure, not a config copy. Everything below was actually executed and verified end-to-end, including two config mistakes discovered live - noted so they aren't repeated.

1. **Asterisk Realtime for dynamic agent SIP endpoints:** install `res_config_pgsql` (`asterisk -rx "module show like res_config_pgsql"` to check first - the `.so` may already be present but disabled via `noload => res_config_pgsql.so` in `modules.conf`, comment that line out). Fill in `telephony_config/res_pgsql.conf` with the backend's Postgres connection details **under a `[general]` section using `db`-prefixed keys** (`dbhost`, `dbuser`, `dbpass`, `dbname`, `dbport`) - a `[postgres]` section or unprefixed keys are silently ignored, and the module falls back to a useless localhost-socket default with no error surfaced beyond a WARNING in the log. **The EC2 box must be able to reach that Postgres instance** - if it's a managed DB that only allowlists Render's egress IPs, add the EC2 box's IP too.
2. Copy `telephony_config/extconfig.conf` into `/etc/asterisk/` - this is what actually maps the `ps_endpoints`/`ps_auths`/`ps_aors`/`ps_contacts` realtime family names to the pgsql driver + `res_pgsql.conf`'s `[general]` section; `sorcery.conf` alone isn't enough.
3. Copy `telephony_config/sorcery.conf` into `/etc/asterisk/`. **Chain the static and realtime wizards for `endpoint`/`auth`/`aor` - do not map them to `realtime` alone.** A bare `endpoint = realtime,ps_endpoints` line *replaces* res_pjsip's normal static-file lookup instead of adding to it, which makes every `[section]` endpoint already in `pjsip.conf` (including `DinstarTrunk` - your actual outbound trunk) invisible to Asterisk. Confirmed live: this broke outbound calling for several minutes before being caught. The working form declares the static `config,pjsip.conf` wizard first, falling through to `realtime` only when nothing static matches (see the file for the exact syntax). **`contact` also needs its own `realtime,ps_contacts` mapping, separate from `aor`** - without it, agent softphones authenticate successfully but the REGISTER still fails (`Unable to bind contact ... to AOR` in the Asterisk log), because the AOR being realtime doesn't automatically make the dynamic Contact each REGISTER creates realtime too.
4. Copy `telephony_config/queues.conf` into `/etc/asterisk/` - no per-agent edits needed here, membership is 100% AMI-driven from Postgres (see `backend/services/queueMembershipService.js`).
5. **After any of the above, do a full `sudo systemctl restart asterisk`, not just a `module reload` or `core reload`.** Realtime config resolution (`extconfig.conf` in particular) is read at process startup, same as the `pjsip.conf` transport `bind=` issue from Workstream 3 - a reload alone leaves you debugging stale state.
6. Create at least one agent via `POST /api/auth/agents` (see Section 1) so there's someone in that client's queue to ring. The agent must then press **Ready** in the softphone (`POST /api/calls/ready`) - logging in alone leaves them at status `login` and out of the queue.
7. **Domain + TLS for the agent softphone.** Let's Encrypt won't issue a certificate for a bare IP - if you don't have a domain, `<your-ec2-ip-with-dashes>.sslip.io` (e.g. `13-205-220-6.sslip.io`) resolves automatically to that IP with zero DNS setup and works fine with Let's Encrypt. Open security-group ports `80` (HTTP, needed only for the certbot challenge) and `8089` (the actual WSS port) to `0.0.0.0/0`, install `certbot`, then: `sudo certbot certonly --standalone --agree-tos --register-unsafely-without-email -d <your-domain>`.
8. **The certificate does NOT go in `pjsip.conf`.** This is the second live-discovered gotcha: `[transport-wss]`'s own `cert_file`/`priv_key_file` fields are silently ignored for the `wss` protocol - Asterisk logs `TLS certificate values ignored for websocket transport as they are configured in http.conf` if you set them there. The WSS transport actually rides on Asterisk's **built-in HTTP server**, configured entirely in `telephony_config/http.conf` (`enabled=yes`, `bindaddr=0.0.0.0`, `tlsenable=yes`, `tlsbindaddr=0.0.0.0:8089`, `tlscertfile`/`tlsprivatekey` pointing at the cert). Copy that file into `/etc/asterisk/` too.
9. Let's Encrypt's files are root-only (0600) and Asterisk runs as its own `asterisk` user - copy the cert/key to somewhere Asterisk can read (e.g. `/etc/asterisk/keys/`, owned `asterisk:root`, mode `640`), and add a certbot **deploy hook** (`/etc/letsencrypt/renewal-hooks/deploy/`) that re-copies + fixes permissions + restarts Asterisk on every renewal (certs expire every 90 days; certbot's own systemd timer handles the renewal trigger, the hook handles getting it to Asterisk).
10. Restart Asterisk, then verify from *outside* the box - `sudo ss -tlnp | grep 8089` should show Asterisk actually listening, and `openssl s_client -connect <ip>:8089 -servername <your-domain>` should return `Verify return code: 0 (ok)` with `issuer=... Let's Encrypt`.
11. Set `ASTERISK_WSS_URL` on Render to `wss://<your-domain>:8089/ws` - **the domain, not the raw IP.** The certificate's name won't match a raw-IP connection even though the cert itself is valid, and the browser will refuse it.
12. Each agent needs a machine with a working microphone - that, not additional SIM cards, is the actual new physical resource this feature requires (a press-1 transfer bridges the SAME already-connected Dinstar channel, it never dials out a second time).
