import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, {
  setToken, getToken, setActiveCollege, getActiveCollege, setUnauthorisedHandler, describeError,
} from './api.js';

/**
 * Who is signed in, and what they are allowed to do.
 *
 * The permission flags here decide which controls are *drawn*. They are a
 * convenience, never a security boundary: the server scopes every query and
 * mutation by college_id / user_id / section_id and refuses anything this user
 * may not do, whatever the interface chose to show. Section 12 is enforced in
 * the API layer; this file only avoids showing people buttons that would fail.
 */

const AuthContext = createContext(null);

const EMPTY_PERMISSIONS = {
  canManageData: false,
  canGenerate: false,
  canEditTimetable: false,
  canSwitchCollege: false,
  canManageUsers: false,
  canManageUniversities: false,
  canEditOwnAvailability: false,
};

export function AuthProvider({ children }) {
  const [state, setState] = useState({
    status: getToken() ? 'checking' : 'anonymous',
    user: null,
    scope: null,
    colleges: [],
    permissions: EMPTY_PERMISSIONS,
    error: null,
  });

  const applySession = useCallback((session) => {
    const colleges = session.colleges || [];
    // Keep the switcher honest: if the stored college is not one this user may
    // see, fall back to their own scope.
    const stored = getActiveCollege();
    const allowed = colleges.some((c) => Number(c.id) === Number(stored));
    const fallback = session.scope && session.scope.collegeId ? session.scope.collegeId : (colleges[0] && colleges[0].id) || null;
    setActiveCollege(allowed ? stored : fallback);

    setState({
      status: 'signedIn',
      user: session.user,
      scope: session.scope || null,
      colleges,
      permissions: { ...EMPTY_PERMISSIONS, ...(session.permissions || {}) },
      error: null,
    });
  }, []);

  const signOut = useCallback((message) => {
    setToken(null);
    setActiveCollege(null);
    setState({
      status: 'anonymous',
      user: null,
      scope: null,
      colleges: [],
      permissions: EMPTY_PERMISSIONS,
      error: message || null,
    });
  }, []);

  // A rejected token means the 12-hour session ran out. Return to sign-in
  // rather than letting every page fail on its own.
  useEffect(() => {
    setUnauthorisedHandler(() => {
      if (getToken()) signOut('Your session has ended. Please sign in again.');
    });
    return () => setUnauthorisedHandler(null);
  }, [signOut]);

  // Restore a session across a window reload.
  useEffect(() => {
    if (state.status !== 'checking') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const session = await api.get('/auth/me');
        if (!cancelled) applySession(session);
      } catch {
        if (!cancelled) signOut(null);
      }
    })();
    return () => { cancelled = true; };
  }, [state.status, applySession, signOut]);

  const signIn = useCallback(async (username, password) => {
    try {
      const session = await api.post('/auth/login', { username, password });
      setToken(session.token);
      applySession(session);
      return session;
    } catch (err) {
      setState((prev) => ({ ...prev, error: describeError(err) }));
      throw err;
    }
  }, [applySession]);

  const refresh = useCallback(async () => {
    const session = await api.get('/auth/me');
    applySession(session);
    return session;
  }, [applySession]);

  /** The Super Admin's college switcher. */
  const switchCollege = useCallback((collegeId) => {
    setActiveCollege(collegeId);
    setState((prev) => ({ ...prev, collegeVersion: (prev.collegeVersion || 0) + 1 }));
  }, []);

  const value = useMemo(() => {
    const role = state.user ? state.user.role : null;
    const activeCollegeId = getActiveCollege();
    const activeCollege = state.colleges.find((c) => Number(c.id) === Number(activeCollegeId)) || null;
    return {
      ...state,
      role,
      isSuperAdmin: role === 'SUPER_ADMIN',
      // COLLEGE_ADMIN is the stored value; "Timetable Coordinator" is what it is
      // called everywhere a person reads it.
      isCoordinator: role === 'COLLEGE_ADMIN',
      isFaculty: role === 'FACULTY',
      isStudent: role === 'STUDENT',
      readOnly: role === 'FACULTY' || role === 'STUDENT',
      activeCollegeId,
      activeCollege,
      signIn,
      signOut,
      refresh,
      switchCollege,
      clearError: () => setState((prev) => ({ ...prev, error: null })),
    };
  }, [state, signIn, signOut, refresh, switchCollege]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth was used outside AuthProvider.');
  return ctx;
}

export default AuthContext;
