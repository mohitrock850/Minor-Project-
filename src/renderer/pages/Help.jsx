import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Card, EmptyState, PageHead, TextInput } from '../components/ui.jsx';

/**
 * Help (Section 16.4).
 *
 * Written for a coordinator who has never seen the application before, in the
 * order they will actually meet things: get the data in, describe the day,
 * generate, then read and fix. Every entry links to the screen it talks about so
 * nothing has to be hunted for.
 *
 * The vocabulary here is deliberately the vocabulary the rest of the interface
 * uses -- "hard limit", "AUTO", "override", "Non-AC" -- because a glossary whose
 * words do not appear on screen helps nobody.
 */

const TOPICS = [
  {
    id: 'start',
    title: 'Getting started',
    tags: ['setup', 'first', 'begin', 'demo', 'seed'],
    body: (
      <>
        <p>
          The application ships with a small demo university so every screen has something in it. When you are
          ready to put your own institution in, take a backup, then use{' '}
          <strong>Settings &rarr; Danger zone &rarr; Reset to empty</strong>. That clears the demo colleges and
          leaves your login working.
        </p>
        <ol>
          <li>Add your university, colleges, departments, programmes and semesters under <Link to="/data">Data Management</Link>.</li>
          <li>Describe each college&apos;s day under <Link to="/timing">Timing Configuration</Link> — working days, period times and breaks.</li>
          <li>Add rooms, teachers, courses, sections and sub-sections. Large lists are far quicker to <Link to="/import">import from Excel</Link>.</li>
          <li>Watch <strong>Data Setup Progress</strong> on the Data Management screen. When it says you are ready, generate.</li>
        </ol>
      </>
    ),
  },
  {
    id: 'auto',
    title: 'What AUTO means',
    tags: ['auto', 'blank', 'empty', 'engine decides', 'wizard'],
    body: (
      <>
        <p>
          Every choice in the <Link to="/generate">Generation Wizard</Link> may be left blank. A blank field is
          not an error and it is not a default — it means <strong>let the engine decide</strong>. Leave the
          teacher blank and any eligible teacher may be used; leave the room blank and any suitable room may be
          used; leave the time blank and the whole week is searched.
        </p>
        <p className="muted">
          Fields the engine will decide for you are marked <span className="auto-tag">AUTO</span> as you go, and
          the wizard&apos;s last step lists every one of them before anything is written.
        </p>
      </>
    ),
  },
  {
    id: 'hard-soft',
    title: 'Hard limits and soft preferences',
    tags: ['rules', 'constraint', 'hard', 'soft', 'preference', 'limit'],
    body: (
      <>
        <p>
          A <strong>hard limit</strong> is never broken. If a class cannot be placed without breaking one, the
          generator leaves that class unplaced and tells you which limit stopped it. A teacher being in two
          rooms at once, a room being double-booked, and a room too small for the group are all hard.
        </p>
        <p>
          A <strong>soft preference</strong> only moves the quality score. Avoiding the last period of the day,
          spreading a course across the week, running sub-section labs in parallel — the generator tries, and
          carries on when it cannot.
        </p>
        <p>
          Which is which, and which are switched on, is per college under{' '}
          <Link to="/rules">Scheduling Rules</Link>.
        </p>
      </>
    ),
  },
  {
    id: 'override',
    title: 'Placing a class anyway (override)',
    tags: ['override', 'conflict', 'force', 'do it anyway', 'clash'],
    body: (
      <>
        <p>
          When you move or create a class by hand and it breaks a hard limit, the application refuses and
          explains why — and then offers <strong>&ldquo;Do it anyway&rdquo;</strong>. Choosing it places the
          class, records the objection on the class itself, and writes it to the activity log with your name.
        </p>
        <p>
          Overridden classes keep a warning marker in every view, so a deliberate clash is never mistaken for a
          clean timetable. Publishing a timetable that still contains one asks you to confirm a second time.
        </p>
      </>
    ),
  },
  {
    id: 'lock',
    title: 'Locking, and re-generating safely',
    tags: ['lock', 'locked', 'regenerate', 'keep', 'hybrid'],
    body: (
      <>
        <p>
          <strong>Lock</strong> a class you are happy with. The generator treats a locked class as immovable
          furniture: it will schedule everything else around it and will never move or delete it.
        </p>
        <p>
          That makes re-generating safe. Fix the two or three classes that matter, lock them, then run the
          wizard again with <em>Keep locked classes</em> on. Hybrid mode is exactly this pattern: place what you
          care about by hand, let the engine fill the rest.
        </p>
      </>
    ),
  },
  {
    id: 'ac',
    title: 'AC and Non-AC rooms',
    tags: ['ac', 'non-ac', 'air conditioning', 'room', 'capacity'],
    body: (
      <>
        <p>
          Air conditioning is shown everywhere a room is named, as a solid{' '}
          <span className="badge-ac">AC</span> or <span className="badge-nonac">NON-AC</span> badge — never as a
          tick in a column you have to hunt for.
        </p>
        <p>
          A course may say <strong>AC required</strong>, <strong>AC preferred</strong> or{' '}
          <strong>AC not required</strong>. &ldquo;Required&rdquo; is a hard limit — a Non-AC room will not be
          used. &ldquo;Preferred&rdquo; is soft — an AC room scores better, a Non-AC room is still allowed.
        </p>
        <p>
          Room capacity is arithmetic, not a guess: the room comparison card shows seats, the group&apos;s
          strength, and how much room is left over.
        </p>
      </>
    ),
  },
  {
    id: 'split',
    title: 'Sub-sections and parallel labs',
    tags: ['sub-section', 'split', 'batch', 'parallel', 'lab'],
    body: (
      <>
        <p>
          A section can be split into sub-sections (B1, B2, …) for practicals. A sub-section class appears in its
          parent section&apos;s view labelled <strong>Section B / B1</strong>, and in the views of whichever
          teacher and room are actually used.
        </p>
        <p>
          Where two sub-sections take their lab in the same period with different teachers and rooms, the views
          draw them side by side in one cell. That is a <em>parallel group</em>, and it is what the
          &ldquo;prefer parallel sub-sections&rdquo; preference is trying to achieve.
        </p>
      </>
    ),
  },
  {
    id: 'views',
    title: 'Reading a timetable',
    tags: ['view', 'section', 'faculty', 'room', 'student', 'export', 'pdf'],
    body: (
      <>
        <p>
          <Link to="/views">Timetable Views</Link> shows the same week from ten different angles — college,
          department, programme, semester, section, sub-section, teacher, room, course, or one student. The grid
          and the cards are identical in each, so nothing has to be re-learned.
        </p>
        <p>
          Any view can be exported to PDF, Excel, CSV or a calendar file (.ics) that Outlook and Google Calendar
          both read. Print uses the same layout as the PDF.
        </p>
        <p className="muted">
          A teacher or student sees only their own week — the server decides that from the login, not the
          screen.
        </p>
      </>
    ),
  },
  {
    id: 'import',
    title: 'Importing from Excel',
    tags: ['import', 'excel', 'template', 'csv', 'bulk', 'upload'],
    body: (
      <>
        <p>
          Download the template for the kind of data you are adding, fill it in offline, then upload it. Nothing
          is written until you have read the report: it lists every row with a problem, every duplicate, and
          every column it did not recognise.
        </p>
        <p>
          Do not rename or reorder the columns — the headers are how the file is understood. The second sheet of
          each template lists the valid values for reference columns, which is where most mistakes happen.
        </p>
        <p>
          An import is all-or-nothing unless you explicitly choose <em>Import valid rows only</em>.
        </p>
      </>
    ),
  },
  {
    id: 'ai',
    title: 'The AI Assistant, and your data',
    tags: ['ai', 'assistant', 'openai', 'key', 'privacy', 'internet'],
    body: (
      <>
        <p>
          The <Link to="/assistant">Assistant</Link> is the only part of this application that uses the
          internet. It is switched off until an administrator adds their own OpenAI API key in{' '}
          <Link to="/settings">Settings</Link>. Everything else — data, generation, views, exports, backups —
          works with the network unplugged.
        </p>
        <p>
          Student names and identifiers are never transmitted; students appear only as counts. Teacher, course
          and room names can be replaced with labels before sending. You can see exactly what would be
          transmitted before you send anything.
        </p>
        <p>
          The key is encrypted by Windows&apos; own credential protection and never leaves this machine except
          to api.openai.com. Requests are billed to the OpenAI account that owns the key.
        </p>
      </>
    ),
  },
  {
    id: 'lan',
    title: 'Sharing between machines',
    tags: ['lan', 'network', 'host', 'client', 'share', 'multi'],
    body: (
      <>
        <p>
          One machine can hold the database and let others use it. On that machine choose{' '}
          <strong>Host</strong> in <Link to="/settings">Settings &rarr; Database &amp; sharing</Link> and note
          one of the addresses it shows you. On every other machine choose <strong>Client</strong> and type that
          address.
        </p>
        <p>
          Keep the host switched on while others are working, and keep taking backups <em>on the host</em> — a
          client stores nothing of its own.
        </p>
      </>
    ),
  },
  {
    id: 'backup',
    title: 'Backups',
    tags: ['backup', 'restore', 'reset', 'safety', 'copy'],
    body: (
      <>
        <p>
          A backup is one file containing everything. Make one before importing a large spreadsheet, before
          restoring, and before resetting. Keep a copy somewhere other than this machine.
        </p>
        <p>
          Restoring replaces the live database completely — but the database it replaced is itself saved first,
          so a mistaken restore can be undone.
        </p>
      </>
    ),
  },
  {
    id: 'roles',
    title: 'Who can do what',
    tags: ['role', 'permission', 'admin', 'faculty', 'student', 'access'],
    body: (
      <>
        <ul>
          <li><strong>Super Admin</strong> — every college, plus universities, user accounts, sharing and restore.</li>
          <li><strong>Timetable Coordinator</strong> — everything within their own college: data, generation, editing, publishing.</li>
          <li><strong>Faculty</strong> — their own week, and their own availability.</li>
          <li><strong>Student</strong> — their own week, read only.</li>
        </ul>
        <p className="muted">
          These limits are enforced by the server. A guessed address cannot show you another college&apos;s
          data.
        </p>
      </>
    ),
  },
  {
    id: 'unplaced',
    title: 'Some classes were not placed',
    tags: ['unplaced', 'failed', 'unscheduled', 'why', 'problem', 'trouble'],
    body: (
      <>
        <p>
          The generator never invents a placement that breaks a hard limit, so an unplaced class is information,
          not a failure. Each one is listed with the reason. The usual causes, in the order worth checking:
        </p>
        <ul>
          <li><strong>No eligible teacher.</strong> Nobody is linked to that course under People &rarr; Faculty–Course.</li>
          <li><strong>No suitable room.</strong> Nothing is large enough, or of the required type, or AC where AC is required.</li>
          <li><strong>The week is full.</strong> The wizard&apos;s preview shows this before you run — periods needed against periods available.</li>
          <li><strong>Constraints too tight.</strong> A fixed day, a narrow window and a single named teacher can leave no legal slot.</li>
          <li><strong>Availability whitelists.</strong> One &ldquo;available&rdquo; window on a day makes the rest of that day unusable for that teacher.</li>
        </ul>
      </>
    ),
  },
];

const GLOSSARY = [
  ['Assignment', 'One class in one period: a course, a group, a teacher, a room and a time.'],
  ['Component', 'The kind of class — lecture, tutorial or practical. A course can need several.'],
  ['Group key', 'What ties sub-section classes together so they can be recognised as one parallel group.'],
  ['Hard limit', 'A rule the generator will never break, even at the cost of leaving a class unplaced.'],
  ['Occurrence', 'One class the data says must exist, before any time or room is chosen.'],
  ['Override', 'Placing a class by hand despite a hard conflict. Recorded on the class and in the log.'],
  ['Period', 'One teaching slot in the day, as defined in Timing Configuration.'],
  ['Quality score', '0–100, from the soft preferences. Useful for comparing two runs; not a pass mark.'],
  ['Soft preference', 'A rule that only changes the score. The generator tries and moves on.'],
  ['Snapshot / version', 'A frozen copy of a timetable you can compare against or roll back to.'],
  ['Sub-section', 'A practical batch within a section — B1, B2 — which may be taught in parallel.'],
  ['Unplaced', 'An occurrence the generator could not place. Always accompanied by the reason.'],
];

const matches = (text, needle) => String(text).toLowerCase().includes(needle);

export default function Help() {
  const auth = useAuth();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set(['start']));

  const needle = query.trim().toLowerCase();
  const topics = needle
    ? TOPICS.filter((t) => matches(t.title, needle) || t.tags.some((tag) => matches(tag, needle)))
    : TOPICS;
  const glossary = needle
    ? GLOSSARY.filter(([term, meaning]) => matches(term, needle) || matches(meaning, needle))
    : GLOSSARY;

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <main className="page">
      <PageHead
        title="Help"
        subtitle="How this application expects to be used, in the order you will meet it."
        actions={(
          <div style={{ minWidth: 220 }}>
            <TextInput
              value={query}
              placeholder="Search help…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
      />

      {needle && topics.length === 0 && glossary.length === 0 ? (
        <EmptyState icon="?" title={`Nothing in the help mentions “${query}”`}>
          Try a plainer word — &ldquo;room&rdquo;, &ldquo;import&rdquo;, &ldquo;conflict&rdquo;.
        </EmptyState>
      ) : null}

      {topics.map((topic) => {
        const isOpen = needle ? true : open.has(topic.id);
        return (
          <Card key={topic.id} flush>
            <button
              type="button"
              className="btn link help-head"
              onClick={() => toggle(topic.id)}
              aria-expanded={isOpen}
            >
              <span className="bold">{topic.title}</span>
              <span className="spacer" />
              <span className="muted" aria-hidden="true">{isOpen ? '−' : '+'}</span>
            </button>
            {isOpen ? <div className="help-body">{topic.body}</div> : null}
          </Card>
        );
      })}

      {glossary.length ? (
        <Card title="Words this application uses" subtitle="The same words appear on the screens themselves.">
          <div className="kv">
            {glossary.map(([term, meaning]) => (
              <React.Fragment key={term}>
                <div>{term}</div>
                <div className="muted">{meaning}</div>
              </React.Fragment>
            ))}
          </div>
        </Card>
      ) : null}

      <Card title="Still stuck?">
        <p className="muted">
          The <Link to="/assistant">Assistant</Link> can explain a specific timetable — why a class could not be
          placed, which teachers are near their limit, which rooms are idle. It needs an OpenAI key; everything
          else here does not.
        </p>
        {auth.isSuperAdmin ? (
          <p className="muted tiny">
            Version and database details are under <Link to="/settings">Settings &rarr; About</Link>.
          </p>
        ) : null}
      </Card>
    </main>
  );
}
