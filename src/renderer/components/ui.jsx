import React, { useEffect, useRef } from 'react';
import { acRequirementLabel, scoreBand, humanise } from '../lib/format.js';

/* =========================================================================
   The small pieces every page is built from.

   Nothing here fetches anything or makes a decision; they take values the server
   has already worked out and put them on the screen consistently. Keeping them in
   one file means the AC badge, the score pill and the empty state look identical
   in the wizard, the manual builder and every view.
   ========================================================================= */

// --- Air conditioning ------------------------------------------------------

/**
 * What a room *is*. Section 1 and 16: this is never allowed to be subtle, so it
 * is a solid colour block with a border and capital letters, shown everywhere a
 * room is named.
 *
 * `isAc` and `acLabel` both come straight from the server's room card.
 */
export function AcBadge({ isAc, acLabel, large, soft, title }) {
  const on = isAc === true || isAc === 1 || acLabel === 'AC';
  return (
    <span
      className={`${on ? 'badge-ac' : 'badge-nonac'}${large ? ' large' : ''}${on && soft ? ' soft' : ''}`}
      title={title || (on ? 'This room is air-conditioned' : 'This room is not air-conditioned')}
    >
      {on ? 'AC' : 'NON-AC'}
    </span>
  );
}

/**
 * What a course *asks for*: REQUIRED | PREFERRED | NOT_REQUIRED. Deliberately
 * shaped differently from AcBadge so a requirement is never mistaken for a fact
 * about a room.
 */
export function AcRequirement({ value, showNotRequired = true }) {
  const key = value || 'NOT_REQUIRED';
  if (key === 'NOT_REQUIRED' && !showNotRequired) return null;
  return (
    <span className={`ac-need ${key}`}>
      {key === 'REQUIRED' ? '❄' : key === 'PREFERRED' ? '≈' : '·'}
      <span className="req-word">{acRequirementLabel(key)}</span>
    </span>
  );
}

// --- Badges, pills, scores -------------------------------------------------

export function Badge({ tone = 'plain', children, title }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

/** A 0-100 score, coloured by band. Shows a dash when the server sent nothing. */
export function ScorePill({ score, suffix = '', title }) {
  const has = score !== null && score !== undefined && Number.isFinite(Number(score));
  return (
    <span className={`score-pill ${has ? scoreBand(score) : 'unknown'}`} title={title}>
      {has ? `${Math.round(Number(score))}${suffix}` : '—'}
    </span>
  );
}

/** The big quality dial on the generation results panel (Section 5). */
export function ScoreDial({ score, label }) {
  const has = Number.isFinite(Number(score));
  return (
    <div className="row" style={{ gap: 14 }}>
      <div className={`score ${has ? scoreBand(score) : 'unknown'}`}>
        <span className="score-value">{has ? Math.round(Number(score)) : '—'}</span>
        <span className="score-of">out of 100</span>
      </div>
      {label ? <div className="small soft" style={{ maxWidth: 260 }}>{label}</div> : null}
    </div>
  );
}

export function Bar({ value, max = 100, band, slim }) {
  const pct = Math.max(0, Math.min(100, (Number(value) / (Number(max) || 100)) * 100));
  const tone = band || scoreBand((Number(value) / (Number(max) || 100)) * 100);
  return (
    <div className={`bar ${tone}${slim ? ' slim' : ''}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Meter({ label, value, of, band, suffix }) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <strong>{value}{suffix || ''}{of != null ? ` / ${of}` : ''}</strong>
      </div>
      <Bar value={value} max={of} band={band} slim />
    </div>
  );
}

// --- Containers ------------------------------------------------------------

export function Card({ title, subtitle, actions, children, className = '', flush, note }) {
  return (
    <section className={`card${flush ? ' flush' : ''} ${className}`.trim()}>
      {(title || actions) ? (
        <header className="card-head">
          <div style={{ minWidth: 0 }}>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <div className="card-note">{subtitle}</div> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
      {note ? <p className="card-note mt">{note}</p> : null}
    </section>
  );
}

export function Stat({ value, label, foot, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`stat${tone ? ` ${tone}` : ''}${onClick ? ' clickable' : ''}`}
      onClick={onClick}
      style={onClick ? { font: 'inherit', textAlign: 'left', cursor: 'pointer' } : undefined}
    >
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {foot ? <span className="stat-foot">{foot}</span> : null}
    </Tag>
  );
}

export function Notice({ tone = 'info', title, children, actions, icon }) {
  const marks = { info: 'ℹ', ok: '✓', warn: '!', bad: '✕' };
  return (
    <div className={`notice ${tone}`}>
      <span className="notice-icon" aria-hidden="true">{icon || marks[tone]}</span>
      <div className="notice-body">
        {title ? <div className="notice-title">{title}</div> : null}
        {children}
      </div>
      {actions ? <div className="notice-actions">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ icon = '○', title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      {title ? <div className="empty-title">{title}</div> : null}
      {children ? <div className="empty-text">{children}</div> : null}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="loading"><span className="spinner" aria-hidden="true" /> {label}</div>;
}

export function PageHead({ title, subtitle, breadcrumbs, actions, children }) {
  return (
    <>
      {breadcrumbs && breadcrumbs.length ? (
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={`${crumb.label}-${i}`}>
              {i > 0 ? <span className="sep">/</span> : null}
              {crumb.to ? <a href={crumb.to}>{crumb.label}</a> : <span>{crumb.label}</span>}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <header className="page-head">
        <div className="page-title">
          <h1>{title}</h1>
          {subtitle ? <div className="page-sub">{subtitle}</div> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </header>
      {children}
    </>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={active === tab.value}
          className={`tab${active === tab.value ? ' active' : ''}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count != null ? <span className="muted"> ({tab.count})</span> : null}
        </button>
      ))}
    </div>
  );
}

// --- Form controls ---------------------------------------------------------

export function Field({ label, hint, error, required, children, htmlFor }) {
  return (
    <div className="field">
      {label ? (
        <label htmlFor={htmlFor}>
          {label}{required ? <span className="req" title="Required">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <span className="error-text">{error}</span> : null}
      {hint && !error ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({ invalid, ...props }) {
  return <input type="text" className={invalid ? 'invalid' : undefined} {...props} />;
}

export function Select({ options, placeholder, invalid, value, ...props }) {
  return (
    <select className={invalid ? 'invalid' : undefined} value={value ?? ''} {...props}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {(options || []).map((opt) => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const text = typeof opt === 'string' ? humanise(opt) : (opt.label ?? String(opt.value));
        return <option key={String(val)} value={val}>{text}</option>;
      })}
    </select>
  );
}

export function Checkbox({ label, hint, checked, onChange, disabled, ...props }) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange && onChange(e.target.checked, e)}
        disabled={disabled}
        {...props}
      />
      <span>
        {label}
        {hint ? <span className="check-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** The working-days picker, and anything else that is a small set of toggles. */
export function ChipToggles({ options, value, onChange, disabled, single }) {
  const selected = Array.isArray(value) ? value.map(String) : (value == null ? [] : [String(value)]);
  const toggle = (raw) => {
    const key = String(raw);
    if (single) return onChange(selected[0] === key ? null : raw);
    const next = selected.includes(key)
      ? selected.filter((v) => v !== key)
      : [...selected, key];
    // Keep the caller's original types (numbers for days, strings for enums).
    return onChange((options || [])
      .filter((o) => next.includes(String(typeof o === 'string' ? o : o.value)))
      .map((o) => (typeof o === 'string' ? o : o.value)));
  };
  return (
    <div className="chip-set">
      {(options || []).map((opt) => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const text = typeof opt === 'string' ? humanise(opt) : opt.label;
        const on = selected.includes(String(val));
        return (
          <button
            key={String(val)}
            type="button"
            className={`chip-toggle${on ? ' on' : ''}`}
            onClick={() => toggle(val)}
            disabled={disabled}
            aria-pressed={on}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Marks a field the scheduling engine will fill in. Section 5: an empty field
 * never means invalid data -- it means "you decide".
 */
export function AutoTag({ children = 'Auto' }) {
  return <span className="auto-tag" title="Left empty on purpose — the scheduler will decide this">{children}</span>;
}

// --- Modal -----------------------------------------------------------------

export function Modal({ title, subtitle, onClose, children, footer, width = '', closeOnBackdrop = true }) {
  const panel = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so Escape and Tab behave.
    if (panel.current) {
      const target = panel.current.querySelector('input, select, textarea, button');
      if (target) target.focus();
    }
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}
    >
      <div className={`modal ${width}`} ref={panel} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div className="modal-title">
            <h2>{title}</h2>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** In-window confirmation. The OS dialog (desktop.confirm) is used for deletions. */
export function ConfirmModal({ title, message, detail, confirmLabel = 'Continue', danger, busy, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : null} {confirmLabel}
          </button>
        </>
      )}
    >
      <p>{message}</p>
      {detail ? <p className="small soft">{detail}</p> : null}
    </Modal>
  );
}

// --- Constraint output -----------------------------------------------------

/**
 * The violations and warnings the constraint checker returns. Hard violations
 * come first and are red; soft warnings are amber and never block anything.
 */
export function ViolationList({ violations = [], warnings = [], compact }) {
  const asText = (v) => (typeof v === 'string' ? v : (v.message || v.rule || JSON.stringify(v)));
  if (!violations.length && !warnings.length) return null;
  return (
    <div className="stack tight">
      {violations.length ? (
        <Notice tone="bad" title={violations.length === 1 ? 'This is not allowed' : `${violations.length} things are not allowed`}>
          <ul>{violations.map((v, i) => <li key={i}>{asText(v)}</li>)}</ul>
        </Notice>
      ) : null}
      {warnings.length ? (
        <Notice tone="warn" title={compact ? null : (warnings.length === 1 ? 'One thing to be aware of' : `${warnings.length} things to be aware of`)}>
          <ul>{warnings.map((w, i) => <li key={i}>{asText(w)}</li>)}</ul>
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * The room comparison card of Section 2: capacity arithmetic, air conditioning
 * and facilities side by side, so two rooms can be judged at a glance.
 *
 * `room` is the server's roomCard() output; the check fields are present only
 * when the room was evaluated against a class.
 */
export function RoomCard({ room, onChoose, chosen, readOnly, showChecks = true }) {
  if (!room) return null;
  const Tag = onChoose ? 'button' : 'div';
  const pill = (check, label) => {
    if (!check) return null;
    const tone = check.ok === false ? 'fail' : check.warn ? 'near' : 'pass';
    return (
      <span className={`check-pill ${tone}`} title={check.message || undefined}>
        {tone === 'pass' ? '✓' : tone === 'near' ? '!' : '✕'} {label}
      </span>
    );
  };
  return (
    <Tag
      type={onChoose ? 'button' : undefined}
      className={`room-card${chosen ? ' chosen' : ''}${readOnly ? ' readonly' : ''}${room.capacityCheck && room.capacityCheck.ok === false ? ' unfit' : ''}`}
      onClick={onChoose}
    >
      <div className="room-card-head">
        <span className="room-name">{room.name || room.roomNumber || room.code}</span>
        <span className="room-badges">
          <AcBadge isAc={room.isAc} acLabel={room.acLabel} />
          {room.roomTypeLabel ? <Badge>{room.roomTypeLabel}</Badge> : null}
          {room.score != null ? <ScorePill score={room.score} /> : null}
        </span>
      </div>
      <div className="room-facts">
        <span>
          Seats <strong>{room.capacity}</strong>
          {room.maxPermitted && room.maxPermitted !== room.capacity ? ` (up to ${room.maxPermitted})` : ''}
        </span>
        {room.requiredStrength != null ? <span>Needs {room.requiredStrength}</span> : null}
        {room.building ? <span>{room.building}{room.floor ? `, ${room.floor}` : ''}</span> : null}
        {room.computerCount ? <span>{room.computerCount} computers</span> : null}
        {room.hasProjector ? <span>Projector</span> : null}
        {room.hasSmartBoard ? <span>Smart board</span> : null}
      </div>
      {showChecks && (room.capacityCheck || room.acCheck || room.facilityCheck) ? (
        <div className="room-checks">
          {pill(room.capacityCheck, 'Capacity')}
          {pill(room.acCheck, 'Air conditioning')}
          {pill(room.facilityCheck, 'Facilities')}
          {room.isCurrent ? <Badge tone="info">Currently used</Badge> : null}
        </div>
      ) : null}
      {Array.isArray(room.warnings) && room.warnings.length ? (
        <div className="tiny" style={{ color: 'var(--warn)' }}>{room.warnings.map((w) => (typeof w === 'string' ? w : w.message)).join(' · ')}</div>
      ) : null}
      {Array.isArray(room.reasons) && room.reasons.length ? (
        <div className="tiny" style={{ color: 'var(--bad)' }}>{room.reasons.map((r) => (typeof r === 'string' ? r : r.message)).join(' · ')}</div>
      ) : null}
    </Tag>
  );
}

/**
 * One candidate slot from Find Best Slot or Find Alternatives. The fields come
 * from the server's slot option shape unchanged.
 */
export function SlotOption({ option, onChoose, chosen, best }) {
  if (!option) return null;
  return (
    <button
      type="button"
      className={`slot-option${best ? ' best' : ''}${chosen ? ' chosen' : ''}`}
      onClick={onChoose}
    >
      <span className="slot-when">
        {option.dayName || `Day ${option.day}`}
        <span className="muted" style={{ fontWeight: 400 }}>
          {' '}{option.timeLabel || `${option.startTime || ''}–${option.endTime || ''}`}
        </span>
      </span>
      <span className="slot-who">
        {option.facultyName ? <>{option.facultyName}</> : null}
        {option.roomName ? <> · <strong>{option.roomName}</strong></> : null}
        {option.acLabel ? <> <AcBadge isAc={option.roomIsAc} acLabel={option.acLabel} /></> : null}
        {option.periods > 1 ? <span className="muted"> · {option.periods} periods</span> : null}
        {Array.isArray(option.warnings) && option.warnings.length ? (
          <div className="tiny" style={{ color: 'var(--warn)' }}>
            {option.warnings.map((w) => (typeof w === 'string' ? w : w.message)).join(' · ')}
          </div>
        ) : null}
      </span>
      <span className="slot-score">
        {best ? <Badge tone="ok">Best</Badge> : null} <ScorePill score={option.score} />
      </span>
    </button>
  );
}
