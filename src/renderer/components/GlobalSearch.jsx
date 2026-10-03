import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../lib/api.js';

/**
 * Section 11: one search box across everything.
 *
 * The server does the searching and the scoping -- a coordinator's results only
 * ever contain their own college, a student's only their own section -- so this
 * component sends the query and renders whatever groups come back. It never
 * filters results itself, because filtering in the interface would mean the data
 * had already been sent to someone who should not have it.
 */

const MIN_QUERY = 2;

export default function GlobalSearch({ open, onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResult(null);
      setCursor(0);
      // A frame later, so the input exists.
      requestAnimationFrame(() => input.current && input.current.focus());
    }
  }, [open]);

  // Debounced, and every in-flight request is abandoned when a newer one starts.
  useEffect(() => {
    if (!open) return undefined;
    const text = query.trim();
    if (text.length < MIN_QUERY) {
      setResult(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        setResult(await api.get('/meta/search', { q: text }, { signal: controller.signal }));
        setCursor(0);
      } catch {
        // A failed search should not shout; the empty state says enough.
      } finally {
        setBusy(false);
      }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open]);

  // A flat list, so the arrow keys can walk across group boundaries.
  const flat = useMemo(() => {
    if (!result || !result.groups) return [];
    return result.groups.flatMap((group) => (group.results || []).map((hit) => ({ ...hit, groupLabel: group.label })));
  }, [result]);

  const go = (hit) => {
    if (!hit) return;
    onClose();
    // The server suggests where to go: the timetable view when there is one,
    // otherwise the data record.
    navigate(hit.viewRoute || hit.route || '/');
  };

  if (!open) return null;

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); go(flat[cursor]); }
  };

  let index = -1;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-input">
          <span aria-hidden="true" className="muted">⌕</span>
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search courses, teachers, rooms, sections, students…"
            aria-label="Search"
          />
          {busy ? <span className="spinner" /> : null}
        </div>

        <div className="palette-results">
          {query.trim().length < MIN_QUERY ? (
            <p className="small soft" style={{ padding: '14px 12px' }}>
              Type at least {MIN_QUERY} characters. Results only ever cover what you are allowed to see.
            </p>
          ) : !result || !flat.length ? (
            <p className="small soft" style={{ padding: '14px 12px' }}>
              {busy ? 'Searching…' : (result && result.message) || `Nothing matched “${query.trim()}”.`}
            </p>
          ) : (
            result.groups.filter((g) => g.results && g.results.length).map((group) => (
              <div key={group.key}>
                <div className="palette-group">
                  {group.label}
                  {group.total > group.results.length ? ` · showing ${group.results.length} of ${group.total}` : ''}
                </div>
                {group.results.map((hit) => {
                  index += 1;
                  const on = index === cursor;
                  return (
                    <button
                      key={`${hit.entity}-${hit.id}`}
                      type="button"
                      className={`palette-hit${on ? ' on' : ''}`}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => go(hit)}
                    >
                      <span className="hit-icon" aria-hidden="true">{group.icon || '·'}</span>
                      <span className="hit-text">
                        <span className="hit-title">{hit.title}</span>
                        {hit.subtitle ? <span className="hit-sub">{hit.subtitle}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          {result && result.total ? <span className="spacer" style={{ marginLeft: 'auto' }}>{result.total} matches</span> : null}
        </div>
      </div>
    </div>
  );
}
