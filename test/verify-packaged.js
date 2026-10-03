'use strict';

/**
 * Checks the *packaged* application rather than the source tree.
 *
 * `npm run dist` produces release/win-unpacked and the installer built from it.
 * Everything in there lives inside resources/app.asar, except the one package
 * that has to stay on disk (node-sqlite3-wasm reads its .wasm with
 * fs.readFileSync). Things that work perfectly from source can still break once
 * archived: a file that was never listed in electron-builder.yml, a static path
 * that resolves relative to the working directory, a native module that was not
 * unpacked.
 *
 * So this runs the packaged backend out of the asar using the packaged Electron
 * binary in its Node mode -- the same Node, the same asar, the same unpacked
 * .wasm the installed application will use -- and drives it through sign-in, a
 * generation run and the role checks.
 *
 * Run it with:  npm run test:packaged
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(UNPACKED, 'University Timetable Management.exe');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

if (!fs.existsSync(EXE)) {
  console.error(`Nothing to check: ${EXE} does not exist.\nRun "npm run dist" (or "npm run pack:dir") first.`);
  process.exit(1);
}

// The body below runs inside the packaged Electron's Node, where require() can
// see through the asar archive. It is passed as a string so the packaged binary
// is the thing executing it -- not this process.
const script = String.raw`
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ASAR = process.env.TMS_ASAR;
const out = [];
let pass = 0;
let fail = 0;
const check = (ok, label, extra) => {
  if (ok) { pass += 1; out.push(['PASS', label, null]); }
  else { fail += 1; out.push(['FAIL', label, extra == null ? null : String(extra).slice(0, 300)]); }
};

(async () => {
  // ---- the archive itself -------------------------------------------------
  check(fs.existsSync(path.join(ASAR, 'src/server/index.js')), 'the backend is inside app.asar');
  check(fs.existsSync(path.join(ASAR, 'dist/renderer/index.html')), 'the compiled interface is inside app.asar');
  check(fs.existsSync(path.join(ASAR, 'src/server/db/schema.sql')), 'the SQL schema was packaged, not just the .js files');
  const unpackedWasm = path.join(path.dirname(ASAR), 'app.asar.unpacked',
    'node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm');
  check(fs.existsSync(unpackedWasm), 'node-sqlite3-wasm stayed unpacked so it can read its .wasm');

  // ---- boot the packaged backend -----------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-packaged-'));
  const { startServer } = require(path.join(ASAR, 'src/server/index.js'));
  const { server, port } = await startServer({
    dbPath: path.join(dir, 'packaged.db'),
    staticDir: path.join(ASAR, 'dist/renderer'),
    port: 0,
  });
  const base = 'http://127.0.0.1:' + port;

  const json = async (p, opts = {}) => {
    const res = await fetch(base + p, opts);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  const send = (token, method, p, body) => json(p, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const auth = (token) => ({ headers: { Authorization: 'Bearer ' + token } });
  const signIn = async (username) => {
    const res = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'demo1234' }),
    });
    return res.body && res.body.token ? res.body : null;
  };

  const health = await json('/api/health');
  check(health.status === 200 && health.body.ok === true, 'the packaged backend starts and reports ok');
  check(health.body.driver === 'node-sqlite3-wasm',
    'SQLite loads from the unpacked package (' + health.body.driver + ')');
  check(health.body.databaseOpen === true, 'a fresh database was created, migrated and seeded');

  // Static files are read straight out of the archive by express.
  const page = await fetch(base + '/');
  const text = await page.text();
  check(page.status === 200 && /<div id="root">/.test(text), 'express serves index.html from inside the asar');
  const asset = /assets\/(index-[^"]+\.js)/.exec(text);
  check(!!asset, 'index.html references the compiled bundle');
  if (asset) {
    const js = await fetch(base + '/assets/' + asset[1]);
    check(js.status === 200 && Number(js.headers.get('content-length')) > 100000,
      'the bundle is served from inside the asar');
  }
  check((await fetch(base + '/generate')).status === 200, 'unknown paths fall back to the interface');

  // ---- Section 17, in the packaged build ---------------------------------
  const coord = await signIn('coordinator.a');
  check(!!coord, 'coordinator.a can sign in');
  if (coord) {
    check(coord.colleges.length === 1, 'and sees exactly one college');
    const wizard = await json('/api/generate/wizard', auth(coord.token));
    check(wizard.body.canGenerate === true, 'the generation wizard is ready',
      JSON.stringify(wizard.body.message || ''));
    check(!!(wizard.body.timing && wizard.body.timing.slots.length),
      "College A's own period grid came through (" + (wizard.body.timing || {}).slots.length + ' periods)');

    const sectionB = wizard.body.scope.sections.find((s) => /(^|\s)B$/.test(s.name || ''))
      || wizard.body.scope.sections[0];
    const courses = wizard.body.courses.filter((c) => c.section_id === sectionB.id
      || c.semester_id === sectionB.semester_id);
    const request = {
      mode: 'HYBRID',
      scope: { sectionIds: [sectionB.id] },
      courses: courses.map((c) => ({
        courseId: c.id,
        include: true,
        facultyMode: 'AUTOMATIC',
        roomMode: 'AUTOMATIC',
        timeMode: 'AUTOMATIC',
        splitIntoSubSections: c.canSplit ? true : null,
      })),
    };
    const run = await send(coord.token, 'POST', '/api/generate/run', {
      ...request, timetableName: 'Packaged build check',
    });
    check(run.status === 200 && run.body.persisted && run.body.persisted.written > 0,
      'a real timetable is generated and written (' + ((run.body.persisted || {}).written) + ' assignments)',
      JSON.stringify(run.body.issues || run.body).slice(0, 300));
    check(run.body.stats && run.body.stats.hardConflicts === 0,
      (run.body.stats || {}).classesScheduled + '/' + (run.body.stats || {}).classesRequired
      + ' placed, 0 hard conflicts, quality ' + run.body.qualityScore);

    const ttId = run.body.timetable && run.body.timetable.id;
    if (ttId) {
      const view = await json('/api/timetable/views/section/' + sectionB.id + '?timetableId=' + ttId,
        auth(coord.token));
      check(view.status === 200 && view.body.cards.length > 0,
        'the section view builds (' + (view.body.cards || []).length + ' cards)');
      const xlsx = await fetch(base + '/api/timetable/export/xlsx/section/' + sectionB.id
        + '?timetableId=' + ttId, auth(coord.token));
      check(xlsx.status === 200, 'an Excel export streams out of the packaged build (exceljs loaded from the asar)');
    }
  }

  // ---- Section 12 --------------------------------------------------------
  const prof = await signIn('prof.a');
  check(!!prof, 'prof.a can sign in');
  if (prof) {
    const mine = await json('/api/timetable/views/faculty', auth(prof.token));
    check(mine.status === 200 && mine.body.canEdit === false, "and their own week is read-only");
  }
  const student = await signIn('student.b1');
  check(!!student, 'student.b1 can sign in');
  const superAdmin = await signIn('superadmin');
  check(superAdmin && superAdmin.colleges.length >= 2, 'superadmin sees every college');

  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  console.log('###RESULT###' + JSON.stringify({ pass, fail, out }));
})().catch((err) => {
  console.log('###RESULT###' + JSON.stringify({
    pass: 0, fail: 1, out: [['FAIL', 'the packaged backend crashed', String(err && err.stack || err)]],
  }));
});
`;

const child = spawn(EXE, ['-e', script], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TMS_ASAR: ASAR },
  cwd: os.tmpdir(), // deliberately not the project folder: nothing may depend on cwd
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });

child.on('close', (code) => {
  const marker = stdout.indexOf('###RESULT###');
  if (marker < 0) {
    console.error('The packaged build produced no result.');
    console.error(`exit code ${code}`);
    if (stdout.trim()) console.error(`stdout:\n${stdout.trim().slice(0, 2000)}`);
    if (stderr.trim()) console.error(`stderr:\n${stderr.trim().slice(0, 2000)}`);
    process.exit(1);
  }
  const result = JSON.parse(stdout.slice(marker + '###RESULT###'.length).trim());
  console.log(`\nVerifying the packaged build in ${path.relative(ROOT, UNPACKED)}\n`);
  for (const [state, label, extra] of result.out) {
    console.log(`  ${state}  ${label}${extra ? `\n        ${extra}` : ''}`);
  }
  console.log(`\n${result.pass} passed, ${result.fail} failed\n`);
  process.exit(result.fail ? 1 : 0);
});
