# Outbound Campaign Module — API Reference

Base URL (production): `https://callcenter-edpl.onrender.com`

This backend has two distinct API surfaces living in the same codebase:

1. **Campaign Broadcast API** — zero-auth, the outbound voice-broadcast dialer (CSV/number upload + audio prompt → calls). This is the primary API for this module.
2. **Contact Center / Agent API** — JWT-authenticated, a separate agent-desk/ACD system (click-to-dial, dispositions, breaks, analytics) that ships in the same backend.

**Security note for the developer you're sharing this with:** the Campaign Broadcast and Gateway Telemetry endpoints currently have **no authentication and no rate limiting** — anyone with the base URL can create a campaign and place real calls on your Dinstar SIMs. Access control for external consumers was intentionally deferred (see project history) — do not put this base URL somewhere public until that's added. Treat the URL itself as the only access control for now.

---

## 1. Health Check

### `GET /health`
No auth. Returns live connectivity status — useful for confirming the deploy is actually working end-to-end, not just that the process is up.

```bash
curl https://callcenter-edpl.onrender.com/health
```

```json
{
  "status": "healthy",
  "timestamp": "2026-07-30T12:22:16.869Z",
  "connections": {
    "postgres": "connected",
    "redis": "disconnected",
    "asterisk_ami": "connected"
  }
}
```
`redis: disconnected` is normal/expected — Redis is optional and the backend runs fine without it. `asterisk_ami` must say `connected` for campaigns to actually dial; if it doesn't, calls will sit at `pending` forever.

---

## 2. Campaign Broadcast API (zero-auth)

### 2.1 Create a campaign — `POST /api/campaigns/broadcast`

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **Yes** | Campaign name/label |
| `broadcastAudio` | file | Yes\* | Audio prompt (`.mp3`/`.wav`, must have an `audio/*` MIME type, max 25MB) — transcoded server-side to 8kHz/16-bit mono WAV and pushed to the Asterisk box automatically |
| `audioBase64` | string | Yes\* | Alternative to `broadcastAudio`: a base64-encoded audio string (`data:audio/...;base64,...` or raw base64) |
| `leadsCsv` | file | Yes\*\* | CSV with a header row. Accepted phone-number columns (any one): `phone`, `phone_number`, `number`, `mobile`, `msisdn`. Accepted name columns: `name`, `customer_name`, `full_name`. Column order doesn't matter — matched by header name. |
| `phoneNumbers` | string or array | Yes\*\* | Manual number list instead of a CSV, e.g. `["9324479120","8422063087"]` or `"9324479120, 8422063087"` |
| `allowedPorts` | string or array | No | e.g. `[0,1]` or `"0,1"`. **This is a soft concurrency hint, not a hard pin** — it does not guarantee a call goes out on a specific physical SIM slot; the Dinstar gateway makes that decision internally. See §2.4. |

\* one of `broadcastAudio` / `audioBase64` required. \*\* one of `leadsCsv` / `phoneNumbers` required.

```bash
curl -X POST https://callcenter-edpl.onrender.com/api/campaigns/broadcast \
  -F "name=Q3_Sales_Campaign" \
  -F "broadcastAudio=@/path/to/prompt.mp3;type=audio/mpeg" \
  -F "leadsCsv=@/path/to/leads.csv" \
  -F "allowedPorts=[0,1]"
```

**Response `201 Created`:**
```json
{
  "message": "Outbound campaign initiated successfully",
  "campaignId": "186c7a11-f2da-4a51-bacd-215c4cbbcbf6",
  "name": "Q3_Sales_Campaign",
  "totalLeads": 2,
  "excludedDncCount": 0,
  "allowedPorts": "0,1",
  "status": "running"
}
```
`excludedDncCount` is how many uploaded numbers were silently dropped because they're on the do-not-call list (see §6) — normalized the same way as the outbound dialer, so a number opted out as `9876543210` is still caught if this upload has it as `+919876543210`.

**Error responses** (`400`): missing `name`, missing audio, missing numbers/CSV, wrong file MIME type, invalid CSV. (`500`): audio transcode failed, audio delivery to Asterisk failed (SSH not configured/unreachable), database error.

### 2.2 List campaigns — `GET /api/campaigns`

```bash
curl https://callcenter-edpl.onrender.com/api/campaigns
```

```json
[
  {
    "id": "186c7a11-f2da-4a51-bacd-215c4cbbcbf6",
    "name": "Q3_Sales_Campaign",
    "audio_url": "1785413392223_transcoded",
    "status": "running",
    "allowed_ports": "0,1",
    "total_leads": 2,
    "processed_leads": 2,
    "created_at": "2026-07-30T12:10:00.924Z",
    "answered_count": "1",
    "busy_count": "0",
    "no_answer_count": "0",
    "failed_count": "1",
    "pending_count": "0"
  }
]
```

### 2.3 Get campaign detail & per-lead status — `GET /api/campaigns/:id`

```bash
curl https://callcenter-edpl.onrender.com/api/campaigns/186c7a11-f2da-4a51-bacd-215c4cbbcbf6
```

```json
{
  "campaign": { "id": "...", "name": "...", "status": "running", "total_leads": 2, "processed_leads": 2 },
  "metrics": { "total": 2, "answered": 1, "busy": 0, "noAnswer": 0, "failed": 1, "processing": 0, "pending": 0 },
  "leads": [
    {
      "id": "d5f9d215-9d21-4e8a-bd60-2d800fcd7e90",
      "phone_number": "9324479120",
      "customer_name": "Contact",
      "dial_status": "answered",
      "attempts": 1,
      "call_duration": 14,
      "updated_at": "2026-07-30T13:52:28.436Z"
    }
  ]
}
```

`dial_status` values: `pending` → `processing` → one of `answered` / `busy` / `no-answer` / `failed` / `opted_out`. These reflect **real Asterisk call-completion events** (AMI `OriginateResponse`/`Hangup`), not just "the dial request was accepted." `opted_out` is set the moment a caller presses 9 (see §5) and is never overwritten by the normal answered/busy/failed finalize, even though the call is usually still technically "answered" at that point.

Two extra columns populated by the dialplan's DTMF menu (§5), also present in each lead object: `amd_status` (`HUMAN`/`MACHINE`/`NOTSURE`, from Asterisk's `AMD()`) and `dtmf_selected` (currently just `"1"` when the caller transferred to an agent).

### 2.4 How call concurrency and `allowedPorts` actually work

- The dialer only runs as many simultaneous calls as there are SIM ports currently reporting registered (`REGISTER_OK`) in the gateway telemetry table. If that telemetry is unavailable (gateway unreachable from the backend), it falls back to **1 call at a time**.
- A lead only leaves `processing` when Asterisk reports the real call outcome — this fixed a bug where a 2nd number would never dial because the 1st lead's slot was freed the instant Asterisk *accepted* the dial request, not when the call actually finished.
- `allowedPorts` is passed through as a round-robin hint and logged, but the physical SIM/port a call goes out on is decided by the Dinstar gateway itself, not this API.

---

## 3. Gateway Telemetry API (zero-auth)

### `GET /api/gateways`
List configured gateways.

### `GET /api/gateways/ports` (alias: `GET /api/gateways/allocations`)
Port-to-tenant allocation records (static config, not live status):
```json
[{ "id": "...", "port_number": 0, "mapped_trunk_name": "ClientHDFC_Trunk", "status": "idle", "gateway_name": "Dinstar UC2000-1", "ip_address": "192.168.1.186" }]
```

### `GET /api/gateways/:gatewayId/live`
Live poll of the physical Dinstar hardware. Returns `502` if the gateway is genuinely unreachable (this used to silently return fake data — fixed).
```json
{ "gatewayId": "...", "name": "Dinstar UC2000-1", "ip": "192.168.1.186", "live_ports": [ /* per-port reg/signal/callstate */ ] }
```

---

## 4. Contact Center / Agent API (JWT-authenticated)

Separate subsystem in the same backend — a multi-tenant agent desk with ACD routing. Every route below requires `Authorization: Bearer <token>` from `/api/auth/login`, and most are further role-gated.

### 4.1 Auth
- `POST /api/auth/login` — body `{ "username": "...", "password": "..." }` → `{ message, token, user: { id, username, role, tenant_id, tenant_name } }`. Token expires in 12h.
- `POST /api/auth/logout` — requires `Authorization` header.

### 4.2 Calls (role: `agent`, unless noted)
- `POST /api/calls/dial` — body `{ customerNumber, campaignId?, bucketId? }` → `{ message, callId }`. Click-to-dial for a logged-in agent.
- `POST /api/calls/disposition` — body `{ callId, dispositionCode, comments?, bucketId? }`. Closes out a call and frees the agent.
- `POST /api/calls/break` — body `{ status: "break"|"idle", breakType? }` (`breakType` required when `status=break`, e.g. `tea`/`lunch`).
- `GET /api/calls/bucket` — agent's pending assigned call queue (SLA-ordered).
- `POST /api/calls/transfer-language` — body `{ callId, targetLanguage }`.
- `POST /api/calls/reassign-bucket` — role: `team_leader`/`mentor`/`client_admin`. Body `{ absentAgentId, targetAgentId }`.

### 4.3 Analytics (role: `client_admin`/`mentor`/`team_leader`, `logs` also allows `super_admin`)
- `GET /api/analytics/live` — dashboard: agent status counts, today's conversions, queue volume, SLA breaches.
- `GET /api/analytics/logs` — last 100 calls with disposition/agent info.

### 4.4 Agent provisioning & readiness (Workstream 7)
- `POST /api/auth/agents` — role: `super_admin`/`client_admin`/`team_leader`. Body `{ username, password, parentId? }` → creates the `users`+`agent_profiles` rows and provisions a SIP softphone identity. Response includes `sip: { sipUsername, sipPassword }` — the only time the raw password is returned; afterwards it's fetched via the next endpoint.
- `GET /api/auth/me/sip-credentials` — any authenticated **agent**. Returns `{ sipUsername, sipPassword, wssUrl }` for the agent softphone (`frontend_component/agent_softphone/`) to register with. Lazily provisions on first call, so agents created before this feature existed work with no manual step.
- `POST /api/calls/ready` — role: `agent`. Moves the caller from `login` to `idle`, making them eligible for both the inbound ACD queue and the campaign agent-transfer queue. (Logging in alone does **not** do this — see §5.)

---

## 5. Live-agent transfer, DTMF menu, AMD & do-not-call (Workstream 7)

The campaign dialplan now supports more than "play a message and hang up":

- **Answering-machine detection** runs first (`AMD()`). If it detects a machine, the message plays once with no menu offered — pressing digits on a voicemail greeting does nothing.
- For a human (or an ambiguous `NOTSURE` result — treated as human rather than risking a silent drop), the message plays **interruptibly** and a DTMF menu is offered:
  - **1** — transfer to a live agent via Asterisk's `Queue()` (hold music if all agents are busy; an apology message if none are online at all).
  - **2** — repeat the message.
  - **9** — opt out. Recorded to the do-not-call list and excluded from all future campaign uploads (see `excludedDncCount` in §2.1).
- Agents must explicitly call `POST /api/calls/ready` after logging in before they're eligible to receive a transferred call — `POST /api/auth/login` alone only sets them to `login`, not `idle`.
- **No new SIM/GSM hardware is needed for this feature.** A transfer bridges the *same already-connected* call to an agent's softphone — it never dials out through Dinstar a second time. What it *does* need: at least one agent with a provisioned SIP identity (§4.4) actually running the softphone with a working microphone.
- The opt-out webhook the dialplan calls (`GET /api/campaigns/optout?leadId=...&phone=...`) is zero-auth, same trust model as `/callback` — not meant to be called directly by an external integrator, just documented for completeness.

---

## 6. Known limitations to tell the other developer about

- **No auth on the Campaign/Gateway APIs.** Add an API-key layer before exposing this URL beyond trusted use.
- **No rate limiting.**
- **`allowedPorts` is advisory, not enforced** — see §2.4.
- **India-only phone normalization** (`bulkCampaignWorker.js`) — strips a `91` country code prefix; not tested against other countries.
- CSV/number list dedup is exact-string match only (no phone-number canonicalization across formats).
- **Agent SIP endpoints require Asterisk Realtime (`res_config_pgsql`) to be installed and configured on the EC2 box** (§5.3 of the README) — `POST /api/auth/agents`/`GET /api/auth/me/sip-credentials` will provision Postgres rows either way, but the agent's softphone can't actually register until that's set up.
- **The agent softphone needs a real TLS certificate on the WSS transport** (browsers reject WebRTC microphone access on self-signed WSS) — done for this deployment via a free `sslip.io` hostname + Let's Encrypt, see README §5.3 for the exact steps and two gotchas that cost real debugging time (the cert config lives in `http.conf`, not `pjsip.conf`, and `sorcery.conf` must chain the static and realtime endpoint lookups or it silently breaks existing static trunks).
- Each client has its own queue (`agents_<tenant uuid>`), so a transferred call can only ever reach that client's own agents. Within a queue the strategy is `leastrecent` with no skills-based routing (language, campaign type, etc.) — every idle agent of that client is treated as interchangeable.
