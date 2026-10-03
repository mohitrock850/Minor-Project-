'use strict';

/**
 * Data readiness (Section 9).
 *
 * Two consumers, one source of truth:
 *   - the Data Setup Progress dashboard (what is done, what is left)
 *   - the pre-generation gate (what actually blocks a generation, and why)
 *
 * Every finding carries an actionable message and, where possible, the entity
 * screen that fixes it, so the user is never told "cannot generate" without
 * being told what to do about it.
 */

const db = require('../db/connection');
const { ENTITIES } = require('./entityRegistry');
const { buildGrid } = require('./timing');

const BLOCK = 'BLOCK';
const WARN = 'WARN';
const OK = 'OK';

function countRows(table, collegeId, extraSql = '', params = []) {
  return db.get(
    `SELECT COUNT(*) AS n FROM ${table} WHERE college_id = ?${extraSql ? ` AND ${extraSql}` : ''}`,
    [collegeId, ...params]
  ).n;
}

/**
 * The ordered setup checklist. Order matters: it is the recommended sequence in
 * which a coordinator should enter data, and it is what the progress bar counts.
 */
function checkCollege(collegeId) {
  const id = Number(collegeId);
  const findings = [];

  const add = (finding) => {
    findings.push({ status: OK, count: null, action: null, ...finding });
  };

  // --- 1. Timing configuration ------------------------------------------------
  const timing = db.get(
    `SELECT * FROM college_timings WHERE college_id = ? AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [id]
  );
  if (!timing) {
    add({
      key: 'timing',
      label: 'College Timing Configuration',
      status: BLOCK,
      count: 0,
      message: 'This college has no timing configuration. Set working days, start and end time, '
        + 'period length and lunch break before generating a timetable.',
      action: { entity: 'college_timings', label: 'Set Up Timing' },
    });
  } else {
    const breaks = db.all('SELECT * FROM college_breaks WHERE timing_id = ? ORDER BY start_time', [timing.id]);
    let grid = null;
    let gridError = null;
    try {
      grid = buildGrid(timing, breaks);
    } catch (err) {
      gridError = err.message;
    }
    if (gridError) {
      add({
        key: 'timing',
        label: 'College Timing Configuration',
        status: BLOCK,
        count: 1,
        message: `The timing configuration is not usable: ${gridError}`,
        action: { entity: 'college_timings', label: 'Fix Timing' },
      });
    } else {
      const lunch = breaks.some((b) => b.kind === 'LUNCH');
      add({
        key: 'timing',
        label: 'College Timing Configuration',
        status: grid.warnings.length || !lunch ? WARN : OK,
        count: 1,
        message: [
          `${grid.workingDays.length} working day(s), ${grid.slots.length} periods of `
            + `${timing.slot_minutes} minutes from ${timing.start_time} to ${timing.end_time}.`,
          lunch ? null : 'No lunch break is configured.',
          ...grid.warnings,
        ].filter(Boolean).join(' '),
        action: { entity: 'college_timings', label: 'Review Timing' },
        detail: { slots: grid.slots.length, workingDays: grid.workingDays, warnings: grid.warnings },
      });
    }
  }

  // --- 2..n. Registry-declared minimum counts --------------------------------
  const declared = ['departments', 'programs', 'semesters', 'sections', 'faculty', 'courses', 'rooms'];
  for (const key of declared) {
    const entity = ENTITIES[key];
    const readiness = entity.readiness || {};
    const n = countRows(entity.table, id, "status = 'ACTIVE'");
    if (n < (readiness.minCount || 1)) {
      add({
        key,
        label: entity.label,
        status: BLOCK,
        count: n,
        message: `No active ${entity.label.toLowerCase()} yet. ${readiness.hint || ''}`.trim(),
        action: { entity: key, label: `Add ${entity.singular}` },
      });
      continue;
    }
    // Rows exist -- are they complete enough to schedule with?
    const gaps = [];
    for (const rule of readiness.completeness || []) {
      const missing = countRows(
        entity.table, id, `status = 'ACTIVE' AND (${rule.column} IS NULL OR ${rule.column} = 0)`
      );
      if (missing) gaps.push(`${missing} ${rule.message}`);
    }
    add({
      key,
      label: entity.label,
      status: gaps.length ? WARN : OK,
      count: n,
      message: gaps.length ? `${gaps.join('; ')}.` : `${n} active record(s).`,
      action: { entity: key, label: `Manage ${entity.label}` },
    });
  }

  // --- Course teaching hours --------------------------------------------------
  const noHours = db.all(
    `SELECT id, code, name FROM courses
      WHERE college_id = ? AND status = 'ACTIVE'
        AND COALESCE(lecture_hours,0) + COALESCE(tutorial_hours,0) + COALESCE(lab_hours,0) = 0`,
    [id]
  );
  if (noHours.length) {
    add({
      key: 'course_hours',
      label: 'Course Weekly Hours',
      status: WARN,
      count: noHours.length,
      message: `${noHours.length} course(s) have no lecture, tutorial or lab hours recorded, so each `
        + `will be scheduled as a single class: ${noHours.slice(0, 5).map((c) => c.code).join(', ')}`
        + `${noHours.length > 5 ? ', ...' : ''}.`,
      action: { entity: 'courses', label: 'Set Weekly Hours' },
    });
  }

  // --- Every course needs an eligible teacher --------------------------------
  const orphanCourses = db.all(
    `SELECT c.id, c.code, c.name FROM courses c
      WHERE c.college_id = ? AND c.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM faculty_courses fc
            JOIN faculty f ON f.id = fc.faculty_id AND f.status = 'ACTIVE'
           WHERE fc.course_id = c.id)`,
    [id]
  );
  add({
    key: 'faculty_courses',
    label: 'Faculty-Course Assignments',
    status: orphanCourses.length ? BLOCK : OK,
    count: orphanCourses.length,
    message: orphanCourses.length
      ? `${orphanCourses.length} course(s) have no eligible faculty: `
        + `${orphanCourses.slice(0, 6).map((c) => `${c.code} ${c.name}`).join(', ')}`
        + `${orphanCourses.length > 6 ? ', ...' : ''}. Assign a teacher, or mark one as Fixed Faculty.`
      : 'Every active course has at least one eligible faculty member.',
    action: { entity: 'faculty_courses', label: 'Assign Faculty' },
    detail: { courses: orphanCourses },
  });

  // --- Sub-sections exist wherever a course asks to be split ----------------
  const splitWithoutSubs = db.all(
    `SELECT c.id, c.code, c.name, s.name AS section_name FROM courses c
       JOIN sections s ON s.id = c.section_id
      WHERE c.college_id = ? AND c.status = 'ACTIVE'
        AND c.split_mode = 'SPLIT_SUB_SECTIONS'
        AND NOT EXISTS (SELECT 1 FROM sub_sections ss
                         WHERE ss.section_id = c.section_id AND ss.status = 'ACTIVE')`,
    [id]
  );
  const subCount = countRows('sub_sections', id, "status = 'ACTIVE'");
  add({
    key: 'sub_sections',
    label: 'Sub-Sections',
    status: splitWithoutSubs.length ? BLOCK : OK,
    count: subCount,
    message: splitWithoutSubs.length
      ? `${splitWithoutSubs.length} course(s) are set to split into sub-sections but their section has `
        + `none: ${splitWithoutSubs.map((c) => `${c.code} (${c.section_name})`).join(', ')}.`
      : subCount
        ? `${subCount} sub-section(s) defined for parallel labs and tutorials.`
        : 'No sub-sections defined. Add them only if you split labs into parallel groups.',
    action: { entity: 'sub_sections', label: 'Manage Sub-Sections' },
    optional: !splitWithoutSubs.length && !subCount,
  });

  // --- AC availability vs AC requirements -----------------------------------
  const acRequired = countRows('courses', id, "status = 'ACTIVE' AND ac_requirement = 'REQUIRED'");
  if (acRequired) {
    const acRooms = countRows('rooms', id, "status = 'ACTIVE' AND is_ac = 1");
    add({
      key: 'ac_rooms',
      label: 'AC Rooms',
      status: acRooms ? OK : BLOCK,
      count: acRooms,
      message: acRooms
        ? `${acRequired} course(s) require AC; ${acRooms} AC room(s) available.`
        : `${acRequired} course(s) require an AC room but no room is marked AC. Either mark AC rooms `
          + 'or change those courses to "AC Preferred".',
      action: { entity: 'rooms', label: 'Mark AC Rooms' },
    });
  }

  // --- Is there a room big enough for the biggest group? --------------------
  const biggest = db.get(
    `SELECT MAX(strength) AS strength FROM (
       SELECT student_count AS strength FROM sections WHERE college_id = ? AND status = 'ACTIVE'
     )`,
    [id]
  );
  const largestRoom = db.get(
    `SELECT MAX(COALESCE(max_capacity, seating_capacity)) AS cap FROM rooms
       WHERE college_id = ? AND status = 'ACTIVE'`,
    [id]
  );
  if (biggest && biggest.strength && largestRoom && largestRoom.cap != null) {
    add({
      key: 'capacity',
      label: 'Room Capacity Coverage',
      status: largestRoom.cap >= biggest.strength ? OK : WARN,
      count: largestRoom.cap,
      message: largestRoom.cap >= biggest.strength
        ? `Largest room holds ${largestRoom.cap}; largest section is ${biggest.strength} students.`
        : `The largest section has ${biggest.strength} students but the biggest room holds `
          + `${largestRoom.cap}. Those classes can only be placed by splitting into sub-sections or `
          + 'allowing capacity overflow.',
      action: { entity: 'rooms', label: 'Review Room Capacity' },
    });
  }

  // --- Rough demand vs supply ------------------------------------------------
  if (timing) {
    const demand = db.get(
      `SELECT SUM(COALESCE(lecture_hours,0) + COALESCE(tutorial_hours,0) + COALESCE(lab_hours,0)) AS periods
         FROM courses WHERE college_id = ? AND status = 'ACTIVE'`,
      [id]
    ).periods || 0;
    const roomCount = countRows('rooms', id, "status = 'ACTIVE'");
    const workingDays = String(timing.working_days || '').split(',').filter(Boolean).length;
    const supply = roomCount * workingDays * (Number(timing.periods_per_day) || 0);
    if (supply > 0) {
      const util = Math.round((demand / supply) * 100);
      add({
        key: 'demand',
        label: 'Timetable Load',
        status: util > 100 ? BLOCK : util > 85 ? WARN : OK,
        count: util,
        message: util > 100
          ? `Courses need about ${demand} class periods a week but the college only has ${supply} `
            + `room-periods (${roomCount} rooms x ${workingDays} days x ${timing.periods_per_day} periods). `
            + 'Add rooms, extend the day, or reduce course hours.'
          : `Courses need about ${demand} of ${supply} available room-periods (${util}% utilisation).`,
        action: { entity: 'rooms', label: 'Add Rooms' },
      });
    }
  }

  const blocking = findings.filter((x) => x.status === BLOCK);
  const warnings = findings.filter((x) => x.status === WARN);
  const required = findings.filter((x) => !x.optional);
  const done = required.filter((x) => x.status !== BLOCK).length;

  return {
    collegeId: id,
    canGenerate: blocking.length === 0,
    findings,
    blocking,
    warnings,
    progress: {
      total: required.length,
      done,
      percent: required.length ? Math.round((done / required.length) * 100) : 0,
    },
    summary: blocking.length
      ? `${blocking.length} item(s) must be fixed before a timetable can be generated.`
      : warnings.length
        ? `Ready to generate, with ${warnings.length} thing(s) worth reviewing.`
        : 'All data checks passed. Ready to generate.',
  };
}

/**
 * Throws a 400 with the full report attached when generation must be refused.
 * Called by both the wizard and the manual builder.
 */
function assertReadyToGenerate(collegeId) {
  const report = checkCollege(collegeId);
  if (!report.canGenerate) {
    const err = new Error(report.blocking[0].message);
    err.status = 400;
    err.code = 'NOT_READY';
    err.details = report.blocking.map((b) => b.message);
    err.report = report;
    throw err;
  }
  return report;
}

module.exports = { checkCollege, assertReadyToGenerate, BLOCK, WARN, OK };
