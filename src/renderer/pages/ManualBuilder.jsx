/**
 * Section 6 -- Manual Timetable Builder.
 *
 * The coordinator's other route to a timetable: pick a class, ask "where does
 * this fit?" (Find Best Slot), or place it wherever they want and be told the
 * consequences before committing. A hard conflict is refused once and then
 * offered as an explicit override, because Section 6 gives the coordinator
 * complete authority -- but never silently.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { canOverride, describeError } from '../lib/api.js';
import TimetableGrid from '../components/TimetableGrid.jsx';
import {
  AcRequirement, AutoTag, Badge, Card, Checkbox, EmptyState, Field, Loading, Notice,
  PageHead, RoomCard, ScorePill, Select, SlotOption, TextInput, ViolationList,
} from '../components/ui.jsx';
import { dayName, formatTimeRange, pluralise } from '../lib/format.js';

const BLANK_DRAFT = {
  courseId: '', sectionId: '', subSectionId: '', component: '', periods: '',
  facultyId: '', roomId: '', day: '', slotIndex: '', lock: false, notes: '',
};

export default function ManualBuilder() {
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [timetableId, setTimetableId] = useState('');

  const [draft, setDraft] = useState(BLANK_DRAFT);
  const [resolved, setResolved] = useState(null);
  const [resolveError, setResolveError] = useState('');

  const [slots, setSlots] = useState(null);
  const [slotsBusy, setSlotsBusy] = useState(false);

  const [picker, setPicker] = useState(null);     // 'faculty' | 'room' | null
  const [pickerData, setPickerData] = useState(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  const [check, setCheck] = useState(null);
  const [checkBusy, setCheckBusy] = useState(false);

  const [view, setView] = useState(null);
  const [placing, setPlacing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [override, setOverride] = useState(null);

  const patch = (p) => {
    setDraft((prev) => ({ ...prev, ...p }));
    setCheck(null);
    setError('');
    setOverride(null);
  };

  // --- Load the builder ---------------------------------------------------
  const loadSetup = useCallback((id) => {
    setLoading(true);
    return api.get('/manual/setup', id ? { timetableId: id } : {})
      .then((data) => {
        setSetup(data);
        setLoadError('');
        if (!id && data.timetables.length) setTimetableId(String(data.timetables[0].id));
        else if (id) setTimetableId(String(id));
      })
      .catch((err) => setLoadError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSetup(null); }, [loadSetup]);

  const reload = useCallback(() => {
    if (timetableId) loadSetup(timetableId);
  }, [timetableId, loadSetup]);

  // --- The section grid beside the composer --------------------------------
  useEffect(() => {
    if (!draft.sectionId || !timetableId) { setView(null); return; }
    let alive = true;
    api.get(`/timetable/views/section/${draft.sectionId}`, { timetableId })
      .then((data) => { if (alive) setView(data); })
      .catch(() => { if (alive) setView(null); });
    return () => { alive = false; };
  }, [draft.sectionId, timetableId, message]);

  // --- Resolve the occurrence whenever the class identity changes ----------
  useEffect(() => {
    if (!draft.courseId || !draft.sectionId) { setResolved(null); return; }
    let alive = true;
    api.post('/manual/occurrence', {
      courseId: Number(draft.courseId),
      sectionId: Number(draft.sectionId),
      subSectionId: draft.subSectionId || null,
      component: draft.component || undefined,
      periods: draft.periods || undefined,
    })
      .then((data) => { if (alive) { setResolved(data); setResolveError(''); } })
      .catch((err) => { if (alive) { setResolved(null); setResolveError(describeError(err)); } });
    return () => { alive = false; };
  }, [draft.courseId, draft.sectionId, draft.subSectionId, draft.component, draft.periods]);

  const courses = useMemo(() => (setup ? setup.courses : []), [setup]);

  const sectionsFor = useMemo(() => {
    if (!setup) return [];
    const course = courses.find((c) => String(c.id) === String(draft.courseId));
    if (!course) return setup.sections;
    if (course.section_id) return setup.sections.filter((s) => s.id === course.section_id);
    return setup.sections.filter((s) => !course.semester_id || s.semester_id === course.semester_id);
  }, [setup, courses, draft.courseId]);

  const subSectionsFor = useMemo(() => {
    if (!setup || !draft.sectionId) return [];
    return setup.subSections.filter((ss) => String(ss.section_id) === String(draft.sectionId));
  }, [setup, draft.sectionId]);

  const componentsFor = useMemo(() => {
    const course = courses.find((c) => String(c.id) === String(draft.courseId));
    return (course && course.components) || (setup ? setup.components : []);
  }, [courses, draft.courseId, setup]);

  const bodyForSlot = useCallback((extra = {}) => ({
    courseId: Number(draft.courseId),
    sectionId: Number(draft.sectionId),
    subSectionId: draft.subSectionId || null,
    component: draft.component || undefined,
    periods: draft.periods || undefined,
    facultyId: draft.facultyId || null,
    roomId: draft.roomId || null,
    ...extra,
  }), [draft]);

  // --- Find Best Slot (Section 6.3) ---------------------------------------
  const findSlots = () => {
    setSlotsBusy(true);
    setError('');
    api.post('/manual/find-best-slot', bodyForSlot({ limit: 12 }))
      .then((data) => setSlots(data))
      .catch((err) => { setSlots(null); setError(describeError(err)); })
      .finally(() => setSlotsBusy(false));
  };

  const chooseSlot = (option) => {
    setSlots(null);
    patch({
      day: String(option.day),
      slotIndex: String(option.slotIndex),
      facultyId: option.facultyId != null ? String(option.facultyId) : draft.facultyId,
      roomId: option.roomId != null ? String(option.roomId) : draft.roomId,
    });
  };

  // --- Teacher / room pickers ---------------------------------------------
  const openPicker = (which) => {
    setPicker(which);
    setPickerData(null);
    setPickerBusy(true);
    api.post(`/manual/${which === 'faculty' ? 'faculty' : 'rooms'}`, bodyForSlot({
      day: Number(draft.day),
      slotIndex: Number(draft.slotIndex),
    }))
      .then((data) => setPickerData(data))
      .catch((err) => { setPickerData({ error: describeError(err) }); })
      .finally(() => setPickerBusy(false));
  };

  // --- Check before placing -----------------------------------------------
  const runCheck = () => {
    setCheckBusy(true);
    setError('');
    api.post('/manual/check', bodyForSlot({
      day: Number(draft.day),
      slotIndex: Number(draft.slotIndex),
    }))
      .then((data) => setCheck(data))
      .catch((err) => { setCheck(null); setError(describeError(err)); })
      .finally(() => setCheckBusy(false));
  };

  // --- Place it ------------------------------------------------------------
  const place = (force) => {
    setPlacing(true);
    setError('');
    setOverride(null);
    api.post('/timetable/assignments', {
      timetableId: Number(timetableId),
      ...bodyForSlot({
        day: Number(draft.day),
        slotIndex: Number(draft.slotIndex),
        lock: draft.lock,
        notes: draft.notes || null,
        force: !!force,
      }),
    })
      .then((data) => {
        setMessage(`Placed: ${(data.card && data.card.title) || (resolved && resolved.label) || 'class'} on ${dayName(Number(draft.day))}.`);
        setCheck(null);
        setSlots(null);
        patch({ day: '', slotIndex: '', facultyId: '', roomId: '' });
        reload();
      })
      .catch((err) => {
        if (canOverride(err)) {
          setOverride({
            message: describeError(err),
            details: err.details || (err.violations || []).map((v) => v.message),
          });
        } else {
          setError(describeError(err));
        }
      })
      .finally(() => setPlacing(false));
  };

  if (loading && !setup) return <Loading label="Opening the manual builder…" />;

  if (loadError) {
    return (
      <div className="page">
        <PageHead title="Manual Builder" breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Manual Builder' }]} />
        <Notice tone="bad" title="Could not open the builder">{loadError}</Notice>
      </div>
    );
  }

  const ready = !!(draft.courseId && draft.sectionId);
  const slotChosen = draft.day !== '' && draft.slotIndex !== '';

  return (
    <div className="page wide">
      <PageHead
        title="Manual Builder"
        subtitle={setup.summary}
        breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Manual Builder' }]}
        actions={(
          <div className="btn-row">
            <Link className="btn ghost small" to="/generate">Generation Wizard</Link>
            <button type="button" className="btn small ghost" onClick={reload}>Refresh</button>
          </div>
        )}
      >
        <Field label="Timetable being built">
          <Select
            value={timetableId}
            placeholder={setup.timetables.length ? 'Choose a timetable' : 'No timetables yet'}
            options={setup.timetables.map((t) => ({
              value: t.id, label: `${t.name} · ${t.mode} · ${t.status}`,
            }))}
            onChange={(e) => { setTimetableId(e.target.value); loadSetup(e.target.value); }}
          />
        </Field>
      </PageHead>

      {!setup.timetables.length ? (
        <Notice tone="warn" title="There is no timetable to build into">
          Create one from the <Link to="/timetables">Timetables</Link> screen, or run the{' '}
          <Link to="/generate">Generation Wizard</Link> once and edit the result here.
        </Notice>
      ) : null}

      {message ? <Notice tone="ok" title="Done">{message}</Notice> : null}

      <div className="grid cols-2">
        {/* ---------------- Still to place ---------------- */}
        <Card
          title="Still to place"
          subtitle={`${setup.outstanding.length} course/component combination(s) with periods left`}
        >
          {setup.outstanding.length === 0 ? (
            <EmptyState icon="✓" title="Nothing outstanding">
              Every period the data calls for has been placed.
            </EmptyState>
          ) : (
            <div className="table-wrap scroll-y">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>Course</th><th>Section</th><th>Component</th>
                    <th className="num">Left</th><th>AC</th><th />
                  </tr>
                </thead>
                <tbody>
                  {setup.outstanding.map((o) => (
                    <tr key={`${o.courseId}:${o.sectionId}:${o.component}`}>
                      <td className="bold">{o.code}<span className="muted small"> {o.name}</span></td>
                      <td>{o.sectionName}</td>
                      <td className="muted">{o.componentLabel}</td>
                      <td className="num">{o.remaining} / {o.periodsNeeded}</td>
                      <td><AcRequirement value={o.acRequirement} showNotRequired={false} /></td>
                      <td className="actions">
                        <button
                          type="button" className="btn tiny"
                          onClick={() => {
                            setSlots(null);
                            setDraft({
                              ...BLANK_DRAFT,
                              courseId: String(o.courseId),
                              sectionId: String(o.sectionId),
                              component: o.component,
                              periods: o.component === 'LAB' && o.labBlockPeriods ? String(o.labBlockPeriods) : '',
                            });
                            setCheck(null);
                            setError('');
                          }}
                        >
                          Place
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ---------------- The composer ---------------- */}
        <Card title="The class you are placing" subtitle="Leave the teacher, room or time empty and ask for the best slot instead.">
          <div className="field-grid tight">
            <Field label="Course" required>
              <Select
                value={draft.courseId}
                placeholder="Choose a course"
                options={courses.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))}
                onChange={(e) => patch({ courseId: e.target.value, sectionId: '', subSectionId: '', component: '' })}
              />
            </Field>
            <Field label="Section" required>
              <Select
                value={draft.sectionId}
                placeholder="Choose a section"
                options={sectionsFor.map((s) => ({ value: s.id, label: s.name }))}
                onChange={(e) => patch({ sectionId: e.target.value, subSectionId: '' })}
              />
            </Field>
            <Field
              label="Sub-Section"
              hint={subSectionsFor.length ? 'Empty means the whole section.' : 'This section has no sub-sections.'}
            >
              <Select
                value={draft.subSectionId}
                placeholder="Whole section"
                options={subSectionsFor.map((ss) => ({ value: ss.id, label: ss.name }))}
                onChange={(e) => patch({ subSectionId: e.target.value })}
                disabled={!subSectionsFor.length}
              />
            </Field>
            <Field label="Component" hint="Empty uses the course's own plan.">
              <Select
                value={draft.component}
                placeholder="From the course"
                options={componentsFor.map((c) => ({ value: c, label: c.replace(/_/g, ' ') }))}
                onChange={(e) => patch({ component: e.target.value })}
              />
            </Field>
            <Field label="Periods" hint="Empty uses the component's own length.">
              <TextInput
                type="number" min="1" value={draft.periods}
                placeholder={resolved ? String(resolved.periods) : 'auto'}
                onChange={(e) => patch({ periods: e.target.value })}
              />
            </Field>
          </div>

          {resolveError ? <Notice tone="bad" title="Cannot resolve this class">{resolveError}</Notice> : null}

          {resolved ? (
            <>
              <div className="fact-row">
                <span><strong>{resolved.label}</strong></span>
                <span>{pluralise(resolved.periods, 'period')}</span>
                <span>{resolved.strength} students</span>
                <span><AcRequirement value={resolved.acRequirement} /></span>
                <span>{resolved.eligibleFaculty.length} eligible teacher(s)</span>
                <span>{resolved.suitableRooms.length} suitable room(s)</span>
              </div>
              {resolved.note ? <Notice tone="warn">{resolved.note}</Notice> : null}
            </>
          ) : null}

          <div className="divider" />

          <div className="field-grid tight">
            <Field label="Day" hint="Empty means Find Best Slot decides.">
              <Select
                value={draft.day}
                placeholder="Engine decides"
                options={setup.grid.workingDays.map((d) => ({ value: d, label: dayName(d) }))}
                onChange={(e) => patch({ day: e.target.value })}
              />
            </Field>
            <Field label="Starting period">
              <Select
                value={draft.slotIndex}
                placeholder="Engine decides"
                options={setup.grid.slots.map((s) => ({
                  value: s.index, label: `P${s.index + 1} · ${formatTimeRange(s.start, s.end)}`,
                }))}
                onChange={(e) => patch({ slotIndex: e.target.value })}
              />
            </Field>
            <Field label="Teacher" hint="Empty means the best available.">
              <div className="row">
                <Select
                  value={draft.facultyId}
                  placeholder="Engine decides"
                  options={(resolved ? resolved.eligibleFaculty : []).map((f) => ({ value: f.id, label: f.name }))}
                  onChange={(e) => patch({ facultyId: e.target.value })}
                />
                <button
                  type="button" className="btn small ghost"
                  disabled={!ready || !slotChosen}
                  onClick={() => openPicker('faculty')}
                  title={slotChosen ? 'Compare who is free in this slot' : 'Choose a day and period first'}
                >
                  Compare
                </button>
              </div>
            </Field>
            <Field label="Room" hint="Empty means the best fit.">
              <div className="row">
                <Select
                  value={draft.roomId}
                  placeholder="Engine decides"
                  options={(resolved ? resolved.suitableRooms : []).map((r) => ({
                    value: r.id, label: `${r.name} · ${r.acLabel} · ${r.capacity || '?'} seats`,
                  }))}
                  onChange={(e) => patch({ roomId: e.target.value })}
                />
                <button
                  type="button" className="btn small ghost"
                  disabled={!ready || !slotChosen}
                  onClick={() => openPicker('room')}
                  title={slotChosen ? 'Compare rooms for this slot' : 'Choose a day and period first'}
                >
                  Compare
                </button>
              </div>
            </Field>
          </div>

          <Checkbox
            label="Lock this class once placed"
            hint="A locked class is never moved by a re-generation."
            checked={draft.lock}
            onChange={(e) => patch({ lock: e.target.checked })}
          />
          <Field label="Note" hint="Optional. Shown on the card and in the activity log.">
            <TextInput value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} />
          </Field>

          {error ? <Notice tone="bad" title="That did not work">{error}</Notice> : null}

          {check ? (
            <Notice
              tone={check.ok ? (check.warnings.length ? 'warn' : 'ok') : 'bad'}
              title={`${check.slot.dayName} ${check.slot.timeLabel} — ${check.ok ? 'this works' : 'this conflicts'}`}
            >
              <p>
                Score <ScorePill score={check.score} />
                {check.parallelWithSiblings
                  ? <> · <Badge tone="info">runs in parallel with a sibling sub-section</Badge></>
                  : null}
              </p>
              <ViolationList violations={check.violations} warnings={check.warnings} />
              {check.overrideHint ? <p className="muted small">{check.overrideHint}</p> : null}
            </Notice>
          ) : null}

          {override ? (
            <Notice
              tone="warn"
              title="This slot conflicts — place it anyway?"
              actions={(
                <div className="btn-row">
                  <button type="button" className="btn danger" disabled={placing} onClick={() => place(true)}>
                    Override and place
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setOverride(null)}>Cancel</button>
                </div>
              )}
            >
              <p>{override.message}</p>
              {override.details && override.details.length ? (
                <ul>{override.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
              ) : null}
              <p className="muted small">
                The conflict will be recorded on the class and in the activity log, so it is never invisible.
              </p>
            </Notice>
          ) : null}

          <div className="btn-row end mt">
            <button type="button" className="btn" disabled={!ready || slotsBusy} onClick={findSlots}>
              {slotsBusy ? 'Searching…' : 'Find Best Slot'}
            </button>
            <button
              type="button" className="btn" disabled={!ready || !slotChosen || checkBusy}
              onClick={runCheck}
            >
              {checkBusy ? 'Checking…' : 'Check this slot'}
            </button>
            <button
              type="button" className="btn primary"
              disabled={!ready || !slotChosen || !timetableId || placing}
              onClick={() => place(false)}
            >
              {placing ? 'Placing…' : 'Place class'}
            </button>
          </div>
        </Card>
      </div>

      {/* ---------------- Find Best Slot results ---------------- */}
      {slots ? (
        <Card
          title="Where it fits"
          subtitle={slots.verdict}
          actions={<button type="button" className="btn small ghost" onClick={() => setSlots(null)}>Close</button>}
        >
          {slots.options.length ? (
            <div className="stack tight">
              {slots.options.map((o, i) => (
                <SlotOption
                  key={`${o.day}:${o.slotIndex}:${i}`}
                  option={o}
                  best={i === 0}
                  chosen={String(o.day) === draft.day && String(o.slotIndex) === draft.slotIndex}
                  onChoose={() => chooseSlot(o)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon="○" title="No slot in the week can take this class">
              The reasons below say what to relax.
            </EmptyState>
          )}
          {slots.whyNot && slots.whyNot.length ? (
            <>
              <div className="divider" />
              <p className="bold small">Why the other {slots.blockedSlots} slot(s) were ruled out</p>
              <ul>
                {slots.whyNot.map((w, i) => (
                  <li key={i}>{w.reason} <span className="muted">({w.slots} slot(s))</span></li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      ) : null}

      {/* ---------------- The section's current week ---------------- */}
      {view ? (
        <Card
          title={`${view.scope.label} — as it stands`}
          subtitle="Click an empty period to aim the composer at it."
          flush
        >
          <TimetableGrid
            grid={view.grid}
            cells={view.cells}
            onEmptyClick={(day, slotIndex) => patch({ day: String(day), slotIndex: String(slotIndex) })}
            emptyLabel="+"
          />
        </Card>
      ) : draft.sectionId ? null : (
        <Notice tone="info" icon="◇">
          Choose a section above and its current week appears here, so you can see what you are placing around.
        </Notice>
      )}

      {/* ---------------- Teacher / room comparison ---------------- */}
      {picker ? (
        <PickerPanel
          which={picker}
          busy={pickerBusy}
          data={pickerData}
          onClose={() => { setPicker(null); setPickerData(null); }}
          onPickFaculty={(id) => { patch({ facultyId: String(id) }); setPicker(null); }}
          onPickRoom={(id) => { patch({ roomId: String(id) }); setPicker(null); }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Change Teacher / Change Room comparison panel
// ---------------------------------------------------------------------------
function PickerPanel({ which, busy, data, onClose, onPickFaculty, onPickRoom }) {
  const isFaculty = which === 'faculty';
  return (
    <Card
      title={isFaculty ? 'Who is free in this slot?' : 'Which room fits?'}
      subtitle={data && data.label ? data.label : ''}
      actions={<button type="button" className="btn small ghost" onClick={onClose}>Close</button>}
    >
      {busy ? <Loading label="Checking everyone…" /> : null}
      {data && data.error ? <Notice tone="bad" title="Could not compare">{data.error}</Notice> : null}

      {data && !data.error && isFaculty ? (
        <>
          <p className="bold small">Available ({data.available.length})</p>
          {data.available.length === 0 ? (
            <EmptyState icon="○" title="Nobody eligible is free in this slot" />
          ) : (
            <div className="table-wrap">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>Teacher</th><th>Employee ID</th><th>Designation</th>
                    <th className="num">This week</th><th className="num">This day</th>
                    <th className="num">Score</th><th />
                  </tr>
                </thead>
                <tbody>
                  {data.available.map((f) => (
                    <tr key={f.facultyId}>
                      <td className="bold">{f.name}{f.isCurrent ? <Badge tone="info">current</Badge> : null}</td>
                      <td className="muted">{f.employeeId || '—'}</td>
                      <td className="muted">{f.designation || '—'}</td>
                      <td className="num">{f.periodsThisWeek}{f.maxWeeklyHours ? ` / ${f.maxWeeklyHours}` : ''}</td>
                      <td className="num">{f.periodsThisDay}</td>
                      <td className="num"><ScorePill score={f.score} /></td>
                      <td className="actions">
                        <button type="button" className="btn tiny" onClick={() => onPickFaculty(f.facultyId)}>
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.unavailable.length ? (
            <>
              <div className="divider" />
              <p className="bold small">Not available ({data.unavailable.length})</p>
              <div className="table-wrap">
                <table className="data compact">
                  <thead><tr><th>Teacher</th><th>Why not</th></tr></thead>
                  <tbody>
                    {data.unavailable.map((f) => (
                      <tr key={f.facultyId} className="is-error">
                        <td>{f.name}</td>
                        <td className="muted">{(f.reasons || []).join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {data && !data.error && !isFaculty ? (
        <>
          {data.requirement ? (
            <p className="hint">
              Needs seats for <strong>{data.requirement.strength}</strong> ·{' '}
              <AcRequirement value={data.requirement.acRequirement} />
              {data.requirement.requiredRoomType ? ` · ${data.requirement.requiredRoomType.replace(/_/g, ' ')}` : ''}
            </p>
          ) : null}

          <p className="bold small">Available ({data.available.length})</p>
          {data.available.length === 0 ? (
            <EmptyState icon="○" title="No suitable room is free in this slot" />
          ) : (
            <div className="grid cols-3">
              {data.available.map((r) => (
                <RoomCard key={r.id} room={r} onChoose={() => onPickRoom(r.id)} />
              ))}
            </div>
          )}

          {data.unavailable.length ? (
            <>
              <div className="divider" />
              <p className="bold small">Not available ({data.unavailable.length})</p>
              <div className="grid cols-3">
                {data.unavailable.map((r) => <RoomCard key={r.id} room={r} readOnly />)}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {!busy && !data ? <AutoTag>Nothing to compare yet</AutoTag> : null}
    </Card>
  );
}
