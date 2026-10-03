import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { describeError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  Badge, Card, EmptyState, Loading, Modal, Notice, PageHead, Select,
} from '../components/ui.jsx';
import { formatBytes, pluralise } from '../lib/format.js';

/**
 * The AI Assistant (Section 14).
 *
 * The only screen in the application that can cause an outbound request, so it is
 * written to be honest about that at every step rather than to hide it:
 *
 *   - if there is no key, the panel says so and does not pretend to be thinking
 *   - "Show what will be sent" prints the exact digest before anything leaves
 *   - the privacy line under every answer states what was actually transmitted
 *
 * A teacher or student may ask questions too, but the server answers them against
 * their own week only -- the view is taken from the login, not from this screen.
 */

const MAX_HISTORY = 8;

export default function Assistant() {
  const auth = useAuth();
  const toast = useToast();

  const [status, setStatus] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [timetables, setTimetables] = useState([]);
  const [timetableId, setTimetableId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [turns, setTurns] = useState([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const logRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/assistant/status'),
      api.get('/assistant/suggestions').catch(() => ({ questions: [] })),
      // Coordinators can point a question at one timetable; everyone else asks
      // about whatever they are allowed to see.
      auth.permissions.canEditTimetable
        ? api.get('/timetable').catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
    ])
      .then(([st, sg, tt]) => {
        setStatus(st);
        setSuggestions(sg.questions || []);
        setTimetables(tt.rows || []);
        setError(null);
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, [auth.permissions.canEditTimetable]);

  useEffect(load, [load, auth.activeCollegeId]);

  // Keep the newest turn in sight without yanking the page around.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, asking]);

  const history = useMemo(
    () => turns
      .filter((t) => t.role !== 'error')
      .slice(-MAX_HISTORY)
      .map((t) => ({ role: t.role, content: t.content })),
    [turns]
  );

  const ask = async (text) => {
    const q = String(text == null ? question : text).trim();
    if (!q || asking) return;
    setQuestion('');
    setTurns((prev) => [...prev, { role: 'user', content: q, id: `u${prev.length}` }]);
    setAsking(true);
    try {
      const body = await api.post(
        '/assistant/ask',
        { question: q, history, timetableId: timetableId || null },
        // A model answering over the network needs more than the default budget.
        { timeoutMs: 90000 }
      );
      setTurns((prev) => [...prev, {
        role: 'assistant',
        content: body.answer || '(The model returned an empty answer.)',
        id: `a${prev.length}`,
        privacy: body.privacy,
        model: body.model,
        usage: body.usage,
        elapsedMs: body.elapsedMs,
        finishReason: body.finishReason,
      }]);
    } catch (err) {
      setTurns((prev) => [...prev, { role: 'error', content: describeError(err), id: `e${prev.length}` }]);
      // aiStatus rides along on the error when the key stopped working mid-session.
      if (err && err.aiStatus) setStatus(err.aiStatus);
    } finally {
      setAsking(false);
    }
  };

  const showPreview = async () => {
    setPreviewBusy(true);
    try {
      setPreview(await api.post('/assistant/preview', { timetableId: timetableId || null }));
    } catch (err) {
      toast.fromError(err);
    } finally {
      setPreviewBusy(false);
    }
  };

  if (loading) return <main className="page"><Loading label="Checking whether the Assistant is configured…" /></main>;

  const available = status && status.available;
  const canConfigure = status && status.canConfigure;

  return (
    <main className="page">
      <PageHead
        title="AI Assistant"
        subtitle="Ask about this college's timetable in plain English. This is the only feature that uses the internet."
        actions={auth.permissions.canEditTimetable && available ? (
          <button type="button" className="btn small" onClick={showPreview} disabled={previewBusy}>
            {previewBusy ? <span className="spinner" /> : null} Show what will be sent
          </button>
        ) : null}
      />

      {error ? <Notice tone="bad" title="Could not reach the Assistant">{error}</Notice> : null}

      {!available ? (
        <Notice
          tone="warn"
          title="The Assistant is not switched on"
          actions={canConfigure ? <Link className="btn primary small" to="/settings?panel=ai">Open AI settings</Link> : null}
        >
          {status && status.message
            ? status.message
            : 'An administrator needs to add an OpenAI API key before questions can be answered.'}
          {status && status.encryption && !status.encryption.available ? (
            <div className="tiny mt">
              This machine cannot encrypt a stored key, so the application refuses to keep one at all.
            </div>
          ) : null}
        </Notice>
      ) : null}

      {!auth.activeCollegeId ? (
        <Notice tone="info" title="Choose a college first">
          The Assistant answers about one college&apos;s timetable. Use the switcher at the top of the window.
        </Notice>
      ) : null}

      <Card
        title="Ask a question"
        subtitle={available ? `Answered by ${status.model} using this college's timetable digest.` : null}
        actions={timetables.length ? (
          <div style={{ minWidth: 220 }}>
            <Select
              value={timetableId}
              placeholder="Every current timetable"
              options={timetables.map((t) => ({ value: t.id, label: `${t.name} (${t.status.toLowerCase()})` }))}
              onChange={(e) => setTimetableId(e.target.value)}
            />
          </div>
        ) : null}
      >
        <div className="chat">
          <div className="chat-log" ref={logRef}>
            {turns.length === 0 ? (
              <EmptyState icon="?" title="Nothing asked yet">
                {available
                  ? 'Pick one of the questions below, or type your own.'
                  : 'Once a key is added, your questions and answers will appear here.'}
              </EmptyState>
            ) : null}

            {turns.map((turn) => (
              <React.Fragment key={turn.id}>
                <div className={`bubble ${turn.role === 'user' ? 'me' : turn.role === 'error' ? 'err' : 'ai'}`}>
                  {turn.content}
                </div>
                {turn.role === 'assistant' && turn.privacy ? (
                  <div className="tiny muted" style={{ alignSelf: 'flex-start' }}>
                    {pluralise(turn.privacy.classesSent, 'class', 'classes')} sent
                    {turn.privacy.truncated ? ' (trimmed to fit)' : ''}
                    {' · '}no student data
                    {turn.privacy.namesSent ? ' · real names' : ' · names replaced with labels'}
                    {turn.model ? ` · ${turn.model}` : ''}
                    {turn.elapsedMs ? ` · ${(turn.elapsedMs / 1000).toFixed(1)} s` : ''}
                    {turn.usage && turn.usage.total_tokens ? ` · ${turn.usage.total_tokens} tokens` : ''}
                    {turn.finishReason === 'length' ? ' · answer was cut short' : ''}
                  </div>
                ) : null}
              </React.Fragment>
            ))}

            {asking ? (
              <div className="bubble ai">
                <span className="spinner" /> Thinking…
              </div>
            ) : null}
          </div>

          <form
            className="chat-form"
            onSubmit={(e) => { e.preventDefault(); ask(); }}
          >
            <textarea
              value={question}
              placeholder={available ? 'Why could some classes not be scheduled?' : 'Add an OpenAI key to ask questions'}
              disabled={!available || asking}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a new line, as everyone expects.
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
              }}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn primary" disabled={!available || asking || !question.trim()}>
              Ask
            </button>
          </form>

          {suggestions.length ? (
            <div className="suggestions">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="suggestion"
                  disabled={!available || asking}
                  onClick={() => ask(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}

          {turns.length ? (
            <div className="btn-row">
              <span className="spacer" />
              <button type="button" className="btn small" onClick={() => setTurns([])} disabled={asking}>
                Clear this conversation
              </button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="What leaves this machine" subtitle="Section 14.3 — nothing is sent that you cannot inspect first.">
        <ul className="muted">
          <li><strong>Never sent:</strong> student names, roll numbers, e-mail addresses or any other student identifier. Students appear only as counts.</li>
          <li><strong>Sent:</strong> a compact digest of the timetable — periods, courses, rooms, teacher load, conflicts and unplaced classes.</li>
          <li>
            <strong>Names:</strong>{' '}
            {status && status.includeNames
              ? 'teacher, course and room names are sent as they are.'
              : 'teacher, course and room names are replaced with labels before sending, and put back in the answer.'}
          </li>
          <li><strong>Destination:</strong> {status ? status.endpoint : 'api.openai.com'} — nowhere else, ever.</li>
          {status && status.billingNote ? <li>{status.billingNote}</li> : null}
        </ul>
        {canConfigure ? (
          <Link className="btn small" to="/settings?panel=ai">Change what is included</Link>
        ) : null}
      </Card>

      {preview ? (
        <Modal
          title="Exactly what would be sent"
          subtitle={`${formatBytes(preview.approximateCharacters)} of JSON to ${preview.destination}`}
          width="xwide"
          onClose={() => setPreview(null)}
          footer={(
            <>
              <span className="spacer" />
              <button type="button" className="btn" onClick={() => setPreview(null)}>Close</button>
            </>
          )}
        >
          <div className="mb btn-row">
            <Badge tone={preview.includeNames ? 'warn' : 'ok'}>
              {preview.includeNames ? 'Real names included' : 'Names replaced with labels'}
            </Badge>
            <Badge tone="ok">No student data</Badge>
            {preview.privacyMode ? <Badge tone="ok">Privacy mode on</Badge> : null}
          </div>
          <div className="table-wrap scroll-y">
            <pre className="mono tiny" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(preview.context, null, 2)}
            </pre>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
