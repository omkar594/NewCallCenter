import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { apiGet, apiPost, getStoredAuth, setStoredAuth } from '../api/client.js';

const AuthContext = createContext(null);

// Persisted in localStorage so a page refresh doesn't force a re-login. This now covers agents
// too - the softphone used to keep its own memory-only token and its own login form, which meant
// agents typed their password twice (see pages/agent/Softphone.jsx).
//
// `features` is the tenant's plan: which capabilities this client actually bought. It is used
// ONLY to hide UI a client has no use for. Every feature is independently enforced server-side by
// backend/middleware/tenantFeature.js, because a hidden menu item is a UX decision, not access
// control - the API is reachable directly with any valid token regardless of what renders here.
export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => getStoredAuth());

  // `portal`: 'client' (/login) or 'admin' (/admin/login) - passed through so the backend can
  // reject a wrong-portal login with the exact same response as a wrong password (see
  // authController.js's login()). Enforcing this server-side, not just redirecting post-login,
  // is what keeps a correct-password-wrong-portal attempt indistinguishable from a genuinely
  // wrong password - otherwise someone probing the client login with guessed admin credentials
  // could tell when they'd found a valid one.
  const login = useCallback(async (username, password, portal) => {
    const data = await apiPost('/api/auth/login', { username, password, portal });
    const nextAuth = { token: data.token, user: data.user, features: data.features || null };
    setStoredAuth(nextAuth);
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  // Re-read the plan on mount. Features are baked into the login response, so without this a
  // client whose Super Admin just enabled live agents would keep seeing the old menus until their
  // 12h token expired. Failure is ignored on purpose: a transient /me error should not log
  // anyone out or blank the nav - a genuinely dead token is already handled centrally by the 401
  // path in api/client.js.
  useEffect(() => {
    if (!auth?.token) return;
    let cancelled = false;
    apiGet('/api/auth/me')
      .then((data) => {
        if (cancelled) return;
        setAuth((prev) => {
          if (!prev) return prev;
          const next = { ...prev, user: { ...prev.user, ...data.user }, features: data.features || null };
          setStoredAuth(next);
          return next;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Intentionally keyed on the token alone: this should re-run when the account changes, not on
    // every unrelated auth object update (which the setAuth above would otherwise loop on).
  }, [auth?.token]);

  const logout = useCallback(() => {
    // Best-effort: bumps token_version server-side (see authController.js) so this token - and
    // any other still-unexpired token for this account - is rejected everywhere immediately,
    // not just cleared from this browser. Local logout must still happen even if this fails
    // (offline, token already expired) - fired without awaiting so it never blocks that.
    apiPost('/api/auth/logout').catch(() => {});
    setStoredAuth(null);
    setAuth(null);
  }, []);

  return (
    <AuthContext.Provider value={{ auth, user: auth?.user || null, token: auth?.token || null, features: auth?.features || null, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
