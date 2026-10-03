/**
 * Section 5 -- Timetable Generation Wizard.
 *
 * Six steps: Scope -> Courses -> Teachers -> Rooms -> Time -> Review & Generate.
 *
 * The rule that shapes every screen here is Section 5's AUTO semantics: an empty
 * field never means invalid data, it means "the scheduling engine determines this
 * value". So every control below starts empty, and the wizard says out loud what
 * it is handing to the engine rather than pretending a value was chosen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { describeError } from '../lib/api.js';
import {
  AcBadge, AcRequirement, AutoTag, Badge, Bar, Card, Checkbox, ChipToggles, EmptyState,
  Field, Loading, Notice, PageHead, ScoreDial, Select, TextInput,
} from '../components/ui.jsx';
import { dayName, formatTimeRange, pluralise } from '../lib/format.js';

const STEPS = [
  { no: 1, label: 'Scope' },
  { no: 2, label: 'Courses' },
  { no: 3, label: 'Teachers' },
  { no: 4, label: 'Rooms' },
  { no: 5, label: 'Time' },
  { no: 6, label: 'Review' },
];

/**
 * Every per-course field starts empty or AUTOMATIC. Nothing here is a hidden
 * default -- it is the literal "the engine decides this" state.
 */
const BLANK_COURSE = {
  include: false,
  splitIntoSubSections: null,
  acRequirement: '',
  requiredRoomType: '',
  requiredFacilities: [],
  facultyMode: 'AUTOMATIC',
  facultyIds: [],
  subSectionFaculty: {},
  roomMode: 'AUTOMATIC',
  roomIds: [],
  subSectionRooms: {},
  timeMode: 'AUTOMATIC',
  fixedSlots: [],
  preferredDays: [],
  windowStart: '',
  windowEnd: '',
};

const SELECTION_HELP = {
  AUTOMATIC: 'The engine chooses. Leave it here unless you have a reason not to.',
  PREFERRED: 'The engine tries your choices first, but may use another if they do not fit.',
  FIXED: 'Only your choices are allowed. If none fit, the class is reported as unplaced.',
};

const TIME_MODE_OPTIONS = [
  { value: 'AUTOMATIC', label: 'Automatic — the engine picks day and period' },
  { value: 'PREFERRED', label: 'Preferred — try these days / this window first' },
  { value: 'FIXED', label: 'Fixed — pin to exact slots' },
];

const modeLabel = (m) => m.charAt(0) + m.slice(1).toLowerCase();

export default function GenerateWizard() {
  const navigate = useNavigate();

  const [wizard, setWizard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('HYBRID');
  const [scope, setScope] = useState({
    departmentId: '', programId: '', semesterId: '', sectionIds: [],
  });
  const [cfg, setCfg] = useState({});

  const [target, setTarget] = useState({
    timetableId: '', timetableName: '', keepLocked: true, keepManual: false,
  });

  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get('/generate/wizard')
      .then((data) => { if (alive) { setWizard(data); setLoadError(''); } })
      .catch((err) => { if (alive) setLoadError(describeError(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // --- Derived scope lists ------------------------------------------------
  const programs = useMemo(() => {
    const all = (wizard && wizard.scope && wizard.scope.programs) || [];
    if (!scope.departmentId) return all;
    return all.filter((p) => String(p.department_id) === String(scope.departmentId));
  }, [wizard, scope.departmentId]);

  const semesters = useMemo(() => {
    const all = (wizard && wizard.scope && wizard.scope.semesters) || [];
    return all.filter((s) => (
      (!scope.programId || String(s.program_id) === String(scope.programId))
      && (!scope.departmentId || String(s.department_id) === String(scope.departmentId))
    ));
  }, [wizard, scope.programId, scope.departmentId]);

  const sections = useMemo(() => {
    const all = (wizard && wizard.scope && wizard.scope.sections) || [];
    return all.filter((s) => (
      (!scope.programId || String(s.program_id) === String(scope.programId))
      && (!scope.semesterId || String(s.semester_id) === String(scope.semesterId))
    ));
  }, [wizard, scope.programId, scope.semesterId]);

  const courses = useMemo(() => {
    const all = (wizard && wizard.courses) || [];
    return all.filter((c) => (
      (!scope.departmentId || String(c.department_id) === String(scope.departmentId))
      && (!scope.programId || String(c.program_id) === String(scope.programId))
      && (!scope.semesterId || String(c.semester_id) === String(scope.semesterId))
    ));
  }, [wizard, scope.departmentId, scope.programId, scope.semesterId]);

  const chosen = useMemo(
    () => courses.filter((c) => cfg[c.id] && cfg[c.id].include),
    [courses, cfg]
  );

  const conf = useCallback((courseId) => cfg[courseId] || BLANK_COURSE, [cfg]);

  const setConf = useCallback((courseId, patch) => {
    setCfg((prev) => ({
      ...prev,
      [courseId]: { ...BLANK_COURSE, ...(prev[courseId] || {}), ...patch },
    }));
    setPreview(null);
  }, []);

  const subSectionsOf = useCallback((course) => {
    if (!wizard) return [];
    const ids = new Set(
      course.section_id ? [course.section_id] : scope.sectionIds.map(Number)
    );
    return wizard.scope.subSections.filter((ss) => ids.has(ss.section_id));
  }, [wizard, scope.sectionIds]);

  // --- Request body -------------------------------------------------------
  // Empty string / empty array is deliberate: the server's isAuto() strips those
  // fields out and records them as "the engine decided this one".
  const buildBody = useCallback((extra = {}) => ({
    mode,
    departmentId: scope.departmentId || null,
    programId: scope.programId || null,
    semesterId: scope.semesterId || null,
    scope: { sectionIds: scope.sectionIds },
    courses: chosen.map((course) => {
      const c = conf(course.id);
      return {
        courseId: course.id,
        include: true,
        splitIntoSubSections: c.splitIntoSubSections,
        acRequirement: c.acRequirement || '',
        requiredRoomType: c.requiredRoomType || '',
        requiredFacilities: c.requiredFacilities || [],
        facultyMode: c.facultyMode || 'AUTOMATIC',
        facultyIds: c.facultyIds || [],
        subSectionFaculty: c.subSectionFaculty || {},
        roomMode: c.roomMode || 'AUTOMATIC',
        roomIds: c.roomIds || [],
        subSectionRooms: c.subSectionRooms || {},
        timeMode: c.timeMode || 'AUTOMATIC',
        fixedSlots: c.fixedSlots || [],
        preferredDays: c.preferredDays || [],
        windowStart: c.windowStart || '',
        windowEnd: c.windowEnd || '',
      };
    }),
    ...extra,
  }), [mode, scope, chosen, conf]);

  const runPreview = useCallback(() => {
    if (!chosen.length) { setPreview(null); return; }
    setPreviewing(true);
    setPreviewError('');
    api.post('/generate/preview', buildBody())
      .then((data) => { setPreview(data); setPreviewError(''); })
      .catch((err) => { setPreview(null); setPreviewError(describeError(err)); })
      .finally(() => setPreviewing(false));
  }, [buildBody, chosen.length]);

  // Step 6 is the review screen, so the preview refreshes on arrival.
  useEffect(() => {
    if (step === 6) runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const run = useCallback((dryRun) => {
    setRunning(true);
    setRunError('');
    api.post('/generate/run', buildBody({
      dryRun: !!dryRun,
      keepLocked: target.keepLocked,
      keepManual: target.keepManual,
      timetableId: target.timetableId || null,
      timetableName: target.timetableName || '',
    }))
      .then((data) => { setResult(data); setRunError(''); })
      .catch((err) => { setResult(null); setRunError(describeError(err)); })
      .finally(() => setRunning(false));
  }, [buildBody, target]);

  if (loading) return <Loading label="Opening the generation wizard…" />;

  if (loadError) {
    return (
      <div className="page">
        <PageHead
          title="Generate Timetable"
          breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Generate' }]}
        />
        <Notice tone="bad" title="Could not open the wizard">{loadError}</Notice>
      </div>
    );
  }

  // --- Section 9: the data dependency gate --------------------------------
  if (wizard && wizard.canGenerate === false) {
    const readiness = wizard.readiness
      || { findings: [], blocking: [], progress: { percent: 0, done: 0, total: 0 } };
    return (
      <div className="page">
        <PageHead
          title="Generate Timetable"
          subtitle="Some data is still missing"
          breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Generate' }]}
        />
        <Notice tone="warn" title="Not enough data yet">
          {wizard.message || readiness.summary}{' '}
          Finish the items below and this wizard opens on its own.
        </Notice>
        <Card
          title="Data Setup Progress"
          subtitle={`${readiness.progress.done} of ${readiness.progress.total} essentials in place`}
          actions={<Link className="btn small" to="/data">Open Data Management</Link>}
        >
          <Bar value={readiness.progress.percent} />
          <div className="stack tight mt">
            {readiness.findings.map((f) => (
              <div key={f.label} className={`check-item ${f.status}`}>
                <span className="check-mark">
                  {f.status === 'OK' ? '✓' : f.status === 'WARN' ? '!' : '×'}
                </span>
                <span className="check-text">
                  <span className="check-label">{f.label}</span>
                  <span className="check-msg">{f.message}</span>
                </span>
                {f.action ? (
                  <Link
                    className="check-go"
                    to={f.action.entity === 'college_timings' ? '/timing' : `/data/${f.action.entity}`}
                  >
                    {f.action.label} →
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // --- Results replace the wizard once a run has happened ------------------
  if (result) {
    return (
      <ResultsPanel
        result={result}
        onBack={() => { setResult(null); setStep(6); }}
        onOpenViews={() => navigate('/views')}
        onOpenManual={() => navigate('/manual')}
      />
    );
  }

  const canLeaveStep1 = !!scope.sectionIds.length || !!scope.semesterId;
  const canLeaveStep2 = chosen.length > 0;
  const nextBlocked = (step === 1 && !canLeaveStep1) || (step === 2 && !canLeaveStep2);

  return (
    <div className="page wide">
      <PageHead
        title="Generate Timetable"
        subtitle={wizard.timing
          ? `Timing: ${wizard.timing.name} · ${wizard.timing.workingDays.length} working days · ${wizard.timing.slots.length} periods a day`
          : ''}
        breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Generate' }]}
        actions={<Link className="btn ghost small" to="/manual">Manual Builder</Link>}
      />

      <div className="steps">
        {STEPS.map((s) => (
          <button
            key={s.no}
            type="button"
            className={`step ${step === s.no ? 'active' : ''} ${step > s.no ? 'done' : ''}`}
            onClick={() => setStep(s.no)}
          >
            <span className="step-no">{step > s.no ? '✓' : s.no}</span>
            <span className="step-label">{s.label}</span>
          </button>
        ))}
      </div>

      <Notice tone="info" icon="◇" title="Anything you leave empty is decided for you">
        {wizard.autoNote}
      </Notice>

      {step === 1 && (
        <StepScope
          wizard={wizard} scope={scope} setScope={setScope}
          programs={programs} semesters={semesters} sections={sections}
        />
      )}
      {step === 2 && (
        <StepCourses
          courses={courses} conf={conf} setConf={setConf}
          mode={mode} setMode={setMode} wizard={wizard} subSectionsOf={subSectionsOf}
        />
      )}
      {step === 3 && (
        <StepTeachers
          chosen={chosen} conf={conf} setConf={setConf}
          wizard={wizard} subSectionsOf={subSectionsOf}
        />
      )}
      {step === 4 && (
        <StepRooms
          chosen={chosen} conf={conf} setConf={setConf}
          wizard={wizard} subSectionsOf={subSectionsOf}
        />
      )}
      {step === 5 && (
        <StepTime chosen={chosen} conf={conf} setConf={setConf} wizard={wizard} />
      )}
      {step === 6 && (
        <StepReview
          wizard={wizard} preview={preview} previewing={previewing} previewError={previewError}
          onRefresh={runPreview} target={target} setTarget={setTarget}
          chosen={chosen} mode={mode} runError={runError} running={running}
          onRun={run}
        />
      )}

      <div className="wizard-foot">
        <button type="button" className="btn ghost" disabled={step === 1} onClick={() => setStep(step - 1)}>
          ← Back
        </button>
        <span className="spacer" />
        {step === 1 && !canLeaveStep1 ? (
          <span className="muted small">Choose at least a semester or one section to continue.</span>
        ) : null}
        {step === 2 && !canLeaveStep2 ? (
          <span className="muted small">Tick at least one course to continue.</span>
        ) : null}
        {step < 6 ? (
          <button type="button" className="btn primary" disabled={nextBlocked} onClick={() => setStep(step + 1)}>
            Next: {STEPS[step].label} →
          </button>
        ) : (
          <button type="button" className="btn primary large" disabled={running} onClick={() => run(false)}>
            {running ? 'Generating…' : 'Generate Timetable'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 -- Scope
// ---------------------------------------------------------------------------
function StepScope({ wizard, scope, setScope, programs, semesters, sections }) {
  const patch = (p) => setScope((prev) => ({ ...prev, ...p }));

  return (
    <Card
      title="Step 1 · What are you scheduling?"
      subtitle="Narrow it down, or leave a level empty to include everything under it."
    >
      <div className="field-grid">
        <Field label="Department" hint="Leave empty for every department.">
          <Select
            value={scope.departmentId}
            placeholder="All departments"
            options={wizard.scope.departments.map((d) => ({ value: d.id, label: d.name }))}
            onChange={(e) => patch({
              departmentId: e.target.value, programId: '', semesterId: '', sectionIds: [],
            })}
          />
        </Field>
        <Field label="Program" hint="Leave empty for every program.">
          <Select
            value={scope.programId}
            placeholder="All programs"
            options={programs.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(e) => patch({ programId: e.target.value, semesterId: '', sectionIds: [] })}
          />
        </Field>
        <Field label="Semester" hint="Leave empty for every semester.">
          <Select
            value={scope.semesterId}
            placeholder="All semesters"
            options={semesters.map((s) => ({
              value: s.id,
              label: `Semester ${s.semester_number}${s.academic_session ? ` · ${s.academic_session}` : ''}`,
            }))}
            onChange={(e) => patch({ semesterId: e.target.value, sectionIds: [] })}
          />
        </Field>
      </div>

      <div className="divider" />

      <Field
        label="Sections"
        hint={scope.sectionIds.length
          ? `${scope.sectionIds.length} selected.`
          : 'Nothing selected means every section listed here.'}
      >
        {sections.length === 0 ? (
          <EmptyState icon="○" title="No sections match this scope">
            Widen the filters above, or add sections under{' '}
            <Link to="/data/sections">Data Management</Link>.
          </EmptyState>
        ) : (
          <>
            <div className="btn-row">
              <button
                type="button" className="btn small ghost"
                onClick={() => setScope((p) => ({ ...p, sectionIds: sections.map((s) => String(s.id)) }))}
              >
                Select all
              </button>
              <button
                type="button" className="btn small ghost"
                onClick={() => setScope((p) => ({ ...p, sectionIds: [] }))}
              >
                Clear
              </button>
            </div>
            <div className="table-wrap mt">
              <table className="data compact">
                <thead>
                  <tr>
                    <th style={{ width: 40 }} />
                    <th>Section</th>
                    <th>Program</th>
                    <th className="num">Sem</th>
                    <th className="num">Students</th>
                    <th className="num">Sub-Sections</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((s) => {
                    const on = scope.sectionIds.includes(String(s.id));
                    return (
                      <tr key={s.id}>
                        <td>
                          <input
                            type="checkbox" checked={on}
                            onChange={() => setScope((prev) => ({
                              ...prev,
                              sectionIds: on
                                ? prev.sectionIds.filter((x) => x !== String(s.id))
                                : [...prev.sectionIds, String(s.id)],
                            }))}
                          />
                        </td>
                        <td className="bold">{s.name}</td>
                        <td className="muted">{s.program_name || '—'}</td>
                        <td className="num">{s.semester_number == null ? '—' : s.semester_number}</td>
                        <td className="num">{s.students || s.student_strength || 0}</td>
                        <td className="num">
                          {s.sub_sections
                            ? <Badge tone="info">{s.sub_sections}</Badge>
                            : <span className="muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Field>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 2 -- Courses, and the Automatic / Manual / Hybrid choice
// ---------------------------------------------------------------------------
function StepCourses({ courses, conf, setConf, mode, setMode, wizard, subSectionsOf }) {
  return (
    <>
      <ModeChoice modes={wizard.modes} mode={mode} setMode={setMode} />

      <Card
        title="Step 2 · Which courses?"
        subtitle="Tick a course to include it. Everything inside keeps its recorded values unless you change it here."
        actions={(
          <div className="btn-row">
            <button
              type="button" className="btn small ghost"
              onClick={() => courses.forEach((c) => setConf(c.id, { include: true }))}
            >
              Include all
            </button>
            <button
              type="button" className="btn small ghost"
              onClick={() => courses.forEach((c) => setConf(c.id, { include: false }))}
            >
              Clear
            </button>
          </div>
        )}
      >
        {courses.length === 0 ? (
          <EmptyState icon="○" title="No courses match this scope">
            Go back to step 1 and widen the filters, or add courses under{' '}
            <Link to="/data/courses">Data Management</Link>.
          </EmptyState>
        ) : (
          <div className="stack">
            {courses.map((course) => {
              const c = conf(course.id);
              const subs = subSectionsOf(course);
              return (
                <div key={course.id} className={`course-row ${c.include ? '' : 'off'}`}>
                  <div className="course-row-head">
                    <input
                      type="checkbox" checked={!!c.include}
                      onChange={() => setConf(course.id, { include: !c.include })}
                    />
                    <span className="course-title">
                      <span className="course-name">{course.code} · {course.name}</span>
                      <span className="course-meta">
                        {pluralise(course.classesPerWeek, 'class')} a week · {course.periodsPerWeek} periods
                        {course.section_name ? ` · ${course.section_name}` : ''}
                        {course.canSplit ? ' · can split into sub-sections' : ''}
                      </span>
                    </span>
                    <AcRequirement value={c.acRequirement || course.ac_requirement} />
                  </div>

                  {c.include ? (
                    <div className="course-row-body">
                      <div className="field-grid tight">
                        <Field label="AC requirement" hint="Empty keeps whatever the course records.">
                          <Select
                            value={c.acRequirement}
                            placeholder={`From the course (${course.acLabel})`}
                            options={wizard.acRequirements}
                            onChange={(e) => setConf(course.id, { acRequirement: e.target.value })}
                          />
                        </Field>
                        <Field label="Room type" hint="Empty means the engine matches the course's own needs.">
                          <Select
                            value={c.requiredRoomType}
                            placeholder="Engine decides"
                            options={wizard.roomTypes.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
                            onChange={(e) => setConf(course.id, { requiredRoomType: e.target.value })}
                          />
                        </Field>
                        <Field
                          label="Split into sub-sections"
                          hint={subs.length
                            ? `${subs.length} sub-section(s) available.`
                            : 'No sub-sections recorded for this section.'}
                        >
                          <Select
                            value={c.splitIntoSubSections === null ? '' : String(c.splitIntoSubSections)}
                            placeholder={`From the course (${course.canSplit ? 'split' : 'whole section'})`}
                            options={[
                              { value: 'true', label: 'Yes — one class per sub-section' },
                              { value: 'false', label: 'No — the whole section together' },
                            ]}
                            onChange={(e) => setConf(course.id, {
                              splitIntoSubSections: e.target.value === '' ? null : e.target.value === 'true',
                            })}
                          />
                        </Field>
                      </div>
                      <Field
                        label="Required facilities"
                        hint="Rooms without these are skipped. Empty means no extra requirement."
                      >
                        <ChipToggles
                          options={wizard.facilities.map((f) => ({ value: f, label: f.replace(/_/g, ' ') }))}
                          value={c.requiredFacilities}
                          onChange={(v) => setConf(course.id, { requiredFacilities: v })}
                        />
                      </Field>
                      {course.plan.length > 1 ? (
                        <p className="hint">
                          Weekly plan: {course.plan.map((p) => `${p.label} ×${p.periods}`).join(', ')}.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

function ModeChoice({ modes, mode, setMode }) {
  return (
    <Card title="How much should the engine do?" subtitle="You can change your mind at any step.">
      <div className="grid cols-3">
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`tile ${mode === m.value ? 'chosen' : ''}`}
            onClick={() => setMode(m.value)}
          >
            <span className="tile-label">{m.label}</span>
            <span className="tile-help">{m.help}</span>
            {mode === m.value ? <span className="tile-tag">Selected</span> : null}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 3 -- Teachers
// ---------------------------------------------------------------------------
function StepTeachers({ chosen, conf, setConf, wizard, subSectionsOf }) {
  if (!chosen.length) {
    return (
      <Card title="Step 3 · Teachers">
        <EmptyState icon="○" title="No courses selected">
          Go back to step 2 and tick some courses.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card
      title="Step 3 · Who teaches what?"
      subtitle="Leave a course alone and the engine picks from the teachers eligible for it."
    >
      <div className="stack">
        {chosen.map((course) => {
          const c = conf(course.id);
          const subs = subSectionsOf(course);
          const splitting = c.splitIntoSubSections === null ? course.canSplit : c.splitIntoSubSections;
          const pool = course.eligibleFaculty.length
            ? course.eligibleFaculty
            : wizard.faculty.map((f) => ({ id: f.id, name: f.name, isFixed: false }));
          return (
            <div key={course.id} className="course-row">
              <div className="course-row-head">
                <span className="course-title">
                  <span className="course-name">{course.code} · {course.name}</span>
                  <span className="course-meta">
                    {course.eligibleFaculty.length
                      ? `${course.eligibleFaculty.length} eligible teacher(s)`
                      : 'No eligible teachers recorded'}
                  </span>
                </span>
                {c.facultyMode === 'AUTOMATIC'
                  ? <AutoTag>Engine picks</AutoTag>
                  : <Badge tone="info">{modeLabel(c.facultyMode)}</Badge>}
              </div>
              <div className="course-row-body">
                {course.facultyNote ? <p className="hint">{course.facultyNote}</p> : null}

                <Field label="How to choose" hint={SELECTION_HELP[c.facultyMode]}>
                  <Select
                    value={c.facultyMode}
                    options={wizard.selectionModes.map((m) => ({ value: m, label: modeLabel(m) }))}
                    onChange={(e) => setConf(course.id, { facultyMode: e.target.value })}
                  />
                </Field>

                {c.facultyMode !== 'AUTOMATIC' && !splitting ? (
                  <Field label="Teachers" hint="Nothing ticked still means the engine decides.">
                    <ChipToggles
                      options={pool.map((f) => ({
                        value: String(f.id),
                        label: f.isFixed ? `${f.name} (fixed)` : f.name,
                      }))}
                      value={(c.facultyIds || []).map(String)}
                      onChange={(v) => setConf(course.id, { facultyIds: v })}
                    />
                  </Field>
                ) : null}

                {c.facultyMode !== 'AUTOMATIC' && splitting && subs.length ? (
                  <>
                    <p className="hint">
                      This course splits into sub-sections. Siblings may run at the same time only when each
                      has a <strong>different teacher and a different room</strong>, so give each one its own teacher.
                    </p>
                    <div className="field-grid tight">
                      {subs.map((ss) => (
                        <Field key={ss.id} label={ss.name} hint="Empty means the engine picks for this sub-section.">
                          <Select
                            value={String((c.subSectionFaculty[ss.id] || [])[0] || '')}
                            placeholder="Engine decides"
                            options={pool.map((f) => ({ value: String(f.id), label: f.name }))}
                            onChange={(e) => setConf(course.id, {
                              subSectionFaculty: {
                                ...c.subSectionFaculty,
                                [ss.id]: e.target.value ? [Number(e.target.value)] : [],
                              },
                            })}
                          />
                        </Field>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 4 -- Rooms
// ---------------------------------------------------------------------------
function StepRooms({ chosen, conf, setConf, wizard, subSectionsOf }) {
  if (!chosen.length) {
    return (
      <Card title="Step 4 · Rooms">
        <EmptyState icon="○" title="No courses selected">
          Go back to step 2 and tick some courses.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card
      title="Step 4 · Which rooms?"
      subtitle="Automatic is the recommended answer — the engine matches capacity, AC and facilities for you."
    >
      <Notice tone="info" icon="◇">
        Every room says whether it is <AcBadge isAc={1} soft /> or <AcBadge isAc={0} soft />, because that is
        never inferred. A course marked <strong>AC Required</strong> is only ever placed in an AC room.
      </Notice>

      <div className="stack mt">
        {chosen.map((course) => {
          const c = conf(course.id);
          const subs = subSectionsOf(course);
          const splitting = c.splitIntoSubSections === null ? course.canSplit : c.splitIntoSubSections;
          const need = String(c.acRequirement || course.ac_requirement || 'NOT_REQUIRED').toUpperCase();
          const pool = wizard.rooms.filter((r) => {
            if (need === 'REQUIRED' && !r.is_ac) return false;
            if (c.requiredRoomType && r.room_type !== c.requiredRoomType) return false;
            return true;
          });
          return (
            <div key={course.id} className="course-row">
              <div className="course-row-head">
                <span className="course-title">
                  <span className="course-name">{course.code} · {course.name}</span>
                  <span className="course-meta">
                    {pool.length} of {wizard.rooms.length} rooms match its requirements
                  </span>
                </span>
                <AcRequirement value={need} />
                {c.roomMode === 'AUTOMATIC'
                  ? <AutoTag>Engine picks</AutoTag>
                  : <Badge tone="info">{modeLabel(c.roomMode)}</Badge>}
              </div>
              <div className="course-row-body">
                <Field label="How to choose" hint={SELECTION_HELP[c.roomMode]}>
                  <Select
                    value={c.roomMode}
                    options={wizard.selectionModes.map((m) => ({ value: m, label: modeLabel(m) }))}
                    onChange={(e) => setConf(course.id, { roomMode: e.target.value })}
                  />
                </Field>

                {c.roomMode !== 'AUTOMATIC' && !splitting ? (
                  <Field label="Rooms" hint="Nothing ticked still means the engine decides.">
                    <ChipToggles
                      options={pool.map((r) => ({
                        value: String(r.id),
                        label: `${r.name || r.room_number} · ${r.acLabel} · ${r.capacity || '?'} seats`,
                      }))}
                      value={(c.roomIds || []).map(String)}
                      onChange={(v) => setConf(course.id, { roomIds: v })}
                    />
                  </Field>
                ) : null}

                {c.roomMode !== 'AUTOMATIC' && splitting && subs.length ? (
                  <div className="field-grid tight">
                    {subs.map((ss) => (
                      <Field
                        key={ss.id} label={ss.name}
                        hint="Siblings sharing a slot need different rooms."
                      >
                        <Select
                          value={String((c.subSectionRooms[ss.id] || [])[0] || '')}
                          placeholder="Engine decides"
                          options={pool.map((r) => ({
                            value: String(r.id),
                            label: `${r.name || r.room_number} · ${r.acLabel}`,
                          }))}
                          onChange={(e) => setConf(course.id, {
                            subSectionRooms: {
                              ...c.subSectionRooms,
                              [ss.id]: e.target.value ? [Number(e.target.value)] : [],
                            },
                          })}
                        />
                      </Field>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 5 -- Time (Section 4: everything read from the college's own timing)
// ---------------------------------------------------------------------------
function StepTime({ chosen, conf, setConf, wizard }) {
  const timing = wizard.timing;

  if (!chosen.length) {
    return (
      <Card title="Step 5 · Time">
        <EmptyState icon="○" title="No courses selected">
          Go back to step 2 and tick some courses.
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <Card
        title={`Step 5 · Time — read from "${timing.name}"`}
        subtitle="Nothing about the clock is hardcoded. Days, periods and breaks all come from this college's own timing configuration."
        actions={<Link className="btn small ghost" to="/timing">Edit timing</Link>}
      >
        <div className="stat-row">
          <div className="stat">
            <span className="stat-value">{timing.workingDays.length}</span>
            <span className="stat-label">Working days</span>
          </div>
          <div className="stat">
            <span className="stat-value">{timing.slots.length}</span>
            <span className="stat-label">Periods a day</span>
          </div>
          <div className="stat">
            <span className="stat-value">{timing.slotMinutes}</span>
            <span className="stat-label">Minutes a period</span>
          </div>
          <div className="stat">
            <span className="stat-value">{timing.weeklyCapacity}</span>
            <span className="stat-label">Slots a week</span>
          </div>
        </div>
        {timing.warnings && timing.warnings.length ? (
          <Notice tone="warn" title="Worth reviewing in the timing configuration">
            <ul>{timing.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </Notice>
        ) : null}
        <div className="chip-row mt">
          {timing.slots.map((s) => (
            <span key={s.index} className="chip">P{s.index + 1} · {formatTimeRange(s.start, s.end)}</span>
          ))}
        </div>
      </Card>

      <Card
        title="Pin anything that must not move"
        subtitle="Leave a course on Automatic and the engine places it wherever it fits best."
      >
        <div className="stack">
          {chosen.map((course) => {
            const c = conf(course.id);
            return (
              <div key={course.id} className="course-row">
                <div className="course-row-head">
                  <span className="course-title">
                    <span className="course-name">{course.code} · {course.name}</span>
                    <span className="course-meta">{course.periodsPerWeek} periods a week</span>
                  </span>
                  {c.timeMode === 'AUTOMATIC'
                    ? <AutoTag>Engine picks</AutoTag>
                    : <Badge tone="info">{modeLabel(c.timeMode)}</Badge>}
                </div>
                <div className="course-row-body">
                  <Field label="How to choose the day and period">
                    <Select
                      value={c.timeMode}
                      options={TIME_MODE_OPTIONS}
                      onChange={(e) => setConf(course.id, { timeMode: e.target.value })}
                    />
                  </Field>

                  {c.timeMode === 'PREFERRED' ? (
                    <div className="field-grid tight">
                      <div className="span-2">
                        <Field label="Preferred days" hint="Empty means any working day.">
                          <ChipToggles
                            options={timing.workingDays.map((d) => ({ value: String(d), label: dayName(d) }))}
                            value={(c.preferredDays || []).map(String)}
                            onChange={(v) => setConf(course.id, { preferredDays: v })}
                          />
                        </Field>
                      </div>
                      <Field label="Not before" hint="Empty means from the first period.">
                        <TextInput
                          type="time" value={c.windowStart}
                          onChange={(e) => setConf(course.id, { windowStart: e.target.value })}
                        />
                      </Field>
                      <Field label="Not after" hint="Empty means until the last period.">
                        <TextInput
                          type="time" value={c.windowEnd}
                          onChange={(e) => setConf(course.id, { windowEnd: e.target.value })}
                        />
                      </Field>
                    </div>
                  ) : null}

                  {c.timeMode === 'FIXED' ? (
                    <FixedSlotPicker
                      timing={timing}
                      value={c.fixedSlots || []}
                      onChange={(fixedSlots) => setConf(course.id, { fixedSlots })}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

function FixedSlotPicker({ timing, value, onChange }) {
  const has = (day, periodIndex) => value
    .some((s) => Number(s.day) === day && Number(s.periodIndex) === periodIndex);
  const toggle = (day, periodIndex) => {
    onChange(has(day, periodIndex)
      ? value.filter((s) => !(Number(s.day) === day && Number(s.periodIndex) === periodIndex))
      : [...value, { day, periodIndex }]);
  };
  return (
    <Field
      label="Fixed slots"
      hint={value.length
        ? `${value.length} slot(s) pinned. The engine will not move these.`
        : 'Nothing pinned yet — click the periods this course must occupy.'}
    >
      <div className="tt-wrap">
        <table className="tt dense">
          <thead>
            <tr>
              <th />
              {timing.slots.map((s) => (
                <th key={s.index}>
                  P{s.index + 1}
                  <span className="slot-time">{formatTimeRange(s.start, s.end)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {timing.workingDays.map((day) => (
              <tr key={day}>
                <th className="tt-day">{dayName(day)}</th>
                {timing.slots.map((s) => (
                  <td
                    key={s.index}
                    role="button"
                    className={`tt-cell ${has(day, s.index) ? 'selected' : 'empty'}`}
                    onClick={() => toggle(day, s.index)}
                  >
                    {has(day, s.index) ? '● pinned' : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Step 6 -- Review & Generate
// ---------------------------------------------------------------------------
function StepReview({
  wizard, preview, previewing, previewError, onRefresh,
  target, setTarget, chosen, mode, runError, running, onRun,
}) {
  return (
    <>
      <Card
        title="Step 6 · Review"
        subtitle="This is exactly what will be handed to the engine."
        actions={(
          <button type="button" className="btn small ghost" onClick={onRefresh} disabled={previewing}>
            Refresh
          </button>
        )}
      >
        {previewError ? <Notice tone="bad" title="Could not build the preview">{previewError}</Notice> : null}
        {previewing && !preview ? <Loading label="Working out what will be scheduled…" /> : null}

        {preview ? (
          <>
            <div className="stat-row">
              <div className="stat">
                <span className="stat-value">{preview.classesToSchedule}</span>
                <span className="stat-label">Classes to place</span>
              </div>
              <div className="stat">
                <span className="stat-value">{preview.periodsNeeded}</span>
                <span className="stat-label">Periods needed</span>
              </div>
              <div className={`stat ${preview.capacity.feasible ? 'good' : 'bad'}`}>
                <span className="stat-value">{preview.capacity.utilisationPercent}%</span>
                <span className="stat-label">Room utilisation</span>
                <span className="stat-foot">{preview.capacity.roomPeriodsAvailable} room-periods available</span>
              </div>
              <div className="stat">
                <span className="stat-value">{preview.parallelGroups}</span>
                <span className="stat-label">Parallel sub-section groups</span>
              </div>
            </div>

            <Notice
              tone={preview.canRun ? (preview.warnings.length ? 'warn' : 'ok') : 'bad'}
              title={preview.verdict}
            >
              {preview.engineWillDecide && preview.engineWillDecide.length ? (
                <ul>{preview.engineWillDecide.map((l, i) => <li key={i}>{l}</li>)}</ul>
              ) : (
                <span>You fixed every teacher, room and time yourself.</span>
              )}
            </Notice>

            {preview.issues && preview.issues.length ? (
              <Notice tone="bad" title="These must be fixed first">
                <ul>{preview.issues.map((x, i) => <li key={i}>{x.message || String(x)}</li>)}</ul>
              </Notice>
            ) : null}
            {preview.warnings && preview.warnings.length ? (
              <Notice tone="warn" title="Worth a look before you generate">
                <ul>{preview.warnings.map((x, i) => <li key={i}>{x.message || String(x)}</li>)}</ul>
              </Notice>
            ) : null}

            <div className="table-wrap mt">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Section</th>
                    <th>Component</th>
                    <th className="num">Periods</th>
                    <th className="num">Students</th>
                    <th>AC</th>
                    <th>Teacher</th>
                    <th className="num">Room options</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.classes.map((k) => (
                    <tr key={k.id} className={k.feasible ? '' : 'row-bad'}>
                      <td className="bold">{k.courseCode} <span className="muted">{k.courseName}</span></td>
                      <td>{k.subSectionName ? `${k.sectionName} / ${k.subSectionName}` : k.sectionName}</td>
                      <td className="muted">{k.componentLabel}</td>
                      <td className="num">{k.periods}</td>
                      <td className="num">{k.students}</td>
                      <td><AcRequirement value={k.acRequirement} showNotRequired={false} /></td>
                      <td>{k.teacher ? k.teacher.name : <AutoTag />}</td>
                      <td className="num">{k.roomChoices == null ? <AutoTag /> : k.roomChoices}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Card>

      <Card
        title="Where should the result go?"
        subtitle="Locked classes are never moved, whichever timetable you pick."
      >
        <div className="field-grid">
          <Field label="Timetable" hint="Empty creates a new one.">
            <Select
              value={target.timetableId}
              placeholder="Create a new timetable"
              options={wizard.timetables.map((t) => ({
                value: t.id,
                label: `${t.name} · ${t.status} · ${t.classes} classes${t.locked ? ` · ${t.locked} locked` : ''}`,
              }))}
              onChange={(e) => setTarget({ ...target, timetableId: e.target.value })}
            />
          </Field>
          <Field label="Name for the new timetable" hint="Leave empty and one is named for you.">
            <TextInput
              value={target.timetableName}
              placeholder={`${modeLabel(mode)} · ${chosen.length} course(s)`}
              disabled={!!target.timetableId}
              onChange={(e) => setTarget({ ...target, timetableName: e.target.value })}
            />
          </Field>
        </div>
        <Checkbox
          label="Keep locked classes exactly where they are"
          hint="Section 8: a locked assignment is never moved by a re-generation."
          checked={target.keepLocked}
          onChange={(e) => setTarget({ ...target, keepLocked: e.target.checked })}
        />
        <Checkbox
          label="Also keep classes I placed by hand"
          hint="Off means manual placements are rebuilt along with everything else."
          checked={target.keepManual}
          onChange={(e) => setTarget({ ...target, keepManual: e.target.checked })}
        />

        {runError ? <Notice tone="bad" title="The run failed">{runError}</Notice> : null}

        <div className="btn-row mt">
          <button type="button" className="btn" disabled={running} onClick={() => onRun(true)}>
            {running ? 'Working…' : 'Dry run — do not save'}
          </button>
          <span className="muted small">
            A dry run shows the same results panel without touching any saved timetable.
          </span>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Generation Results panel (Section 5.6)
// ---------------------------------------------------------------------------
function ResultsPanel({ result, onBack, onOpenViews, onOpenManual }) {
  const s = result.stats || {};
  return (
    <div className="page wide">
      <PageHead
        title={result.dryRun ? 'Dry run results' : 'Generation results'}
        subtitle={result.headline}
        breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Generate' }, { label: 'Results' }]}
        actions={(
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={onBack}>← Change something and re-run</button>
            {result.dryRun ? null : (
              <button type="button" className="btn primary" onClick={onOpenViews}>Open the timetable</button>
            )}
          </div>
        )}
      />

      {result.dryRun ? (
        <Notice tone="info" icon="◇" title="Nothing was saved">
          This was a dry run. Go back and use <strong>Generate Timetable</strong> to keep the result.
        </Notice>
      ) : null}

      <div className="grid cols-2">
        <Card title="Quality Score" subtitle="0–100, from how well the soft rules were satisfied.">
          <div className="result-head">
            <ScoreDial score={result.qualityScore} label={result.ok ? 'Complete' : 'Needs attention'} />
            <div className="result-text">
              <p>{result.headline}</p>
              <p className="muted small">
                Finished in {Math.round((result.elapsedMs || 0) / 10) / 100}s.
              </p>
            </div>
          </div>
        </Card>

        <Card title="What happened">
          <div className="stat-row">
            <div className="stat good">
              <span className="stat-value">{s.classesScheduled || 0}</span>
              <span className="stat-label">Scheduled</span>
            </div>
            <div className={`stat ${s.classesUnscheduled ? 'warn' : ''}`}>
              <span className="stat-value">{s.classesUnscheduled || 0}</span>
              <span className="stat-label">Unplaced</span>
            </div>
            <div className={`stat ${s.hardConflicts ? 'bad' : 'good'}`}>
              <span className="stat-value">{s.hardConflicts || 0}</span>
              <span className="stat-label">Hard conflicts</span>
            </div>
            <div className="stat">
              <span className="stat-value">{s.softWarnings || 0}</span>
              <span className="stat-label">Soft warnings</span>
            </div>
          </div>
          <dl className="kv">
            <dt>Courses considered</dt><dd>{s.coursesConsidered || 0}</dd>
            <dt>Classes required</dt><dd>{s.classesRequired || 0}</dd>
            <dt>Parallel sub-section groups</dt><dd>{s.parallelGroups || 0}</dd>
            {result.timetable ? (<><dt>Timetable</dt><dd>{result.timetable.name}</dd></>) : null}
          </dl>
        </Card>
      </div>

      {result.engineDecided && result.engineDecided.length ? (
        <Card title="What the engine decided for you">
          <ul>{result.engineDecided.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </Card>
      ) : null}

      {result.unscheduled && result.unscheduled.length ? (
        <Card
          title={`Could not be placed (${result.unscheduled.length})`}
          subtitle="Each one says why, so you can fix the cause rather than guess."
        >
          <div className="stack tight">
            {result.unscheduled.map((u, i) => (
              <div key={i} className="unplaced">
                <span className="unplaced-label">
                  {u.label}{' '}
                  {u.occurrences > 1 ? <Badge tone="warn">{u.occurrences} occurrences</Badge> : null}
                </span>
                <ul>{(u.reasons || []).map((r, j) => <li key={j}>{r.message}</li>)}</ul>
              </div>
            ))}
          </div>
          <div className="btn-row mt">
            <button type="button" className="btn" onClick={onOpenManual}>Place these by hand →</button>
          </div>
        </Card>
      ) : null}

      {result.issues && result.issues.length ? (
        <Notice tone="bad" title="Issues">
          <ul>{result.issues.map((x, i) => <li key={i}>{x.message || String(x)}</li>)}</ul>
        </Notice>
      ) : null}
      {result.warnings && result.warnings.length ? (
        <Notice tone="warn" title="Warnings">
          <ul>{result.warnings.map((x, i) => <li key={i}>{x.message || String(x)}</li>)}</ul>
        </Notice>
      ) : null}

      {result.nextSteps && result.nextSteps.length ? (
        <Card title="Suggested next steps">
          <ol>{result.nextSteps.map((n, i) => <li key={i}>{typeof n === 'string' ? n : n.message}</li>)}</ol>
        </Card>
      ) : null}
    </div>
  );
}
