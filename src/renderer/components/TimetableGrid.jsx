import React from 'react';
import { AcBadge, Badge, ScorePill } from './ui.jsx';
import { formatTime, truncate } from '../lib/format.js';

/* =========================================================================
   The week grid (Section 7).

   One component draws every view -- section, sub-section, faculty, room, course,
   semester, programme, department, whole college -- because the server returns the
   same shape for all of them:

     grid  { workingDays, slots, rows, dayNames, slotMinutes }
     cells { "day:slotIndex": [ card, ... ] }

   Days run down the side, periods across the top, which is how a timetable is
   read on paper.

   Two details the server has already worked out and this component must respect:

     - a class occupying several periods appears in `cells` once per period, with
       `continuation: true` on all but the first. Only the first is drawn, with a
       colSpan; the rest are skipped, or the row would grow extra columns.
     - two sub-sections legitimately sharing one period (Section 3) both appear in
       the same cell as leading entries. They are placed side by side rather than
       treated as a clash.
   ========================================================================= */

/** One scheduled class. */
export function TimetableCard({ card, onClick, selected, compact, showGroup = true }) {
  const warnings = Array.isArray(card.warnings) ? card.warnings : [];
  const hasConflict = warnings.some((w) => (typeof w === 'object' && (w.severity === 'HARD' || w.hard)));
  const cancelled = card.status === 'CANCELLED';

  const classes = [
    'tt-card',
    onClick ? '' : 'readonly',
    card.isLocked ? 'locked' : '',
    hasConflict ? 'has-conflict' : (warnings.length ? 'has-warning' : ''),
    cancelled ? 'cancelled' : '',
    selected ? 'selected' : '',
    card.isSplit ? 'parallel' : '',
  ].filter(Boolean).join(' ');

  const Tag = onClick ? 'button' : 'div';
  const title = [
    `${card.courseCode || ''} ${card.courseName || ''}`.trim(),
    card.groupLabel,
    card.facultyName,
    card.roomName ? `${card.roomName} (${card.acLabel || 'no room'})` : 'No room',
    card.timeLabel,
    card.isLocked ? 'Locked — re-generation will leave this where it is' : '',
    warnings.map((w) => (typeof w === 'string' ? w : w.message)).join(' · '),
  ].filter(Boolean).join('\n');

  return (
    <Tag type={onClick ? 'button' : undefined} className={classes} onClick={onClick} title={title}>
      <span className="tt-code">
        {card.courseCode || card.courseName || 'Class'}
        {card.component && card.component !== 'LECTURE' ? (
          <span className="muted" style={{ fontWeight: 500 }}> · {card.component === 'LAB' ? 'Lab' : card.component === 'TUTORIAL' ? 'Tut' : card.component}</span>
        ) : null}
      </span>

      {!compact && card.courseName ? (
        <span className="tt-name">{truncate(card.courseName, 46)}</span>
      ) : null}

      {showGroup && card.isSplit ? (
        <span className="tt-sub">{card.subSectionName ? `Group ${card.subSectionName}` : 'Sub-section'}</span>
      ) : null}

      {card.facultyName ? <span className="tt-line">{truncate(card.facultyName, 30)}</span> : (
        <span className="tt-line" style={{ color: 'var(--bad)' }}>No teacher</span>
      )}

      <span className="tt-line">
        {card.roomName ? <span className="tt-room">{card.roomName}</span> : <span style={{ color: 'var(--bad)' }}>No room</span>}
        {card.roomId ? <AcBadge isAc={card.roomIsAc} acLabel={card.acLabel} /> : null}
      </span>

      <span className="tt-flags">
        {card.isLocked ? <Badge tone="locked" title="Locked in place">🔒 Locked</Badge> : null}
        {card.isManual ? <Badge tone="info" title="Placed by hand">Manual</Badge> : null}
        {cancelled ? <Badge tone="bad">Cancelled</Badge> : null}
        {warnings.length ? (
          <Badge tone={hasConflict ? 'bad' : 'warn'} title={warnings.map((w) => (typeof w === 'string' ? w : w.message)).join('\n')}>
            {hasConflict ? '✕' : '!'} {warnings.length}
          </Badge>
        ) : null}
      </span>
    </Tag>
  );
}

/**
 * @param {object} props
 *   grid        the server's grid object
 *   cells       the server's cells map
 *   onCardClick (card) => void; omit for a read-only view (Faculty, Student)
 *   selectedId  highlights one assignment
 *   onEmptyClick (day, slotIndex) => void; used by the manual builder
 */
export default function TimetableGrid({
  grid,
  cells = {},
  onCardClick,
  onEmptyClick,
  selectedId,
  compact,
  showGroup = true,
  legend = true,
  emptyLabel = '',
}) {
  if (!grid || !Array.isArray(grid.slots) || !grid.slots.length) {
    return (
      <div className="empty">
        <span className="empty-icon">◻</span>
        <div className="empty-title">There is no period grid yet</div>
        <div className="empty-text">
          Set the college&apos;s working days and period times in Timing Configuration, and the
          week will appear here.
        </div>
      </div>
    );
  }

  // `rows` interleaves periods and breaks in display order. A class block never
  // crosses a break (the timing service guarantees contiguity), so a colSpan
  // never has to jump over a break column.
  const columns = Array.isArray(grid.rows) && grid.rows.length
    ? grid.rows
    : grid.slots.map((s) => ({ kind: 'PERIOD', index: s.index, start: s.start, end: s.end }));

  const dayName = (day) => (grid.dayNames && grid.dayNames[day]) || `Day ${day}`;

  return (
    <>
      <div className="tt-wrap">
        <table className={`tt${compact ? ' dense' : ''}`}>
          <thead>
            <tr>
              <th className="tt-day" scope="col">Day</th>
              {columns.map((col, i) => (
                <th key={col.kind === 'PERIOD' ? `p${col.index}` : `b${i}`} scope="col">
                  {col.kind === 'PERIOD' ? (
                    <>
                      Period {col.index}
                      <span className="slot-time">{formatTime(col.start)}–{formatTime(col.end)}</span>
                    </>
                  ) : (
                    <>
                      {col.name || 'Break'}
                      <span className="slot-time">{formatTime(col.start)}–{formatTime(col.end)}</span>
                    </>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(grid.workingDays || []).map((day) => {
              let skip = 0;   // columns already covered by a multi-period block
              return (
                <tr key={day}>
                  <th className="tt-day" scope="row">{dayName(day)}</th>
                  {columns.map((col, i) => {
                    if (col.kind === 'BREAK') {
                      return (
                        <td key={`b${i}`} className="tt-break">
                          <div className="break-label">{col.name || 'Break'}</div>
                        </td>
                      );
                    }
                    if (skip > 0) {
                      skip -= 1;
                      return null;   // covered by the colSpan of an earlier cell
                    }

                    const entries = cells[`${day}:${col.index}`] || [];
                    const leading = entries.filter((e) => !e.continuation);

                    if (!leading.length) {
                      return (
                        <td
                          key={`p${col.index}`}
                          className="tt-cell empty"
                          onClick={onEmptyClick ? () => onEmptyClick(day, col.index) : undefined}
                          style={onEmptyClick ? { cursor: 'pointer' } : undefined}
                          title={onEmptyClick ? `Place a class here — ${dayName(day)}, period ${col.index}` : undefined}
                        >
                          {emptyLabel ? <div className="break-label">{emptyLabel}</div> : null}
                        </td>
                      );
                    }

                    const span = leading.reduce((n, c) => Math.max(n, Number(c.periods) || 1), 1);
                    skip = span - 1;

                    // Two sub-sections sharing one period sit side by side; anything
                    // else that lands together is stacked so nothing is hidden.
                    const sideBySide = leading.length > 1 && leading.every((c) => c.subSectionId);

                    return (
                      <td key={`p${col.index}`} className="tt-cell" colSpan={span}>
                        <div className={`tt-stack${sideBySide ? ' split' : ''}`}>
                          {leading.map((card) => (
                            <TimetableCard
                              key={card.id}
                              card={card}
                              compact={compact || leading.length > 1}
                              showGroup={showGroup}
                              selected={selectedId != null && Number(selectedId) === Number(card.id)}
                              onClick={onCardClick ? () => onCardClick(card) : undefined}
                            />
                          ))}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {legend ? (
        <div className="tt-legend">
          <span className="key"><span className="swatch normal" /> Scheduled</span>
          <span className="key"><span className="swatch locked" /> Locked in place</span>
          <span className="key"><span className="swatch warn" /> Has a soft warning</span>
          <span className="key"><span className="swatch conflict" /> Has a hard conflict</span>
          <span className="key"><AcBadge isAc /> air-conditioned room</span>
          <span className="key"><AcBadge isAc={false} /> not air-conditioned</span>
          {onCardClick ? <span className="key muted">Click a class to edit, move or replace it</span> : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * A flat list of the same cards, ordered by day and period. Used where a grid is
 * the wrong shape -- a teacher's day at a glance, or a student's "today".
 */
export function TimetableList({ cards = [], onCardClick, emptyText = 'Nothing scheduled.' }) {
  if (!cards.length) return <p className="soft small">{emptyText}</p>;
  const sorted = [...cards].sort((a, b) => (a.day - b.day) || (a.slotIndex - b.slotIndex));
  return (
    <div className="table-wrap">
      <table className="data compact">
        <thead>
          <tr>
            <th>Day</th>
            <th>Time</th>
            <th>Course</th>
            <th>Group</th>
            <th>Teacher</th>
            <th>Room</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((card) => (
            <tr
              key={card.id}
              onClick={onCardClick ? () => onCardClick(card) : undefined}
              style={onCardClick ? { cursor: 'pointer' } : undefined}
            >
              <td className="nowrap">{card.dayName}</td>
              <td className="nowrap">{card.timeLabel ? `${formatTime(card.startTime)}–${formatTime(card.endTime)}` : `Period ${card.slotIndex}`}</td>
              <td>
                <strong>{card.courseCode}</strong> {card.courseName}
                {card.component && card.component !== 'LECTURE' ? <span className="muted"> · {card.component}</span> : null}
              </td>
              <td>{card.groupLabel || '—'}</td>
              <td>{card.facultyName || <span className="muted">—</span>}</td>
              <td className="nowrap">
                {card.roomName || <span className="muted">—</span>}{' '}
                {card.roomId ? <AcBadge isAc={card.roomIsAc} acLabel={card.acLabel} /> : null}
              </td>
              <td className="nowrap">
                {card.isLocked ? <Badge tone="locked">🔒</Badge> : null}{' '}
                {card.score != null ? <ScorePill score={card.score} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
