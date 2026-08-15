import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pool from '../config/database.js';

dotenv.config();

/**
 * Middleware to authenticate requests via JWT.
 * Populates req.user with decoded user properties.
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      // 401 (not 403) - the token itself is invalid/expired, not a permissions issue. client.js's
      // request() only clears storage and bounces back to /login on a 401; a 403 here left users
      // stuck on a half-broken page (stale cached data, this error scattered across cards)
      // instead of cleanly being sent to log in again for a fresh token. 403 stays reserved for
      // authorizeRoles below and other genuine "authenticated but not allowed" cases.
      return res.status(401).json({ error: 'Invalid or expired access token' });
    }

    try {
      // Revocation check: a token whose tokenVersion doesn't match the account's CURRENT
      // token_version was issued before a "Log out" (or the account no longer exists) - reject
      // it here even though it's still cryptographically valid and unexpired. See
      // authController.js's login() (embeds the version) and logout() (bumps it). One extra
      // indexed primary-key lookup per authenticated request.
      const result = await pool.query('SELECT token_version FROM users WHERE id = $1', [decoded.id]);
      const currentVersion = result.rows[0]?.token_version;
      if (currentVersion === undefined || currentVersion !== decoded.tokenVersion) {
        return res.status(401).json({ error: 'Invalid or expired access token' });
      }
    } catch (dbErr) {
      console.error('[Auth] Token revocation check failed:', dbErr.message);
      return res.status(500).json({ error: 'Internal server error during authentication' });
    }

    req.user = decoded;
    next();
  });
}

/**
 * Middleware to authorize specific user roles.
 * @param {Array<string>} roles - List of allowed roles.
 */
export function authorizeRoles(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission denied for this role' });
    }
    next();
  };
}
