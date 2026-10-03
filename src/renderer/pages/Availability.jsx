import React, { useCallback, useEffect, useState } from 'react';
import api, { describeError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Badge, Card, ConfirmModal, Field, Loading, Modal, Notice, PageHead, Select, TextInput,
} from '../components/ui.jsx';
import { DAY_NAMES, formatTime, humanise } from '../lib/format.js';

/**
 * A teacher's own availability.
 *
 * The three kinds mean different things to the scheduler and the wording here
 * says so, because a teacher who marks a window "available" expecting a hint
 * would be surprised to find every other hour blocked:
 *
 *   UNAVAILABLE  a hard block -- never scheduled, no exceptions without an override
 *   AVAILABLE    a whitelist -- once one exists for a day, only those hours are usable
 *   PREFERRED    a soft bonus -- scheduling here scores better, nothing is refused
 *
 * The server allows this screen to touch only the signed-in teacher's own rows,
 * and only while the administrator has left that permission on.
 */

const KINDS = ['UNAVAILABLE', 'PREFERRED', 'AVAILABLE'];

const KIND_HELP = {
  UNAVAILABLE: 'Never schedule me in this window.',
  AVAILABLE: 'Only these hours on this day. Adding one restricts the rest of that day.',
  PREFERRED: 'I would rather teach here. A preference only — nothing is refused.',
};

const KIND_TONE = { UNAVAILABLE: 'bad', AVAILABLE: 'info', PREFERRED: 'ok' };

export default function Availability() {
  const auth = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/entities/faculty_availability', { limit: 500 })
      .then((body) => { setRows(body.rows || []); setError(null); })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const remove = async () => {
    try {
      await api.del(`/entities/faculty_availability/${deleting.id}`);
      toast.success('Removed.');
      setDeleting(null);
      load();
    } catch (err) {
      toast.fromError(err);
      setDeleting(null);
    }
  };

  const byDay = Object.entries(DAY_NAMES).map(([num, name]) => ({
    day: Number(num),
    name,
    entries: rows.filter((r) => Number(r.day_of_week) === Number(num))
      .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time))),
  }));

  return (
    <main className="page">
      <PageHead
        title="My Availability"
        subtitle="What you tell the scheduler about your week. Your Timetable Coordinator sees the same thing."
        actions={(
          <button type="button" className="btn primary small" onClick={() => setEditing({ row: null })}>
            Add a window
          </button>
        )}
      />

      {error ? <Notice tone="bad" title="Could not load your availability">{error}</Notice> : null}

      <Notice tone="info" title="What the three kinds do">
        <ul>
          <li><strong>Unavailable</strong> — a hard block. Nothing is placed there.</li>
          <li>
            <strong>Available</strong> — a whitelist. As soon as you add one for a day, only the hours you listed
            for that day can be used, so add every window you can teach.
          </li>
          <li><strong>Preferred</strong> — a nudge. Scheduling here scores better; nothing is refused.</li>
        </ul>
      </Notice>

      {loading ? <Loading /> : (
        <div className="grid cols-2">
          {byDay.map((day) => (
            <Card key={day.day} title={day.name} subtitle={day.entries.length ? null : 'Nothing set — treated as fully available.'}>
              {day.entries.length === 0 ? (
                <button type="button" className="btn small" onClick={() => setEditing({ row: { day_of_week: day.day } })}>
                  Add a window on {day.name}
                </button>
              ) : (
                <div className="stack tight">
                  {day.entries.map((entry) => (
                    <div key={entry.id} className="avail-row">
                      <Badge tone={KIND_TONE[entry.kind] || 'plain'}>{humanise(entry.kind)}</Badge>
                      <span className="avail-when">
                        {formatTime(entry.start_time)} – {formatTime(entry.end_time)}
                      </span>
                      {entry.note ? <span className="muted tiny">{entry.note}</span> : null}
                      <span className="spacer" />
                      <button type="button" className="btn tiny" onClick={() => setEditing({ row: entry })}>Edit</button>
                      <button type="button" className="btn tiny danger" onClick={() => setDeleting(entry)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <AvailabilityForm
          row={editing.row}
          facultyId={auth.scope ? auth.scope.facultyId : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); toast.success('Saved.'); load(); }}
        />
      ) : null}

      {deleting ? (
        <ConfirmModal
          title="Remove this window?"
          message={`${DAY_NAMES[deleting.day_of_week]}, ${formatTime(deleting.start_time)}–${formatTime(deleting.end_time)}`}
          detail="Classes already scheduled are not moved — tell your coordinator if something now clashes."
          confirmLabel="Remove"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </main>
  );
}

function AvailabilityForm({ row, facultyId, onClose, onSaved }) {
  const [values, setValues] = useState({
    day_of_week: row && row.day_of_week ? Number(row.day_of_week) : 1,
    start_time: row && row.start_time ? String(row.start_time).slice(0, 5) : '09:00',
    end_time: row && row.end_time ? String(row.end_time).slice(0, 5) : '11:00',
    kind: (row && row.kind) || 'UNAVAILABLE',
    note: (row && row.note) || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // faculty_id is sent for completeness; the server ignores any other value
      // and pins the row to the signed-in teacher.
      const payload = { ...values, faculty_id: (row && row.faculty_id) || facultyId };
      if (row && row.id) await api.put(`/entities/faculty_availability/${row.id}`, payload);
      else await api.post('/entities/faculty_availability', payload);
      onSaved();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={row && row.id ? 'Edit this window' : 'Add an availability window'}
      onClose={onClose}
      footer={(
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="avail-form" className="btn primary" disabled={busy}>
            {busy ? <span className="spinner" /> : null} Save
          </button>
        </>
      )}
    >
      <form id="avail-form" onSubmit={submit}>
        {error ? <div className="mb"><Notice tone="bad">{error}</Notice></div> : null}

        <Field label="Kind" required hint={KIND_HELP[values.kind]}>
          <Select
            value={values.kind}
            options={KINDS.map((k) => ({ value: k, label: humanise(k) }))}
            onChange={(e) => set('kind', e.target.value)}
          />
        </Field>

        <Field label="Day" required>
          <Select
            value={values.day_of_week}
            options={Object.entries(DAY_NAMES).map(([num, name]) => ({ value: Number(num), label: name }))}
            onChange={(e) => set('day_of_week', Number(e.target.value))}
          />
        </Field>

        <div className="field-grid">
          <Field label="From" required>
            <input type="time" value={values.start_time} onChange={(e) => set('start_time', e.target.value)} />
          </Field>
          <Field label="To" required>
            <input type="time" value={values.end_time} onChange={(e) => set('end_time', e.target.value)} />
          </Field>
        </div>

        <Field label="Note" hint="Optional — your coordinator can read this.">
          <TextInput value={values.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
