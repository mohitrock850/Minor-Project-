import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { describeError } from '../lib/api.js';

/**
 * Short-lived confirmations in the corner of the window.
 *
 * Used for "it worked" and for errors that do not need the user to make a
 * decision. Anything the user must answer -- a hard conflict they could override,
 * a destructive action -- gets a modal or an OS dialog instead, never a toast.
 */

const ToastContext = createContext(null);

let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((toast) => {
    const id = nextId++;
    const entry = { id, tone: 'info', ...toast };
    setToasts((prev) => [...prev.slice(-3), entry]);   // never stack more than four
    if (entry.duration !== 0) {
      const ms = entry.duration || (entry.tone === 'bad' ? 8000 : 4000);
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    }
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({
    push,
    dismiss,
    success: (message, title) => push({ tone: 'ok', message, title }),
    info: (message, title) => push({ tone: 'info', message, title }),
    warn: (message, title) => push({ tone: 'warn', message, title }),
    error: (message, title) => push({ tone: 'bad', message, title }),
    /** Turns a thrown ApiError into a readable toast, details and all. */
    fromError: (err, title) => push({ tone: 'bad', title: title || null, message: describeError(err) }),
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`} role="status">
            <div className="toast-body">
              {toast.title ? <div className="toast-title">{toast.title}</div> : null}
              <div>{toast.message}</div>
            </div>
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast was used outside ToastProvider.');
  return ctx;
}

export default ToastContext;
