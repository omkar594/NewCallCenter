import crypto from 'crypto';
import pool from '../config/database.js';

// Authenticates the public call-control API (/api/v1), which is used by client systems rather
// than by people. Those clients have no user account, no login and no session - they hold a
// single long-lived key - so authenticateToken (JWT, 12h, tied to a users row) does not apply.
//
// Deliberately NOT soft-enforced, unlike middleware/webhookAuth.js. That one lets requests
// through when its secret is unset, which is a reasonable trade for a dialplan we control and
// can update at our own pace. These endpoints spend real money placing live calls on a client's
// behalf, so an unknown or missing key is always rejected - there is no configuration state in
// which this becomes optional.
//
// Keys are compared by SHA-256 hash. The raw key is shown once at creation and never stored, so
// a leaked copy of api_keys is not a set of working credentials.

export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// 'vk_' so a key is recognisable on sight in a log or a support ticket, and greppable if one is
// ever pasted somewhere it should not be. 32 random bytes, url-safe.
export function generateApiKey() {
  const raw = 'vk_' + crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

export async function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!key) {
    return res.status(401).json({
      error: 'Missing API key. Send it as: Authorization: Bearer <your-api-key>'
    });
  }

  try {
    // Looked up by hash, so the query itself never contains the secret and a timing difference
    // on the index reveals nothing useful about a valid key's contents.
    const result = await pool.query(`
      SELECT k.id, k.tenant_id, k.revoked_at, t.status AS tenant_status
        FROM api_keys k
        JOIN tenants t ON t.id = k.tenant_id
       WHERE k.key_hash = $1
    `, [hashApiKey(key)]);

    const row = result.rows[0];
    // One generic message for unknown, revoked and suspended alike: telling a caller which of
    // those applies confirms that a key exists, which is information they should not get.
    if (!row || row.revoked_at || row.tenant_status !== 'active') {
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }

    req.tenantId = row.tenant_id;
    req.apiKeyId = row.id;

    // Fire-and-forget: knowing when a key was last used is how you find out a client has stopped
    // integrating, or that an old key is still live and should be revoked. Never worth failing a
    // real call over, so the write is not awaited and its failure is swallowed.
    pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});

    return next();
  } catch (err) {
    console.error('[ApiKeyAuth] Key lookup failed:', err.message);
    return res.status(503).json({ error: 'Unable to verify API key right now' });
  }
}
