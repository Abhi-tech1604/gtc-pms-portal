import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api, getToken, setToken } from './api';
import type { ModuleAction, ModuleCode, PageAction, PermissionFlag, User } from './types';
import { hasPagePermission } from './permissions';

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  can: (flag: PermissionFlag) => boolean;
  /** True if the account's module-access switch for this module is on. This
   *  is a UI convenience only — the server independently enforces the same
   *  check on every request behind the module (spec 5/20). */
  hasModule: (code: ModuleCode) => boolean;
  /** Module access AND the specific action within it. For PMS, use `can()`
   *  with its existing permission flags instead — PMS's real permissions
   *  never moved into this generic grid. */
  hasModuleAction: (code: ModuleCode, action: ModuleAction) => boolean;
  /**
   * Admin > User Rights' page-level matrix: module Access, then this page's
   * specific action — falling back to the module's own defaults (PMS/Admin's
   * legacy per-flag rules, or the other modules' CRUD grid) when no explicit
   * per-page override exists. A UI convenience only; the server enforces the
   * identical rule on every request (requirePage in middleware/auth.ts).
   */
  canPage: (code: ModuleCode, pageKey: string, action: PageAction) => boolean;
  isAdmin: boolean;
  /** Non-null when the account is limited to one rig (spec 5.3). */
  rigScope: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const didMount = useRef(false);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const data = await api.get<{ user: User }>('/auth/me');
      setUser(data.user);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * `user` (and every right/moduleAccess/pagePermission derived from it) is a
   * snapshot taken at the last /auth/me call — the server itself always reads
   * permissions fresh from the database on every request (middleware/auth.ts's
   * loadUser), so this snapshot, not the server, is the only thing that can go
   * stale. Re-pulling it on every navigation is what makes "the next
   * navigation must immediately enforce the new permission" true on the
   * frontend too: an Admin's save to another account takes effect for that
   * account the moment it next navigates anywhere, with no sign-out, no full
   * page reload. Skips the very first run — the mount effect above already
   * covers initial load — so app boot doesn't fire the request twice.
   */
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (!getToken()) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  /**
   * Belt-and-braces for a page the user is already sitting on when access is
   * revoked mid-session (no navigation involved): the server's 403 on that
   * very request (api.ts) is what actually blocks the action — this just
   * catches the UI up to match, immediately, on the same request instead of
   * waiting for the next navigation.
   */
  useEffect(() => {
    const onDenied = () => { void refresh(); };
    window.addEventListener('pms:permission-denied', onDenied);
    return () => window.removeEventListener('pms:permission-denied', onDenied);
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    const data = await api.post<{ token: string; user: User }>('/auth/login', { username, password });
    setToken(data.token);
    setUser(data.user);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(() => ({
    user,
    loading,
    signIn,
    signOut,
    can: (flag) => !!user?.rights?.[flag],
    hasModule: (code) => !!user?.moduleAccess?.[code]?.access,
    hasModuleAction: (code, action) => {
      const m = user?.moduleAccess?.[code];
      return !!m?.access && !!m[action];
    },
    canPage: (code, pageKey, action) =>
      hasPagePermission(user?.role, user?.rights, user?.moduleAccess, user?.pagePermissions, code, pageKey, action),
    isAdmin: user?.role === 'Admin',
    rigScope: user?.rigId ?? null,
    refresh,
  }), [user, loading, signIn, signOut, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
