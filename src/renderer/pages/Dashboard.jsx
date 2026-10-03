import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import TimetableGrid, { TimetableList } from '../components/TimetableGrid.jsx';
import AssignmentModal from '../components/CardActions.jsx';
import {
  Bar, Badge, Card, EmptyState, Loading, Notice, PageHead, ScoreDial, ScorePill, Stat,
} from '../components/ui.jsx';
import {
  dayName, formatDateTime, pluralise, scoreBand, timeAgo,
} from '../lib/format.js';

/**
 * One endpoint, four dashboards (Section 7.2).
 *
 * The server decides which shape to return from the signed-in role -- the
 * renderer never asks for "the faculty dashboard", it asks for *its* dashboard
 * and draws whatever came back. That way a faculty member who guesses a URL
 * still cannot obtain a coordinator's roll-up.
 */

export default function Dashboard() {
  const auth = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get('/meta/dashboard')
      .then((body) => { setData(body); setError(null); })
      .catch((err) => { setError(err); setData(null); })
      .finally(() => setLoading(false));
  };

  useEffect(load, [auth.activeCollegeId]);

  if (loading) return <main className="page"><Loading label="Opening your dashboard…" /></main>;

  if (error) {
    return (
      <main className="page">
        <PageHead title="Dashboard" />
        <Notice tone="bad" title="The dashboard could not be loaded" actions={<button type="button" className="btn small" onClick={load}>Try again</button>}>
          {error.message}
        </Notice>
      </main>
    );
  }

  if (!data) return null;

  if (data.kind === 'SUPER_ADMIN_ALL_COLLEGES') return <SuperAdminDashboard data={data} onRefresh={load} />;
  if (data.kind === 'COORDINATOR') return <CoordinatorDashboard data={data} onRefresh={load} />;
  if (data.kind === 'FACULTY') return <FacultyDashboard data={data} />;
  if (data.kind === 'STUDENT') return <StudentDashboard data={data} />;
  return <main className="page"><EmptyState title="Nothing to show yet" /></main>;
}

// ---------------------------------------------------------------------------
// Super Admin -- every college at once, with no college selected
// ---------------------------------------------------------------------------
function SuperAdminDashboard({ data, onRefresh }) {
  const auth = useAuth();
  const navigate = useNavigate();

  const open = (collegeId) => {
    auth.switchCollege(collegeId);
    navigate('/');
  };

  return (
    <main className="page">
      <PageHead
        title={data.settings.institutionName || 'All colleges'}
        subtitle={data.settings.session ? `Academic session ${data.settings.session}` : 'Every college on this installation'}
        actions={<button type="button" className="btn small" onClick={onRefresh}>Refresh</button>}
      />

      <div className="stat-row">
        <Stat value={data.totals.colleges} label="Colleges" />
        <Stat value={data.totals.faculty} label="Faculty" />
        <Stat value={data.totals.students} label="Students" />
        <Stat value={data.totals.rooms} label="Rooms" />
        <Stat value={data.totals.classes} label="Classes scheduled" />
      </div>

      <Card
        title="Colleges"
        subtitle="Pick one to work inside it — everything else on this screen is a roll-up."
      >
        {data.colleges.length === 0 ? (
          <EmptyState
            icon="＋"
            title="No colleges yet"
            action={<Link className="btn primary" to="/data/colleges">Add the first college</Link>}
          >
            A college owns its own timing configuration, so nothing can be scheduled until one exists.
          </EmptyState>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>College</th>
                <th>Setup</th>
                <th>Timetable</th>
                <th className="num">Sections</th>
                <th className="num">Faculty</th>
                <th className="num">Rooms</th>
                <th className="num">Classes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.colleges.map((college) => (
                <tr key={college.id}>
                  <td>
                    <strong>{college.name}</strong>
                    {college.code ? <span className="muted"> · {college.code}</span> : null}
                  </td>
                  <td style={{ minWidth: 130 }}>
                    {college.readiness ? (
                      <>
                        <Bar value={college.readiness.percent} band={scoreBand(college.readiness.percent)} slim />
                        <span className="tiny muted">
                          {college.readiness.percent}%{college.readiness.canGenerate ? ' · ready' : ' · not ready'}
                        </span>
                      </>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td>
                    {college.timetable ? (
                      <>
                        <Badge tone={college.timetable.status === 'PUBLISHED' ? 'ok' : 'plain'}>
                          {college.timetable.status}
                        </Badge>
                        {college.timetable.qualityScore != null ? (
                          <> <ScorePill score={college.timetable.qualityScore} /></>
                        ) : null}
                      </>
                    ) : <span className="muted">none</span>}
                  </td>
                  <td className="num">{college.counts.sections}</td>
                  <td className="num">{college.counts.faculty}</td>
                  <td className="num">{college.counts.rooms}</td>
                  <td className="num">{college.counts.classes}</td>
                  <td className="right">
                    <button type="button" className="btn small" onClick={() => open(college.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Universities" subtitle="Colleges belong to a university.">
        {data.universities.length === 0 ? (
          <EmptyState title="No universities yet" action={<Link className="btn" to="/data/universities">Add one</Link>} />
        ) : (
          <div className="chip-row">
            {data.universities.map((u) => (
              <span key={u.id} className="chip">{u.name}{u.code ? ` (${u.code})` : ''}</span>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Timetable Coordinator (and Super Admin inside one college)
// ---------------------------------------------------------------------------
function CoordinatorDashboard({ data, onRefresh }) {
  const { readiness, timing, timetable, conflicts, counts } = data;
  const percent = readiness && readiness.progress ? readiness.progress.percent : 0;
  const blocking = (readiness && readiness.blocking) || [];

  return (
    <main className="page">
      <PageHead
        title={data.college ? data.college.name : 'Dashboard'}
        subtitle={timing && !timing.error
          ? `${timing.name} · ${timing.workingDays.length} days a week · ${timing.periods} periods of ${timing.slotMinutes} min`
          : 'Timing configuration is not set up yet'}
        actions={(
          <>
            <button type="button" className="btn small" onClick={onRefresh}>Refresh</button>
            <Link className="btn small" to="/views">View timetable</Link>
            <Link className="btn primary small" to="/generate">Generate</Link>
          </>
        )}
      />

      {/* Section 9: the gate. Nothing can be generated until this is clear. */}
      {readiness && !readiness.canGenerate ? (
        <Notice
          tone="warn"
          title={`Setup is ${percent}% complete — ${pluralise(blocking.length, 'thing')} still needed before a timetable can be generated`}
          actions={<Link className="btn small" to="/data">Go to Data Management</Link>}
        >
          <ul>
            {blocking.slice(0, 5).map((finding) => (
              <li key={finding.key}>
                {finding.message}
                {finding.action ? <> — <Link to={`/data/${finding.action.entity}`}>{finding.action.label}</Link></> : null}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {timing && timing.error ? (
        <Notice tone="bad" title="This college has no working timing configuration" actions={<Link className="btn small" to="/timing">Set it up</Link>}>
          {timing.error}
        </Notice>
      ) : null}

      <div className="stat-row">
        <Stat value={counts.sections || 0} label="Sections" />
        <Stat value={counts.courses || 0} label="Courses" />
        <Stat value={counts.faculty || 0} label="Faculty" />
        <Stat value={counts.rooms || 0} label="Rooms" />
        <Stat value={counts.students || 0} label="Students" />
      </div>

      <div className="grid cols-2">
        <Card
          title="Current timetable"
          actions={timetable ? <Link className="btn small" to="/timetables">Versions &amp; history</Link> : null}
        >
          {!timetable ? (
            <EmptyState
              icon="⚡"
              title="No timetable yet"
              action={<Link className="btn primary" to="/generate">Open the Generation Wizard</Link>}
            >
              {readiness && readiness.canGenerate
                ? 'Your data is ready. Choose a section, tell the wizard what to keep fixed, and let it work out the rest.'
                : 'Finish the setup above first.'}
            </EmptyState>
          ) : (
            <div className="split-head">
              <div>
                <h3 className="tight">{timetable.name}</h3>
                <div className="muted tiny">
                  <Badge tone={timetable.status === 'PUBLISHED' ? 'ok' : 'plain'}>{timetable.status}</Badge>
                  {timetable.academic_session ? ` · ${timetable.academic_session}` : ''}
                  {timetable.updated_at ? ` · updated ${timeAgo(timetable.updated_at)}` : ''}
                </div>
                {conflicts ? (
                  <div className="stack tight mt">
                    <div className="fact-row">
                      <span>Classes: <strong>{conflicts.classes}</strong></span>
                      <span>
                        Hard conflicts:{' '}
                        <strong className={conflicts.hardConflicts ? 'bad-text' : 'ok-text'}>
                          {conflicts.hardConflicts}
                        </strong>
                      </span>
                      <span>Soft warnings: <strong>{conflicts.softWarnings}</strong></span>
                    </div>
                  </div>
                ) : null}
              </div>
              {timetable.quality_score != null ? (
                <ScoreDial score={timetable.quality_score} label="Quality" />
              ) : null}
            </div>
          )}
        </Card>

        <Card title="Data Setup Progress" subtitle="Section 9 — what the scheduler still needs.">
          <div className="mb">
            <Bar value={percent} band={scoreBand(percent)} />
            <div className="tiny muted">
              {readiness && readiness.progress
                ? `${readiness.progress.done} of ${readiness.progress.total} steps done`
                : ''}
            </div>
          </div>
          <div className="stack tight">
            {(readiness && readiness.findings ? readiness.findings : []).slice(0, 8).map((finding) => (
              <div key={finding.key} className={`check-item ${finding.status}`}>
                <span className="check-mark" aria-hidden="true">
                  {finding.status === 'OK' ? '✓' : finding.status === 'WARN' ? '!' : '✕'}
                </span>
                <span className="check-text">
                  <span className="check-label">{finding.label}</span>
                  <span className="check-msg">{finding.message}</span>
                </span>
                {finding.action ? (
                  <Link className="btn tiny" to={`/data/${finding.action.entity}`}>{finding.action.label}</Link>
                ) : null}
              </div>
            ))}
          </div>
          <p className="card-note mt"><Link to="/data">See all setup steps</Link></p>
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Teacher workload" subtitle="Periods scheduled against each teacher's declared maximum.">
          {!data.workload || !data.workload.length ? (
            <EmptyState title="No faculty yet" action={<Link className="btn" to="/data/faculty">Add faculty</Link>} />
          ) : (
            <table className="data compact">
              <thead>
                <tr><th>Teacher</th><th className="num">Periods</th><th>Load</th></tr>
              </thead>
              <tbody>
                {data.workload.slice(0, 10).map((f) => (
                  <tr key={f.id} className={f.overloaded ? 'row-bad' : undefined}>
                    <td>
                      {f.name}
                      {f.designation ? <span className="muted tiny"> · {f.designation}</span> : null}
                    </td>
                    <td className="num">
                      {f.periods}{f.maxWeeklyHours ? <span className="muted"> / {f.maxWeeklyHours}</span> : null}
                    </td>
                    <td style={{ minWidth: 110 }}>
                      {f.loadPercent != null ? (
                        <>
                          <Bar value={Math.min(100, f.loadPercent)} band={f.overloaded ? 'bad' : scoreBand(100 - Math.abs(70 - f.loadPercent))} slim />
                          <span className="tiny muted">{f.loadPercent}%{f.overloaded ? ' · over limit' : ''}</span>
                        </>
                      ) : <span className="muted tiny">no limit set</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Room use" subtitle="Section 2 — AC and Non-AC are never hidden.">
          {!data.rooms || !data.rooms.length ? (
            <EmptyState title="No rooms yet" action={<Link className="btn" to="/data/rooms">Add rooms</Link>} />
          ) : (
            <table className="data compact">
              <thead>
                <tr><th>Room</th><th>Seats</th><th className="num">Used</th><th>Utilisation</th></tr>
              </thead>
              <tbody>
                {data.rooms.slice(0, 10).map((room) => (
                  <tr key={room.id}>
                    <td>
                      {room.name}{' '}
                      <span className={room.isAc ? 'badge-ac' : 'badge-nonac'}>{room.isAc ? 'AC' : 'NON-AC'}</span>
                    </td>
                    <td>{room.capacity}</td>
                    <td className="num">{room.periodsUsed}</td>
                    <td style={{ minWidth: 110 }}>
                      <Bar value={room.utilizationPercent} slim />
                      <span className="tiny muted">{room.utilizationPercent}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Recent changes" subtitle="Every manual edit is recorded (Section 8.4).">
          {!data.recentActivity || !data.recentActivity.length ? (
            <p className="muted">Nothing has been changed by hand yet.</p>
          ) : (
            <ul className="feed">
              {data.recentActivity.map((entry) => (
                <li key={entry.id}>
                  <span className="feed-what">{entry.summary || entry.action}</span>
                  <span className="feed-who">
                    {entry.actor_name || entry.username || 'system'} · {formatDateTime(entry.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="This machine">
          <div className="fact-list">
            <div><span>Saved timetables</span><strong>{(data.timetables || []).length}</strong></div>
            <div><span>Last backup</span><strong>{timeAgo(data.lastBackupAt)}</strong></div>
            <div><span>Academic session</span><strong>{timetable ? timetable.academic_session || '—' : '—'}</strong></div>
          </div>
          <p className="card-note mt">
            Everything is stored on this computer. <Link to="/settings">Settings → Backup</Link> makes a copy you
            can keep somewhere safe.
          </p>
        </Card>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Faculty -- their own week, with no edit controls anywhere (Section 12)
// ---------------------------------------------------------------------------
function FacultyDashboard({ data }) {
  const [openCard, setOpenCard] = useState(null);
  const { view, workload, me } = data;

  return (
    <main className="page">
      <PageHead
        title={`Good day, ${me ? me.name : 'there'}`}
        subtitle={`${data.college ? data.college.name : ''}${me && me.designation ? ` · ${me.designation}` : ''}`}
        actions={data.canEditOwnAvailability ? <Link className="btn small" to="/availability">My availability</Link> : null}
      />

      <div className="stat-row">
        <Stat value={data.classes.length} label={`Classes ${data.todayName ? `on ${data.todayName}` : 'today'}`} />
        <Stat value={workload ? workload.periods : 0} label="Periods this week" foot={workload && workload.maxWeeklyHours ? `of ${workload.maxWeeklyHours}` : null} />
        <Stat value={workload ? workload.classes : 0} label="Weekly classes" />
        <Stat value={workload ? workload.daysUsed : 0} label="Days on campus" />
      </div>

      {workload && workload.overloaded ? (
        <Notice tone="warn" title="You are scheduled above your declared weekly maximum">
          {workload.periods} periods against a maximum of {workload.maxWeeklyHours}. Your Timetable Coordinator can
          see the same figure.
        </Notice>
      ) : null}

      <Card title={`Today — ${data.todayName || dayName(data.today)}`}>
        <TimetableList cards={data.classes} onCardClick={(card) => setOpenCard(card.id)} emptyText="Nothing scheduled for you today." />
      </Card>

      <Card title="My week" subtitle="Read only — changes are made by your Timetable Coordinator." flush>
        <TimetableGrid grid={view.grid} cells={view.cells} onCardClick={(card) => setOpenCard(card.id)} />
      </Card>

      {openCard ? (
        <AssignmentModal assignmentId={openCard} canEdit={false} onClose={() => setOpenCard(null)} />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Student -- their own section only (Section 12)
// ---------------------------------------------------------------------------
function StudentDashboard({ data }) {
  const [openCard, setOpenCard] = useState(null);
  const { view, me } = data;

  return (
    <main className="page">
      <PageHead
        title={`Hello, ${me ? me.name : 'there'}`}
        subtitle={[
          data.college ? data.college.name : null,
          me && me.section_name ? `Section ${me.section_name}` : null,
          me && me.sub_section_name ? `Sub-Section ${me.sub_section_name}` : null,
          me && me.roll_number ? `Roll ${me.roll_number}` : null,
        ].filter(Boolean).join(' · ')}
      />

      <div className="stat-row">
        <Stat value={data.classes.length} label={`Classes ${data.todayName ? `on ${data.todayName}` : 'today'}`} />
        <Stat value={view && view.stats ? view.stats.classes : 0} label="Classes this week" />
        <Stat value={view && view.stats ? view.stats.periods : 0} label="Periods this week" />
        <Stat value={view && view.stats ? view.stats.freePeriods : 0} label="Free periods" />
      </div>

      <Card title={`Today — ${data.todayName || dayName(data.today)}`}>
        <TimetableList cards={data.classes} onCardClick={(card) => setOpenCard(card.id)} emptyText="No classes today." />
      </Card>

      <Card title="My timetable" subtitle="Read only." flush>
        <TimetableGrid grid={view.grid} cells={view.cells} onCardClick={(card) => setOpenCard(card.id)} />
      </Card>

      {openCard ? (
        <AssignmentModal assignmentId={openCard} canEdit={false} onClose={() => setOpenCard(null)} />
      ) : null}
    </main>
  );
}
