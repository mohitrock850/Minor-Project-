/**
 * Sections 14.1 and 15 -- Settings: general, AI Assistant key, LAN sharing,
 * backup / restore / reset, and About.
 *
 * Two things on this screen deserve their reputation for being touchy, and both
 * are handled the way the specification asks:
 *
 *   - The OpenAI key never leaves this machine except to api.openai.com, is
 *     stored through the operating system's own encryption, and is never sent
 *     back to this screen -- the most it ever sees is "sk-...1234". If the OS
 *     cannot encrypt it, the server refuses to store it at all rather than
 *     falling back to a plain-text file.
 *   - Restore and "Reset to empty" destroy or replace everything, so both are
 *     Super-Admin-only on the server and both take a typed confirmation here.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api, { describeError, getApiBase } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useRuntime } from '../lib/runtime.jsx';
import desktop from '../lib/desktop.js';
import {
  Badge, Card, Checkbox, ConfirmModal, EmptyState, Field, Loading, Modal, Notice,
  PageHead, Select, Stat, Tabs, TextInput,
} from '../components/ui.jsx';
import { formatBytes, formatDateTime, humanise, timeAgo } from '../lib/format.js';

const PANELS = [
  { value: 'general', label: 'General' },
  { value: 'ai', label: 'AI Assistant' },
  { value: 'network', label: 'Sharing & network' },
  { value: 'backup', label: 'Backup & restore' },
  { value: 'about', label: 'About' },
];

export default function Settings() {
  const auth = useAuth();
  const runtime = useRuntime();
  const [search, setSearch] = useSearchParams();

  const [panel, setPanel] = useState(search.get('panel') || 'general');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(() => {
    api.get('/settings')
      .then((d) => { setData(d); setError(''); })
      .catch((err) => setError(describeError(err)));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const next = new URLSearchParams(search);
    next.set('panel', panel);
    next.delete('action');
    setSearch(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  // The application menu navigates here with a panel already chosen (File → Back
  // up now goes to ?panel=backup). Without following the address afterwards, that
  // does nothing at all when this screen is the one already open: the tab was
  // fixed when the screen first appeared.
  const asked = search.get('panel');
  useEffect(() => {
    if (asked && asked !== panel && PANELS.some((p) => p.value === asked)) setPanel(asked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const notify = (text) => { setMessage(text); load(); };

  if (error && !data) {
    return (
      <div className="page">
        <PageHead title="Settings" breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Settings' }]} />
        <Notice tone="bad" title="Could not load settings">{error}</Notice>
      </div>
    );
  }

  if (!data) return <Loading label="Loading settings…" />;

  return (
    <div className="page">
      <PageHead
        title="Settings"
        subtitle="Everything on this screen applies to this installation."
        breadcrumbs={[{ label: 'Home', to: '#/' }, { label: 'Settings' }]}
      />

      {message ? <Notice tone="ok" actions={<button type="button" className="btn tiny ghost" onClick={() => setMessage('')}>Dismiss</button>}>{message}</Notice> : null}
      {error ? <Notice tone="bad" title="That did not work">{error}</Notice> : null}

      <Tabs tabs={PANELS} active={panel} onChange={setPanel} />

      {panel === 'general' ? (
        <GeneralPanel data={data} onSaved={notify} onError={setError} />
      ) : null}

      {panel === 'ai' ? (
        <AiPanel data={data} onSaved={notify} onError={setError} />
      ) : null}

      {panel === 'network' ? (
        <NetworkPanel
          isSuperAdmin={auth.isSuperAdmin}
          runtime={runtime.runtime}
          onSaved={notify}
          onError={setError}
        />
      ) : null}

      {panel === 'backup' ? (
        <BackupPanel
          isSuperAdmin={auth.isSuperAdmin}
          requested={search.get('action') || ''}
          onSaved={notify}
          onError={setError}
        />
      ) : null}

      {panel === 'about' ? <AboutPanel runtime={runtime.runtime} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// General -- driven entirely by the server's setting definitions, so a new
// setting on the server appears here without touching this file.
// ---------------------------------------------------------------------------
function GeneralPanel({ data, onSaved, onError }) {
  const groups = useMemo(
    () => data.groups.filter((g) => g.name !== 'Network' && g.name !== 'AI Assistant'),
    [data.groups]
  );
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);

  const valueOf = (item) => (draft[item.key] !== undefined ? draft[item.key] : item.value);
  const dirty = Object.keys(draft).length > 0;

  const save = () => {
    setBusy(true);
    api.put('/settings', { settings: draft })
      .then((res) => {
        setDraft({});
        onSaved(res.restartRequired
          ? 'Saved. Restart the application for it to take effect.'
          : 'Settings saved.');
      })
      .catch((err) => onError(describeError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="stack">
      {groups.map((group) => (
        <Card key={group.name} title={group.name}>
          <div className="field-grid">
            {group.settings.map((item) => (
              <SettingField
                key={item.key}
                item={item}
                value={valueOf(item)}
                onChange={(v) => setDraft((d) => ({ ...d, [item.key]: v }))}
              />
            ))}
          </div>
        </Card>
      ))}

      <div className="btn-row end">
        {dirty ? <span className="muted small">Unsaved changes</span> : null}
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function SettingField({ item, value, onChange }) {
  if (item.type === 'boolean') {
    return (
      <Checkbox
        label={item.label}
        hint={item.help}
        checked={value === '1' || value === true}
        onChange={(e) => onChange(e.target.checked ? '1' : '0')}
      />
    );
  }
  if (item.type === 'enum' && item.values) {
    return (
      <Field label={item.label} hint={item.help}>
        <Select
          value={value ?? ''}
          options={item.values.map((v) => ({ value: v, label: v }))}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    );
  }
  return (
    <Field label={item.label} hint={item.help}>
      <TextInput
        type={item.type === 'number' ? 'number' : 'text'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Section 14.1 -- the OpenAI key, and what is allowed to be sent with a question
// ---------------------------------------------------------------------------
function AiPanel({ data, onSaved, onError }) {
  const ai = data.ai;
  const aiSettings = useMemo(
    () => (data.groups.find((g) => g.name === 'AI Assistant') || { settings: [] }).settings,
    [data.groups]
  );

  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [clearing, setClearing] = useState(false);
  const [draft, setDraft] = useState({});

  const valueOf = (item) => (draft[item.key] !== undefined ? draft[item.key] : item.value);
  const dirty = Object.keys(draft).length > 0;

  const saveKey = () => {
    setBusy('key');
    api.post('/settings/ai-key', { key: key.trim() })
      .then((res) => { setKey(''); onSaved(res.message || 'Key saved.'); })
      .catch((err) => onError(describeError(err)))
      .finally(() => setBusy(''));
  };

  const dropKey = () => {
    setBusy('drop');
    api.del('/settings/ai-key')
      .then((res) => onSaved(res.message || 'Key removed.'))
      .catch((err) => onError(describeError(err)))
      .finally(() => { setBusy(''); setClearing(false); });
  };

  const saveSettings = () => {
    setBusy('settings');
    api.put('/settings', { settings: draft })
      .then(() => { setDraft({}); onSaved('Assistant settings saved.'); })
      .catch((err) => onError(describeError(err)))
      .finally(() => setBusy(''));
  };

  return (
    <div className="stack">
      <Notice tone={ai.available ? 'ok' : 'info'} icon="◇" title={ai.available ? 'The Assistant is ready' : 'The Assistant is not set up yet'}>
        {ai.message || 'Your own OpenAI key is stored on this machine and questions go straight to OpenAI.'}
        {' '}
        <b>Every other feature in this application works with no internet connection at all.</b>
      </Notice>

      <Card title="Your OpenAI API key" subtitle="Bring your own key. It is the only provider this application talks to.">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            {ai.configured
              ? <><Badge tone="ok">Saved</Badge> <span className="mono">{ai.keyHint}</span></>
              : <Badge tone="warn">Not saved</Badge>}
          </dd>
          <dt>Stored using</dt>
          <dd>{ai.encryption.mechanism || <span className="bad-text">{ai.encryption.reason}</span>}</dd>
          <dt>Sent to</dt>
          <dd className="mono">{ai.endpoint}</dd>
          <dt>Billing</dt>
          <dd className="muted">{ai.billingNote}</dd>
        </dl>

        {ai.encryption.available ? (
          <>
            <Field
              label={ai.configured ? 'Replace the key' : 'Paste your key'}
              hint="Starts with sk-. It is written straight into the operating system's encrypted store and never appears on this screen again."
            >
              <div className="row">
                <TextInput
                  type="password"
                  value={key}
                  placeholder="sk-…"
                  autoComplete="off"
                  onChange={(e) => setKey(e.target.value)}
                />
                <button type="button" className="btn primary" disabled={!key.trim() || !!busy} onClick={saveKey}>
                  {busy === 'key' ? 'Saving…' : 'Save key'}
                </button>
              </div>
            </Field>
            {ai.configured ? (
              <div className="btn-row">
                <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setClearing(true)}>
                  Forget the stored key
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <Notice tone="warn" title="Cannot store a key here">
            {ai.encryption.reason} A key is never written to a plain-text file as a fallback.
          </Notice>
        )}
      </Card>

      <Card
        title="What gets sent with a question"
        subtitle="Privacy mode is on by default: student names and IDs are stripped before anything leaves this machine."
      >
        <div className="field-grid">
          {aiSettings.map((item) => (
            <SettingField
              key={item.key}
              item={item}
              value={valueOf(item)}
              onChange={(v) => setDraft((d) => ({ ...d, [item.key]: v }))}
            />
          ))}
        </div>
        <div className="btn-row end">
          <button type="button" className="btn primary" disabled={!dirty || !!busy} onClick={saveSettings}>
            {busy === 'settings' ? 'Saving…' : 'Save'}
          </button>
        </div>
        <p className="card-note">
          Timetable context is trimmed to {ai.maxContextClasses} classes per question, so a large
          college does not send its whole week to a third party.
        </p>
      </Card>

      {clearing ? (
        <ConfirmModal
          title="Forget the stored key?"
          message="The Assistant switches off until a new key is added. Nothing else is affected."
          confirmLabel="Forget it"
          danger
          busy={busy === 'drop'}
          onConfirm={dropKey}
          onClose={() => setClearing(false)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 15 -- local by default, LAN as an opt-in
// ---------------------------------------------------------------------------
function NetworkPanel({ isSuperAdmin, runtime, onSaved, onError }) {
  const [net, setNet] = useState(null);
  const [mode, setMode] = useState('');
  const [port, setPort] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [probe, setProbe] = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api.get('/settings/network')
      .then((d) => { setNet(d); setMode(d.mode); setPort(String(d.port)); setHostUrl(d.hostUrl || ''); })
      .catch((err) => onError(describeError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!net) return <Loading label="Reading the network settings…" />;

  const changed = mode !== net.mode || String(port) !== String(net.port) || hostUrl !== (net.hostUrl || '');

  const apply = () => {
    setBusy('save');
    api.put('/settings/network', { mode, port: Number(port), hostUrl })
      .then((res) => {
        setNet(res);
        onSaved(`${res.message} ` + 'Close the application and open it again when you are ready.');
      })
      .catch((err) => onError(describeError(err)))
      .finally(() => { setBusy(''); setConfirming(false); });
  };

  const testHost = () => {
    setBusy('probe'); setProbe(null);
    desktop.probeHost(hostUrl)
      .then(setProbe)
      .catch((err) => setProbe({ ok: false, message: err.message }))
      .finally(() => setBusy(''));
  };

  const chosen = net.modes.find((m) => m.value === mode);

  return (
    <div className="stack">
      <Card title="Where the database lives">
        <div className="stat-row">
          <div>
            <span className="muted small">Right now</span>
            <div><b>{(net.modes.find((m) => m.value === net.mode) || {}).label || net.mode}</b></div>
          </div>
          <div>
            <span className="muted small">This window is talking to</span>
            <div className="mono small">{getApiBase() || '—'}</div>
          </div>
          {runtime && runtime.databasePath ? (
            <div>
              <span className="muted small">Database file</span>
              <div className="mono small">{runtime.databasePath}</div>
            </div>
          ) : null}
        </div>
      </Card>

      {!isSuperAdmin ? (
        <Notice tone="info" icon="◇" title="Only the Super Admin can change this">
          Switching between local and shared changes it for everyone who uses this installation, so
          it is reserved for the Super Admin account.
        </Notice>
      ) : null}

      <Card title="Mode" subtitle="Local is the default and is enough for one coordinator on one machine.">
        <div className="stack tight">
          {net.modes.map((m) => (
            <label className={`rule ${mode === m.value ? '' : 'off'}`} key={m.value}>
              <div className="rule-control">
                <input
                  type="radio"
                  name="netmode"
                  value={m.value}
                  checked={mode === m.value}
                  disabled={!isSuperAdmin}
                  onChange={() => setMode(m.value)}
                />
              </div>
              <div className="rule-body">
                <div className="rule-label">
                  {m.label}
                  {net.mode === m.value ? <Badge tone="ok" title="In use now">Current</Badge> : null}
                </div>
                <div className="rule-help">{m.description}</div>
              </div>
            </label>
          ))}
        </div>
      </Card>

      {mode === 'HOST' ? (
        <Card title="Hosting" subtitle="Give the other machines one of these addresses.">
          <Field label="Port" hint="Between 1024 and 65535. Only change this if something else on the machine already uses it.">
            <TextInput
              type="number" value={port} disabled={!isSuperAdmin}
              onChange={(e) => setPort(e.target.value)}
            />
          </Field>
          {net.shareUrls.length ? (
            <div className="fact-list">
              {net.shareUrls.map((u, i) => (
                <div className="fact-row" key={u}>
                  <span className="mono">{u}</span>
                  <span className="muted small">{(net.addresses[i] || {}).interface}</span>
                </div>
              ))}
            </div>
          ) : (
            <Notice tone="warn">
              This machine has no network address at the moment, so nothing could reach it. Connect it
              to the college network first.
            </Notice>
          )}
          <p className="card-note">
            Keep this machine switched on while others are using it, and keep taking backups here —
            the client machines store nothing of their own.
          </p>
        </Card>
      ) : null}

      {mode === 'CLIENT' ? (
        <Card title="Host machine" subtitle="The machine that holds the database.">
          <Field label="Address" required hint="For example http://192.168.1.24:4713 — the host machine shows its own addresses on this screen.">
            <div className="row">
              <TextInput
                value={hostUrl} placeholder="http://192.168.1.24:4713" disabled={!isSuperAdmin}
                onChange={(e) => { setHostUrl(e.target.value); setProbe(null); }}
              />
              <button type="button" className="btn" disabled={!hostUrl.trim() || !!busy} onClick={testHost}>
                {busy === 'probe' ? 'Testing…' : 'Test'}
              </button>
            </div>
          </Field>
          {probe ? (
            <Notice tone={probe.ok ? 'ok' : 'bad'}>
              {probe.ok ? `Reached it${probe.version ? ` — version ${probe.version}` : ''}.` : (probe.message || 'Could not reach that address.')}
            </Notice>
          ) : null}
          <Notice tone="warn" icon="◇">
            A client machine cannot open the timetable while the host is switched off or unreachable.
          </Notice>
        </Card>
      ) : null}

      {isSuperAdmin ? (
        <div className="btn-row end">
          <span className="muted small">{net.note}</span>
          <button type="button" className="btn primary" disabled={!changed || !!busy} onClick={() => setConfirming(true)}>
            {busy === 'save' ? 'Saving…' : 'Save and require a restart'}
          </button>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmModal
          title={`Switch to “${chosen ? chosen.label : mode}”?`}
          message={chosen ? chosen.description : ''}
          detail="The change is written now and takes effect the next time the application starts."
          confirmLabel="Save"
          busy={busy === 'save'}
          onConfirm={apply}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 15 -- backup, restore, and the way back out of the demo data
// ---------------------------------------------------------------------------
function BackupPanel({ isSuperAdmin, requested, onSaved, onError }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState('');
  const [labelling, setLabelling] = useState(false);
  const [restoring, setRestoring] = useState(null);   // { name?, path?, inspected }
  const [dropping, setDropping] = useState(null);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(() => {
    api.get('/backup')
      .then((d) => setInfo(d))
      .catch((err) => onError(describeError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  // The Electron menu can arrive here asking for a specific action.
  useEffect(() => {
    if (requested === 'backup') setLabelling(true);
    if (requested === 'restore') setRestoring({ pick: true });
  }, [requested]);

  const makeBackup = (label) => {
    setBusy('create');
    api.post('/backup', { label: label || undefined })
      .then((res) => { onSaved(res.message || 'Backup created.'); load(); })
      .catch((err) => onError(describeError(err)))
      .finally(() => { setBusy(''); setLabelling(false); });
  };

  const saveCopy = (row) => {
    setBusy(row.name);
    api.raw(`/backup/download/${encodeURIComponent(row.name)}`)
      .then((res) => res.blob())
      .then((blob) => desktop.saveFile({ filename: row.name, blob, kind: 'db', title: 'Save a copy of this backup' }))
      .then((res) => { if (res && res.saved) onSaved(`Saved a copy to ${res.path || row.name}.`); })
      .catch((err) => onError(describeError(err)))
      .finally(() => setBusy(''));
  };

  const inspect = (name) => {
    setBusy('inspect');
    api.get(`/backup/inspect/${encodeURIComponent(name)}`)
      .then((d) => setRestoring({ name, inspected: d }))
      .catch((err) => onError(describeError(err)))
      .finally(() => setBusy(''));
  };

  const doRestore = (target, allowVersionMismatch) => {
    setBusy('restore');
    api.post('/backup/restore', { name: target, confirm: true, allowVersionMismatch })
      .then((res) => { setRestoring(null); onSaved(res.message || 'Restored.'); load(); })
      .catch((err) => onError(describeError(err)))
      .finally(() => setBusy(''));
  };

  const drop = (name) => {
    setBusy('drop');
    api.del(`/backup/${encodeURIComponent(name)}`)
      .then(() => { onSaved('Backup deleted.'); load(); })
      .catch((err) => onError(describeError(err)))
      .finally(() => { setBusy(''); setDropping(null); });
  };

  if (!info) return <Loading label="Looking for backups…" />;

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Stat value={info.database ? info.database.size : '—'} label="Database size" />
        <Stat value={info.backups.length} label="Backups on this machine" />
        <Stat
          value={info.lastBackupAt ? timeAgo(info.lastBackupAt) : 'Never'}
          label="Last backup"
          tone={info.lastBackupAt ? '' : 'warn'}
        />
        <Stat value={info.counts.assignments ?? '—'} label="Scheduled classes" foot={`${info.counts.colleges ?? 0} college(s)`} />
      </div>

      <Card
        title="Backups"
        subtitle={info.note}
        actions={(
          <button type="button" className="btn small primary" disabled={!!busy} onClick={() => setLabelling(true)}>
            Back up now
          </button>
        )}
        flush
      >
        {info.backups.length === 0 ? (
          <div className="pad">
            <EmptyState icon="○" title="No backups yet">
              A backup is a single file holding everything. Make one before importing a large
              spreadsheet or before generating over a timetable you care about.
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data compact">
              <thead>
                <tr>
                  <th>File</th><th className="num">Size</th><th>Made</th><th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {info.backups.map((b) => (
                  <tr key={b.name}>
                    <td className="mono small">{b.name}</td>
                    <td className="num">{b.size}</td>
                    <td className="muted small nowrap" title={formatDateTime(b.createdAt)}>{timeAgo(b.createdAt)}</td>
                    <td className="actions">
                      <div className="btn-row">
                        <button type="button" className="btn tiny ghost" disabled={!!busy} onClick={() => saveCopy(b)}>
                          Save a copy
                        </button>
                        {isSuperAdmin ? (
                          <>
                            <button type="button" className="btn tiny" disabled={!!busy} onClick={() => inspect(b.name)}>
                              Restore…
                            </button>
                            <button type="button" className="btn tiny ghost" disabled={!!busy} onClick={() => setDropping(b)}>
                              Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="card-note">
          Kept in <span className="mono">{info.directory}</span>. Copy one somewhere other than this
          machine — a backup that only exists on the machine that failed is not a backup.
        </p>
      </Card>

      {isSuperAdmin ? (
        <Card title="Start over" subtitle="Section 15's way out of the demo colleges.">
          <p>
            {info.seeded
              ? 'This machine still holds the two demo colleges that were loaded on first run. Resetting removes them along with everything else, leaving an empty installation you fill with your own data.'
              : 'Resetting removes every college, department, course, room, teacher, student and timetable on this machine.'}
          </p>
          <Notice tone="warn" title="A backup is taken automatically first">
            Your own login is kept, so the machine is never locked out.
          </Notice>
          <div className="btn-row">
            <button type="button" className="btn danger" disabled={!!busy} onClick={() => setResetting(true)}>
              Reset to empty…
            </button>
          </div>
        </Card>
      ) : (
        <Notice tone="info" icon="◇">
          Restoring a backup and resetting the machine are reserved for the Super Admin.
        </Notice>
      )}

      {labelling ? (
        <LabelModal busy={busy === 'create'} onClose={() => setLabelling(false)} onCreate={makeBackup} />
      ) : null}

      {restoring && restoring.pick ? (
        <Modal
          title="Restore a backup"
          subtitle="Pick one of the backups on this machine."
          onClose={() => setRestoring(null)}
        >
          {info.backups.length === 0 ? (
            <EmptyState icon="○" title="There is nothing to restore yet" />
          ) : (
            <div className="stack tight">
              {info.backups.map((b) => (
                <button
                  key={b.name} type="button" className="btn block"
                  onClick={() => inspect(b.name)}
                >
                  {b.name} · {b.size} · {timeAgo(b.createdAt)}
                </button>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {restoring && restoring.inspected ? (
        <RestoreModal
          target={restoring.name}
          inspected={restoring.inspected}
          busy={busy === 'restore'}
          onClose={() => setRestoring(null)}
          onRestore={doRestore}
        />
      ) : null}

      {dropping ? (
        <ConfirmModal
          title={`Delete ${dropping.name}?`}
          message="The backup file is removed permanently. The live database is untouched."
          confirmLabel="Delete"
          danger
          busy={busy === 'drop'}
          onConfirm={() => drop(dropping.name)}
          onClose={() => setDropping(null)}
        />
      ) : null}

      {resetting ? (
        <ResetModal
          counts={info.counts}
          onClose={() => setResetting(false)}
          onDone={(msg) => { setResetting(false); onSaved(msg); load(); }}
          onError={onError}
        />
      ) : null}
    </div>
  );
}

function LabelModal({ busy, onClose, onCreate }) {
  const [label, setLabel] = useState('');
  return (
    <Modal
      title="Back up now"
      subtitle="One file with everything in it."
      onClose={onClose}
      footer={(
        <div className="btn-row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => onCreate(label)}>
            {busy ? 'Backing up…' : 'Back up'}
          </button>
        </div>
      )}
    >
      <Field label="Label" hint="Optional. Added to the filename so you can recognise it later — letters, numbers and dashes only.">
        <TextInput value={label} placeholder="e.g. before-import" onChange={(e) => setLabel(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function RestoreModal({ target, inspected, busy, onClose, onRestore }) {
  const [accept, setAccept] = useState(false);
  const mismatch = !!inspected.warning;

  return (
    <Modal
      title="Restore this backup?"
      subtitle={inspected.name}
      onClose={onClose}
      footer={(
        <div className="btn-row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn danger"
            disabled={busy || (mismatch && !accept)}
            onClick={() => onRestore(target, mismatch)}
          >
            {busy ? 'Restoring…' : 'Replace everything with this backup'}
          </button>
        </div>
      )}
    >
      <Notice tone="warn" title="This replaces everything currently in the database">
        A copy of what is being replaced is saved first, so this is reversible.
      </Notice>

      <dl className="kv">
        <dt>Made</dt><dd>{formatDateTime(inspected.createdAt)}</dd>
        <dt>Size</dt><dd>{inspected.size || formatBytes(inspected.bytes)}</dd>
        <dt>Schema version</dt>
        <dd>{inspected.schemaVersion || 'unknown'} {inspected.versionMatches ? <Badge tone="ok">Matches</Badge> : <Badge tone="warn">Different</Badge>}</dd>
        {inspected.counts ? Object.entries(inspected.counts).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{humanise(k)}</dt><dd>{v == null ? '—' : v}</dd>
          </React.Fragment>
        )) : null}
      </dl>

      {mismatch ? (
        <>
          <Notice tone="bad" title="Version mismatch">{inspected.warning}</Notice>
          <Checkbox
            label="I understand it may not work, restore it anyway"
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
          />
        </>
      ) : null}
    </Modal>
  );
}

const RESET_PHRASE = 'DELETE EVERYTHING';

function ResetModal({ counts, onClose, onDone, onError }) {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    api.post('/backup/reset', { confirm: phrase })
      .then((res) => onDone(res.message || 'Everything has been removed.'))
      .catch((err) => onError(describeError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title="Reset to empty"
      subtitle="Removes every college on this machine."
      onClose={onClose}
      footer={(
        <div className="btn-row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn danger"
            disabled={busy || phrase.trim().toUpperCase() !== RESET_PHRASE}
            onClick={submit}
          >
            {busy ? 'Resetting…' : 'Reset to empty'}
          </button>
        </div>
      )}
    >
      <Notice tone="bad" title="This removes everything">
        {counts.colleges ?? 0} college(s), {counts.courses ?? 0} course(s), {counts.faculty ?? 0} teacher(s),{' '}
        {counts.rooms ?? 0} room(s), {counts.students ?? 0} student(s) and {counts.assignments ?? 0} scheduled
        class(es) go. A backup is taken first and your own login is kept.
      </Notice>
      <Field label={`Type ${RESET_PHRASE} to confirm`} required>
        <TextInput
          value={phrase} placeholder={RESET_PHRASE} autoComplete="off"
          onChange={(e) => setPhrase(e.target.value)} autoFocus
        />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------
function AboutPanel({ runtime }) {
  const [sys, setSys] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/settings/system').then(setSys).catch((err) => setError(describeError(err)));
  }, []);

  if (error) return <Notice tone="bad" title="Could not read the system details">{error}</Notice>;
  if (!sys) return <Loading />;

  return (
    <div className="stack">
      <Card title="University Timetable Management" subtitle={`Version ${sys.appVersion || '—'}`}>
        <dl className="kv">
          <dt>Database file</dt>
          <dd>
            <span className="mono small">{sys.databasePath || 'on the host machine'}</span>
            {sys.databasePath ? (
              <button type="button" className="btn link small" onClick={() => desktop.reveal(sys.databasePath)}>
                Show in folder
              </button>
            ) : null}
          </dd>
          <dt>Database size</dt><dd>{sys.databaseSize || formatBytes(sys.databaseBytes)}</dd>
          <dt>SQLite driver</dt><dd>{sys.sqliteDriver}</dd>
          <dt>Schema version</dt><dd>{sys.schemaVersion}</dd>
          <dt>Sharing mode</dt><dd>{humanise(sys.network.mode)}</dd>
          <dt>Machine</dt><dd>{sys.hostname} · {sys.platform}</dd>
          <dt>Runtime</dt>
          <dd className="small muted">
            Node {sys.node}
            {sys.electron ? ` · Electron ${sys.electron}` : ''}
            {sys.chrome ? ` · Chrome ${sys.chrome}` : ''}
            {runtime && runtime.mode ? ` · ${runtime.mode}` : ''}
          </dd>
          <dt>Key encryption</dt>
          <dd>{sys.encryption.available ? sys.encryption.mechanism : <span className="warn-text">not available</span>}</dd>
        </dl>
      </Card>

      <Notice tone="ok" icon="◇" title="Works offline">{sys.offlineNote}</Notice>
    </div>
  );
}
