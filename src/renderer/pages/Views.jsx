/**
 * Section 7 -- Timetable Views.
 *
 * One screen for all ten scopes: College, Department, Program, Semester, Section,
 * Sub-Section, Faculty, Room, Course and Student. The role decides what the view
 * picker even offers -- a Faculty token gets exactly one target (themselves) and
 * a Student gets exactly one (their section) -- and that is enforced by the
 * server, not by hiding the dropdown.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { describeError, downloadFrom } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import TimetableGrid, { TimetableList } from '../components/TimetableGrid.jsx';
import AssignmentModal from '../components/CardActions.jsx';
import {
  Bar, Card, Checkbox, EmptyState, Field, Loading, Meter, Modal, Notice,
  PageHead, ScorePill, Select, Stat, Tabs,
} from '../components/ui.jsx';
import { humanise, slugForFile } from '../lib/format.js';

const TYPE_LABEL = {
  college: 'College', department: 'Department', program: 'Program', semester: 'Semester',
  section: 'Section', sub_section: 'Sub-Section', faculty: 'Faculty', room: 'Room',
  course: 'Course', student: 'Student',
};

const TYPE_HELP = {
  college: 'Everything scheduled anywhere in the college this week.',
  department: 'Every class belonging to one department.',
  program: 'Every class belonging to one program.',
  semester: 'Every section of one semester, side by side in the same grid.',
  section: "One section's own week — the view students and coordinators use most.",
  sub_section: 'One sub-section only, so a split lab reads cleanly.',
  faculty: "One teacher's week, rolled up from every section and sub-section they teach.",
  room: "One room's week, so you can see when it is free.",
  course: 'Every class of one course, across all its sections.',
  student: "One student's week, taken from their section and sub-section.",
};

const EXPORTS = [
  { format: 'pdf', label: 'PDF', kind: 'pdf', ext: 'pdf' },
  { format: 'excel', label: 'Excel', kind: 'excel', ext: 'xlsx' },
  { format: 'csv', label: 'CSV', kind: 'csv', ext: 'csv' },
  { format: 'ical', label: 'Calendar (iCal)', kind: 'ical', ext: 'ics' },
];

export default function Views() {
  const { type: routeType, id: routeId } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const auth = useAuth();

  const [targets, setTargets] = useState(null);
  const [timetables, setTimetables] = useState([]);
  const [type, setType] = useState(routeType || '');
  const [id, setId] = useState(routeId || '');
  const [timetableId, setTimetableId] = useState('');
  const [includeCancelled, setIncludeCancelled] = useState(false);

  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [tab, setTab] = useState('grid');
  const [openCard, setOpenCard] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [exporting, setExporting] = useState('');
  const [exportOpen, setExportOpen] = useState(search.get('export') === '1');

  // File → Export from the application menu navigates here with ?export=1. When
  // this screen is already the one open it does not mount again, so the address
  // has to be followed rather than only read once.
  const exportAsked = search.get('export') === '1';
  useEffect(() => {
    if (exportAsked) setExportOpen(true);
  }, [exportAsked]);

  // --- What can this role even look at? -----------------------------------
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get('/timetable/view-targets'),
      api.get('/timetable').catch(() => ({ rows: [] })),
    ])
      .then(([t, list]) => {
        if (!alive) return;
        setTargets(t);
        setTimetables(list.rows || []);
        // A Faculty or Student token gets exactly one target, so the screen opens
        // straight onto it rather than asking a question with one answer.
        if (!routeType) {
          const only = t.types[0];
          setType(only);
          const rows = t[only] || [];
          if (rows.length === 1) setId(String(rows[0].id));
        }
      })
      .catch((err) => { if (alive) setError(describeError(err)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(() => {
    if (!type) return;
    if (type !== 'college' && !id) { setView(null); setLoading(false); return; }
    setLoading(true);
    const path = type === 'college' ? '/timetable/views/college' : `/timetable/views/${type}/${id}`;
    api.get(path, {
      timetableId: timetableId || undefined,
      includeCancelled: includeCancelled ? '1' : undefined,
    })
      .then((data) => { setView(data); setError(''); })
      .catch((err) => { setView(null); setError(describeError(err)); })
      .finally(() => setLoading(false));
  }, [type, id, timetableId, includeCancelled]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'analysis' || analysis) return;
    api.get('/timetable/analysis', { timetableId: timetableId || undefined })
      .then(setAnalysis)
      .catch(() => setAnalysis({ faculty: [], rooms: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, timetableId]);

  // Keep the URL honest so a view can be linked to and reloaded.
  useEffect(() => {
    if (!type) return;
    const want = type === 'college' ? '/views/college' : (id ? `/views/${type}/${id}` : '/views');
    if (window.location.hash.replace(/^#/, '').split('?')[0] !== want) {
      navigate(want, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id]);

  const options = useMemo(() => (targets && type ? (targets[type] || []) : []), [targets, type]);
  const availableTypes = useMemo(() => (targets ? targets.types : []), [targets]);

  const doExport = (spec) => {
    setExporting(spec.format);
    const scopePath = type === 'college' ? 'college' : `${type}/${id}`;
    const label = view && view.scope ? view.scope.label : type;
    downloadFrom(`/timetable/export/${spec.format}/${scopePath}`, {
      filename: `${slugForFile(label || 'timetable')}.${spec.ext}`,
      kind: spec.kind,
      landscape: true,
      query: { timetableId: timetableId || undefined },
    })
      .then(() => { setExportOpen(false); setSearch({}, { replace: true }); })
      .catch((err) => setError(describeError(err)))
      .finally(() => setExporting(''));
  };

  const readOnly = !(view && view.canEdit);

  if (error && !view) {
    return (
      <div className="page">
        <PageHead title="Timetable" breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Views' }]} />
        <Notice tone="bad" title="Could not open this view">{error}</Notice>
      </div>
    );
  }

  if (!targets) return <Loading label="Loading views…" />;

  const singleTarget = availableTypes.length === 1 && options.length <= 1;

  return (
    <div className="page wide">
      <PageHead
        title={view && view.scope ? view.scope.label : 'Timetable'}
        subtitle={view && view.scope ? `${TYPE_LABEL[view.scope.type] || humanise(view.scope.type)} view` : TYPE_HELP[type]}
        breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Views' }]}
        actions={(
          <div className="btn-row">
            <button type="button" className="btn small ghost" onClick={load}>Refresh</button>
            <button
              type="button" className="btn small" disabled={!view}
              onClick={() => setExportOpen(true)}
            >
              Export
            </button>
          </div>
        )}
      >
        {singleTarget ? (
          <p className="hint">
            {auth.isFaculty
              ? 'You are seeing your own timetable. It is read-only — changes are made by your Timetable Coordinator.'
              : auth.isStudent
                ? "You are seeing your section's timetable. It is read-only."
                : TYPE_HELP[type]}
          </p>
        ) : (
          <div className="field-grid tight">
            <Field label="Look at" hint={TYPE_HELP[type]}>
              <Select
                value={type}
                options={availableTypes.map((t) => ({ value: t, label: TYPE_LABEL[t] || humanise(t) }))}
                onChange={(e) => { setType(e.target.value); setId(''); setView(null); }}
              />
            </Field>
            {type && type !== 'college' ? (
              <Field label={TYPE_LABEL[type] || humanise(type)} required>
                <Select
                  value={id}
                  placeholder={options.length ? `Choose a ${(TYPE_LABEL[type] || type).toLowerCase()}` : 'Nothing recorded yet'}
                  options={options.map((o) => ({ value: o.id, label: o.label }))}
                  onChange={(e) => setId(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Timetable" hint="Empty shows every non-archived timetable together.">
              <Select
                value={timetableId}
                placeholder="All timetables"
                options={timetables.map((t) => ({
                  value: t.id, label: `${t.name} · ${t.status}`,
                }))}
                onChange={(e) => setTimetableId(e.target.value)}
              />
            </Field>
          </div>
        )}
        {!singleTarget ? (
          <Checkbox
            label="Also show cancelled classes"
            checked={includeCancelled}
            onChange={(e) => setIncludeCancelled(e.target.checked)}
          />
        ) : null}
      </PageHead>

      {error ? <Notice tone="warn" title="Something went wrong">{error}</Notice> : null}

      {loading ? <Loading label="Building the view…" /> : null}

      {!loading && !view && type !== 'college' ? (
        <EmptyState icon="○" title={`Choose a ${(TYPE_LABEL[type] || type).toLowerCase()} above`}>
          {TYPE_HELP[type]}
        </EmptyState>
      ) : null}

      {view ? (
        <>
          <div className="grid cols-4">
            <Stat value={view.stats.classes} label="Classes" />
            <Stat value={view.stats.periods} label="Periods used" foot={`${view.stats.freePeriods} free`} />
            <Stat
              value={`${view.stats.utilizationPercent}%`}
              label="Slot utilisation"
              tone={view.stats.utilizationPercent > 95 ? 'warn' : ''}
            />
            <Stat
              value={view.stats.locked}
              label="Locked"
              foot={view.stats.withWarnings ? `${view.stats.withWarnings} with warnings` : 'No warnings'}
              tone={view.stats.withWarnings ? 'warn' : ''}
            />
          </div>

          {view.stats.parallelGroups ? (
            <Notice tone="info" icon="◇" title={`${view.stats.parallelGroups} parallel sub-section group(s)`}>
              Sub-sections sharing a slot are stacked in the same cell. Each one has its own teacher and its
              own room — that is the only way they are allowed to run at the same time.
            </Notice>
          ) : null}

          {readOnly ? (
            <Notice tone="info" icon="◇">
              This view is read-only.{' '}
              {auth.isFaculty || auth.isStudent
                ? 'Ask your Timetable Coordinator for any change.'
                : 'Open it as a coordinator to edit.'}
            </Notice>
          ) : null}

          <Tabs
            tabs={[
              { value: 'grid', label: 'Week grid' },
              { value: 'list', label: `List (${view.cards.length})` },
              { value: 'analysis', label: 'Workload & utilisation' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'grid' ? (
            <Card flush>
              <TimetableGrid
                grid={view.grid}
                cells={view.cells}
                onCardClick={(card) => setOpenCard(card.id)}
                showGroup={view.scope.type !== 'sub_section'}
              />
            </Card>
          ) : null}

          {tab === 'list' ? (
            <Card title="Every class in this view" flush>
              <TimetableList cards={view.cards} onCardClick={(card) => setOpenCard(card.id)} />
            </Card>
          ) : null}

          {tab === 'analysis' ? (
            <AnalysisPanel analysis={analysis} />
          ) : null}
        </>
      ) : null}

      {openCard ? (
        <AssignmentModal
          assignmentId={openCard}
          canEdit={!readOnly}
          onClose={() => setOpenCard(null)}
          onChanged={() => { load(); setAnalysis(null); }}
        />
      ) : null}

      {exportOpen ? (
        <Modal
          title="Export this timetable"
          subtitle={view && view.scope ? view.scope.label : ''}
          onClose={() => { setExportOpen(false); setSearch({}, { replace: true }); }}
        >
          <p className="hint">
            Everything is produced on this machine — no upload, no internet needed.
          </p>
          <div className="stack tight">
            {EXPORTS.map((spec) => (
              <button
                key={spec.format}
                type="button"
                className="btn block"
                disabled={!!exporting}
                onClick={() => doExport(spec)}
              >
                {exporting === spec.format ? 'Preparing…' : `Export as ${spec.label}`}
              </button>
            ))}
          </div>
          <p className="hint mt">
            The calendar file uses local times with no timezone, so it imports cleanly wherever
            the college actually is.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 7.3 -- workload and utilisation beside the grid
// ---------------------------------------------------------------------------
function AnalysisPanel({ analysis }) {
  if (!analysis) return <Loading label="Working out the load…" />;

  return (
    <div className="grid cols-2">
      <Card title="Teacher workload" subtitle="Periods scheduled against each teacher's declared maximum.">
        {analysis.faculty.length === 0 ? (
          <EmptyState icon="○" title="No teachers recorded yet" />
        ) : (
          <div className="table-wrap scroll-y">
            <table className="data compact">
              <thead>
                <tr>
                  <th>Teacher</th><th className="num">Classes</th><th className="num">Periods</th>
                  <th className="num">Days</th><th>Load</th>
                </tr>
              </thead>
              <tbody>
                {analysis.faculty.map((f) => (
                  <tr key={f.id} className={f.overloaded ? 'is-warn' : ''}>
                    <td className="bold">
                      {f.name}
                      {f.designation ? <span className="muted small"> · {f.designation}</span> : null}
                    </td>
                    <td className="num">{f.classes}</td>
                    <td className="num">
                      {f.periods}{f.maxWeeklyHours ? <span className="muted"> / {f.maxWeeklyHours}</span> : null}
                    </td>
                    <td className="num">{f.daysUsed}</td>
                    <td>
                      {f.loadPercent == null ? (
                        <span className="muted small">no maximum recorded</span>
                      ) : (
                        <Bar value={f.loadPercent} band={f.overloaded ? 'bad' : f.loadPercent > 85 ? 'fair' : 'good'} slim />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Room utilisation" subtitle="How much of the week each room is actually used.">
        {analysis.rooms.length === 0 ? (
          <EmptyState icon="○" title="No rooms recorded yet" />
        ) : (
          <div className="table-wrap scroll-y">
            <table className="data compact">
              <thead>
                <tr>
                  <th>Room</th><th>AC</th><th className="num">Seats</th>
                  <th className="num">Classes</th><th>Used</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rooms.map((r) => (
                  <tr key={r.id}>
                    <td className="bold">{r.name || r.roomNumber}</td>
                    <td>
                      <span className={r.isAc ? 'badge-ac soft' : 'badge-nonac soft'}>{r.acLabel}</span>
                    </td>
                    <td className="num">{r.capacity || '—'}</td>
                    <td className="num">{r.classes}</td>
                    <td>
                      <Meter
                        label={`${r.periodsUsed} / ${r.periodsAvailable}`}
                        value={r.utilizationPercent}
                        of={100}
                        suffix="%"
                        band={r.utilizationPercent > 90 ? 'fair' : 'good'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
