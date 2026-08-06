import { createContext, useContext, useState, useCallback } from 'react';
import { apiPost, getStoredAuth, setStoredAuth } from '../api/client.js';

const AuthContext = createContext(null);

// Persisted in localStorage (unlike the agent softphone's deliberately in-memory-only token -
// see pages/agent/Softphone.jsx) since back-office users refreshing the page shouldn't have to
// log in again every time.
export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => getStoredAuth());

  const login = useCallback(async (username, password) => {
    const data = await apiPost('/api/auth/login', { username, password });
    const nextAuth = { token: data.token, user: data.user };
    setStoredAuth(nextAuth);
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const logout = useCallback(() => {
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
