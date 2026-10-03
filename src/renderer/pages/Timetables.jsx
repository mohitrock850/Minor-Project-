/**
 * Section 8 -- Saved timetables: manage, validate, publish, roll back.
 *
 * This is the coordinator's shelf. Every generated or hand-built timetable lives
 * here with its own version history, so nothing is ever a one-way door: publish
 * takes an automatic snapshot, clearing takes one first, and any snapshot can be
 * restored. Section 13's checklist can be re-run over a saved timetable at any
 * time, and the audit trail records who changed what.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api, { canOverride, describeError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  Badge, Card, Checkbox, ConfirmModal, EmptyState, Field, Loading, Modal, Notice,
  PageHead, ScorePill, Select, Stat, Tabs, TextInput, ViolationList,
} from '../components/ui.jsx';
import { dayName, formatDateTime, humanise, timeAgo } from '../lib/format.js';

const STATUS_TONE = { PUBLISHED: 'ok', DRAFT: 'info', ARCHIVED: 'plain' };

const MODES = [
  { value: 'AUTOMATIC', label: 'Automatic' },
  { value: 'MANUAL', label: 'Manual' },
  { value: 'HYBRID', label: 'Hybrid (recommended)' },
];

const STATUSES = [
  { value: 'DRAFT', label: 'Draft — still being worked on' },
  { value: 'PUBLISHED', label: 'Published — visible to faculty and students' },
  { value: 'ARCHIVED', label: 'Archived — kept for the record, out of the way' },
];

const AUDIT_LABEL = {
  CREATE: 'Class added',
  CREATE_TIMETABLE: 'Timetable created',
  UPDATE_TIMETABLE: 'Timetable details changed',
  MOVE: 'Class moved',
  CHANGE_TEACHER: 'Teacher changed',
  CHANGE_ROOM: 'Room changed',
  EDIT: 'Class edited',
  CANCEL: 'Class cancelled',
  RESTORE: 'Class restored',
  DUPLICATE: 'Class duplicated',
  LOCK: 'Class locked',
  UNLOCK: 'Class unlocked',
  DELETE: 'Class deleted',
  GENERATE: 'Timetable generated',
  CLEAR: 'Timetable cleared',
  RESTORE_VERSION: 'Version restored',
};

export default function Timetables() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();

  const [rows, setRows] = useState(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(search.get('id') || '');
  const [creating, setCreating] = useState(false);

  const list = useCallback(() => {
    api.get('/timetable', { includeArchived: includeArchived ? '1' : undefined })
      .then((data) => { setRows(data.rows || []); setError(''); })
      .catch((err) => { setRows([]); setError(describeError(err)); });
  }, [includeArchived]);

  useEffect(() => { list(); }, [list]);

  // Keep ?id= in the URL so a timetable can be linked to directly.
  useEffect(() => {
    const next = new URLSearchParams(search);
    if (openId) next.set('id', String(openId)); else next.delete('id');
    setSearch(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  if (!rows) return <Loading label="Loading timetables…" />;

  const published = rows.filter((r) => r.status === 'PUBLISHED');
  const totalClasses = rows.reduce((n, r) => n + r.counts.total, 0);
  const totalLocked = rows.reduce((n, r) => n + r.counts.locked, 0);

  return (
    <div className="page wide">
      <PageHead
        title="Timetables"
        subtitle="Every timetable saved for this college, with its full version history."
        breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Timetables' }]}
        actions={(
          <div className="btn-row">
            <button type="button" className="btn small ghost" onClick={list}>Refresh</button>
            <Link className="btn small" to="/manual">Manual Builder</Link>
            <Link className="btn small primary" to="/generate">Generate</Link>
          </div>
        )}
      >
        <Checkbox
          label="Also show archived timetables"
          checked={includeArchived}
          onChange={(e) => setIncludeArchived(e.target.checked)}
        />
      </PageHead>

      {error ? <Notice tone="bad" title="Could not load timetables">{error}</Notice> : null}

      <div className="grid cols-4">
        <Stat value={rows.length} label="Timetables" />
        <Stat value={published.length} label="Published" tone={published.length ? 'good' : ''} />
        <Stat value={totalClasses} label="Classes scheduled" />
        <Stat value={totalLocked} label="Locked classes" foot="Never moved by re-generation" />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="○"
          title="No timetables yet"
          action={<Link className="btn primary" to="/generate">Generate the first one</Link>}
        >
          Generate one from your data, or start an empty one and place classes by hand in the
          Manual Builder.
        </EmptyState>
      ) : (
        <Card
          title="Saved timetables"
          actions={<button type="button" className="btn small" onClick={() => setCreating(true)}>New empty timetable</button>}
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th className="num">Classes</th>
                  <th className="num">Locked</th>
                  <th>Quality</th>
                  <th>Last changed</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="bold">
                      <button type="button" className="btn link" onClick={() => setOpenId(String(r.id))}>
                        {r.name}
                      </button>
                      {r.academic_session ? <div className="muted small">{r.academic_session}</div> : null}
                    </td>
                    <td><Badge tone={STATUS_TONE[r.status] || 'plain'}>{humanise(r.status)}</Badge></td>
                    <td className="muted small">{humanise(r.mode)}</td>
                    <td className="num">{r.counts.total}</td>
                    <td className="num">{r.counts.locked || '—'}</td>
                    <td><ScorePill score={r.quality_score} /></td>
                    <td className="muted small nowrap" title={formatDateTime(r.updated_at)}>
                      {timeAgo(r.updated_at)}
                    </td>
                    <td className="actions">
                      <div className="btn-row">
                        <button type="button" className="btn tiny" onClick={() => setOpenId(String(r.id))}>
                          Manage
                        </button>
                        <button
                          type="button" className="btn tiny ghost"
                          onClick={() => navigate(`/views/college?timetableId=${r.id}`)}
                        >
                          Open
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Notice tone="info" icon="◇" title="How versions work">
        A snapshot is taken automatically whenever a timetable is published or cleared, and you can
        take one by hand at any time. Restoring a snapshot replaces the current classes with the ones
        it holds — the timetable itself, its name and its history stay put.
      </Notice>

      {creating ? (
        <CreateModal onClose={() => setCreating(false)} onCreated={(row) => { setCreating(false); list(); setOpenId(String(row.id)); }} />
      ) : null}

      {openId ? (
        <TimetableDetail
          id={openId}
          canEdit={!!auth.permissions.canEditTimetable}
          onClose={() => setOpenId('')}
          onChanged={list}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New empty timetable
// ---------------------------------------------------------------------------
function CreateModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('HYBRID');
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = () => {
    setBusy(true); setError('');
    api.post('/timetable', { name, mode, academicSession: session || undefined })
      .then(onCreated)
      .catch((err) => setError(describeError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title="New empty timetable"
      subtitle="Start blank and place every class yourself, or generate into it later."
      onClose={onClose}
      footer={(
        <div className="btn-row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}
    >
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Field label="Name" required hint="Something you will recognise later, e.g. “CSE Semester 5 — Odd 2025”.">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Mode" hint="This is only a label for how you intend to work — you can change it any time.">
        <Select value={mode} options={MODES} onChange={(e) => setMode(e.target.value)} />
      </Field>
      <Field label="Academic session" hint="Leave empty to use the college's current session.">
        <TextInput value={session} placeholder="e.g. 2025-26 Odd" onChange={(e) => setSession(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// One timetable: details, versions, checklist, audit trail
// ---------------------------------------------------------------------------
function TimetableDetail({ id, canEdit, onClose, onChanged }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const [check, setCheck] = useState(null);
  const [audit, setAudit] = useState(null);
  const [snapping, setSnapping] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [publishConflict, setPublishConflict] = useState(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(() => {
    api.get(`/timetable/${id}`)
      .then((d) => { setData(d); setError(''); })
      .catch((err) => setError(describeError(err)));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'checklist' || check) return;
    api.get(`/timetable/${id}/validate`).then(setCheck).catch((err) => setError(describeError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  useEffect(() => {
    if (tab !== 'audit' || audit) return;
    api.get(`/timetable/${id}/audit`, { limit: 100 })
      .then((d) => setAudit(d.entries || []))
      .catch(() => setAudit([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  const after = (label) => {
    setMessage(label);
    setCheck(null); setAudit(null);
    load(); onChanged();
  };

  const patch = (body, label) => {
    setBusy(label); setError(''); setMessage('');
    api.patch(`/timetable/${id}`, body)
      .then(() => after(label))
      .catch((err) => {
        if (canOverride(err)) setPublishConflict(err);
        else setError(describeError(err));
      })
      .finally(() => setBusy(''));
  };

  const restore = (versionId) => {
    setBusy('restore'); setError('');
    api.post(`/timetable/versions/${versionId}/restore`, {})
      .then(() => after('Version restored.'))
      .catch((err) => setError(describeError(err)))
      .finally(() => { setBusy(''); setConfirm(null); });
  };

  const dropVersion = (versionId) => {
    setBusy('drop'); setError('');
    api.del(`/timetable/versions/${versionId}`)
      .then(() => after('Snapshot deleted.'))
      .catch((err) => setError(describeError(err)))
      .finally(() => { setBusy(''); setConfirm(null); });
  };

  const removeTimetable = () => {
    setBusy('delete'); setError('');
    api.del(`/timetable/${id}`)
      .then(() => { onChanged(); onClose(); })
      .catch((err) => setError(describeError(err)))
      .finally(() => { setBusy(''); setConfirm(null); });
  };

  const clear = (keepLocked) => {
    setBusy('clear'); setError('');
    api.post(`/timetable/${id}/clear`, { keepLocked })
      .then((res) => after(
        `Removed ${res.removed} class(es)${res.keptLocked ? `, kept ${res.kept} locked one(s)` : ''}.`
      ))
      .catch((err) => setError(describeError(err)))
      .finally(() => { setBusy(''); setClearing(false); });
  };

  if (!data) {
    return (
      <Modal title="Timetable" onClose={onClose}>
        {error ? <Notice tone="bad">{error}</Notice> : <Loading />}
      </Modal>
    );
  }

  return (
    <Modal
      title={data.name}
      subtitle={`${humanise(data.status)} · ${humanise(data.mode)}${data.academic_session ? ` · ${data.academic_session}` : ''}`}
      width="xwide"
      onClose={onClose}
      footer={(
        <div className="btn-row">
          <button
            type="button" className="btn"
            onClick={() => navigate(`/views/college?timetableId=${data.id}`)}
          >
            Open in views
          </button>
          {canEdit ? (
            <button type="button" className="btn" onClick={() => navigate(`/manual?timetableId=${data.id}`)}>
              Edit by hand
            </button>
          ) : null}
          <span className="spacer" />
          {canEdit && data.status !== 'PUBLISHED' ? (
            <button
              type="button" className="btn primary" disabled={!!busy}
              onClick={() => patch({ status: 'PUBLISHED' }, 'Published.')}
            >
              {busy === 'Published.' ? 'Publishing…' : 'Publish'}
            </button>
          ) : null}
          {canEdit && data.status === 'PUBLISHED' ? (
            <button
              type="button" className="btn" disabled={!!busy}
              onClick={() => patch({ status: 'DRAFT' }, 'Moved back to draft.')}
            >
              Back to draft
            </button>
          ) : null}
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
      )}
    >
      {error ? <Notice tone="bad" title="That did not work">{error}</Notice> : null}
      {message ? <Notice tone="ok">{message}</Notice> : null}

      <div className="grid cols-4">
        <Stat value={data.counts.total} label="Classes" foot={data.counts.cancelled ? `${data.counts.cancelled} cancelled` : ''} />
        <Stat value={data.counts.locked} label="Locked" foot="Protected from re-generation" />
        <Stat value={data.counts.manual} label="Placed by hand" />
        <Stat value={data.quality_score == null ? '—' : Math.round(data.quality_score)} label="Quality score" foot="Out of 100" />
      </div>

      <Tabs
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'checklist', label: 'Checklist' },
          { value: 'versions', label: `Versions (${data.versions.length})` },
          { value: 'audit', label: 'History' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' ? (
        <OverviewTab
          data={data} canEdit={canEdit} busy={busy}
          onRename={(name) => patch({ name }, 'Name updated.')}
          onMode={(mode) => patch({ mode }, 'Mode updated.')}
          onStatus={(status) => patch({ status }, `Status set to ${humanise(status)}.`)}
          onClear={() => setClearing(true)}
          onDelete={() => setConfirm({ kind: 'delete' })}
        />
      ) : null}

      {tab === 'checklist' ? <ChecklistTab check={check} /> : null}

      {tab === 'versions' ? (
        <VersionsTab
          versions={data.versions}
          canEdit={canEdit}
          busy={busy}
          snapping={snapping}
          onSnapshot={() => setSnapping(true)}
          onRestore={(v) => setConfirm({ kind: 'restore', version: v })}
          onDelete={(v) => setConfirm({ kind: 'dropVersion', version: v })}
        />
      ) : null}

      {tab === 'audit' ? <AuditTab entries={audit} /> : null}

      {snapping ? (
        <SnapshotModal
          id={id}
          onClose={() => setSnapping(false)}
          onDone={() => { setSnapping(false); after('Snapshot taken.'); }}
        />
      ) : null}

      {clearing ? (
        <ClearModal busy={busy === 'clear'} counts={data.counts} onClose={() => setClearing(false)} onClear={clear} />
      ) : null}

      {publishConflict ? (
        <ConfirmModal
          title="Publish with unresolved conflicts?"
          message={describeError(publishConflict)}
          detail={(publishConflict.details || []).join('\n')}
          confirmLabel="Publish anyway"
          danger
          busy={busy === 'force'}
          onConfirm={() => {
            setBusy('force');
            api.patch(`/timetable/${id}`, { status: 'PUBLISHED', force: true })
              .then(() => { setPublishConflict(null); after('Published with conflicts on the record.'); })
              .catch((err) => setError(describeError(err)))
              .finally(() => setBusy(''));
          }}
          onClose={() => setPublishConflict(null)}
        />
      ) : null}

      {confirm && confirm.kind === 'restore' ? (
        <ConfirmModal
          title={`Restore version ${confirm.version.version_no}?`}
          message="The classes currently in this timetable are replaced by the ones in this snapshot."
          detail={`${confirm.version.assignments ?? '?'} class(es) will be restored. A snapshot of the current state is taken first, so this is reversible.`}
          confirmLabel="Restore"
          busy={busy === 'restore'}
          onConfirm={() => restore(confirm.version.id)}
          onClose={() => setConfirm(null)}
        />
      ) : null}

      {confirm && confirm.kind === 'dropVersion' ? (
        <ConfirmModal
          title={`Delete snapshot ${confirm.version.version_no}?`}
          message="The snapshot is removed permanently. The timetable itself is untouched."
          confirmLabel="Delete snapshot"
          danger
          busy={busy === 'drop'}
          onConfirm={() => dropVersion(confirm.version.id)}
          onClose={() => setConfirm(null)}
        />
      ) : null}

      {confirm && confirm.kind === 'delete' ? (
        <ConfirmModal
          title={`Delete “${data.name}”?`}
          message="The timetable, all its classes and all its snapshots are removed permanently."
          detail="Your university data — courses, faculty, rooms, sections — is not touched. Only this timetable goes."
          confirmLabel="Delete timetable"
          danger
          busy={busy === 'delete'}
          onConfirm={removeTimetable}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function OverviewTab({ data, canEdit, busy, onRename, onMode, onStatus, onClear, onDelete }) {
  const [name, setName] = useState(data.name);
  useEffect(() => { setName(data.name); }, [data.name]);

  const lastRun = data.runs && data.runs.length ? data.runs[0] : null;

  return (
    <div className="stack">
      <Card title="Details">
        <div className="field-grid">
          <Field label="Name">
            <div className="row">
              <TextInput value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
              {canEdit && name.trim() && name !== data.name ? (
                <button type="button" className="btn small" disabled={!!busy} onClick={() => onRename(name.trim())}>
                  Save
                </button>
              ) : null}
            </div>
          </Field>
          <Field label="Mode" hint="How this timetable is meant to be worked on.">
            <Select value={data.mode} options={MODES} disabled={!canEdit} onChange={(e) => onMode(e.target.value)} />
          </Field>
          <Field label="Status">
            <Select value={data.status} options={STATUSES} disabled={!canEdit} onChange={(e) => onStatus(e.target.value)} />
          </Field>
          <Field label="Academic session">
            <TextInput value={data.academic_session || ''} disabled readOnly />
          </Field>
        </div>
        <dl className="kv">
          <dt>Created</dt><dd>{formatDateTime(data.created_at)}</dd>
          <dt>Last changed</dt><dd>{formatDateTime(data.updated_at)}</dd>
          <dt>Cancelled classes</dt><dd>{data.counts.cancelled || 'None'}</dd>
        </dl>
      </Card>

      {lastRun && lastRun.result ? (
        <Card title="Last generation run" subtitle={formatDateTime(lastRun.createdAt)}>
          <p>{lastRun.result.headline || 'Generated.'}</p>
          <div className="stat-row">
            <div><b>{lastRun.result.stats?.classesScheduled ?? '—'}</b><span className="muted small"> placed</span></div>
            <div><b>{lastRun.result.stats?.classesUnscheduled ?? 0}</b><span className="muted small"> unplaced</span></div>
            <div><b>{lastRun.result.stats?.hardConflicts ?? 0}</b><span className="muted small"> conflicts</span></div>
            <div><ScorePill score={lastRun.result.qualityScore} /></div>
          </div>
        </Card>
      ) : null}

      {canEdit ? (
        <Card title="Careful with these" subtitle="Both take a snapshot first, so neither is a one-way door.">
          <div className="btn-row">
            <button type="button" className="btn" disabled={!!busy} onClick={onClear}>
              Clear all classes…
            </button>
            <button type="button" className="btn danger" disabled={!!busy} onClick={onDelete}>
              Delete this timetable…
            </button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ChecklistTab({ check }) {
  if (!check) return <Loading label="Re-running the checklist…" />;

  const clean = check.hardConflicts === 0 && check.softWarnings === 0;

  return (
    <div className="stack">
      <Notice
        tone={check.hardConflicts ? 'bad' : check.softWarnings ? 'warn' : 'ok'}
        title={check.verdict || (clean ? 'No problems found' : 'Some things to look at')}
      >
        {check.classes} class(es) checked · {check.hardConflicts} hard conflict(s) ·{' '}
        {check.softWarnings} soft warning(s).
      </Notice>

      {check.problems && check.problems.length ? (
        <Card title="Hard conflicts" subtitle="These must be fixed before the timetable is trustworthy." flush>
          <div className="table-wrap">
            <table className="data compact">
              <thead>
                <tr><th>Class</th><th>When</th><th>Problem</th><th /></tr>
              </thead>
              <tbody>
                {check.problems.map((p) => (
                  <tr key={p.assignmentId} className="row-bad">
                    <td className="bold">
                      {p.label}
                      {p.isLocked ? <Badge tone="locked" title="Locked">Locked</Badge> : null}
                    </td>
                    <td className="nowrap muted small">
                      {dayName(p.day)} · period {Number(p.slotIndex) + 1}
                    </td>
                    <td><ViolationList violations={p.violations} compact /></td>
                    <td className="actions">
                      <Link className="btn tiny" to={`/views/college`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {check.warnings && check.warnings.length ? (
        <Card title="Soft warnings" subtitle="Preferences the schedule did not manage to honour.">
          <ViolationList warnings={check.warnings} />
        </Card>
      ) : null}

      {clean ? (
        <EmptyState icon="✓" title="Every check passed">
          No teacher, room, section or sub-section clash; every AC requirement met; every capacity
          respected.
        </EmptyState>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
function VersionsTab({ versions, canEdit, busy, onSnapshot, onRestore, onDelete }) {
  return (
    <Card
      title="Version history"
      subtitle="Snapshots of the classes in this timetable. Newest first."
      actions={canEdit ? (
        <button type="button" className="btn small" disabled={!!busy} onClick={onSnapshot}>
          Take a snapshot
        </button>
      ) : null}
      flush
    >
      {versions.length === 0 ? (
        <div className="pad">
          <EmptyState icon="○" title="No snapshots yet">
            One is taken automatically when you publish or clear this timetable. You can also take
            one by hand before trying something risky.
          </EmptyState>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data compact">
            <thead>
              <tr>
                <th className="num">#</th><th>Label</th><th className="num">Classes</th>
                <th>Taken</th><th>By</th><th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="num bold">{v.version_no}</td>
                  <td>
                    {v.label || <span className="muted">Untitled</span>}
                    {v.reason ? <div className="muted small">{v.reason}</div> : null}
                  </td>
                  <td className="num">{v.assignments ?? '—'}</td>
                  <td className="muted small nowrap" title={formatDateTime(v.created_at)}>{timeAgo(v.created_at)}</td>
                  <td className="muted small">{v.created_by_name || '—'}</td>
                  <td className="actions">
                    {canEdit ? (
                      <div className="btn-row">
                        <button type="button" className="btn tiny" disabled={!!busy} onClick={() => onRestore(v)}>
                          Restore
                        </button>
                        <button type="button" className="btn tiny ghost" disabled={!!busy} onClick={() => onDelete(v)}>
                          Delete
                        </button>
                      </div>
                    ) : <span className="muted small">read-only</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function AuditTab({ entries }) {
  if (!entries) return <Loading label="Reading the history…" />;
  if (entries.length === 0) {
    return <EmptyState icon="○" title="Nothing recorded yet">Every change made from here on is logged.</EmptyState>;
  }

  return (
    <Card title="Change history" subtitle="Who changed what, newest first." flush>
      <div className="feed scroll-y">
        {entries.map((e) => (
          <div className="feed-row" key={e.id}>
            <div className="feed-what">
              {AUDIT_LABEL[e.action] || humanise(e.action)}
              {' '}
              <span className="muted small">{describeAudit(e)}</span>
            </div>
            <div className="feed-who">
              {e.actor_name || 'System'} · <span title={formatDateTime(e.created_at)}>{timeAgo(e.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Turn the before/after JSON of one audit row into a single readable line. */
function describeAudit(entry) {
  const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const before = parse(entry.before_json);
  const afterRow = parse(entry.after_json);
  const row = afterRow || before;
  if (!row) return '';
  const bits = [];
  if (row.name) bits.push(row.name);
  if (row.day != null && row.slot_index != null) {
    bits.push(`${dayName(row.day)} period ${Number(row.slot_index) + 1}`);
  }
  if (before && afterRow && before.slot_index != null && afterRow.slot_index != null
      && (before.slot_index !== afterRow.slot_index || before.day !== afterRow.day)) {
    bits.push(`(was ${dayName(before.day)} period ${Number(before.slot_index) + 1})`);
  }
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
function SnapshotModal({ id, onClose, onDone }) {
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = () => {
    setBusy(true); setError('');
    api.post(`/timetable/${id}/versions`, { label: label || undefined, reason: reason || undefined })
      .then(onDone)
      .catch((err) => setError(describeError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title="Take a snapshot"
      subtitle="A named point you can come back to."
      onClose={onClose}
      footer={(
        <div className="btn-row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : 'Take snapshot'}
          </button>
        </div>
      )}
    >
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Field label="Label" hint="Optional, but future you will be grateful.">
        <TextInput value={label} placeholder="e.g. Before moving the labs" onChange={(e) => setLabel(e.target.value)} autoFocus />
      </Field>
      <Field label="Why" hint="Optional note about what you were about to try.">
        <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function ClearModal({ counts, busy, onClose, onClear }) {
  const [keepLocked, setKeepLocked] = useState(true);

  return (
    <Modal
      title="Clear all classes"
      subtitle="A snapshot is taken first, so you can undo this."
      onClose={onClose}
      footer={(
        <div className="btn-row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => onClear(keepLocked)}>
            {busy ? 'Clearing…' : `Clear ${keepLocked && counts.locked ? counts.total - counts.locked : counts.total} class(es)`}
          </button>
        </div>
      )}
    >
      <Notice tone="warn" title="This empties the timetable">
        The timetable, its name and its version history stay. Only the placed classes go.
      </Notice>
      <Checkbox
        label="Keep locked classes"
        hint={counts.locked
          ? `${counts.locked} class(es) are locked. Locked classes are what you told the system never to move.`
          : 'Nothing is locked in this timetable right now.'}
        checked={keepLocked}
        onChange={(e) => setKeepLocked(e.target.checked)}
      />
    </Modal>
  );
}
