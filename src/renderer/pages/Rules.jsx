import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { describeError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Card, Checkbox, ConfirmModal, Field, Loading, Notice, PageHead, TextInput,
} from '../components/ui.jsx';

/**
 * Scheduling rules (Section 13).
 *
 * The catalogue comes from the server, so a rule added to the constraint checker
 * appears here without a change to this file. Each rule says plainly whether it
 * is a hard limit or a soft preference, because that is the difference between
 * "the generator will refuse" and "the generator will try".
 */

const SOFT_RULES = new Set([
  'prefer_parallel_subsections', 'avoid_last_period', 'spread_course_across_days',
]);

export default function Rules() {
  const auth = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState([]);
  const [confirmReset, setConfirmReset] = useState(false);

  const readOnly = !auth.permissions.canManageData;

  const load = useCallback(() => {
    setLoading(true);
    api.get('/config/rules')
      .then((body) => {
        setRules(body.rules || []);
        setDraft(Object.fromEntries((body.rules || []).map((r) => [r.key, { value: r.value, enabled: r.enabled }])));
        setError(null);
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load, auth.activeCollegeId]);

  if (loading) return <main className="page"><Loading label="Reading this college's rules…" /></main>;

  const set = (key, patch) => setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const dirty = rules && rules.some((r) => {
    const d = draft[r.key] || {};
    return String(d.value) !== String(r.value) || !!d.enabled !== !!r.enabled;
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    setDetails([]);
    try {
      await api.put('/config/rules', { rules: draft });
      toast.success('Rules saved. The next generation run will follow them.');
      load();
    } catch (err) {
      setError(describeError(err));
      setDetails(Array.isArray(err.details) ? err.details : []);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    try {
      await api.del('/config/rules');
      toast.success('Every rule is back to its shipped default.');
      load();
    } catch (err) {
      toast.fromError(err);
    }
  };

  return (
    <main className="page">
      <PageHead
        title="Scheduling Rules"
        breadcrumbs={[{ label: 'Data Management', to: '#/data' }, { label: 'Scheduling Rules' }]}
        subtitle={auth.activeCollege ? `${auth.activeCollege.name} — rules are per college.` : 'Rules are per college.'}
        actions={readOnly ? null : (
          <>
            <button type="button" className="btn small" onClick={() => setConfirmReset(true)}>Reset to defaults</button>
            <button type="button" className="btn primary small" onClick={save} disabled={busy || !dirty}>
              {busy ? <span className="spinner" /> : null} Save rules
            </button>
          </>
        )}
      />

      {error ? (
        <Notice tone="bad" title="This could not be saved">
          {error}
          {details.length ? <ul>{details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
        </Notice>
      ) : null}

      <Notice tone="info" title="Hard limits and soft preferences">
        A hard limit is never broken by the generator — it will leave a class unplaced and tell you why. A soft
        preference only changes the quality score, so the generator will do its best and move on. Either way you
        can still place a class by hand and override the objection (Section 8).
      </Notice>

      <Card title="Rules" flush>
        <div className="rule-list">
          {(rules || []).map((rule) => {
            const d = draft[rule.key] || {};
            const soft = SOFT_RULES.has(rule.key);
            return (
              <div key={rule.key} className={`rule${d.enabled ? '' : ' off'}`}>
                <div className="rule-body">
                  <div className="rule-label">
                    {rule.label}
                    <span className={`rule-tag ${soft ? 'soft' : 'hard'}`}>{soft ? 'preference' : 'hard limit'}</span>
                    {rule.isDefault ? <span className="muted tiny"> · default</span> : null}
                  </div>
                  {rule.help ? <div className="rule-help">{rule.help}</div> : null}
                </div>

                <div className="rule-control">
                  {rule.type === 'boolean' ? (
                    <Checkbox
                      label={String(d.value) === '1' || d.value === true ? 'On' : 'Off'}
                      checked={String(d.value) === '1' || d.value === true}
                      disabled={readOnly}
                      onChange={(checked) => set(rule.key, { value: checked ? '1' : '0' })}
                    />
                  ) : rule.type === 'number' ? (
                    <input
                      type="number"
                      min={0}
                      value={d.value ?? ''}
                      disabled={readOnly}
                      onChange={(e) => set(rule.key, { value: e.target.value })}
                      style={{ width: 96 }}
                    />
                  ) : (
                    <TextInput
                      value={d.value ?? ''}
                      placeholder="6:5,6:6"
                      disabled={readOnly}
                      onChange={(e) => set(rule.key, { value: e.target.value })}
                    />
                  )}
                  {!readOnly && !soft ? (
                    <label className="check tiny">
                      <input
                        type="checkbox"
                        checked={!!d.enabled}
                        onChange={(e) => set(rule.key, { enabled: e.target.checked })}
                      />
                      <span>Enforce</span>
                    </label>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Next">
        <p className="muted">
          Rules describe what the generator may do. What it actually schedules comes from your data —{' '}
          <Link to="/data">Data Management</Link> — and from what you tell the{' '}
          <Link to="/generate">Generation Wizard</Link> to keep fixed.
        </p>
      </Card>

      {confirmReset ? (
        <ConfirmModal
          title="Put every rule back to its default?"
          message="Your own values for this college will be discarded."
          detail="No timetable is changed — this only affects the next generation run and future checks."
          confirmLabel="Reset rules"
          onConfirm={reset}
          onClose={() => setConfirmReset(false)}
        />
      ) : null}
    </main>
  );
}
