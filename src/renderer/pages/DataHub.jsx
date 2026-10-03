import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  Bar, Card, EmptyState, Loading, Notice, PageHead,
} from '../components/ui.jsx';
import { pluralise, scoreBand } from '../lib/format.js';

/**
 * Data Management (Section 1) and Data Setup Progress (Section 9) on one screen.
 *
 * The tiles are built from the entity registry the server sends, not from a list
 * kept here -- so an entity or a field added on the server appears on this screen
 * without any change to the renderer. Nothing about the university is hardcoded.
 */

/** The order the groups are worked through when setting up a college. */
const GROUP_ORDER = [
  'Institution', 'Academic Structure', 'Students', 'People', 'Infrastructure', 'Configuration',
];

const GROUP_HELP = {
  Institution: 'The university and its colleges.',
  'Academic Structure': 'Departments, programmes, semesters and the courses taught in them.',
  Students: 'Batches, sections, sub-sections and the students themselves.',
  People: 'Teachers, when they are available, and what they can teach.',
  Infrastructure: 'Buildings, floors and rooms — with AC status and capacity.',
  Configuration: 'Each college\'s own working days, period times and breaks.',
};

export default function DataHub() {
  const auth = useAuth();
  const [registry, setRegistry] = useState(null);
  const [counts, setCounts] = useState({});
  const [readiness, setReadiness] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get('/meta/registry'),
      api.get('/meta/counts').catch(() => ({ counts: {} })),
      // A Super Admin with no college chosen has nothing to be ready for.
      auth.activeCollegeId ? api.get('/meta/readiness').catch(() => null) : Promise.resolve(null),
    ])
      .then(([reg, cnt, ready]) => {
        if (cancelled) return;
        setRegistry(reg);
        setCounts(cnt.counts || {});
        setReadiness(ready);
        setError(null);
      })
      .catch((err) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [auth.activeCollegeId]);

  const groups = useMemo(() => {
    if (!registry) return [];
    const visible = registry.entities.filter((e) => {
      // Only a Super Admin manages universities; everyone else would only see a
      // refusal from the server.
      if (e.superAdminOnly && !auth.isSuperAdmin) return false;
      return true;
    });
    const byGroup = new Map();
    for (const entity of visible) {
      const key = entity.group || 'Other';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(entity);
    }
    const known = GROUP_ORDER.filter((g) => byGroup.has(g));
    const rest = [...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g));
    return [...known, ...rest].map((name) => ({ name, entities: byGroup.get(name) }));
  }, [registry, auth.isSuperAdmin]);

  if (loading) return <main className="page"><Loading label="Reading the data model…" /></main>;

  if (error) {
    return (
      <main className="page">
        <PageHead title="Data Management" />
        <Notice tone="bad" title="Could not load the data model">{error.message}</Notice>
      </main>
    );
  }

  const percent = readiness && readiness.progress ? readiness.progress.percent : null;

  return (
    <main className="page">
      <PageHead
        title="Data Management"
        subtitle="Everything the scheduler works from. Add it by hand, or import a filled-in Excel template."
        actions={(
          <>
            <Link className="btn small" to="/import">Import &amp; Export</Link>
            <Link className="btn small" to="/timing">Timing Configuration</Link>
          </>
        )}
      />

      {readiness ? (
        <Card
          title="Data Setup Progress"
          subtitle={readiness.canGenerate
            ? 'Everything the Generation Wizard needs is in place.'
            : `${pluralise((readiness.blocking || []).length, 'thing')} still needed before a timetable can be generated.`}
          actions={readiness.canGenerate ? <Link className="btn primary small" to="/generate">Generate a timetable</Link> : null}
        >
          <div className="mb">
            <Bar value={percent || 0} band={scoreBand(percent || 0)} />
            <div className="tiny muted">
              {readiness.progress.done} of {readiness.progress.total} steps done
              {percent != null ? ` · ${percent}%` : ''}
            </div>
          </div>

          <div className="stack tight">
            {(readiness.findings || []).map((finding) => (
              <div key={finding.key} className={`check-item ${finding.status}`}>
                <span className="check-mark" aria-hidden="true">
                  {finding.status === 'OK' ? '✓' : finding.status === 'WARN' ? '!' : '✕'}
                </span>
                <span className="check-text">
                  <span className="check-label">
                    {finding.label}
                    {finding.optional ? <span className="muted tiny"> · optional</span> : null}
                  </span>
                  <span className="check-msg">{finding.message}</span>
                  {typeof finding.detail === 'string' ? <span className="check-msg tiny">{finding.detail}</span> : null}
                </span>
                {finding.action ? (
                  <Link
                    className="btn tiny"
                    to={finding.action.entity === 'college_timings' ? '/timing' : `/data/${finding.action.entity}`}
                  >
                    {finding.action.label}
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : auth.isSuperAdmin ? (
        <Notice tone="info" title="Choose a college to see its setup progress">
          Use the college switcher at the top of the window. Setup progress and readiness are per college,
          because each college has its own timings, rooms and staff.
        </Notice>
      ) : null}

      {groups.map((group) => (
        <Card key={group.name} title={group.name} subtitle={GROUP_HELP[group.name]}>
          <div className="tile-grid">
            {group.entities.map((entity) => {
              const count = counts[entity.key];
              const to = entity.customEditor === 'timing' ? '/timing' : `/data/${entity.key}`;
              return (
                <Link key={entity.key} className="tile" to={to}>
                  <span className="tile-count">{count == null ? '—' : count}</span>
                  <span className="tile-label">{entity.label}</span>
                  {entity.help ? <span className="tile-help">{entity.help}</span> : null}
                  {entity.superAdminOnly ? <span className="tile-tag">Super Admin only</span> : null}
                  {entity.customEditor === 'timing' ? <span className="tile-tag">Own editor</span> : null}
                </Link>
              );
            })}
          </div>
        </Card>
      ))}

      {groups.length === 0 ? <EmptyState title="Nothing to manage" /> : null}

      <Card title="Scheduling rules" subtitle="The limits the generator must respect (Section 13).">
        <p className="muted">
          Maximum periods a day, whether a teacher may be given back-to-back classes, how labs should be
          blocked — these are per college and have sensible defaults.
        </p>
        <Link className="btn small" to="/rules">Open scheduling rules</Link>
      </Card>
    </main>
  );
}
