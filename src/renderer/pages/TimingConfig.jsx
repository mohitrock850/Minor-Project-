import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { describeError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Card, EmptyState, Field, Loading, Notice, PageHead, Select, TextInput,
} from '../components/ui.jsx';
import { DAY_NAMES, formatMinutes, formatTime, humanise } from '../lib/format.js';

/**
 * College Timing Configuration (Section 1.15 / Section 4).
 *
 * This is the one screen that makes Section 4 true: no working day, period
 * length, start time or break is assumed anywhere in the application, and every
 * timetable grid in it is derived from whatever is saved here. Because the parts
 * only make sense together -- moving lunch changes how many periods fit -- the
 * whole configuration is edited and saved as one object, and the real derived
 * grid is previewed live from the server rather than guessed at in the browser.
 */

const DAY_LIST = [1, 2, 3, 4, 5, 6, 7];
const BREAK_KINDS = ['LUNCH', 'SHORT'];

const EMPTY = {
  name: 'Default Timing',
  workingDays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '16:00',
  slotMinutes: 60,
  periodsPerDay: 6,
  breaks: [{ kind: 'LUNCH', name: 'Lunch', startTime: '13:00', endTime: '13:45' }],
};

function fromServer(body) {
  if (!body.configured || !body.timing) return { ...EMPTY };
  const t = body.timing;
  return {
    name: t.name || 'Default Timing',
    workingDays: String(t.working_days || '').split(',').map((s) => Number(s.trim())).filter(Boolean),
    startTime: (t.start_time || '').slice(0, 5),
    endTime: (t.end_time || '').slice(0, 5),
    slotMinutes: Number(t.slot_minutes) || 60,
    periodsPerDay: Number(t.periods_per_day) || 6,
    breaks: (body.breaks || []).map((b) => ({
      kind: b.kind || 'LUNCH',
      name: b.name || '',
      startTime: (b.start_time || '').slice(0, 5),
      endTime: (b.end_time || '').slice(0, 5),
    })),
  };
}

export default function TimingConfig() {
  const auth = useAuth();
  const toast = useToast();
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState([]);
  const timer = useRef(null);

  const readOnly = !auth.permissions.canManageData;

  const load = useCallback(() => {
    setLoading(true);
    api.get('/config/timing')
      .then((body) => { setSaved(body); setForm(fromServer(body)); setError(null); })
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load, auth.activeCollegeId]);

  // The preview is the server's own grid builder, debounced. Working it out in
  // the browser would mean two implementations of the same arithmetic, and the
  // one that matters is the one the scheduler uses.
  useEffect(() => {
    if (!form || readOnly) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.post('/config/timing/preview', form)
        .then((body) => { setPreview(body); setPreviewError(null); })
        .catch((err) => { setPreview(null); setPreviewError(describeError(err)); });
    }, 350);
    return () => clearTimeout(timer.current);
  }, [form, readOnly]);

  if (loading || !form) return <main className="page"><Loading label="Reading this college's timings…" /></main>;

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const setBreak = (index, key, value) => setForm((prev) => ({
    ...prev,
    breaks: prev.breaks.map((b, i) => (i === index ? { ...b, [key]: value } : b)),
  }));

  const addBreak = () => setForm((prev) => ({
    ...prev,
    breaks: [...prev.breaks, { kind: 'SHORT', name: '', startTime: '11:00', endTime: '11:15' }],
  }));

  const removeBreak = (index) => setForm((prev) => ({
    ...prev,
    breaks: prev.breaks.filter((_, i) => i !== index),
  }));

  const toggleDay = (day) => setForm((prev) => ({
    ...prev,
    workingDays: prev.workingDays.includes(day)
      ? prev.workingDays.filter((d) => d !== day)
      : [...prev.workingDays, day].sort((a, b) => a - b),
  }));

  const save = async () => {
    setBusy(true);
    setError(null);
    setDetails([]);
    try {
      const body = await api.put('/config/timing', form);
      setSaved(body);
      setForm(fromServer(body));
      toast.success('Timing configuration saved. Every timetable grid now follows it.');
      if (body.staleWarning) toast.warn(body.staleWarning);
    } catch (err) {
      setError(describeError(err));
      setDetails(Array.isArray(err.details) ? err.details : []);
    } finally {
      setBusy(false);
    }
  };

  const shown = preview || (saved && saved.grid ? { grid: saved.grid, rows: saved.rows, warnings: saved.warnings } : null);
  const capacity = shown && shown.grid
    ? shown.grid.workingDays.length * shown.grid.slots.length
    : 0;

  return (
    <main className="page">
      <PageHead
        title="Timing Configuration"
        breadcrumbs={[{ label: 'Data Management', to: '#/data' }, { label: 'Timing Configuration' }]}
        subtitle={auth.activeCollege
          ? `${auth.activeCollege.name} — this college's own working week. No other college is affected.`
          : 'This college\'s own working week.'}
        actions={readOnly ? null : (
          <button type="button" className="btn primary" onClick={save} disabled={busy || !!previewError}>
            {busy ? <span className="spinner" /> : null} Save configuration
          </button>
        )}
      />

      {!saved || !saved.configured ? (
        <Notice tone="warn" title="This college has no timing configuration yet">
          Nothing about the timetable is assumed until you set this: the working days, the day window, how long
          a period lasts and where the breaks fall. The values below are a starting suggestion, not a default —
          change them to match your college and save.
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="bad" title="This could not be saved">
          {error}
          {details.length ? <ul>{details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
        </Notice>
      ) : null}

      <div className="grid cols-2">
        <Card title="The working week">
          <Field label="Configuration name" htmlFor="tname">
            <TextInput id="tname" value={form.name} disabled={readOnly} onChange={(e) => set('name', e.target.value)} />
          </Field>

          <Field label="Working days" required hint="Six-day weeks and Sunday working are both fine — nothing here is fixed.">
            <div className="chip-set">
              {DAY_LIST.map((day) => (
                <button
                  key={day}
                  type="button"
                  className={`chip-toggle${form.workingDays.includes(day) ? ' on' : ''}`}
                  onClick={() => toggleDay(day)}
                  disabled={readOnly}
                  aria-pressed={form.workingDays.includes(day)}
                >
                  {DAY_NAMES[day]}
                </button>
              ))}
            </div>
          </Field>

          <div className="field-grid">
            <Field label="College start time" htmlFor="tstart" required>
              <input id="tstart" type="time" value={form.startTime} disabled={readOnly} onChange={(e) => set('startTime', e.target.value)} />
            </Field>
            <Field label="College end time" htmlFor="tend" required>
              <input id="tend" type="time" value={form.endTime} disabled={readOnly} onChange={(e) => set('endTime', e.target.value)} />
            </Field>
            <Field label="Period duration (minutes)" htmlFor="tslot" required>
              <input
                id="tslot"
                type="number"
                min={5}
                max={240}
                value={form.slotMinutes}
                disabled={readOnly}
                onChange={(e) => set('slotMinutes', Number(e.target.value))}
              />
            </Field>
            <Field
              label="Periods per day"
              htmlFor="tperiods"
              required
              hint="If fewer fit between the breaks, you will be told rather than silently given fewer."
            >
              <input
                id="tperiods"
                type="number"
                min={1}
                max={20}
                value={form.periodsPerDay}
                disabled={readOnly}
                onChange={(e) => set('periodsPerDay', Number(e.target.value))}
              />
            </Field>
          </div>
        </Card>

        <Card
          title="Breaks"
          subtitle="Lunch and short breaks. A class is never scheduled across one."
          actions={readOnly ? null : <button type="button" className="btn small" onClick={addBreak}>Add a break</button>}
        >
          {form.breaks.length === 0 ? (
            <EmptyState icon="◷" title="No breaks">
              A college day with no break at all is allowed. Add one if yours has a lunch or tea break.
            </EmptyState>
          ) : (
            <div className="stack">
              {form.breaks.map((b, i) => (
                <div key={i} className="row-editor">
                  <Field label="Kind">
                    <Select
                      value={b.kind}
                      options={BREAK_KINDS.map((k) => ({ value: k, label: humanise(k) }))}
                      disabled={readOnly}
                      onChange={(e) => setBreak(i, 'kind', e.target.value)}
                    />
                  </Field>
                  <Field label="Name">
                    <TextInput
                      value={b.name}
                      placeholder={b.kind === 'LUNCH' ? 'Lunch' : 'Short break'}
                      disabled={readOnly}
                      onChange={(e) => setBreak(i, 'name', e.target.value)}
                    />
                  </Field>
                  <Field label="From">
                    <input type="time" value={b.startTime} disabled={readOnly} onChange={(e) => setBreak(i, 'startTime', e.target.value)} />
                  </Field>
                  <Field label="To">
                    <input type="time" value={b.endTime} disabled={readOnly} onChange={(e) => setBreak(i, 'endTime', e.target.value)} />
                  </Field>
                  {readOnly ? null : (
                    <button type="button" className="btn tiny danger" onClick={() => removeBreak(i)} aria-label="Remove this break">Remove</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="The day this produces"
        subtitle="Worked out by the scheduler itself, not by this screen — so what you see is exactly what will be scheduled."
      >
        {previewError ? (
          <Notice tone="bad" title="This configuration cannot be used yet">{previewError}</Notice>
        ) : !shown || !shown.grid ? (
          <Loading label="Working out the periods…" />
        ) : (
          <>
            <div className="fact-row mb">
              <span><strong>{shown.grid.slots.length}</strong> periods a day</span>
              <span><strong>{shown.grid.workingDays.length}</strong> working days</span>
              <span><strong>{capacity}</strong> periods a week per section</span>
              <span>Each period <strong>{formatMinutes(shown.grid.slotMinutes)}</strong></span>
            </div>

            {(shown.warnings || []).length ? (
              <div className="mb">
                <Notice tone="warn" title="Worth knowing">
                  <ul>
                    {shown.warnings.map((w, i) => <li key={i}>{typeof w === 'string' ? w : w.message}</li>)}
                  </ul>
                </Notice>
              </div>
            ) : null}

            <div className="tt-wrap">
              <table className="tt preview">
                <thead>
                  <tr>
                    {(shown.rows || []).map((row, i) => (
                      <th key={i} className={row.kind === 'BREAK' ? 'is-break' : undefined}>
                        {row.kind === 'PERIOD' ? `Period ${row.index}` : (row.name || humanise(row.breakKind || 'Break'))}
                        <span className="slot-time">{formatTime(row.start)}–{formatTime(row.end)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {(shown.rows || []).map((row, i) => (
                      <td key={i} className={row.kind === 'BREAK' ? 'tt-break' : undefined}>
                        {row.kind === 'BREAK' ? <span className="tiny">no classes</span> : <span className="tiny muted">available</span>}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="card-note mt">
              These are the columns every timetable, view and export will use for {auth.activeCollege ? auth.activeCollege.name : 'this college'}.
              Another college with different timings is unaffected.
            </p>
          </>
        )}
      </Card>

      {saved && saved.staleWarning ? (
        <Notice tone="warn" title="Some existing classes no longer fit">{saved.staleWarning}</Notice>
      ) : null}

      <Card title="Next">
        <p className="muted">
          With the week defined, the scheduler knows when it may place a class.{' '}
          <Link to="/rules">Scheduling rules</Link> decide how it behaves inside that week, and{' '}
          <Link to="/generate">Generate</Link> puts it to work.
        </p>
      </Card>
    </main>
  );
}
