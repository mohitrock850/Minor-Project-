import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api, { describeError, downloadFrom } from '../lib/api.js';
import desktop from '../lib/desktop.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Badge, Card, Checkbox, EmptyState, Loading, Modal, Notice, PageHead, Select, Tabs, TextInput,
} from '../components/ui.jsx';
import { formatBytes, formatDateTime, humanise, pluralise } from '../lib/format.js';

/**
 * Import & Export (Section 10).
 *
 * Three steps, in this order, with nothing written until the third:
 *
 *   1. download the template for one kind of data
 *   2. upload the filled-in file and read the report
 *   3. import
 *
 * The report is the point of the screen. It shows every row, the ones with
 * problems marked and explained, so the file can be fixed offline rather than
 * half-imported and then cleaned up in the database.
 */

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const ROWS_SHOWN = 200;

export default function ImportExport() {
  const auth = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [catalogue, setCatalogue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [tab, setTab] = useState(params.get('tab') === 'history' ? 'history' : 'import');
  const [entityKey, setEntityKey] = useState(params.get('entity') || '');
  const [withData, setWithData] = useState(false);
  const [busy, setBusy] = useState('');

  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [allowPartial, setAllowPartial] = useState(false);
  const [result, setResult] = useState(null);
  const [columnsFor, setColumnsFor] = useState(null);

  const [batches, setBatches] = useState([]);
  const [batch, setBatch] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/import/entities')
      .then((body) => {
        setCatalogue(body);
        setEntityKey((prev) => {
          if (prev && (body.entities || []).some((e) => e.key === prev)) return prev;
          return (body.entities || []).length ? body.entities[0].key : '';
        });
        setError(null);
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load, auth.activeCollegeId]);

  const loadBatches = useCallback(() => {
    api.get('/import/batches')
      .then((body) => setBatches(body.batches || []))
      .catch(() => setBatches([]));
  }, []);

  useEffect(() => { if (tab === 'history') loadBatches(); }, [tab, loadBatches, auth.activeCollegeId]);

  const entities = (catalogue && catalogue.entities) || [];
  const entity = useMemo(() => entities.find((e) => e.key === entityKey) || null, [entities, entityKey]);

  /** Changing the kind of data invalidates any file already chosen. */
  const chooseEntity = (key) => {
    setEntityKey(key);
    setFile(null);
    setReport(null);
    setResult(null);
    setAllowPartial(false);
    const next = new URLSearchParams(params);
    next.set('entity', key);
    setParams(next, { replace: true });
  };

  const downloadTemplate = async () => {
    if (!entity) return;
    setBusy('template');
    try {
      const saved = await downloadFrom(`/import/template/${entity.key}`, {
        query: withData ? { withData: 1 } : undefined,
        kind: 'excel',
      });
      if (saved && saved.saved === false && !saved.cancelled) throw new Error(saved.error || 'Could not save the file.');
      if (saved && saved.cancelled) toast.info('Download cancelled.');
      else toast.success(`Template saved${saved && saved.path ? ` to ${saved.path}` : ''}.`);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy('');
    }
  };

  const pickFile = async () => {
    setBusy('pick');
    try {
      const picked = await desktop.openFile({
        kind: 'excel',
        accept: '.xlsx,.xls,.csv',
        title: `Choose the filled-in ${entity ? entity.label.toLowerCase() : 'data'} file`,
        maxBytes: MAX_UPLOAD_BYTES,
      });
      if (!picked || !picked.opened) {
        if (picked && picked.error) toast.error(picked.error);
        return;
      }
      setFile(picked);
      setReport(null);
      setResult(null);
      setAllowPartial(false);
      await validate(picked);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy('');
    }
  };

  const validate = async (picked) => {
    const chosen = picked || file;
    if (!chosen || !entity) return;
    setBusy('validate');
    setReport(null);
    setResult(null);
    try {
      const body = await api.post('/import/validate', {
        entity: entity.key,
        filename: chosen.name,
        dataBase64: chosen.data,
      });
      setReport(body);
      if (body.fileErrors && body.fileErrors.length) toast.error(body.fileErrors[0]);
      else if (body.errorRows) toast.warn(body.summary);
      else toast.success(body.summary);
    } catch (err) {
      // A file the server cannot even parse still comes back with a report
      // sometimes; show whichever of the two we were given.
      if (err && err.report) setReport(err.report);
      toast.fromError(err);
    } finally {
      setBusy('');
    }
  };

  const commit = async () => {
    if (!file || !entity) return;
    setBusy('commit');
    try {
      const body = await api.post('/import/commit', {
        entity: entity.key,
        filename: file.name,
        dataBase64: file.data,
        allowPartial,
      });
      setResult(body);
      setReport(body.report || report);
      toast.success(body.message);
      loadBatches();
    } catch (err) {
      if (err && err.report) setReport(err.report);
      toast.fromError(err);
    } finally {
      setBusy('');
    }
  };

  const showColumns = async () => {
    if (!entity) return;
    setBusy('columns');
    try {
      setColumnsFor(await api.get(`/import/columns/${entity.key}`));
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy('');
    }
  };

  if (loading) return <main className="page"><Loading label="Reading what can be imported…" /></main>;

  if (error) {
    return (
      <main className="page">
        <PageHead title="Import &amp; Export" />
        <Notice tone="bad" title="Could not load the import templates">{error}</Notice>
      </main>
    );
  }

  const byGroup = [];
  for (const e of entities) {
    let group = byGroup.find((g) => g.name === (e.group || 'Other'));
    if (!group) { group = { name: e.group || 'Other', entities: [] }; byGroup.push(group); }
    group.entities.push(e);
  }

  return (
    <main className="page">
      <PageHead
        title="Import &amp; Export"
        breadcrumbs={[{ label: 'Data Management', to: '#/data' }, { label: 'Import & Export' }]}
        subtitle="Fill a template in offline, upload it, read the report, then import."
      />

      {catalogue && !catalogue.excelAvailable ? (
        <Notice tone="info" title="Templates are CSV files in this build">{catalogue.formatNote}</Notice>
      ) : null}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'import', label: 'Import' },
          { value: 'export', label: 'Export your data' },
          { value: 'history', label: 'Past imports' },
        ]}
      />

      {tab === 'import' ? (
        <>
          <Card title="1. What are you adding?" subtitle="One kind of data per file.">
            <div className="field-grid">
              <Select
                value={entityKey}
                onChange={(e) => chooseEntity(e.target.value)}
                options={byGroup.flatMap((g) => g.entities.map((e) => ({
                  value: e.key, label: `${g.name} — ${e.label}`,
                })))}
              />
              <div className="btn-row">
                <button type="button" className="btn small" onClick={showColumns} disabled={!entity || busy === 'columns'}>
                  {busy === 'columns' ? <span className="spinner" /> : null} See the columns
                </button>
              </div>
            </div>

            {entity ? (
              <div className="mt">
                <div className="tiny muted mb">
                  {pluralise(entity.columns.length, 'column')}
                  {entity.columns.filter((c) => c.required).length
                    ? ` · required: ${entity.columns.filter((c) => c.required).map((c) => c.header).join(', ')}`
                    : ''}
                </div>
                {entity.duplicateKey && entity.duplicateKey.length ? (
                  <div className="tiny muted">
                    A {entity.singular.toLowerCase()} is treated as a duplicate when{' '}
                    <strong>{entity.duplicateKey.join(' + ')}</strong> already exists.
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card
            title="2. Download the template"
            subtitle="The headers are how the file is understood — do not rename or reorder them."
          >
            <Checkbox
              label="Pre-fill it with what is already in the system"
              hint="Useful for correcting existing rows offline, or as an export of this data."
              checked={withData}
              onChange={setWithData}
            />
            <div className="btn-row mt">
              <button type="button" className="btn primary" onClick={downloadTemplate} disabled={!entity || busy === 'template'}>
                {busy === 'template' ? <span className="spinner" /> : null}{' '}
                Download {entity ? entity.label : 'template'}
              </button>
              {catalogue ? <span className="tiny muted">Template version {catalogue.templateVersion}</span> : null}
            </div>
          </Card>

          <Card title="3. Upload it" subtitle="Nothing is written yet — this only produces the report.">
            <div className="btn-row">
              <button type="button" className="btn" onClick={pickFile} disabled={!entity || busy === 'pick'}>
                {busy === 'pick' ? <span className="spinner" /> : null} Choose a file…
              </button>
              {file ? (
                <>
                  <span className="bold">{file.name}</span>
                  <span className="muted tiny">{formatBytes(file.bytes)}</span>
                  <button type="button" className="btn small" onClick={() => validate()} disabled={busy === 'validate'}>
                    {busy === 'validate' ? <span className="spinner" /> : null} Check it again
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => { setFile(null); setReport(null); setResult(null); }}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="muted tiny">At most {formatBytes(MAX_UPLOAD_BYTES)}.</span>
              )}
            </div>
          </Card>

          {report ? <ImportReport report={report} /> : null}

          {report && !result ? (
            <Card title="4. Import" flush={false}>
              {report.fileErrors && report.fileErrors.length ? (
                <Notice tone="bad" title="This file cannot be imported as it is">
                  <ul>{report.fileErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </Notice>
              ) : (
                <>
                  {report.errorRows ? (
                    <Checkbox
                      label={`Import the ${report.validRows} good row(s) only, skipping ${report.errorRows}`}
                      hint="Without this, an import is all-or-nothing: nothing is written while any row has a problem."
                      checked={allowPartial}
                      onChange={setAllowPartial}
                    />
                  ) : null}
                  <div className="btn-row mt">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={commit}
                      disabled={busy === 'commit' || !report.canImport || (report.errorRows > 0 && !allowPartial)}
                    >
                      {busy === 'commit' ? <span className="spinner" /> : null}{' '}
                      Import {report.errorRows && allowPartial ? report.validRows : report.totalRows} row(s)
                    </button>
                    <span className="muted tiny">
                      Take a backup first if this is a large change — Settings &rarr; Backup.
                    </span>
                  </div>
                </>
              )}
            </Card>
          ) : null}

          {result ? (
            <Notice
              tone="ok"
              title={result.message}
              actions={(
                <>
                  <Link className="btn small" to={`/data/${result.entity}`}>See the {result.entityLabel.toLowerCase()}</Link>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => { setFile(null); setReport(null); setResult(null); }}
                  >
                    Import something else
                  </button>
                </>
              )}
            >
              {result.skipped ? `${result.skipped} row(s) were skipped because they had problems.` : null}
            </Notice>
          ) : null}
        </>
      ) : null}

      {tab === 'export' ? (
        <Card
          title="Export your data"
          subtitle="Each export is the same template as the import, filled in — so it can be edited and imported back."
        >
          <div className="tile-grid">
            {entities.map((e) => (
              <button
                key={e.key}
                type="button"
                className="tile"
                onClick={async () => {
                  setBusy(`export-${e.key}`);
                  try {
                    await downloadFrom(`/import/template/${e.key}`, { query: { withData: 1 }, kind: 'excel' });
                    toast.success(`${e.label} exported.`);
                  } catch (err) {
                    toast.error(describeError(err));
                  } finally {
                    setBusy('');
                  }
                }}
              >
                <span className="tile-count">{busy === `export-${e.key}` ? <span className="spinner" /> : '↓'}</span>
                <span className="tile-label">{e.label}</span>
                <span className="tile-help">{e.group}</span>
              </button>
            ))}
          </div>
          <p className="muted tiny mt">
            Looking for a timetable rather than the data behind it? Those export as PDF, Excel, CSV or a calendar
            file from <Link to="/views">Timetable Views</Link>.
          </p>
        </Card>
      ) : null}

      {tab === 'history' ? (
        <Card title="Past imports" flush>
          {batches.length === 0 ? (
            <div className="pad"><EmptyState icon="○" title="Nothing has been imported on this machine yet" /></div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>File</th>
                    <th className="num">Rows</th>
                    <th className="num">Imported</th>
                    <th className="num">Skipped</th>
                    <th>Result</th>
                    <th>By</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className={b.status === 'FAILED' ? 'is-error' : undefined}>
                      <td className="nowrap">{formatDateTime(b.created_at)}</td>
                      <td>{humanise(b.entity)}</td>
                      <td className="muted">{b.filename || '—'}</td>
                      <td className="num">{b.total_rows}</td>
                      <td className="num">{b.valid_rows}</td>
                      <td className="num">{b.error_rows}</td>
                      <td>
                        <Badge tone={b.status === 'COMMITTED' ? 'ok' : 'bad'}>
                          {b.status === 'COMMITTED' ? 'Imported' : 'Failed'}
                        </Badge>
                      </td>
                      <td className="muted">{b.created_by_name || '—'}</td>
                      <td className="actions">
                        <button
                          type="button"
                          className="btn tiny"
                          onClick={() => api.get(`/import/batches/${b.id}`).then(setBatch).catch(toast.fromError)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {columnsFor ? (
        <Modal
          title={`${columnsFor.entityLabel} — the columns`}
          subtitle={`Template version ${columnsFor.templateVersion}. Headers must match exactly.`}
          width="wide"
          onClose={() => setColumnsFor(null)}
          footer={<><span className="spacer" /><button type="button" className="btn" onClick={() => setColumnsFor(null)}>Close</button></>}
        >
          <div className="table-wrap">
            <table className="data compact">
              <thead><tr><th>Column</th><th>Required</th><th>Type</th><th>What goes in it</th></tr></thead>
              <tbody>
                {columnsFor.columns.map((c) => (
                  <tr key={c.key}>
                    <td className="mono">{c.header}</td>
                    <td>{c.required ? <Badge tone="warn">required</Badge> : <span className="muted tiny">optional</span>}</td>
                    <td className="muted tiny">{humanise(c.type)}</td>
                    <td className="muted tiny">{c.hint || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {columnsFor.references && columnsFor.references.length ? (
            <div className="mt">
              <div className="bold mb">Valid values for the reference columns</div>
              <p className="muted tiny">
                These are what already exist in this college. Type the value exactly as shown — this is where
                most import errors come from.
              </p>
              {columnsFor.references.map((ref) => (
                <div key={ref.header || ref.label || ref.key} className="mb">
                  <div className="small bold">{ref.header || ref.label || ref.key}</div>
                  <div className="muted tiny">
                    {(ref.values || ref.options || []).slice(0, 60)
                      .map((v) => (typeof v === 'string' ? v : (v.label || v.name || v.value)))
                      .join(' · ') || 'Nothing has been added yet.'}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </Modal>
      ) : null}

      {batch ? (
        <Modal
          title={`Import #${batch.id} — ${humanise(batch.entity)}`}
          subtitle={`${formatDateTime(batch.created_at)} · ${batch.filename || 'no filename'}`}
          width="wide"
          onClose={() => setBatch(null)}
          footer={<><span className="spacer" /><button type="button" className="btn" onClick={() => setBatch(null)}>Close</button></>}
        >
          <div className="kv">
            <div>Result</div>
            <div>{batch.status === 'COMMITTED' ? 'Imported' : 'Failed — nothing was written'}</div>
            <div>Rows in the file</div>
            <div>{batch.total_rows}</div>
            <div>Imported</div>
            <div>{batch.valid_rows}</div>
            <div>Skipped</div>
            <div>{batch.error_rows}</div>
          </div>
          {batch.report && batch.report.message ? (
            <Notice tone="bad" title="Why it failed">{batch.report.message}</Notice>
          ) : null}
          {batch.report && Array.isArray(batch.report.skipped) && batch.report.skipped.length ? (
            <div className="mt">
              <div className="bold mb">Rows that were skipped</div>
              <div className="table-wrap scroll-y">
                <table className="data compact">
                  <thead><tr><th className="num">Row</th><th>Problem</th></tr></thead>
                  <tbody>
                    {batch.report.skipped.map((s) => (
                      <tr key={s.rowNumber} className="is-error">
                        <td className="num">{s.rowNumber}</td>
                        <td>{(s.errors || []).join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </main>
  );
}

/** The pre-import report of Section 10.3 -- every row, with the bad ones explained. */
function ImportReport({ report }) {
  const [onlyProblems, setOnlyProblems] = useState(report.errorRows > 0);
  const rows = onlyProblems ? report.rows.filter((r) => !r.ok) : report.rows;
  const shown = rows.slice(0, ROWS_SHOWN);

  return (
    <Card
      title="What would happen"
      subtitle={report.summary}
      actions={report.errorRows ? (
        <Checkbox
          label="Only rows with problems"
          checked={onlyProblems}
          onChange={setOnlyProblems}
        />
      ) : null}
    >
      <div className="stat-row mb">
        <span><strong>{report.totalRows}</strong> <span className="muted tiny">rows in the file</span></span>
        <span className="ok-text"><strong>{report.validRows}</strong> <span className="muted tiny">ready</span></span>
        <span className={report.errorRows ? 'bad-text' : undefined}>
          <strong>{report.errorRows}</strong> <span className="muted tiny">with problems</span>
        </span>
        <span><strong>{report.duplicateRows}</strong> <span className="muted tiny">duplicates</span></span>
      </div>

      {report.fileErrors && report.fileErrors.length ? (
        <Notice tone="bad" title="The file itself is wrong">
          <ul>{report.fileErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </Notice>
      ) : null}

      {report.fileWarnings && report.fileWarnings.length ? (
        <Notice tone="warn" title="Worth checking">
          <ul>{report.fileWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Notice>
      ) : null}

      {report.rows.length === 0 ? (
        <EmptyState icon="○" title="No data rows were found in that file">
          The first row must be the headers, and the rows beneath it the data.
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap scroll-y">
            <table className="data compact">
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Would become</th>
                  <th>Problems</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={r.rowNumber}
                    className={r.duplicate ? 'is-duplicate' : r.ok ? undefined : 'is-error'}
                  >
                    <td className="num">{r.rowNumber}</td>
                    <td>
                      {r.preview}
                      {r.duplicate ? <> <Badge tone="warn">duplicate</Badge></> : null}
                    </td>
                    <td>
                      {r.ok ? <span className="ok-text tiny">ready</span> : (
                        <span className="bad-text tiny">{r.errors.join(' · ')}</span>
                      )}
                      {r.warnings && r.warnings.length ? (
                        <div className="tiny muted">{r.warnings.join(' · ')}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > ROWS_SHOWN ? (
            <div className="tiny muted mt">
              Showing the first {ROWS_SHOWN} of {rows.length}. Fix these, upload again, and the rest will follow.
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
