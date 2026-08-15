import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

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

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      // 401 (not 403) - the token itself is invalid/expired, not a permissions issue. client.js's
      // request() only clears storage and bounces back to /login on a 401; a 403 here left users
      // stuck on a half-broken page (stale cached data, this error scattered across cards)
      // instead of cleanly being sent to log in again for a fresh token. 403 stays reserved for
      // authorizeRoles below and other genuine "authenticated but not allowed" cases.
      return res.status(401).json({ error: 'Invalid or expired access token' });
    }
    req.user = user;
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
