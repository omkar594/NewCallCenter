import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import pool from '../config/database.js';
import { transcodeCampaignAudio } from '../services/audioTranscoder.js';
import { deliverCampaignAudio } from '../services/audioDeliveryService.js';

// Same default tenant every other write path in this backend falls back to when a caller
// (e.g. super_admin, whose JWT carries no tenant_id) doesn't have one of their own - matches
// authController.js's DEFAULT_TENANT_ID.
const DEFAULT_TENANT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const VALID_NODE_TYPES = new Set([
  'play', 'menu', 'collect_input', 'lookup', 'branch',
  'transfer_queue', 'sms', 'optout', 'amd_check', 'hangup'
]);
// A prompt is mandatory for play/menu (they always speak something); every other type
// (including collect_input/optout) can run with no prompt at all - see ivrFlowEngine.js's
// `if (node.prompt_id)` guards on those two handlers.
const PROMPT_REQUIRED_TYPES = new Set(['play', 'menu']);
const LOOKUP_TABLE_MAX_ROWS = 50000; // sane cap so one giant CSV can't block the event loop
const LOOKUP_ROW_INSERT_CHUNK = 500;

function resolveTenantId(req) {
  return req.user?.tenant_id || DEFAULT_TENANT_ID;
}

// Validates the client-authored flow shape (see routes/ivr.js for the wire format): nodes
// reference each other by a caller-chosen client_id string, not a DB UUID, since those don't
// exist until insert time. Everything here is check-then-fail-fast, before any DB writes.
function validateFlowBody(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string') errors.push('name is required');
  if (!Array.isArray(body.nodes) || body.nodes.length === 0) errors.push('nodes must be a non-empty array');
  if (errors.length) return errors;

  const clientIds = new Set();
  let startCount = 0;
  for (const node of body.nodes) {
    if (!node.client_id) {
      errors.push('every node needs a client_id');
      continue;
    }
    if (clientIds.has(node.client_id)) {
      errors.push(`duplicate client_id "${node.client_id}"`);
      continue;
    }
    clientIds.add(node.client_id);
    if (!VALID_NODE_TYPES.has(node.type)) {
      errors.push(`node "${node.client_id}" has invalid type "${node.type}"`);
    }
    // prompt_id (an uploaded file's basename, or the older {{var}}-in-prompt_id TTS trick) and
    // prompt_text (always TTS, no {{var}} required - see resolvePromptMedia()) are two ways to
    // say the same thing - a node must pick exactly one, never both, never neither when required.
    const hasPromptId = node.prompt_id !== undefined && node.prompt_id !== null && node.prompt_id !== '';
    const hasPromptText = node.prompt_text !== undefined && node.prompt_text !== null && node.prompt_text !== '';
    if (hasPromptId && hasPromptText) {
      errors.push(`node "${node.client_id}" has both prompt_id and prompt_text - use exactly one`);
    } else if (PROMPT_REQUIRED_TYPES.has(node.type) && !hasPromptId && !hasPromptText) {
      errors.push(`node "${node.client_id}" (type "${node.type}") needs prompt_id or prompt_text`);
    }
    if (node.is_start) startCount++;
  }
  if (startCount !== 1) {
    errors.push(`exactly one node must have is_start true (found ${startCount})`);
  }

  for (const node of body.nodes) {
    if (node.next && !clientIds.has(node.next)) {
      errors.push(`node "${node.client_id}" references unknown next "${node.next}"`);
    }
    if (node.branches) {
      for (const [matchValue, target] of Object.entries(node.branches)) {
        if (!clientIds.has(target)) {
          errors.push(`node "${node.client_id}" branch "${matchValue}" references unknown target "${target}"`);
        }
      }
    }
  }
  return errors;
}

// Inserts every node first (to mint real UUIDs), then a second pass wires up next_node_id and
// branches - a node's `next`/branch targets may point at a node authored later in the array.
async function persistFlowNodes(client, flowId, nodes) {
  const idByClientId = new Map();
  for (const node of nodes) {
    const result = await client.query(
      `INSERT INTO ivr_nodes (flow_id, type, is_start, prompt_id, prompt_text, config)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [flowId, node.type, !!node.is_start, node.prompt_id || null, node.prompt_text || null, JSON.stringify(node.config || {})]
    );
    idByClientId.set(node.client_id, result.rows[0].id);
  }
  for (const node of nodes) {
    if (node.next) {
      await client.query(`UPDATE ivr_nodes SET next_node_id = $1 WHERE id = $2`, [
        idByClientId.get(node.next),
        idByClientId.get(node.client_id)
      ]);
    }
    if (node.branches) {
      for (const [matchValue, target] of Object.entries(node.branches)) {
        await client.query(
          `INSERT INTO ivr_node_branches (node_id, match_value, next_node_id) VALUES ($1, $2, $3)`,
          [idByClientId.get(node.client_id), matchValue, idByClientId.get(target)]
        );
      }
    }
  }
  return idByClientId;
}

export async function createFlow(req, res) {
  const tenantId = resolveTenantId(req);
  const errors = validateFlowBody(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid flow definition', details: errors });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const flowResult = await client.query(
      `INSERT INTO ivr_flows (tenant_id, name, version, is_active)
       VALUES ($1, $2, 1, false) RETURNING id, name, version, is_active, created_at`,
      [tenantId, req.body.name]
    );
    const flow = flowResult.rows[0];
    await persistFlowNodes(client, flow.id, req.body.nodes);
    await client.query('COMMIT');
    res.status(201).json(flow);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[IvrController] createFlow failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

// Full-replace semantics on every edit: existing nodes for the flow are dropped (branches
// cascade away with their parent node) and re-authored from the request body, rather than
// diffed - simpler and matches "this is what a future visual builder would also call" from the
// plan, where the builder always has the complete current graph in hand anyway.
export async function updateFlow(req, res) {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const errors = validateFlowBody(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid flow definition', details: errors });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, version FROM ivr_flows WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Flow not found' });
    }
    const newVersion = existing.rows[0].version + 1;
    await client.query(
      `UPDATE ivr_flows SET name = $1, version = $2, updated_at = NOW() WHERE id = $3`,
      [req.body.name, newVersion, id]
    );
    await client.query(`DELETE FROM ivr_nodes WHERE flow_id = $1`, [id]);
    await persistFlowNodes(client, id, req.body.nodes);
    await client.query('COMMIT');
    res.json({ id, name: req.body.name, version: newVersion });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[IvrController] updateFlow failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

// Lists flows for the caller's own tenant - only get-by-id existed before, which a real
// frontend needs a "your flows" list/picker to build on. super_admin may pass ?tenantId= to
// drill into a specific client's flows (silently ignored for everyone else, same pattern as
// gatewayController.js's getPortAllocations isSuperAdmin branch).
export async function listFlows(req, res) {
  const isSuperAdmin = req.user?.role === 'super_admin';
  const tenantId = (isSuperAdmin && req.query.tenantId) ? req.query.tenantId : resolveTenantId(req);
  try {
    const result = await pool.query(
      `SELECT id, name, version, is_active, created_at, updated_at FROM ivr_flows WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[IvrController] listFlows failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

export async function getFlow(req, res) {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  try {
    const flowResult = await pool.query(`SELECT * FROM ivr_flows WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!flowResult.rows[0]) return res.status(404).json({ error: 'Flow not found' });

    const nodesResult = await pool.query(`SELECT * FROM ivr_nodes WHERE flow_id = $1`, [id]);
    const branchesResult = await pool.query(
      `SELECT b.* FROM ivr_node_branches b JOIN ivr_nodes n ON n.id = b.node_id WHERE n.flow_id = $1`,
      [id]
    );
    const branchesByNode = new Map();
    for (const branch of branchesResult.rows) {
      if (!branchesByNode.has(branch.node_id)) branchesByNode.set(branch.node_id, {});
      branchesByNode.get(branch.node_id)[branch.match_value] = branch.next_node_id;
    }

    const nodes = nodesResult.rows.map((n) => ({
      id: n.id,
      type: n.type,
      is_start: n.is_start,
      prompt_id: n.prompt_id,
      prompt_text: n.prompt_text,
      config: n.config,
      next: n.next_node_id,
      branches: branchesByNode.get(n.id) || undefined
    }));

    res.json({ ...flowResult.rows[0], nodes });
  } catch (err) {
    console.error('[IvrController] getFlow failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Marks a flow live and, if campaignId is given, points that campaign at it - Workstream 8.8's
// dialplan entry point reads voice_campaigns.ivr_flow_id to decide whether to route a lead
// through Stasis(ivr_engine,...) instead of the plain campaign-broadcast-context.
export async function activateFlow(req, res) {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  const { campaignId } = req.body || {};
  try {
    const flowResult = await pool.query(
      `UPDATE ivr_flows SET is_active = true, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, tenantId]
    );
    if (!flowResult.rows[0]) return res.status(404).json({ error: 'Flow not found' });

    if (campaignId) {
      const campaignResult = await pool.query(
        `UPDATE voice_campaigns SET ivr_flow_id = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
        [id, campaignId]
      );
      if (!campaignResult.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json({ id, is_active: true, campaignId: campaignId || null });
  } catch (err) {
    console.error('[IvrController] activateFlow failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Uploads a static prompt audio file for a flow node (the 'play'/'menu'/'collect_input'/'optout'
// node types' prompt_id field). This is the piece a client actually needs to design a flow
// end-to-end via the API: createFlow/updateFlow already let them author any number of nodes with
// any prompt_id string they choose, but nothing previously let them get real audio content onto
// the Asterisk box for that prompt_id - they'd have had no way to make a client_id-only flow
// actually speak anything. Reuses the exact same transcode+SFTP-delivery pipeline as campaign
// broadcast audio (Workstream 3), so Playback() never needs to know whether a file came from here
// or from a campaign upload.
export async function uploadPromptAudio(req, res) {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Audio file is required (field "audio")' });
  }

  const targetDir = path.join(os.tmpdir(), 'campaign_audio');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const outputPath = path.join(targetDir, `${Date.now()}_ivr_prompt.wav`);

  try {
    await transcodeCampaignAudio(file.path, outputPath);
    const promptId = await deliverCampaignAudio(outputPath);
    res.status(201).json({ prompt_id: promptId });
  } catch (err) {
    console.error('[IvrController] uploadPromptAudio failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(file.path); } catch (e) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
  }
}

async function bulkInsertLookupRows(client, tableId, rows) {
  for (let i = 0; i < rows.length; i += LOOKUP_ROW_INSERT_CHUNK) {
    const chunk = rows.slice(i, i + LOOKUP_ROW_INSERT_CHUNK);
    const placeholders = [];
    const params = [];
    chunk.forEach((row, idx) => {
      const base = idx * 3;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      params.push(tableId, row.keyValue, JSON.stringify(row.data));
    });
    await client.query(
      `INSERT INTO ivr_lookup_rows (table_id, key_value, data) VALUES ${placeholders.join(',')}`,
      params
    );
  }
}

// CSV upload for a client-hosted lookup table (the 'lookup' node's source_type: 'table' option -
// for clients without their own webhook backend). Reuses the header-name-lookup CSV parsing
// convention campaignController.js's lead upload already established.
export async function uploadLookupTable(req, res) {
  const tenantId = resolveTenantId(req);
  const { name, keyColumn } = req.body;
  const file = req.file;

  if (!name || !keyColumn) {
    return res.status(400).json({ error: 'name and keyColumn are required' });
  }
  if (!file) {
    return res.status(400).json({ error: 'CSV file is required (field "csv")' });
  }

  let records;
  try {
    const content = fs.readFileSync(file.path, 'utf8');
    records = parseCsv(content, {
      columns: (header) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true
    });
  } catch (err) {
    return res.status(400).json({ error: `Failed to parse CSV: ${err.message}` });
  } finally {
    fs.unlink(file.path, () => {});
  }

  const normalizedKeyColumn = keyColumn.trim().toLowerCase();
  if (records.length === 0) {
    return res.status(400).json({ error: 'CSV has no data rows' });
  }
  if (!(normalizedKeyColumn in records[0])) {
    return res.status(400).json({ error: `Key column "${keyColumn}" not found in CSV headers` });
  }
  if (records.length > LOOKUP_TABLE_MAX_ROWS) {
    return res.status(400).json({ error: `CSV has ${records.length} rows, exceeding the ${LOOKUP_TABLE_MAX_ROWS} row limit` });
  }

  const rows = [];
  const seenKeys = new Set();
  const duplicateKeys = new Set();
  for (const record of records) {
    const keyValue = String(record[normalizedKeyColumn] || '').trim();
    if (!keyValue) continue;
    if (seenKeys.has(keyValue)) {
      duplicateKeys.add(keyValue);
      continue;
    }
    seenKeys.add(keyValue);
    const data = { ...record };
    delete data[normalizedKeyColumn];
    rows.push({ keyValue, data });
  }
  // Plan's explicit edge case: a duplicate key_value in the upload must be a rejected, visible
  // error, not silent last-write-wins - checked up front so nothing gets partially inserted.
  if (duplicateKeys.size > 0) {
    return res.status(400).json({
      error: 'Duplicate key_value(s) in CSV',
      duplicates: [...duplicateKeys].slice(0, 50)
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tableResult = await client.query(
      `INSERT INTO ivr_lookup_tables (tenant_id, name, key_column) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, name, normalizedKeyColumn]
    );
    const tableId = tableResult.rows[0].id;
    await bulkInsertLookupRows(client, tableId, rows);
    await client.query('COMMIT');
    res.status(201).json({ id: tableId, name, key_column: normalizedKeyColumn, row_count: rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[IvrController] uploadLookupTable failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

export async function getLookupTable(req, res) {
  const tenantId = resolveTenantId(req);
  const { id } = req.params;
  try {
    const tableResult = await pool.query(
      `SELECT * FROM ivr_lookup_tables WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (!tableResult.rows[0]) return res.status(404).json({ error: 'Lookup table not found' });

    const rowsResult = await pool.query(
      `SELECT key_value, data FROM ivr_lookup_rows WHERE table_id = $1 ORDER BY key_value`,
      [id]
    );
    res.json({ ...tableResult.rows[0], rows: rowsResult.rows });
  } catch (err) {
    console.error('[IvrController] getLookupTable failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}
