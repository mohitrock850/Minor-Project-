import React, { createContext, useContext, useEffect, useState } from 'react';
import desktop from './desktop.js';
import { initApi } from './api.js';

/**
 * Discovers, once, which backend this window is talking to.
 *
 * Everything below this provider can assume the API address is already set, so
 * no page has to know whether it is running on the machine that holds the
 * database, on a machine borrowing another one's, or in a browser tab.
 */

const RuntimeContext = createContext({ loading: true, runtime: null, error: null });

export function RuntimeProvider({ children }) {
  const [state, setState] = useState({ loading: true, runtime: null, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runtime = await initApi();
        if (!cancelled) setState({ loading: false, runtime, error: runtime?.startupError || null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, runtime: null, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.loading) {
    return <div className="boot">Starting&hellip;</div>;
  }

  return (
    <RuntimeContext.Provider value={{ ...state, isDesktop: desktop.isDesktop }}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntime() {
  return useContext(RuntimeContext);
}

export default RuntimeContext;
