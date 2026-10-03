import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import desktop from '../lib/desktop.js';
import { useAuth } from '../lib/auth.jsx';
import { useRuntime } from '../lib/runtime.jsx';
import { useToast } from './Toast.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import { Badge } from './ui.jsx';
import { roleLabel } from '../lib/format.js';

/**
 * The window frame: a role-scoped sidebar, a top bar with the college switcher
 * and search, and whatever page is routed inside.
 *
 * The sidebar is built from what this user may do. That is a convenience only --
 * the server refuses anything they are not allowed to do regardless of what is
 * drawn here (Section 12) -- but it keeps a student from staring at a Generate
 * button that would only ever fail.
 */

/** Every possible destination, with the permission that earns it. */
function navigationFor(auth) {
  const { permissions, isSuperAdmin, isCoordinator, isFaculty, isStudent } = auth;
  const groups = [];

  groups.push({
    label: null,
    items: [
      { to: '/', label: 'Dashboard', icon: '◱', end: true },
      isFaculty || isStudent
        ? { to: '/views', label: 'My Timetable', icon: '▦' }
        : { to: '/views', label: 'Timetable Views', icon: '▦' },
    ],
  });

  if (permissions.canGenerate || permissions.canEditTimetable) {
    groups.push({
      label: 'Timetable',
      items: [
        permissions.canGenerate ? { to: '/generate', label: 'Generate', icon: '⚡' } : null,
        permissions.canEditTimetable ? { to: '/manual', label: 'Manual Builder', icon: '✎' } : null,
        permissions.canEditTimetable ? { to: '/timetables', label: 'Saved & Versions', icon: '⧉' } : null,
      ].filter(Boolean),
    });
  }

  if (permissions.canManageData) {
    groups.push({
      label: 'University Data',
      items: [
        { to: '/data', label: 'Data Management', icon: '☰' },
        { to: '/timing', label: 'Timing Configuration', icon: '◷' },
        { to: '/rules', label: 'Scheduling Rules', icon: '⚖' },
        { to: '/import', label: 'Import & Export', icon: '⇅' },
      ],
    });
  }

  if (isFaculty && permissions.canEditOwnAvailability) {
    groups.push({
      label: 'Mine',
      items: [{ to: '/availability', label: 'My Availability', icon: '◷' }],
    });
  }

  groups.push({
    label: 'Help & Setup',
    items: [
      { to: '/assistant', label: 'AI Assistant', icon: '✦' },
      { to: '/settings', label: 'Settings', icon: '⚙' },
      { to: '/help', label: 'Getting Started', icon: '?' },
    ],
  });

  // Nothing above is shown to a role that cannot use it, so an empty group is
  // dropped rather than left as a stray heading.
  return groups.filter((g) => g.items.length);
}

export default function AppShell({ children }) {
  const auth = useAuth();
  const { runtime } = useRuntime();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [counts, setCounts] = useState(null);

  const nav = useMemo(() => navigationFor(auth), [auth]);

  // Record counts sit next to the Data Management link so a coordinator can see
  // at a glance whether anything has been entered yet.
  useEffect(() => {
    if (!auth.permissions.canManageData) return;
    let cancelled = false;
    api.get('/meta/counts')
      .then((body) => { if (!cancelled) setCounts(body.counts || null); })
      .catch(() => { /* the sidebar works fine without them */ });
    return () => { cancelled = true; };
  }, [auth.permissions.canManageData, auth.activeCollegeId, location.pathname]);

  // --- Menu commands (Ctrl+B, Ctrl+I, Ctrl+1..5, Ctrl+K …) ------------------
  const handleMenu = useCallback((command, payload) => {
    switch (command) {
      case 'go':
        navigate(payload || '/');
        break;
      case 'search':
        setSearchOpen(true);
        break;
      case 'backup':
        navigate('/settings?panel=backup&action=backup');
        break;
      case 'restore':
        navigate('/settings?panel=backup&action=restore');
        break;
      case 'import':
        navigate('/import');
        break;
      case 'export':
        navigate('/views?export=1');
        break;
      case 'reveal-data':
        desktop.reveal().catch(() => toast.warn('The data folder could not be opened.'));
        break;
      default:
        break;
    }
  }, [navigate, toast]);

  useEffect(() => desktop.onMenuCommand(handleMenu), [handleMenu]);

  // The same shortcuts work when the interface is open in a browser, where
  // there is no application menu to send them.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const initials = (auth.user && auth.user.fullName ? auth.user.fullName : (auth.user && auth.user.username) || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

  const countFor = (to) => {
    if (!counts || to !== '/data') return null;
    const total = Object.values(counts).reduce((n, v) => n + (Number(v) || 0), 0);
    return total || null;
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">Timetable Management</span>
          <span className="brand-sub">
            {auth.activeCollege ? auth.activeCollege.name : (runtime && runtime.name) || 'University'}
          </span>
        </div>

        {nav.map((group, gi) => (
          <React.Fragment key={group.label || `g${gi}`}>
            {group.label ? <div className="nav-group">{group.label}</div> : null}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
                {countFor(item.to) ? <span className="nav-count">{countFor(item.to)}</span> : null}
              </NavLink>
            ))}
          </React.Fragment>
        ))}

        <div className="sidebar-foot">
          {runtime && runtime.mode === 'CLIENT' ? (
            <div><Badge tone="info">Shared database</Badge></div>
          ) : runtime && runtime.mode === 'HOST' ? (
            <div><Badge tone="info">Sharing on the network</Badge></div>
          ) : null}
          <div>Works offline{runtime && runtime.version ? ` · v${runtime.version}` : ''}</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          {/* Super Admin only: everyone else is pinned to their own college by
              the server, and the switcher would be a lie. */}
          {auth.permissions.canSwitchCollege && auth.colleges.length > 1 ? (
            <select
              value={auth.activeCollegeId || ''}
              onChange={(e) => auth.switchCollege(e.target.value ? Number(e.target.value) : null)}
              aria-label="College"
              style={{ maxWidth: 260 }}
            >
              {auth.colleges.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.code ? ` (${c.code})` : ''}</option>
              ))}
            </select>
          ) : auth.activeCollege ? (
            <strong style={{ fontSize: 13 }}>{auth.activeCollege.name}</strong>
          ) : null}

          <button type="button" className="search-open" onClick={() => setSearchOpen(true)}>
            <span aria-hidden="true">⌕</span>
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>

          <span className="spacer" />

          <div className="who">
            <div className="who-text">
              <span className="who-name">{(auth.user && auth.user.fullName) || (auth.user && auth.user.username)}</span>
              <span className="who-role">{roleLabel(auth.role)}</span>
            </div>
            <span className="avatar" aria-hidden="true">{initials}</span>
            <button type="button" className="btn small ghost" onClick={() => auth.signOut()}>Sign out</button>
          </div>
        </header>

        {children}
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
