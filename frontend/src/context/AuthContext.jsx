import { createContext, useContext, useState, useCallback } from 'react';
import { apiPost, getStoredAuth, setStoredAuth } from '../api/client.js';

const AuthContext = createContext(null);

// Persisted in localStorage (unlike the agent softphone's deliberately in-memory-only token -
// see pages/agent/Softphone.jsx) since back-office users refreshing the page shouldn't have to
// log in again every time.
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
    const nextAuth = { token: data.token, user: data.user };
    setStoredAuth(nextAuth);
    setAuth(nextAuth);
    return nextAuth;
  }, []);

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
    <AuthContext.Provider value={{ auth, user: auth?.user || null, token: auth?.token || null, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
