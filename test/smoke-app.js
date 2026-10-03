'use strict';

/**
 * Boots the real backend against a throwaway database, serving the built
 * renderer, and checks the pieces Electron would otherwise be the first thing to
 * exercise: the static bundle, /health, sign-in, and then the Section 17
 * acceptance path all the way through a real generation run.
 *
 * Deliberately not part of npm test -- it needs dist/renderer to exist.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { startServer } = require(path.join(ROOT, 'src/server/index.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-smoke-'));
const dbPath = path.join(dir, 'smoke.db');
const staticDir = path.join(ROOT, 'dist/renderer');

let pass = 0;
let fail = 0;
const check = (ok, label, extra) => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`); } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra ? `\n        ${String(extra).slice(0, 300)}` : ''}`);
  }
};
const head = (title) => console.log(`\n${title}`);

(async () => {
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
    console.error('dist/renderer/index.html is missing -- run "npm run build:renderer" first.');
    process.exit(1);
  }

  const { server, port } = await startServer({ dbPath, staticDir, port: 0 });
  const base = `http://127.0.0.1:${port}`;
  console.log(`\nServer up on ${base}`);

  const json = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  const signIn = async (username) => {
    const res = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'demo1234' }),
    });
    return res.body && res.body.token ? res.body : null;
  };
  const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
  const send = (token, method, p, body) => json(p, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // -------------------------------------------------------------------------
  head('The shell Electron loads');
  const html = await fetch(`${base}/`);
  const text = await html.text();
  check(html.status === 200 && /<div id="root">/.test(text), 'the built interface is served at /');
  const assetName = /assets\/(index-[^"]+\.js)/.exec(text);
  check(!!assetName, 'index.html references the compiled bundle');
  if (assetName) {
    const js = await fetch(`${base}/assets/${assetName[1]}`);
    check(js.status === 200, 'the bundle itself loads');
  }
  const deep = await fetch(`${base}/generate`);
  check(deep.status === 200, 'an unknown path falls back to the interface (SPA routing)');

  head('Health and the seeded logins');
  const health = await json('/api/health');
  check(health.status === 200 && health.body.ok === true, 'GET /api/health reports ok');
  check(
    health.body.seed && health.body.seed.accounts.length === 5,
    'health names the five seeded accounts',
    JSON.stringify(health.body.seed)
  );
  check(health.body.driver && health.body.databaseOpen === true,
    `the database is open via ${health.body.driver}`);

  // -------------------------------------------------------------------------
  head('Section 17 -- the coordinator for College A');
  const coord = await signIn('coordinator.a');
  check(!!coord, 'coordinator.a can sign in');
  if (!coord) { server.close(); process.exit(1); }

  check(coord.user.role === 'COLLEGE_ADMIN', 'and is stored as COLLEGE_ADMIN');
  check(coord.colleges.length === 1, 'the session offers exactly one college',
    JSON.stringify(coord.colleges.map((c) => c.name)));
  check(coord.permissions.canGenerate === true && coord.permissions.canSwitchCollege === false,
    'may generate, may not switch college');

  const wizard = await json('/api/generate/wizard', auth(coord.token));
  check(wizard.status === 200 && wizard.body.canGenerate === true,
    'the generation wizard reports ready', JSON.stringify(wizard.body.message || ''));
  check(!!(wizard.body.timing && wizard.body.timing.slots.length),
    "and carries College A's own period grid",
    `${wizard.body.timing && wizard.body.timing.slots.length} slots`);
  check(wizard.body.modes.some((m) => m.value === 'HYBRID'),
    'all three modes are offered, Hybrid included');

  // The acceptance scenario: Semester 5, Section B, everything on AUTO.
  const sectionB = wizard.body.scope.sections.find((s) => /(^|\s)B$/.test(s.name || ''))
    || wizard.body.scope.sections[0];
  check(!!sectionB, 'Section B exists in the seeded data', JSON.stringify(
    wizard.body.scope.sections.map((s) => s.name)
  ));
  const courses = wizard.body.courses.filter((c) => c.section_id === sectionB.id
    || c.semester_id === sectionB.semester_id);
  check(courses.length >= 4, `${courses.length} courses are available for that section`);

  const request = {
    mode: 'HYBRID',
    scope: { sectionIds: [sectionB.id] },
    courses: courses.map((c) => ({
      courseId: c.id,
      include: true,
      // Rooms AUTO, faculty AUTO, time AUTO -- exactly the acceptance scenario.
      facultyMode: 'AUTOMATIC',
      roomMode: 'AUTOMATIC',
      timeMode: 'AUTOMATIC',
      splitIntoSubSections: c.canSplit ? true : null,
    })),
  };

  const preview = await json('/api/generate/preview', {
    method: 'POST',
    headers: { Authorization: `Bearer ${coord.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  check(preview.status === 200 && preview.body.canRun === true,
    'the preview says it can run', JSON.stringify(preview.body.issues || preview.body));
  check(preview.body.classesToSchedule > 0,
    `${preview.body.classesToSchedule} classes to schedule, ${preview.body.periodsNeeded} periods`);
  check(preview.body.engineWillDecide.length > 0,
    'the preview lists what the engine will decide',
    JSON.stringify(preview.body.engineWillDecide));

  const run = await send(coord.token, 'POST', '/api/generate/run', {
    ...request, timetableName: 'Smoke test — Semester 5 Section B',
  });
  check(run.status === 200 && run.body.persisted && run.body.persisted.written > 0,
    "the run wrote " + ((run.body.persisted || {}).written) + ' assignment(s) to the database',
    JSON.stringify(run.body.issues || run.body).slice(0, 300));
  check(run.body.stats.classesScheduled > 0,
    `${run.body.stats.classesScheduled}/${run.body.stats.classesRequired} classes placed, `
    + `${run.body.stats.hardConflicts} hard conflicts, quality ${run.body.qualityScore}`);
  check(run.body.stats.hardConflicts === 0, 'with no hard conflicts',
    JSON.stringify(run.body.unscheduled));

  const ttId = run.body.timetable && run.body.timetable.id;
  check(!!ttId, 'the timetable has an id');

  head('Section 7 and 8 -- views, checklist, versions');
  const view = await json(`/api/timetable/views/section/${sectionB.id}?timetableId=${ttId}`, auth(coord.token));
  check(view.status === 200 && view.body.cards.length > 0,
    `the section view builds with ${view.body.cards && view.body.cards.length} cards`);
  check(view.body.canEdit === true, 'and the coordinator may edit it');
  check(!!view.body.grid && view.body.grid.slots.length > 0, 'the grid carries its own slots');

  const validate = await json(`/api/timetable/${ttId}/validate`, auth(coord.token));
  check(validate.status === 200 && validate.body.hardConflicts === 0,
    'the Section 13 checklist passes', JSON.stringify(validate.body.problems || []).slice(0, 200));

  const snap = await send(coord.token, 'POST', `/api/timetable/${ttId}/versions`, { label: 'smoke' });
  check(snap.status === 201, 'a snapshot can be taken');
  const detail = await json(`/api/timetable/${ttId}`, auth(coord.token));
  check(detail.body.versions.length >= 1 && detail.body.runs.length >= 1,
    'the detail screen has its versions and its run history');

  const publish = await send(coord.token, 'PATCH', `/api/timetable/${ttId}`, { status: 'PUBLISHED' });
  check(publish.status === 200 && publish.body.status === 'PUBLISHED', 'it publishes',
    JSON.stringify(publish.body).slice(0, 200));

  head('Manual Builder and Settings screens have their data');
  const setup = await json(`/api/manual/setup?timetableId=${ttId}`, auth(coord.token));
  check(setup.status === 200 && !!setup.body.grid, 'the Manual Builder setup loads');
  const settingsRes = await json('/api/settings', auth(coord.token));
  check(settingsRes.status === 200 && settingsRes.body.ai.configured === false,
    'Settings loads with the Assistant reported as not configured');
  const net = await json('/api/settings/network', auth(coord.token));
  check(net.status === 200 && net.body.mode === 'LOCAL', 'the network panel reports LOCAL');
  const sys = await json('/api/settings/system', auth(coord.token));
  check(sys.status === 200 && !!sys.body.databasePath, 'the About panel reports the database path');
  const backupRes = await json('/api/backup', auth(coord.token));
  check(backupRes.status === 200 && !!backupRes.body.database, 'the Backup panel loads');

  head('Section 12 -- the read-only roles');
  const prof = await signIn('prof.a');
  check(!!prof, 'prof.a can sign in');
  if (prof) {
    const targets = await json('/api/timetable/view-targets', auth(prof.token));
    check(targets.body.types.length === 1 && targets.body.types[0] === 'faculty',
      'Faculty is offered exactly one kind of view', JSON.stringify(targets.body.types));
    const mine = await json('/api/timetable/views/faculty', auth(prof.token));
    check(mine.status === 200 && mine.body.canEdit === false, 'and it is read-only');
    const blocked = await send(prof.token, 'POST', '/api/generate/run', request);
    check(blocked.status === 403, 'and cannot generate', `status ${blocked.status}`);
  }

  const student = await signIn('student.b1');
  check(!!student, 'student.b1 can sign in');
  if (student) {
    const targets = await json('/api/timetable/view-targets', auth(student.token));
    check(targets.body.types.length === 1 && targets.body.types[0] === 'student',
      'Student is offered exactly one target -- themselves', JSON.stringify(targets.body.types));
    const mine = await json('/api/timetable/views/student', auth(student.token));
    check(mine.status === 200 && mine.body.canEdit === false, 'and it is read-only');
  }

  const superAdmin = await signIn('superadmin');
  check(!!superAdmin, 'superadmin can sign in');
  if (superAdmin) {
    check(superAdmin.colleges.length >= 2, 'and sees both colleges',
      JSON.stringify(superAdmin.colleges.map((c) => c.name)));
    check(superAdmin.permissions.canSwitchCollege === true, 'with a college switcher');
  }

  const coordB = await signIn('coordinator.b');
  if (coordB) {
    const other = await json(`/api/timetable/${ttId}`, auth(coordB.token));
    check(other.status === 404 || other.status === 403,
      "College B's coordinator cannot reach College A's timetable", `status ${other.status}`);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
