'use strict';

/**
 * Acceptance tests.
 *
 * These walk the Section 17 scenario through the real HTTP API on a throwaway
 * database: a College A coordinator generates Semester 5 Section B with a split
 * Computer Networks lab, then the results are checked for the things the
 * specification actually promises -- no double bookings, lunch left alone, AC
 * honoured, B1 and B2 genuinely parallel with different teachers and rooms, and
 * the four roles seeing only what they are allowed to see.
 *
 *   node test/run-tests.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../src/server');
const { checkContract } = require('./api-contract');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-test-'));
const dbPath = path.join(tmpDir, 'timetable.db');

let passed = 0;
const failures = [];
let group = '';

function section(title) {
  group = title;
  console.log(`\n${title}`);
}

function check(label, ok, extra) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${group} / ${label}`);
    console.log(`  FAIL  ${label}`);
    if (extra !== undefined) {
      console.log(`        ${JSON.stringify(extra).slice(0, 700)}`);
    }
  }
}

/**
 * The database driver locks by creating a directory beside the file, so a
 * process that dies without unlocking leaves one behind and every later start
 * used to fail with "database is locked" for ever. These checks run before the
 * server opens, on their own throwaway file, and cover both halves of the fix:
 * debris is cleared, and a lock that is genuinely held is not.
 */
function lockRecovery() {
  const db = require('../src/server/db/connection');
  const file = path.join(tmpDir, 'lock-probe.db');
  const lock = db.lockPathFor(file);
  const owner = db.ownerPathFor(file);

  // A pid far above any operating system's range: nothing can be running there,
  // which is what a lock left by a process that has gone looks like.
  const DEAD_PID = 999999999;
  const claim = (pid, host) => {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(owner, JSON.stringify({ pid, host: host || os.hostname(), since: '2026-01-01T00:00:00.000Z' }));
  };
  const tidy = () => {
    try { fs.rmSync(owner, { force: true }); } catch { /* not there */ }
    try { fs.rmdirSync(lock); } catch { /* not there */ }
  };

  section('The database recovers from a lock left behind');

  db.openDatabase(file);
  check('a new database opens and records which process holds it',
    db.isOpen() && fs.existsSync(owner), fs.existsSync(owner));
  db.closeDatabase();
  check('closing removes both the lock and the owner record',
    !fs.existsSync(lock) && !fs.existsSync(owner));

  // 1. Debris with nobody claiming it -- a crash, End Task, or a power cut.
  fs.mkdirSync(lock, { recursive: true });
  let said = '';
  db.openDatabase(file, { log: (m) => { said += `${m}\n`; } });
  check('an abandoned lock is cleared rather than reported as a failure',
    db.isOpen() && /cleared a lock left behind/.test(said), said.trim());
  db.closeDatabase();

  // 2. Claimed, but by a process that is no longer running.
  claim(DEAD_PID);
  said = '';
  db.openDatabase(file, { log: (m) => { said += `${m}\n`; } });
  check('a lock claimed by a process that has gone is cleared',
    db.isOpen() && said.includes(String(DEAD_PID)), said.trim());
  db.closeDatabase();

  // 3. Claimed by something that really is running: this one must survive, or
  //    the recovery would happily corrupt a database another copy is writing to.
  //    A real child process is used, so the liveness test is not a guess.
  const holder = require('node:child_process')
    .spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  claim(holder.pid);
  check('a lock held by a running copy is left alone',
    db.clearStaleLock(file) === null && fs.existsSync(lock), { holder: holder.pid });

  let refused = null;
  try {
    db.openDatabase(file);
  } catch (err) {
    refused = err;
  }
  if (db.isOpen()) {
    // The driver takes its lock per transaction rather than for the whole
    // connection, so an idle lock directory does not always block an open. What
    // must not happen is the lock being deleted while its owner is alive.
    check('and the running copy\'s lock was not deleted', fs.existsSync(lock));
    db.closeDatabase();
  } else {
    check('and the reason given names the other copy, not "database is locked"',
      refused && refused.code === 'DATABASE_IN_USE' && String(refused.message).includes(String(holder.pid)),
      refused && refused.message);
  }
  holder.kill();
  tidy();

  // 4. A shared folder on a LAN: another machine's lock is never ours to clear.
  claim(DEAD_PID, 'some-other-machine');
  check('a lock made by another machine is never cleared',
    db.clearStaleLock(file) === null && fs.existsSync(lock));
  tidy();

  check('"database is locked" is recognised however the driver words it',
    db.isLockedError(new Error('SQLITE_BUSY: database is locked'))
    && db.isLockedError({ code: 'SQLITE_BUSY' })
    && !db.isLockedError(new Error('no such table: rooms')));

  try { fs.rmSync(file, { force: true }); } catch { /* leaving it is harmless */ }
}

async function main() {
  lockRecovery();

  const srv = await startServer({
    dbPath, port: 0, staticDir: path.join(tmpDir, 'no-renderer-here'),
  });
  const api = `${srv.url}/api`;

  const call = async (method, url, { token, body, raw } = {}) => {
    const res = await fetch(`${api}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
  };

  const login = async (username) => {
    const r = await call('POST', '/auth/login', { body: { username, password: 'demo1234' } });
    if (r.status !== 200 || !r.body.token) {
      throw new Error(`Could not sign in as ${username}: ${JSON.stringify(r.body)}`);
    }
    return r.body.token;
  };

  const rows = async (token, entity, query = '') => {
    const r = await call('GET', `/entities/${entity}${query}`, { token });
    return (r.body && r.body.rows) || [];
  };

  // =========================================================================
  section('First run and sign-in');
  // =========================================================================
  const health = await call('GET', '/health');
  check('the service answers /health with the demo data loaded',
    health.status === 200 && health.body.seeded === true, health.body);

  const coordA = await login('coordinator.a');
  const coordB = await login('coordinator.b');
  const superAdmin = await login('superadmin');
  const facultyUser = await login('prof.a');
  const studentUser = await login('student.b1');
  check('one login exists for each of the four roles', true);

  const wrongPassword = await call('POST', '/auth/login', {
    body: { username: 'coordinator.a', password: 'not-the-password' },
  });
  check('a wrong password is refused', wrongPassword.status === 401, wrongPassword.body);

  const noToken = await call('GET', '/entities/rooms');
  check('an unauthenticated request is refused', noToken.status === 401, noToken.body);

  // =========================================================================
  section('Section 4 -- timing comes from each college\'s own configuration');
  // =========================================================================
  const timingA = await call('GET', '/config/timing', { token: coordA });
  const gridA = timingA.body.grid || timingA.body;
  check('College A: 5 working days, 6 periods of 60 minutes',
    gridA.workingDays.length === 5 && gridA.slots.length === 6 && gridA.slotMinutes === 60,
    { days: gridA.workingDays, slots: gridA.slots.length, minutes: gridA.slotMinutes });
  check('College A: every configured period fits, so no shortfall warning',
    !gridA.warnings || gridA.warnings.length === 0, gridA.warnings);
  check('College A: no period overlaps the 13:00-14:00 lunch window',
    gridA.slots.every((s) => s.end <= '13:00' || s.start >= '14:00'),
    gridA.slots.map((s) => `${s.start}-${s.end}`));

  const timingB = await call('GET', '/config/timing', { token: coordB });
  const gridB = timingB.body.grid || timingB.body;
  check('College B: 6 working days, 7 periods of 45 minutes -- nothing is hardcoded',
    gridB.workingDays.length === 6 && gridB.slots.length === 7 && gridB.slotMinutes === 45,
    { days: gridB.workingDays, slots: gridB.slots.length, minutes: gridB.slotMinutes });
  check('College B: both of its breaks are excluded',
    gridB.slots.every((s) => (s.end <= '10:45' || s.start >= '11:00')
      && (s.end <= '12:30' || s.start >= '13:00')),
    gridB.slots.map((s) => `${s.start}-${s.end}`));

  // =========================================================================
  section('Section 9 -- the data dependency gate');
  // =========================================================================
  const readiness = await call('GET', '/meta/readiness', { token: coordA });
  check('College A is ready to generate',
    readiness.body.canGenerate === true && readiness.body.blocking.length === 0,
    readiness.body.blocking);
  check('nothing is flagged as incomplete in the seeded data',
    (readiness.body.warnings || []).length === 0,
    (readiness.body.warnings || []).map((w) => w.message));
  check('the setup progress reads 100%',
    readiness.body.progress && readiness.body.progress.percent === 100, readiness.body.progress);

  // =========================================================================
  section('Section 17 -- generating Semester 5, Section B');
  // =========================================================================
  const wizard = await call('GET', '/generate/wizard', { token: coordA });
  check('the wizard loads', wizard.body.canGenerate === true, wizard.body.message);

  const sections = wizard.body.scope.sections;
  const sectionB = sections.find((s) => s.name === 'Section B');
  const subs = wizard.body.scope.subSections.filter((s) => s.section_id === sectionB.id);
  const b1 = subs.find((s) => s.name === 'B1');
  const b2 = subs.find((s) => s.name === 'B2');
  check('Section B has sub-sections B1 and B2', !!b1 && !!b2, subs.map((s) => s.name));

  const byCode = {};
  for (const c of wizard.body.courses) byCode[c.code] = c;
  const facultyByName = {};
  for (const f of wizard.body.faculty) facultyByName[f.name] = f;

  const cn = byCode.CS504;
  check('Computer Networks is marked as splitting into sub-sections', cn.canSplit === true, cn.split_mode);
  check('Computer Networks requires AC', cn.ac_requirement === 'REQUIRED', cn.acLabel);
  check('Professors D and E are both eligible for the Computer Networks lab',
    cn.eligibleFaculty.some((f) => f.name === 'Professor D')
    && cn.eligibleFaculty.some((f) => f.name === 'Professor E'),
    cn.eligibleFaculty.map((f) => f.name));

  // Exactly the scenario's configuration: teachers fixed, rooms AUTO, time AUTO.
  const request = {
    departmentId: sectionB.department_id,
    programId: sectionB.program_id,
    semesterId: sectionB.semester_id,
    mode: 'HYBRID',
    scope: { sectionIds: [sectionB.id] },
    timetableName: 'B.Tech CSE - Semester 5 - Section B',
    courses: [
      {
        courseId: byCode.CS501.id, facultyMode: 'FIXED',
        facultyIds: [facultyByName['Professor A'].id],
        roomMode: 'AUTOMATIC', timeMode: 'AUTOMATIC', acRequirement: 'REQUIRED',
      },
      {
        courseId: byCode.CS502.id, facultyMode: 'FIXED',
        facultyIds: [facultyByName['Professor B'].id],
        roomMode: 'AUTOMATIC', timeMode: 'AUTOMATIC', acRequirement: 'REQUIRED',
      },
      {
        courseId: byCode.CS503.id, facultyMode: 'FIXED',
        facultyIds: [facultyByName['Professor C'].id],
        roomMode: 'AUTOMATIC', timeMode: 'AUTOMATIC',
      },
      {
        courseId: byCode.CS504.id,
        splitIntoSubSections: true,
        facultyMode: 'FIXED',
        subSectionFaculty: {
          [b1.id]: [facultyByName['Professor D'].id],
          [b2.id]: [facultyByName['Professor E'].id],
        },
        roomMode: 'AUTOMATIC', timeMode: 'AUTOMATIC', acRequirement: 'REQUIRED',
      },
    ],
  };

  const preview = await call('POST', '/generate/preview', { token: coordA, body: request });
  check('the preview can run', preview.body.canRun === true, preview.body.issues);
  check('the preview says the engine will choose rooms and times',
    (preview.body.engineWillDecide || []).join(' ').includes('room'),
    preview.body.engineWillDecide);
  const previewSplit = (preview.body.classes || []).filter((o) => o.subSectionName);
  check('the preview splits the lab into B1 and B2 classes',
    previewSplit.some((o) => o.subSectionName === 'B1')
    && previewSplit.some((o) => o.subSectionName === 'B2'),
    previewSplit.map((o) => `${o.courseCode} ${o.subSectionName || ''}`));
  check('the two halves are listed as a parallel group of 30 students each',
    preview.body.parallelGroups > 0 && previewSplit.every((o) => o.parallelGroup && o.students === 30),
    previewSplit.map((o) => `${o.subSectionName}: ${o.students} students, group ${o.parallelGroup}`));
  check('Computer Networks appears only as a lab, with no whole-section lecture',
    (preview.body.classes || []).filter((o) => o.courseCode === 'CS504')
      .every((o) => o.subSectionName && o.component !== 'LECTURE'),
    (preview.body.classes || []).filter((o) => o.courseCode === 'CS504')
      .map((o) => `${o.componentLabel} ${o.subSectionName || '(whole section)'}`));

  const run = await call('POST', '/generate/run', { token: coordA, body: request });
  check('generation succeeds', run.status === 200 && run.body.ok === true,
    run.body && (run.body.message || run.body.unscheduled));
  check('nothing was left unscheduled',
    (run.body.unscheduled || []).length === 0,
    (run.body.unscheduled || []).map((u) => u.reason || u));
  check('a quality score between 0 and 100 is reported',
    typeof run.body.qualityScore === 'number'
    && run.body.qualityScore >= 0 && run.body.qualityScore <= 100,
    run.body.qualityScore);

  const timetableId = run.body.timetable.id;

  // =========================================================================
  section('Section 13 -- the constraint checklist, verified on the result');
  // =========================================================================
  const validation = await call('GET', `/timetable/${timetableId}/validate`, { token: coordA });
  check('the generated timetable validates cleanly',
    validation.body.hardConflicts === 0 && validation.body.classes > 0,
    { verdict: validation.body.verdict, problems: (validation.body.problems || []).slice(0, 6) });

  const view = await call('GET', `/timetable/views/section/${sectionB.id}?timetableId=${timetableId}`,
    { token: coordA });
  const cards = view.body.cards || [];
  check('the section view returns the generated classes', cards.length > 0, cards.length);

  const key = (c) => `${c.day}:${c.slotIndices.join(',')}`;
  const clash = (pick) => {
    const seen = new Map();
    for (const c of cards) {
      const who = pick(c);
      if (who == null) continue;
      for (const slot of c.slotIndices) {
        const k = `${who}@${c.day}:${slot}`;
        if (seen.has(k)) return { first: seen.get(k), second: c.id, at: k };
        seen.set(k, c.id);
      }
    }
    return null;
  };
  check('no teacher is double-booked', clash((c) => `t${c.facultyId}`) === null,
    clash((c) => `t${c.facultyId}`));
  check('no room is double-booked', clash((c) => `r${c.roomId}`) === null,
    clash((c) => `r${c.roomId}`));
  check('the whole section is never in two places at once',
    clash((c) => (c.subSectionId ? null : 's')) === null,
    clash((c) => (c.subSectionId ? null : 's')));

  const acRequired = cards.filter((c) => c.acRequirement === 'REQUIRED');
  check('every class that requires AC got an AC room',
    acRequired.length > 0 && acRequired.every((c) => c.roomIsAc === true),
    acRequired.filter((c) => !c.roomIsAc).map((c) => `${c.courseCode} in ${c.roomName}`));

  check('every class fits inside its room',
    cards.every((c) => !c.roomMaxCapacity || c.studentCount <= c.roomMaxCapacity),
    cards.filter((c) => c.roomMaxCapacity && c.studentCount > c.roomMaxCapacity)
      .map((c) => `${c.courseCode}: ${c.studentCount} in ${c.roomName} (${c.roomMaxCapacity})`));

  check('no class lands in the lunch window',
    cards.every((c) => c.endTime <= '13:00' || c.startTime >= '14:00'),
    cards.filter((c) => !(c.endTime <= '13:00' || c.startTime >= '14:00'))
      .map((c) => `${c.courseCode} ${c.timeLabel}`));

  check('every class is inside College A\'s working hours and days',
    cards.every((c) => c.startTime >= '09:00' && c.endTime <= '16:00'
      && gridA.workingDays.includes(c.day)),
    cards.map((c) => `${c.day} ${c.timeLabel}`));

  check('the two-period lab is scheduled as one block, not two singles',
    cards.filter((c) => c.component === 'LAB').every((c) => c.slotIndices.length === 2),
    cards.filter((c) => c.component === 'LAB').map((c) => c.slotIndices.length));

  // =========================================================================
  section('Section 3 -- B1 and B2 run in parallel, but never share');
  // =========================================================================
  const labCards = cards.filter((c) => c.courseCode === 'CS504' && c.subSectionId);
  check('both halves of the lab were scheduled',
    labCards.some((c) => c.subSectionName === 'B1') && labCards.some((c) => c.subSectionName === 'B2'),
    labCards.map((c) => c.groupLabel));

  const pairs = new Map();
  for (const c of labCards) {
    const k = key(c);
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(c);
  }
  const parallelPairs = [...pairs.values()].filter((g) => g.length > 1);
  check('B1 and B2 were placed in the same slot at least once',
    parallelPairs.length > 0,
    [...pairs.entries()].map(([k, g]) => `${k}: ${g.map((c) => c.subSectionName).join('+')}`));
  check('wherever they are parallel, the teacher and the room differ',
    parallelPairs.every((g) => {
      const teachers = new Set(g.map((c) => c.facultyId));
      const rooms = new Set(g.map((c) => c.roomId));
      return teachers.size === g.length && rooms.size === g.length;
    }),
    parallelPairs.map((g) => g.map((c) => `${c.subSectionName}:${c.facultyName}@${c.roomName}`)));

  check('B1 is taught by Professor D and B2 by Professor E, as configured',
    labCards.filter((c) => c.subSectionName === 'B1').every((c) => c.facultyName === 'Professor D')
    && labCards.filter((c) => c.subSectionName === 'B2').every((c) => c.facultyName === 'Professor E'),
    labCards.map((c) => `${c.subSectionName}=${c.facultyName}`));

  check('each half of the lab is sized at 30 students, not 60',
    labCards.every((c) => c.studentCount === 30), labCards.map((c) => c.studentCount));

  // The forbidden move: give B2's lab the same room as B1's in the same slot.
  const pair = parallelPairs[0];
  if (pair) {
    const [one, two] = pair;
    const sameRoom = await call('POST', `/timetable/assignments/${two.id}/change-room`,
      { token: coordA, body: { roomId: one.roomId } });
    check('moving B2\'s lab into B1\'s room is refused',
      sameRoom.status >= 400 && sameRoom.body.canOverride === true,
      { status: sameRoom.status, message: sameRoom.body && sameRoom.body.message });

    const sameTeacher = await call('POST', `/timetable/assignments/${two.id}/change-teacher`,
      { token: coordA, body: { facultyId: one.facultyId } });
    check('giving B2\'s lab B1\'s teacher in the same slot is refused',
      sameTeacher.status >= 400 && sameTeacher.body.canOverride === true,
      { status: sameTeacher.status, message: sameTeacher.body && sameTeacher.body.message });
  } else {
    check('moving B2\'s lab into B1\'s room is refused', false, 'no parallel pair to test with');
    check('giving B2\'s lab B1\'s teacher in the same slot is refused', false, 'no parallel pair');
  }

  // =========================================================================
  section('Section 8 -- manual authority over the result');
  // =========================================================================
  const target = cards.find((c) => c.courseCode === 'CS501');
  const alternatives = await call('GET', `/timetable/assignments/${target.id}/alternatives`,
    { token: coordA });
  const alt = alternatives.body || {};
  const altSlots = (alt.slotsKeepingBoth && alt.slotsKeepingBoth.options) || [];
  check('Find Alternatives offers other slots for the same teacher and room',
    altSlots.length > 0, alt.slotsKeepingBoth && alt.slotsKeepingBoth.totalFeasible);
  check('Find Alternatives also offers a free choice of teacher and room',
    ((alt.slotsAnyResource && alt.slotsAnyResource.options) || []).length > 0,
    alt.slotsAnyResource && alt.slotsAnyResource.totalFeasible);
  check('Change Teacher lists eligible teachers for the current slot',
    ((alt.faculty && alt.faculty.available) || []).length > 0,
    alt.faculty && (alt.faculty.available || []).map((f) => f.name));
  check('Change Room lists usable rooms for the current slot',
    ((alt.rooms && alt.rooms.available) || []).length > 0,
    alt.rooms && (alt.rooms.available || []).length);
  check('the card\'s own slot is reported as valid', alt.current && alt.current.valid === true,
    alt.current && alt.current.violations);

  const firstAlt = altSlots[0];
  const moved = await call('POST', `/timetable/assignments/${target.id}/move`, {
    token: coordA,
    body: { day: firstAlt.day, slotIndex: firstAlt.slotIndex },
  });
  check('a class can be moved to a suggested slot', moved.status === 200, moved.body);
  check('the move landed where it was asked to',
    moved.body.assignment && moved.body.assignment.day_of_week === firstAlt.day
    && moved.body.assignment.slot_index === firstAlt.slotIndex,
    moved.body.assignment);

  const locked = await call('POST', `/timetable/assignments/${target.id}/lock`, { token: coordA });
  check('a class can be locked', locked.body.assignment.is_locked === 1, locked.body.assignment);

  const lockedDay = locked.body.assignment.day_of_week;
  const lockedSlot = locked.body.assignment.slot_index;
  const regenerate = await call('POST', '/generate/run', {
    token: coordA, body: { ...request, timetableId, keepLocked: true },
  });
  check('re-generating succeeds', regenerate.status === 200, regenerate.body && regenerate.body.message);
  const afterRegen = await call('GET', `/timetable/assignments/${target.id}`, { token: coordA });
  check('a locked class is not moved by re-generation',
    afterRegen.body.assignment.day_of_week === lockedDay
    && afterRegen.body.assignment.slot_index === lockedSlot,
    { was: `${lockedDay}:${lockedSlot}`,
      now: `${afterRegen.body.assignment.day_of_week}:${afterRegen.body.assignment.slot_index}` });

  const cancelled = await call('POST', `/timetable/assignments/${target.id}/cancel`,
    { token: coordA, body: { reason: 'Teacher on leave' } });
  check('a class can be cancelled', cancelled.status === 200
    && cancelled.body.assignment.status === 'CANCELLED', cancelled.body.assignment);
  const restored = await call('POST', `/timetable/assignments/${target.id}/restore`, { token: coordA });
  check('and restored again', restored.body.assignment.status === 'SCHEDULED', restored.body.assignment);

  const versions = await call('POST', `/timetable/${timetableId}/versions`,
    { token: coordA, body: { label: 'After manual edits' } });
  check('a version can be saved', versions.status === 200 || versions.status === 201, versions.body);
  const versionList = await call('GET', `/timetable/${timetableId}/versions`, { token: coordA });
  check('the saved version is listed',
    (versionList.body.versions || versionList.body.rows || []).length > 0, versionList.body);

  // =========================================================================
  section('Section 8.5 -- exports');
  // =========================================================================
  for (const format of ['pdf', 'excel', 'ical']) {
    const exported = await call('GET',
      `/timetable/export/${format}/section/${sectionB.id}?timetableId=${timetableId}`,
      { token: coordA, raw: true });
    check(`the section timetable exports as ${format}`,
      exported.status === 200 && exported.text.length > 0, exported.status);
  }

  // =========================================================================
  section('Section 12 -- roles, checked by signing in');
  // =========================================================================
  const aColleges = (await call('GET', '/meta/colleges', { token: coordA })).body;
  check('the College A coordinator sees only College A',
    (aColleges.colleges || []).length === 1 && aColleges.colleges[0].code === 'CA',
    aColleges.colleges);
  check('and is given no college switcher', aColleges.canSwitch !== true, aColleges.canSwitch);

  const bSections = await rows(coordB, 'sections');
  check('the College B coordinator cannot see College A\'s Section B',
    bSections.every((s) => s.id !== sectionB.id), bSections.map((s) => s.name));

  const crossRead = await call('GET', `/entities/sections/${sectionB.id}`, { token: coordB });
  check('asking for College A\'s section by id directly is refused',
    crossRead.status === 404 || crossRead.status === 403, crossRead.status);

  const crossEdit = await call('PUT', `/entities/sections/${sectionB.id}`,
    { token: coordB, body: { student_count: 1 } });
  check('and editing it is refused', crossEdit.status === 404 || crossEdit.status === 403, crossEdit.status);

  const crossCard = await call('POST', `/timetable/assignments/${labCards[0].id}/cancel`,
    { token: coordB, body: { reason: 'should not be possible' } });
  check('the College B coordinator cannot cancel a College A class',
    crossCard.status === 404 || crossCard.status === 403, crossCard.status);

  const superColleges = (await call('GET', '/meta/colleges', { token: superAdmin })).body;
  check('the Super Admin sees both colleges and a switcher',
    (superColleges.colleges || []).length === 2 && superColleges.canSwitch === true,
    superColleges.colleges);

  const facultyView = await call('GET', '/timetable/views/faculty', { token: facultyUser });
  const facultyCards = facultyView.body.cards || [];
  check('Faculty sees a timetable', facultyView.status === 200, facultyView.body);
  check('Faculty sees only their own classes',
    facultyCards.every((c) => c.facultyName === 'Professor A'),
    [...new Set(facultyCards.map((c) => c.facultyName))]);
  check('Faculty is given no edit controls',
    facultyView.body.canEdit === false, facultyView.body.canEdit);
  const facultyEdit = await call('POST', `/timetable/assignments/${labCards[0].id}/move`,
    { token: facultyUser, body: { day: 1, slotIndex: 0 } });
  check('and cannot move a class', facultyEdit.status === 403, facultyEdit.status);

  const studentView = await call('GET', '/timetable/views/section/999', { token: studentUser });
  const studentCards = studentView.body.cards || [];
  check('a Student asking for another section still gets their own',
    studentView.status === 200 && studentCards.every((c) => c.sectionId === sectionB.id),
    [...new Set(studentCards.map((c) => c.sectionName))]);
  check('a Student sees their own sub-section\'s lab, not the other half',
    studentCards.filter((c) => c.subSectionId).every((c) => c.subSectionName === 'B1'),
    studentCards.filter((c) => c.subSectionId).map((c) => c.subSectionName));
  check('Student is given no edit controls', studentView.body.canEdit === false, studentView.body.canEdit);

  // =========================================================================
  section('Section 14 -- the Assistant is off until a key is added');
  // =========================================================================
  const aiStatus = await call('GET', '/assistant/status', { token: coordA });
  check('the Assistant reports itself unconfigured, not broken',
    aiStatus.status === 200 && aiStatus.body.configured === false, aiStatus.body);
  const ask = await call('POST', '/assistant/ask', { token: coordA, body: { question: 'Am I free on Friday?' } });
  check('asking without a key fails with an explanation rather than a crash',
    ask.status >= 400 && ask.status < 500 && !!ask.body.message, ask.body);

  // =========================================================================
  section('Section 10 -- Excel templates');
  // =========================================================================
  const entitiesForImport = await call('GET', '/import/entities', { token: coordA });
  check('the import screen lists importable entities',
    (entitiesForImport.body.entities || []).length > 0, entitiesForImport.body.entities);
  const template = await call('GET', '/import/template/rooms', { token: coordA, raw: true });
  check('a blank room template downloads',
    template.status === 200 && template.text.length > 0, template.status);
  const badImport = await call('POST', '/import/validate?entity=rooms', {
    token: coordA, body: { dataBase64: Buffer.from('not,a,real,sheet\n1,2,3,4').toString('base64') },
  });
  check('a file with the wrong headers is reported, not imported',
    badImport.status === 200 && badImport.body.canImport === false
    && (badImport.body.fileErrors || []).length > 0,
    { status: badImport.status, fileErrors: badImport.body && badImport.body.fileErrors });
  const badCommit = await call('POST', '/import/commit?entity=rooms', {
    token: coordA, body: { dataBase64: Buffer.from('not,a,real,sheet\n1,2,3,4').toString('base64') },
  });
  const roomsAfter = await rows(coordA, 'rooms');
  check('and committing it anyway changes nothing',
    (badCommit.status >= 400 || badCommit.body.imported === 0) && roomsAfter.length === 10,
    { status: badCommit.status, message: badCommit.body && badCommit.body.message,
      rooms: roomsAfter.length });

  // =========================================================================
  section('The interface and the server agree');
  // =========================================================================
  // Static, so it sends nothing and changes nothing: it reads the paths the
  // renderer writes and asks the real router whether they would match.
  const contract = checkContract(srv.app);
  check('every endpoint the interface calls exists on the server',
    contract.missing.length === 0, contract.missing);
  check('the whole interface was scanned, not a handful of files',
    contract.sites.length >= 40, contract.sites.length);

  // =========================================================================
  section('Section 15 -- backup and reset');
  // =========================================================================
  const made = await call('POST', '/backup', { token: coordA, body: { label: 'test' } });
  check('a backup can be taken', made.status === 201 && made.body.bytes > 0, made.body);
  const inspected = await call('GET', `/backup/inspect/${made.body.name}`, { token: coordA });
  check('the backup identifies itself as ours',
    inspected.body.versionMatches === true && inspected.body.counts.assignments > 0, inspected.body);
  const resetNoPhrase = await call('POST', '/backup/reset', { token: superAdmin, body: { confirm: 'yes' } });
  check('reset without the confirmation phrase is refused',
    resetNoPhrase.status === 400, resetNoPhrase.body);
  const resetAsCoordinator = await call('POST', '/backup/reset',
    { token: coordA, body: { confirm: 'DELETE EVERYTHING' } });
  check('a coordinator cannot reset the machine', resetAsCoordinator.status === 403, resetAsCoordinator.status);

  const system = await call('GET', '/settings/system', { token: coordA });
  check('the About panel reports the driver and database path',
    !!system.body.sqliteDriver && !!system.body.databasePath, system.body);

  // Destructive, so it runs last.
  const reset = await call('POST', '/backup/reset',
    { token: superAdmin, body: { confirm: 'DELETE EVERYTHING' } });
  check('the Super Admin can reset to empty', reset.body.reset === true, reset.body);
  const afterReset = await call('GET', '/meta/colleges', { token: superAdmin });
  check('no colleges remain after a reset',
    (afterReset.body.colleges || []).length === 0, afterReset.body.colleges);
  const stillIn = await call('GET', '/auth/me', { token: superAdmin });
  check('the account that reset the machine can still sign in', stillIn.status === 200, stillIn.status);

  await srv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\nThe test run stopped early:');
  console.error(err);
  process.exit(1);
});
