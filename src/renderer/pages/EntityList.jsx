import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { describeError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  AcBadge, AcRequirement, Badge, Card, Checkbox, ChipToggles, ConfirmModal, EmptyState, Field,
  Loading, Modal, Notice, PageHead, Select, TextInput,
} from '../components/ui.jsx';
import { DAY_NAMES, formatTime, humanise, pluralise } from '../lib/format.js';

/**
 * One screen for all 19 entity types (Section 1).
 *
 * The columns, the form, the validation hints and the pickers all come from the
 * registry the server sends. Nothing about any particular entity is written here,
 * which is what keeps "add a field" a one-line change on the server rather than a
 * change in five places.
 *
 * Two fields get special treatment on purpose, both from Section 2 / 16: a room's
 * AC status and a course's AC requirement are drawn as unmissable badges rather
 * than as a tick in a column, because choosing the wrong one is the mistake this
 * application exists to prevent.
 */

const PAGE_SIZE = 200;

/** A blank row: every declared default applied, everything else empty. */
function blankValues(entity) {
  const out = {};
  for (const field of entity.fields) {
    out[field.key] = field.default !== undefined ? field.default : '';
  }
  return out;
}

function rowToValues(entity, row) {
  const out = {};
  for (const field of entity.fields) {
    const value = row[field.key];
    if (field.type === 'boolean') out[field.key] = value ? 1 : 0;
    else if (field.type === 'csv') out[field.key] = value == null ? '' : String(value);
    else out[field.key] = value == null ? '' : value;
  }
  return out;
}

export default function EntityList() {
  const { entity: entityKey } = useParams();
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [registry, setRegistry] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // {mode:'create'|'edit', row}
  const [deleting, setDeleting] = useState(null);
  const [options, setOptions] = useState({});

  const entity = useMemo(
    () => (registry ? registry.entities.find((e) => e.key === entityKey) : null),
    [registry, entityKey]
  );

  useEffect(() => {
    api.get('/meta/registry').then(setRegistry).catch(setError);
  }, []);

  const load = useCallback(() => {
    if (!entityKey) return;
    setLoading(true);
    api.get(`/entities/${entityKey}`, { q: query || undefined, limit: PAGE_SIZE })
      .then((body) => { setRows(body.rows || []); setTotal(body.total || 0); setError(null); })
      .catch((err) => { setError(err); setRows([]); })
      .finally(() => setLoading(false));
  }, [entityKey, query]);

  useEffect(() => { load(); }, [load, auth.activeCollegeId]);

  // Pickers for every reference field, scoped by the server to this college.
  useEffect(() => {
    if (!entity) return;
    const refs = entity.fields.filter((f) => f.type === 'ref');
    if (!refs.length) return;
    let cancelled = false;
    Promise.all(refs.map((f) => api.get(`/meta/options/${f.ref}`)
      .then((body) => [f.key, body.options || []])
      .catch(() => [f.key, []])))
      .then((pairs) => { if (!cancelled) setOptions(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [entity, auth.activeCollegeId, rows.length]);

  // "?new=1" opens the form straight away -- the readiness findings link here.
  useEffect(() => {
    if (entity && searchParams.get('new') === '1') {
      setEditing({ mode: 'create', row: null });
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [entity, searchParams, setSearchParams]);

  if (!registry && !error) return <main className="page"><Loading /></main>;

  if (registry && !entity) {
    return (
      <main className="page">
        <PageHead title="Unknown data type" />
        <EmptyState title={`There is no entity called "${entityKey}"`} action={<Link className="btn" to="/data">Back to Data Management</Link>} />
      </main>
    );
  }

  if (entity && entity.customEditor === 'timing') {
    // college_timings has its own editor; sending someone to the generic form
    // would let them build a grid the timing service would then reject.
    navigate('/timing', { replace: true });
    return null;
  }

  const listedFields = entity ? entity.fields.filter((f) => f.listed) : [];
  const canWrite = auth.permissions.canManageData
    && !(entity.superAdminOnly && !auth.isSuperAdmin);
  const canCreate = canWrite && !(entity.superAdminCreateOnly && !auth.isSuperAdmin);

  const remove = async () => {
    try {
      await api.del(`/entities/${entityKey}/${deleting.id}`);
      toast.success(`${entity.singular} deleted.`);
      setDeleting(null);
      load();
    } catch (err) {
      toast.fromError(err);
      setDeleting(null);
    }
  };

  const cellFor = (row, field) => {
    const value = row[field.key];
    switch (field.type) {
      case 'boolean':
        // A room's AC status is the one boolean that is never a tick.
        if (field.key === 'is_ac') return <AcBadge isAc={!!value} />;
        return value ? <Badge tone="ok">Yes</Badge> : <span className="muted">No</span>;
      case 'enum':
        if (field.key === 'ac_requirement') return <AcRequirement value={value} />;
        if (value == null || value === '') return <span className="muted">—</span>;
        if (field.key === 'status') {
          return <Badge tone={value === 'ACTIVE' ? 'ok' : 'plain'}>{humanise(value)}</Badge>;
        }
        return humanise(value);
      case 'ref': {
        const label = row._labels && row._labels[field.key];
        return label || (value == null ? <span className="muted">—</span> : `#${value}`);
      }
      case 'time':
        return value ? formatTime(value) : <span className="muted">—</span>;
      case 'day':
        return value ? (DAY_NAMES[Number(value)] || value) : <span className="muted">—</span>;
      case 'number':
        return value == null || value === '' ? <span className="muted">—</span> : value;
      default:
        return value == null || value === '' ? <span className="muted">—</span> : String(value);
    }
  };

  return (
    <main className="page">
      <PageHead
        title={entity.label}
        breadcrumbs={[{ label: 'Data Management', to: '#/data' }, { label: entity.label }]}
        subtitle={entity.help || `${pluralise(total, entity.singular.toLowerCase())} on record.`}
        actions={(
          <>
            {entity.bulk ? <Link className="btn small" to={`/import?entity=${entity.key}`}>Import from Excel</Link> : null}
            {canCreate ? (
              <button type="button" className="btn primary small" onClick={() => setEditing({ mode: 'create', row: null })}>
                Add {entity.singular}
              </button>
            ) : null}
          </>
        )}
      />

      {entity.superAdminOnly && !auth.isSuperAdmin ? (
        <Notice tone="info">Only a Super Admin can change {entity.label.toLowerCase()}.</Notice>
      ) : null}
      {entity.selfCollegeRow && !auth.isSuperAdmin ? (
        <Notice tone="info">You are looking at your own college. Other colleges are not visible to your account.</Notice>
      ) : null}

      <Card flush>
        <div className="list-toolbar">
          <input
            type="search"
            placeholder={`Search ${entity.label.toLowerCase()}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <span className="spacer" />
          <span className="muted tiny">
            {total > rows.length ? `Showing the first ${rows.length} of ${total}` : pluralise(total, 'record')}
          </span>
        </div>

        {error ? <div className="pad"><Notice tone="bad" title="Could not load">{describeError(error)}</Notice></div> : null}

        {loading ? <div className="pad"><Loading /></div> : rows.length === 0 ? (
          <div className="pad">
            <EmptyState
              icon="＋"
              title={query ? 'Nothing matched that search' : `No ${entity.label.toLowerCase()} yet`}
              action={canCreate && !query ? (
                <button type="button" className="btn primary" onClick={() => setEditing({ mode: 'create', row: null })}>
                  Add the first {entity.singular.toLowerCase()}
                </button>
              ) : null}
            >
              {entity.bulk && !query ? (
                <>You can also fill in a blank Excel template and import it — see <Link to={`/import?entity=${entity.key}`}>Import &amp; Export</Link>.</>
              ) : null}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {listedFields.map((field) => (
                    <th key={field.key} className={field.type === 'number' ? 'num' : undefined}>{field.label}</th>
                  ))}
                  {canWrite ? <th className="right">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    {listedFields.map((field) => (
                      <td key={field.key} className={field.type === 'number' ? 'num' : undefined}>
                        {cellFor(row, field)}
                      </td>
                    ))}
                    {canWrite ? (
                      <td className="right nowrap">
                        <button type="button" className="btn tiny" onClick={() => setEditing({ mode: 'edit', row })}>Edit</button>
                        {canCreate ? (
                          <button type="button" className="btn tiny danger" onClick={() => setDeleting(row)}>Delete</button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <EntityForm
          entity={entity}
          row={editing.row}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); toast.success(message); load(); }}
        />
      ) : null}

      {deleting ? (
        <ConfirmModal
          title={`Delete this ${entity.singular.toLowerCase()}?`}
          message={`"${deleting[entity.titleField] || `#${deleting.id}`}" will be removed.`}
          detail="Anything that refers to it will stop the deletion rather than lose its reference."
          confirmLabel="Delete"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// The generic form
// ---------------------------------------------------------------------------
function EntityForm({ entity, row, options, onClose, onSaved }) {
  const [values, setValues] = useState(() => (row ? rowToValues(entity, row) : blankValues(entity)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState([]);

  const set = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDetails([]);
    try {
      // Empty strings are sent as null so the server sees "not given" rather
      // than "given as blank" -- Section 5's rule that empty never means invalid.
      const payload = {};
      for (const field of entity.fields) {
        const value = values[field.key];
        if (field.type === 'boolean') payload[field.key] = value ? 1 : 0;
        else payload[field.key] = value === '' ? null : value;
      }
      if (row) await api.put(`/entities/${entity.key}/${row.id}`, payload);
      else await api.post(`/entities/${entity.key}`, payload);
      onSaved(row ? `${entity.singular} updated.` : `${entity.singular} added.`);
    } catch (err) {
      setError(describeError(err));
      setDetails(Array.isArray(err.details) ? err.details : []);
      setBusy(false);
    }
  };

  const control = (field) => {
    const id = `f-${field.key}`;
    const value = values[field.key];
    switch (field.type) {
      case 'boolean':
        return (
          <Checkbox
            label={field.key === 'is_ac' ? 'This room is air conditioned' : field.label}
            checked={!!value}
            onChange={(checked) => set(field.key, checked ? 1 : 0)}
          />
        );
      case 'textarea':
        return <textarea id={id} rows={3} value={value ?? ''} onChange={(e) => set(field.key, e.target.value)} />;
      case 'number':
        return (
          <input
            id={id}
            type="number"
            value={value ?? ''}
            min={0}
            onChange={(e) => set(field.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      case 'enum':
        return (
          <Select
            id={id}
            value={value ?? ''}
            placeholder={field.required ? 'Choose…' : '— not set —'}
            options={(field.values || []).map((v) => ({ value: v, label: humanise(v) }))}
            onChange={(e) => set(field.key, e.target.value)}
          />
        );
      case 'ref':
        return (
          <Select
            id={id}
            value={value ?? ''}
            placeholder={field.required ? 'Choose…' : '— not set —'}
            options={(options[field.key] || []).map((opt) => ({
              value: opt.id,
              label: opt.sublabel ? `${opt.label} — ${opt.sublabel}` : opt.label,
            }))}
            onChange={(e) => set(field.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      case 'time':
        return <input id={id} type="time" value={value ?? ''} onChange={(e) => set(field.key, e.target.value)} />;
      case 'date':
        return <input id={id} type="date" value={value ?? ''} onChange={(e) => set(field.key, e.target.value)} />;
      case 'day':
        return (
          <Select
            id={id}
            value={value ?? ''}
            placeholder="Choose a day…"
            options={Object.entries(DAY_NAMES).map(([num, name]) => ({ value: Number(num), label: name }))}
            onChange={(e) => set(field.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      case 'csv':
        if (field.values && field.values.length) {
          const list = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
          return (
            <ChipToggles
              options={field.values.map((v) => ({ value: v, label: humanise(v) }))}
              value={list}
              onChange={(next) => set(field.key, next.join(','))}
            />
          );
        }
        return (
          <TextInput
            id={id}
            value={value ?? ''}
            placeholder="Separate several with commas"
            onChange={(e) => set(field.key, e.target.value)}
          />
        );
      default:
        return <TextInput id={id} value={value ?? ''} onChange={(e) => set(field.key, e.target.value)} />;
    }
  };

  // Fields flagged `prominent` in the registry (AC, for one) are pulled to the
  // top of the form so they cannot be skipped by scrolling past them.
  const ordered = [
    ...entity.fields.filter((f) => f.prominent),
    ...entity.fields.filter((f) => !f.prominent),
  ];

  return (
    <Modal
      title={row ? `Edit ${entity.singular}` : `Add ${entity.singular}`}
      subtitle={entity.help}
      onClose={onClose}
      width="wide"
      footer={(
        <>
          <span className="muted tiny">Fields marked * are required.</span>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="entity-form" className="btn primary" disabled={busy}>
            {busy ? <span className="spinner" /> : null} {row ? 'Save changes' : `Add ${entity.singular}`}
          </button>
        </>
      )}
    >
      <form id="entity-form" onSubmit={submit}>
        {error ? (
          <div className="mb">
            <Notice tone="bad" title="This could not be saved">
              {error}
              {details.length ? <ul>{details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
            </Notice>
          </div>
        ) : null}

        <div className="field-grid">
          {ordered.map((field) => (
            <div key={field.key} className={field.type === 'textarea' || field.type === 'csv' ? 'span-2' : undefined}>
              <Field
                label={field.type === 'boolean' ? null : field.label}
                htmlFor={`f-${field.key}`}
                required={field.required}
                hint={field.help}
              >
                {control(field)}
              </Field>
            </div>
          ))}
        </div>
      </form>
    </Modal>
  );
}
