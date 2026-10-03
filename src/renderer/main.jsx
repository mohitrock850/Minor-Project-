import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { RuntimeProvider } from './lib/runtime.jsx';
import './styles.css';

/**
 * Entry point.
 *
 * HashRouter, not BrowserRouter: the packaged application is loaded from a
 * file:// URL, where path-based routing cannot work.
 *
 * The provider order matters. Runtime first (it discovers which API to talk to),
 * then toasts (so anything below can report a problem), then auth (which needs
 * both).
 */

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // No console in a packaged build, but this still reaches the dev tools and
    // the Electron log when run with npm run dev.
    console.error('Interface error:', error, info && info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>Something in the interface stopped working.</h1>
        <p>
          Your data is safe — nothing was changed. Reloading the window usually clears this.
        </p>
        <pre>{String(this.state.error && this.state.error.message)}</pre>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <RuntimeProvider>
      <ToastProvider>
        <AuthProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </AuthProvider>
      </ToastProvider>
    </RuntimeProvider>
  </ErrorBoundary>
);
