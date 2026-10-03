import React, { useCallback, useEffect, useState } from 'react';
import api, { describeError } from '../lib/api.js';
import desktop from '../lib/desktop.js';
import { useToast } from './Toast.jsx';
import {
  Modal, Badge, Notice, Loading, ViolationList, RoomCard, SlotOption,
  ScorePill, AcBadge, AcRequirement, Field, Select, Tabs, Checkbox,
} from './ui.jsx';
import { formatDateTime, formatTime, humanise } from '../lib/format.js';

/* =========================================================================
   Section 8: everything you can do to one class.

   View, Edit, Move, Change Teacher, Change Room, Find Alternatives, Lock,
   Cancel, Duplicate -- all from the card itself, all revalidated the moment the
   coordinator picks something.

   Two rules from the specification shape this file:

     - Nothing is applied blindly. Every choice is checked first (POST .../check)
       and the score, the violations and the warnings are shown before the
       coordinator commits.
     - When a change breaks a hard rule the server refuses it, but says
       canOverride: true. The coordinator keeps final authority, so the refusal
       is shown with a "Do it anyway" button that re-sends the same change with
       force -- and the conflict is then recorded on the class.
   ========================================================================= */

const TABS = [
  { value: 'details', label: 'Details' },
  { value: 'move', label: 'Move' },
  { value: 'teacher', label: 'Change teacher' },
  { value: 'room', label: 'Change room' },
  { value: 'more', label: 'More' },
];

/** The refusal-with-an-override-offer panel. */
function OverridePrompt({ error, busy, onOverride, onDismiss }) {
  if (!error) return null;
  if (!error.canOverride) {
    return <Notice tone="bad" title="That change was not made">{describeError(error)}</Notice>;
  }
  return (
    <Notice
      tone="warn"
      title="This clashes with something"
      actions={(
        <>
          <button type="button" className="btn small" onClick={onDismiss} disabled={busy}>Cancel</button>
          <button type="button" className="btn small danger" onClick={onOverride} disabled={busy}>
            {busy ? <span className="spinner" /> : null} Do it anyway
          </button>
        </>
      )}
    >
      <div>{describeError(error)}</div>
      <div className="tiny mt">
        {error.overrideHint
          || 'You have the final say. If you continue, the clash is recorded on the class and in the activity log.'}
      </div>
    </Notice>
  );
}

export default function AssignmentModal({ assignmentId, onClose, onChanged, canEdit }) {
  const toast = useToast();
  const [tab, setTab] = useState('details');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [alts, setAlts] = useState(null);
  const [altsLoading, setAltsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);   // the change awaiting confirmation
  const [check, setCheck] = useState(null);
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await api.get(`/timetable/assignments/${assignmentId}`);
      setData(body);
      setNotes((body.assignment && body.assignment.notes) || '');
    } catch (err) {
      toast.fromError(err, 'This class could not be opened');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [assignmentId, onClose, toast]);

  useEffect(() => { load(); }, [load]);

  // Alternatives are fetched once, the first time a tab needs them.
  const loadAlternatives = useCallback(async () => {
    if (alts || altsLoading) return;
    setAltsLoading(true);
    try {
      setAlts(await api.get(`/timetable/assignments/${assignmentId}/alternatives`, { limit: 12 }));
    } catch (err) {
      toast.fromError(err, 'Alternatives could not be worked out');
    } finally {
      setAltsLoading(false);
    }
  }, [alts, altsLoading, assignmentId, toast]);

  useEffect(() => {
    if (['move', 'teacher', 'room'].includes(tab)) loadAlternatives();
  }, [tab, loadAlternatives]);

  /** Dry run, so the coordinator sees the effect before committing. */
  const runCheck = useCallback(async (proposal) => {
    setPending(proposal);
    setError(null);
    setCheck(null);
    try {
      setCheck(await api.post(`/timetable/assignments/${assignmentId}/check`, proposal));
    } catch (err) {
      setError(err);
    }
  }, [assignmentId]);

  /** Applies an action. Retries with force when the coordinator overrides. */
  const apply = useCallback(async (action, body, { force = false, successMessage } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post(
        `/timetable/assignments/${assignmentId}/${action}`,
        { ...body, ...(force ? { force: true } : {}) }
      );
      toast.success(successMessage || result.message || 'Saved.');
      setPending(null);
      setCheck(null);
      setAlts(null);
      if (onChanged) onChanged(result);
      // Duplicate returns a different class; the modal follows the original.
      if (action === 'duplicate') onClose();
      else await load();
      return result;
    } catch (err) {
      setError(err);
      if (!err.canOverride) toast.fromError(err);
      return null;
    } finally {
      setBusy(false);
    }
  }, [assignmentId, load, onChanged, onClose, toast]);

  const removeClass = useCallback(async () => {
    const { confirmed } = await desktop.confirm({
      title: 'Remove this class?',
      message: 'Remove this class from the timetable?',
      detail: 'The period becomes free again. This cannot be undone, though you can restore an '
        + 'earlier saved version of the whole timetable.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.del(`/timetable/assignments/${assignmentId}`);
      toast.success('The class was removed.');
      if (onChanged) onChanged({ action: 'delete' });
      onClose();
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy(false);
    }
  }, [assignmentId, onChanged, onClose, toast]);

  if (loading) {
    return <Modal title="Class" onClose={onClose} width="wide"><Loading /></Modal>;
  }
  if (!data) return null;

  const { card, assignment, validation, history } = data;
  const locked = !!(assignment && assignment.is_locked);
  const cancelled = assignment && assignment.status === 'CANCELLED';
  const readOnly = !canEdit;

  const title = `${card ? card.courseCode : ''} ${card ? card.courseName : 'Class'}`.trim();
  const subtitle = card
    ? [
      card.groupLabel,
      `${card.dayName}, ${formatTime(card.startTime)}–${formatTime(card.endTime)}`,
      card.periods > 1 ? `${card.periods} periods` : null,
    ].filter(Boolean).join(' · ')
    : '';

  // ---- panels -------------------------------------------------------------
  const detailsPanel = (
    <div className="stack">
      {cancelled ? (
        <Notice tone="warn" title="This class is cancelled">
          It stays on the timetable, struck through, until it is restored or removed.
        </Notice>
      ) : null}

      {validation ? (
        validation.ok
          ? <Notice tone="ok" title="No problems">This class breaks no rules where it is.</Notice>
          : <ViolationList violations={validation.violations} warnings={validation.warnings} />
      ) : null}
      {validation && validation.ok && validation.warnings && validation.warnings.length ? (
        <ViolationList warnings={validation.warnings} compact />
      ) : null}

      <dl className="kv">
        <dt>Course</dt>
        <dd>
          <strong>{card.courseCode}</strong> {card.courseName}
          {card.courseType ? <span className="muted"> · {humanise(card.courseType)}</span> : null}
          {card.component ? <span className="muted"> · {humanise(card.component)}</span> : null}
        </dd>

        <dt>Group</dt>
        <dd>
          {card.groupLabel || '—'}
          {card.isSplit ? <> <Badge tone="info">Sub-section</Badge></> : null}
          {card.studentCount ? <span className="muted"> · {card.studentCount} students</span> : null}
        </dd>

        <dt>When</dt>
        <dd>
          {card.dayName}, period {card.slotIndex}
          {card.periods > 1 ? `–${card.slotIndex + card.periods - 1}` : ''}
          {' '}<span className="muted">({formatTime(card.startTime)}–{formatTime(card.endTime)})</span>
        </dd>

        <dt>Teacher</dt>
        <dd>{card.facultyName || <span style={{ color: 'var(--bad)' }}>Not assigned</span>}</dd>

        <dt>Room</dt>
        <dd>
          {card.roomName ? (
            <>
              {card.roomName} <AcBadge isAc={card.roomIsAc} acLabel={card.acLabel} />
              {card.roomCapacity ? <span className="muted"> · seats {card.roomCapacity}</span> : null}
              {card.buildingName ? <span className="muted"> · {card.buildingName}</span> : null}
            </>
          ) : <span style={{ color: 'var(--bad)' }}>Not assigned</span>}
        </dd>

        <dt>Air conditioning</dt>
        <dd><AcRequirement value={card.acRequirement} /></dd>

        <dt>Quality</dt>
        <dd><ScorePill score={card.score} /> <span className="muted tiny">out of 100 for this placement</span></dd>

        <dt>State</dt>
        <dd>
          {locked ? <Badge tone="locked">🔒 Locked in place</Badge> : <Badge>Not locked</Badge>}{' '}
          {card.isManual ? <Badge tone="info">Placed by hand</Badge> : <Badge>Placed by the scheduler</Badge>}
        </dd>

        {assignment && assignment.notes ? (<><dt>Note</dt><dd>{assignment.notes}</dd></>) : null}
      </dl>

      {Array.isArray(history) && history.length ? (
        <div>
          <h3 className="mb">What has happened to this class</h3>
          <div className="table-wrap scroll-y">
            <table className="data compact">
              <thead><tr><th>When</th><th>Change</th><th>By</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="nowrap">{formatDateTime(h.created_at)}</td>
                    <td>{humanise(h.action)}{h.reason ? <span className="muted"> — {h.reason}</span> : null}</td>
                    <td>{h.actor_name || h.username || <span className="muted">system</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );

  const slotList = (bucket, label, help) => {
    if (!bucket) return null;
    const options = bucket.options || [];
    return (
      <div className="mb">
        <h3>{label}</h3>
        {help ? <p className="small soft">{help}</p> : null}
        {!options.length ? (
          <p className="small soft">
            No free slot was found this way{bucket.totalFeasible ? '' : ' — every period is either taken or blocked'}.
          </p>
        ) : options.map((opt, i) => (
          <SlotOption
            key={`${opt.day}-${opt.slotIndex}-${opt.facultyId}-${opt.roomId}-${i}`}
            option={opt}
            best={i === 0}
            chosen={pending && pending.day === opt.day && pending.slotIndex === opt.slotIndex
              && pending.roomId === opt.roomId && pending.facultyId === opt.facultyId}
            onChoose={readOnly ? undefined : () => runCheck({
              day: opt.day,
              slotIndex: opt.slotIndex,
              periods: opt.periods,
              facultyId: opt.facultyId,
              roomId: opt.roomId,
            })}
          />
        ))}
      </div>
    );
  };

  const movePanel = altsLoading || !alts ? <Loading label="Working out where else this could go…" /> : (
    <div className="stack">
      {locked ? (
        <Notice tone="info" title="This class is locked">
          You can still move it by hand. Locking only stops the scheduler from moving it.
        </Notice>
      ) : null}
      {slotList(alts.slotsKeepingBoth, 'Same teacher and same room, different time',
        'The simplest kind of move: only the time changes.')}
      {slotList(alts.slotsAnyResource, 'Any free combination',
        'The scheduler is free to pick a different teacher or room as well, if that opens up a better slot.')}
      {alts.slotsAnyResource && alts.slotsAnyResource.blocked && alts.slotsAnyResource.blocked.length ? (
        <details>
          <summary className="small soft">Why other periods were ruled out</summary>
          <ul className="small soft mt">
            {alts.slotsAnyResource.blocked.slice(0, 20).map((b, i) => (
              <li key={i}>
                {b.dayName || `Day ${b.day}`}, period {b.slotIndex}: {b.reason || b.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );

  const teacherPanel = altsLoading || !alts ? <Loading label="Checking who is free…" /> : (
    <div className="stack">
      <div>
        <h3>Free at this time</h3>
        {!(alts.faculty && alts.faculty.available && alts.faculty.available.length) ? (
          <p className="small soft">Nobody else who can teach this course is free in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="data compact">
              <thead>
                <tr>
                  <th>Teacher</th><th className="num">This week</th><th className="num">This day</th>
                  <th className="num">Fit</th><th />
                </tr>
              </thead>
              <tbody>
                {alts.faculty.available.map((f) => (
                  <tr key={f.facultyId}>
                    <td>
                      {f.name}
                      {f.isCurrent ? <> <Badge tone="info">Current</Badge></> : null}
                      {f.designation ? <div className="tiny muted">{f.designation}</div> : null}
                      {f.warnings && f.warnings.length ? (
                        <div className="tiny" style={{ color: 'var(--warn)' }}>
                          {f.warnings.map((w) => (typeof w === 'string' ? w : w.message)).join(' · ')}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{f.periodsThisWeek}{f.maxWeeklyHours ? ` / ${f.maxWeeklyHours}` : ''}</td>
                    <td className="num">{f.periodsThisDay}</td>
                    <td className="num"><ScorePill score={f.score} /></td>
                    <td className="actions">
                      <button
                        type="button"
                        className="btn small"
                        disabled={readOnly || f.isCurrent}
                        onClick={() => runCheck({ facultyId: f.facultyId })}
                      >
                        Choose
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {alts.faculty && alts.faculty.unavailable && alts.faculty.unavailable.length ? (
        <details>
          <summary className="small soft">
            {alts.faculty.unavailable.length} not available, and why
          </summary>
          <ul className="small soft mt">
            {alts.faculty.unavailable.map((f) => (
              <li key={f.facultyId}>
                <strong>{f.name}</strong> — {(f.reasons || []).map((r) => (typeof r === 'string' ? r : r.message)).join('; ')}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );

  const roomPanel = altsLoading || !alts ? <Loading label="Comparing rooms…" /> : (
    <div className="stack">
      {alts.rooms && alts.rooms.requirement ? (
        <Notice tone="info" title="What this class needs">
          <div className="row tiny">
            {alts.rooms.requirement.strength != null ? <span>Seats for {alts.rooms.requirement.strength}</span> : null}
            {alts.rooms.requirement.acRequirement ? <AcRequirement value={alts.rooms.requirement.acRequirement} /> : null}
            {alts.rooms.requirement.roomType ? <span>· {humanise(alts.rooms.requirement.roomType)}</span> : null}
            {Array.isArray(alts.rooms.requirement.facilities) && alts.rooms.requirement.facilities.length
              ? <span>· {alts.rooms.requirement.facilities.map(humanise).join(', ')}</span> : null}
          </div>
        </Notice>
      ) : null}

      <div>
        <h3 className="mb">Free at this time</h3>
        {!(alts.rooms && alts.rooms.available && alts.rooms.available.length) ? (
          <p className="small soft">No other suitable room is free in this period.</p>
        ) : (
          <div className="grid cols-2">
            {alts.rooms.available.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                chosen={pending && pending.roomId === room.id}
                readOnly={readOnly}
                onChoose={readOnly ? undefined : () => runCheck({ roomId: room.id })}
              />
            ))}
          </div>
        )}
      </div>

      {alts.rooms && alts.rooms.unavailable && alts.rooms.unavailable.length ? (
        <details>
          <summary className="small soft">{alts.rooms.unavailable.length} ruled out, and why</summary>
          <div className="grid cols-2 mt">
            {alts.rooms.unavailable.map((room) => (
              <RoomCard key={room.id} room={room} readOnly />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );

  const morePanel = (
    <div className="stack">
      <div className="card">
        <h3 className="mb">Lock</h3>
        <p className="small soft">
          A locked class is never moved when the timetable is generated again. Use it for anything
          fixed — a visiting lecturer&apos;s slot, a shared lab, a class the department has already announced.
        </p>
        <button
          type="button"
          className="btn"
          disabled={readOnly || busy}
          onClick={() => apply('lock', { locked: !locked })}
        >
          {locked ? '🔓 Unlock this class' : '🔒 Lock this class in place'}
        </button>
      </div>

      <div className="card">
        <h3 className="mb">Duplicate</h3>
        <p className="small soft">
          Copies this class to another period — useful for a course that meets twice with the same
          teacher and room. The copy is checked like any other placement.
        </p>
        <DuplicateForm
          card={card}
          disabled={readOnly || busy}
          onSubmit={(body) => apply('duplicate', body, { successMessage: 'The class was duplicated.' })}
        />
      </div>

      <div className="card">
        <h3 className="mb">Note</h3>
        <Field hint="Visible to anyone who can see this class. Nothing is scheduled around it.">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={readOnly}
            placeholder="e.g. Shared with the M.Tech group; do not move without asking Dr Rao."
          />
        </Field>
        <button
          type="button"
          className="btn"
          disabled={readOnly || busy || notes === ((assignment && assignment.notes) || '')}
          onClick={() => apply('edit', { notes }, { successMessage: 'The note was saved.' })}
        >
          Save note
        </button>
      </div>

      <div className="card">
        <h3 className="mb">Cancel or remove</h3>
        <p className="small soft">
          Cancelling keeps the class on the timetable, struck through, so everyone can see it is off.
          Removing frees the period completely.
        </p>
        <div className="btn-row">
          {cancelled ? (
            <button type="button" className="btn" disabled={readOnly || busy} onClick={() => apply('restore', {})}>
              Restore this class
            </button>
          ) : (
            <CancelForm disabled={readOnly || busy} onSubmit={(reason) => apply('cancel', { reason })} />
          )}
          <span className="spacer" />
          <button type="button" className="btn danger" disabled={readOnly || busy} onClick={removeClass}>
            Remove from timetable
          </button>
        </div>
      </div>
    </div>
  );

  const panels = { details: detailsPanel, move: movePanel, teacher: teacherPanel, room: roomPanel, more: morePanel };

  // The action a pending proposal maps to, so the server records the right one.
  const pendingAction = !pending ? null
    : (pending.day != null || pending.slotIndex != null) ? 'move'
      : pending.facultyId != null ? 'change-teacher'
        : pending.roomId != null ? 'change-room' : 'edit';

  return (
    <Modal
      title={title || 'Class'}
      subtitle={subtitle}
      onClose={onClose}
      width="xwide"
      footer={(
        <>
          {readOnly ? <span className="small soft">You are viewing this timetable. Only the coordinator can change it.</span> : null}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </>
      )}
    >
      <Tabs tabs={TABS} active={tab} onChange={(v) => { setTab(v); setPending(null); setCheck(null); setError(null); }} />

      {/* The confirmation strip: what would change, and whether it is allowed. */}
      {pending ? (
        <div className="mb">
          <Notice
            tone={check && check.ok ? 'ok' : check ? 'warn' : 'info'}
            title="Ready to apply"
            actions={(
              <>
                <button type="button" className="btn small" onClick={() => { setPending(null); setCheck(null); setError(null); }}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn small primary"
                  disabled={busy}
                  onClick={() => apply(pendingAction, pending)}
                >
                  {busy ? <span className="spinner" /> : null} Apply
                </button>
              </>
            )}
          >
            <div className="row tiny">
              {pending.day != null ? <span>Move to {check && check.slot ? `${check.slot.dayName}, ${check.slot.timeLabel}` : `day ${pending.day}, period ${pending.slotIndex}`}</span> : null}
              {pending.facultyId != null && pending.day == null ? <span>New teacher</span> : null}
              {pending.roomId != null && pending.day == null ? <span>New room</span> : null}
              {check ? <ScorePill score={check.score} /> : <span className="spinner" />}
              {check && check.parallelWithSiblings ? <Badge tone="info">Runs in parallel with the other sub-section</Badge> : null}
            </div>
            {check ? <ViolationList violations={check.violations} warnings={check.warnings} compact /> : null}
          </Notice>
        </div>
      ) : null}

      {error ? (
        <div className="mb">
          <OverridePrompt
            error={error}
            busy={busy}
            onDismiss={() => setError(null)}
            onOverride={() => apply(pendingAction || 'move', pending || {}, {
              force: true,
              successMessage: 'Applied. The clash has been recorded on the class.',
            })}
          />
        </div>
      ) : null}

      {panels[tab]}
    </Modal>
  );
}

/** Day + period + optional new teacher/room for a duplicate. */
function DuplicateForm({ card, disabled, onSubmit }) {
  const [day, setDay] = useState('');
  const [slotIndex, setSlotIndex] = useState('');
  return (
    <>
      <div className="field-grid tight">
        <Field label="Day">
          <Select
            value={day}
            placeholder="Same day"
            options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: d, label: ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][d] }))}
            onChange={(e) => setDay(e.target.value)}
            disabled={disabled}
          />
        </Field>
        <Field label="Starting period">
          <input
            type="number"
            min="1"
            value={slotIndex}
            placeholder={String(card.slotIndex)}
            onChange={(e) => setSlotIndex(e.target.value)}
            disabled={disabled}
          />
        </Field>
      </div>
      <button
        type="button"
        className="btn"
        disabled={disabled || (!day && !slotIndex)}
        onClick={() => onSubmit({
          day: day ? Number(day) : undefined,
          slotIndex: slotIndex ? Number(slotIndex) : undefined,
        })}
      >
        Duplicate to that period
      </button>
    </>
  );
}

function CancelForm({ disabled, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button type="button" className="btn" disabled={disabled} onClick={() => setOpen(true)}>
        Cancel this class
      </button>
    );
  }
  return (
    <div style={{ flex: '1 1 260px' }}>
      <Field label="Why is it cancelled?" hint="Shown on the class so students and faculty know.">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Faculty on leave, 14 September"
        />
      </Field>
      <div className="btn-row">
        <button type="button" className="btn primary" disabled={disabled} onClick={() => onSubmit(reason)}>
          Cancel the class
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Never mind</button>
      </div>
    </div>
  );
}
