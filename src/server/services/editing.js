'use strict';

/**
 * Assignment editing -- the Section 8 card actions.
 *
 * Every mutation here follows the same shape:
 *   1. load the row inside the caller's college scope
 *   2. rebuild the occurrence and re-validate against the live calendar,
 *      ignoring the row's own current booking
 *   3. refuse hard conflicts, unless the coordinator explicitly overrides, in
 *      which case the reasons are stored on the card so nothing is hidden
 *   4. write, then audit
 *
 * Locked assignments are never touched by re-generation (Section 8.3): the
 * generator loads them as immovable occupancy and only clears unlocked rows.
 */

const db = require('../db/connection');
const { httpError } = require('../auth/middleware');
const { buildContext } = require('./context');
const { checkPlacement } = require('./constraints');
const { scoreCandidate } = require('./scoring');
const { materialiseSlot } = require('./scheduler');
const {
  occurrenceForAssignment, occurrenceForRequest, placementIdFor, parallelWithSiblings,
} = require('./alternatives');
const { snapshot, audit } = require('./versions');

// ---------------------------------------------------------------------------
// Row access
// ---------------------------------------------------------------------------
function getAssignment(collegeId, id) {
  const row = db.get('SELECT * FROM assignments WHERE id = ? AND college_id = ?', [id, collegeId]);
  if (!row) throw httpError(404, 'That class is no longer in the timetable.');
  return row;
}

function getTimetable(collegeId, id) {
  const row = db.get('SELECT * FROM timetables WHERE id = ? AND college_id = ?', [id, collegeId]);
  if (!row) throw httpError(404, 'Timetable not found.');
  return row;
}

/** Wall-clock times for a block, always derived from the college's own grid. */
function slotTimes(ctx, slotIndex, periods) {
  const startIdx = ctx.grid.slots.findIndex((s) => s.index === Number(slotIndex));
  if (startIdx < 0) throw httpError(400, `Period ${slotIndex} does not exist in this college's timing configuration.`);
  const endIdx = Math.min(ctx.grid.slots.length - 1, startIdx + Math.max(1, periods) - 1);
  return {
    startIdx,
    start_time: ctx.grid.slots[startIdx].start,
    end_time: ctx.grid.slots[endIdx].end,
  };
}

// ---------------------------------------------------------------------------
// Validation of a proposed state
// ---------------------------------------------------------------------------

/**
 * Validates a proposed (day, slot, faculty, room) for an existing assignment.
 * @returns {{ok, violations, warnings, score, breakdown, slot}}
 */
function validateProposal(ctx, row, proposal) {
  const occ = occurrenceForAssignment(ctx, row);
  const ignore = new Set([placementIdFor(row.id)]);

  const day = proposal.day != null ? Number(proposal.day) : Number(row.day_of_week);
  const slotIndex = proposal.slotIndex != null ? Number(proposal.slotIndex) : Number(row.slot_index);
  const periods = proposal.periods != null ? Math.max(1, Number(proposal.periods)) : occ.periods;
  const facultyId = proposal.facultyId !== undefined
    ? (proposal.facultyId == null ? null : Number(proposal.facultyId))
    : (row.faculty_id || null);
  const roomId = proposal.roomId !== undefined
    ? (proposal.roomId == null ? null : Number(proposal.roomId))
    : (row.room_id || null);

  const { startIdx } = slotTimes(ctx, slotIndex, periods);
  const base = materialiseSlot(ctx, { day, startIdx }, periods);
  if (!base) {
    return {
      ok: false,
      violations: [{
        code: 'BLOCK_DOES_NOT_FIT',
        message: `A ${periods}-period class cannot start at period ${slotIndex} -- `
          + 'the day ends before it would finish.',
      }],
      warnings: [], score: 0, breakdown: [], resolved: { day, slotIndex, periods, facultyId, roomId },
    };
  }

  const cand = {
    ...base,
    facultyId,
    roomId,
    parallelWithSiblings: parallelWithSiblings(ctx, { ...occ, periods }, base, ctx.calendar, ignore),
  };
  const occForCheck = { ...occ, periods };
  const check = checkPlacement(cand, occForCheck, ctx.calendar, ctx, ignore);
  const scored = check.ok ? scoreCandidate(cand, occForCheck, ctx.calendar, ctx, check.warnings) : { score: 0, breakdown: [] };

  return {
    ok: check.ok,
    violations: check.violations,
    warnings: check.warnings,
    score: scored.score,
    breakdown: scored.breakdown,
    slot: base,
    resolved: { day, slotIndex, periods, facultyId, roomId },
    label: occ.label,
  };
}

/** Re-validates a card exactly where it currently sits (Section 8.2). */
function validateAssignment(ctx, row) {
  return validateProposal(ctx, row, {});
}

/**
 * Whole-timetable conflict report. Used after a manual edit and by the
 * "Validate" button so the coordinator can see every outstanding problem.
 */
function validateTimetable(collegeId, timetableId) {
  const ctx = buildContext({ collegeId });
  const rows = db.all(
    `SELECT * FROM assignments WHERE timetable_id = ? AND college_id = ? AND status = 'SCHEDULED'
      ORDER BY day_of_week, slot_index`,
    [timetableId, collegeId]
  );
  const problems = [];
  const warnings = [];
  let scoreSum = 0;

  for (const row of rows) {
    const res = validateProposal(ctx, row, {});
    scoreSum += res.score;
    if (!res.ok) {
      problems.push({
        assignmentId: row.id,
        label: res.label,
        day: row.day_of_week,
        slotIndex: row.slot_index,
        isLocked: !!row.is_locked,
        violations: res.violations,
      });
    }
    res.warnings.forEach((w) => warnings.push({ assignmentId: row.id, label: res.label, ...w }));
  }

  return {
    timetableId: Number(timetableId),
    classes: rows.length,
    hardConflicts: problems.length,
    softWarnings: warnings.length,
    averageScore: rows.length ? Math.round(scoreSum / rows.length) : 0,
    problems,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
function applyProposal(ctx, row, proposal, user, action) {
  const res = validateProposal(ctx, row, proposal);
  const force = !!proposal.force;

  if (!res.ok && !force) {
    const err = httpError(409, res.violations[0].message, 'CONFLICT');
    err.details = res.violations.map((v) => v.message);
    err.violations = res.violations;
    // The client offers "Find Alternatives" straight from this payload.
    err.canOverride = true;
    throw err;
  }

  const { day, slotIndex, periods, facultyId, roomId } = res.resolved;
  const times = slotTimes(ctx, slotIndex, periods);
  const storedWarnings = [
    ...res.warnings,
    ...(res.ok ? [] : res.violations.map((v) => ({ code: 'OVERRIDE', message: `Override: ${v.message}` }))),
  ];

  const before = { ...row };
  db.run(
    `UPDATE assignments
        SET day_of_week = ?, slot_index = ?, periods = ?, start_time = ?, end_time = ?,
            faculty_id = ?, room_id = ?, score = ?, warnings = ?, is_manual = 1,
            updated_at = datetime('now')
      WHERE id = ?`,
    [
      day, slotIndex, periods, times.start_time, times.end_time,
      facultyId, roomId, res.score, JSON.stringify(storedWarnings), row.id,
    ]
  );
  db.run("UPDATE timetables SET updated_at = datetime('now') WHERE id = ?", [row.timetable_id]);

  const after = db.get('SELECT * FROM assignments WHERE id = ?', [row.id]);
  audit({
    timetableId: row.timetable_id,
    assignmentId: row.id,
    collegeId: row.college_id,
    action,
    userId: user ? user.id : null,
    before,
    after: { ...after, overridden: !res.ok },
  });

  return {
    assignment: after,
    validation: res,
    overridden: !res.ok,
    warnings: storedWarnings,
  };
}

function moveAssignment(collegeId, id, body, user) {
  const row = getAssignment(collegeId, id);
  const ctx = buildContext({ collegeId });
  return applyProposal(ctx, row, {
    day: body.day,
    slotIndex: body.slotIndex,
    periods: body.periods,
    facultyId: body.facultyId,
    roomId: body.roomId,
    force: body.force,
  }, user, 'MOVE');
}

function changeFaculty(collegeId, id, body, user) {
  const row = getAssignment(collegeId, id);
  const ctx = buildContext({ collegeId });
  if (body.facultyId == null) throw httpError(400, 'Select a teacher.');
  return applyProposal(ctx, row, { facultyId: body.facultyId, force: body.force }, user, 'CHANGE_TEACHER');
}

function changeRoom(collegeId, id, body, user) {
  const row = getAssignment(collegeId, id);
  const ctx = buildContext({ collegeId });
  if (body.roomId == null) throw httpError(400, 'Select a room.');
  return applyProposal(ctx, row, { roomId: body.roomId, force: body.force }, user, 'CHANGE_ROOM');
}

/** Edit several properties at once (the card's Edit dialog). */
function editAssignment(collegeId, id, body, user) {
  const row = getAssignment(collegeId, id);
  const ctx = buildContext({ collegeId });
  const result = applyProposal(ctx, row, body, user, 'EDIT');
  if (body.notes !== undefined) {
    db.run('UPDATE assignments SET notes = ? WHERE id = ?', [body.notes || null, id]);
    result.assignment = db.get('SELECT * FROM assignments WHERE id = ?', [id]);
  }
  return result;
}

function setLock(collegeId, id, locked, user) {
  const row = getAssignment(collegeId, id);
  db.run("UPDATE assignments SET is_locked = ?, updated_at = datetime('now') WHERE id = ?",
    [locked ? 1 : 0, id]);
  audit({
    timetableId: row.timetable_id,
    assignmentId: row.id,
    collegeId: row.college_id,
    action: locked ? 'LOCK' : 'UNLOCK',
    userId: user ? user.id : null,
    before: { is_locked: row.is_locked },
    after: { is_locked: locked ? 1 : 0 },
  });
  return db.get('SELECT * FROM assignments WHERE id = ?', [id]);
}

/**
 * Cancel keeps the row (so the history and the reason survive) but frees the
 * teacher, the room and the student group.
 */
function cancelAssignment(collegeId, id, body, user) {
  const row = getAssignment(collegeId, id);
  db.run(
    `UPDATE assignments SET status = 'CANCELLED', notes = ?, updated_at = datetime('now') WHERE id = ?`,
    [body && body.reason ? String(body.reason) : row.notes, id]
  );
  audit({
    timetableId: row.timetable_id,
    assignmentId: row.id,
    collegeId: row.college_id,
    action: 'CANCEL',
    userId: user ? user.id : null,
    before: { status: row.status },
    after: { status: 'CANCELLED', reason: body && body.reason },
  });
  return db.get('SELECT * FROM assignments WHERE id = ?', [id]);
}

function restoreAssignment(collegeId, id, user) {
  const row = getAssignment(collegeId, id);
  const ctx = buildContext({ collegeId });
  const res = validateProposal(ctx, { ...row, status: 'CANCELLED' }, {});
  if (!res.ok) {
    const err = httpError(409,
      `This class cannot be restored where it was: ${res.violations[0].message}`, 'CONFLICT');
    err.details = res.violations.map((v) => v.message);
    err.violations = res.violations;
    throw err;
  }
  db.run("UPDATE assignments SET status = 'SCHEDULED', updated_at = datetime('now') WHERE id = ?", [id]);
  audit({
    timetableId: row.timetable_id,
    assignmentId: row.id,
    collegeId: row.college_id,
    action: 'RESTORE',
    userId: user ? user.id : null,
    before: { status: row.status },
    after: { status: 'SCHEDULED' },
  });
  return db.get('SELECT * FROM assignments WHERE id = ?', [id]);
}

function deleteAssignment(collegeId, id, user) {
  const row = getAssignment(collegeId, id);
  db.run('DELETE FROM assignments WHERE id = ?', [id]);
  audit({
    timetableId: row.timetable_id,
    assignmentId: id,
    collegeId: row.college_id,
    action: 'DELETE',
    userId: user ? user.id : null,
    before: row,
  });
  return { deleted: true, id: Number(id) };
}

/** Duplicate: same class, new slot. Useful for an extra weekly session. */
function duplicateAssignment(collegeId, id, body, user) {
  const row = getAssignment(collegeId, id);
  const ctx = buildContext({ collegeId });
  return createAssignment(collegeId, {
    timetableId: row.timetable_id,
    courseId: row.course_id,
    sectionId: row.section_id,
    subSectionId: row.sub_section_id,
    facultyId: body.facultyId !== undefined ? body.facultyId : row.faculty_id,
    roomId: body.roomId !== undefined ? body.roomId : row.room_id,
    component: row.component,
    periods: body.periods != null ? body.periods : row.periods,
    day: body.day != null ? body.day : row.day_of_week,
    slotIndex: body.slotIndex != null ? body.slotIndex : row.slot_index,
    groupKey: row.group_key,
    force: body.force,
  }, user, { ctx, action: 'DUPLICATE' });
}

/**
 * Manual creation (Section 6.1) -- also the write path behind Duplicate and
 * behind the Hybrid mode's "fix this class first, then auto-fill the rest".
 */
function createAssignment(collegeId, body, user, opts = {}) {
  const ctx = opts.ctx || buildContext({ collegeId });
  const timetable = getTimetable(collegeId, body.timetableId);

  const occ = occurrenceForRequest(ctx, body);
  if (body.day == null || body.slotIndex == null) {
    throw httpError(400, 'Choose a day and a period for this class.');
  }
  const periods = body.periods != null ? Math.max(1, Number(body.periods)) : occ.periods;
  const { startIdx, start_time: startTime, end_time: endTime } = slotTimes(ctx, body.slotIndex, periods);
  const base = materialiseSlot(ctx, { day: Number(body.day), startIdx }, periods);
  if (!base) {
    throw httpError(400, `A ${periods}-period class cannot start at period ${body.slotIndex} -- `
      + 'the day ends before it would finish.');
  }

  const facultyId = body.facultyId != null ? Number(body.facultyId) : null;
  const roomId = body.roomId != null ? Number(body.roomId) : null;
  const cand = {
    ...base,
    facultyId,
    roomId,
    parallelWithSiblings: parallelWithSiblings(ctx, { ...occ, periods }, base, ctx.calendar, null),
  };
  const occForCheck = { ...occ, periods };
  const check = checkPlacement(cand, occForCheck, ctx.calendar, ctx, null);

  if (!check.ok && !body.force) {
    const err = httpError(409, check.violations[0].message, 'CONFLICT');
    err.details = check.violations.map((v) => v.message);
    err.violations = check.violations;
    err.canOverride = true;
    throw err;
  }
  const scored = check.ok
    ? scoreCandidate(cand, occForCheck, ctx.calendar, ctx, check.warnings)
    : { score: 0, breakdown: [] };
  const storedWarnings = [
    ...check.warnings,
    ...(check.ok ? [] : check.violations.map((v) => ({ code: 'OVERRIDE', message: `Override: ${v.message}` }))),
  ];

  const info = db.run(
    `INSERT INTO assignments
       (timetable_id, college_id, course_id, section_id, sub_section_id, faculty_id, room_id,
        day_of_week, start_time, end_time, slot_index, periods, component, group_key,
        is_locked, is_manual, status, score, warnings, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'SCHEDULED', ?, ?, ?)`,
    [
      timetable.id, collegeId, occ.courseId, occ.sectionId, occ.subSectionId,
      facultyId, roomId, Number(body.day), startTime, endTime, Number(body.slotIndex), periods,
      occ.component, body.groupKey || null, body.lock ? 1 : 0,
      scored.score, JSON.stringify(storedWarnings), body.notes || null,
    ]
  );

  const created = db.get('SELECT * FROM assignments WHERE id = ?', [info.lastInsertRowid]);
  audit({
    timetableId: timetable.id,
    assignmentId: created.id,
    collegeId,
    action: opts.action || 'CREATE',
    userId: user ? user.id : null,
    after: { ...created, overridden: !check.ok },
  });

  return {
    assignment: created,
    validation: { ok: check.ok, violations: check.violations, warnings: check.warnings, score: scored.score, breakdown: scored.breakdown },
    overridden: !check.ok,
    warnings: storedWarnings,
  };
}

// ---------------------------------------------------------------------------
// Persisting a generation result
// ---------------------------------------------------------------------------

/**
 * Writes a solver result into a timetable.
 *
 * `keepLocked` is the Section 8.3 guarantee: locked rows survive untouched and
 * the solver was already given them as occupancy, so nothing it produced can
 * collide with them.
 */
function persistGeneration(collegeId, {
  timetableId, result, request, userId = null, keepLocked = true, keepManual = false,
}) {
  return db.transaction(() => {
    const timetable = getTimetable(collegeId, timetableId);
    const existing = db.get('SELECT COUNT(*) AS n FROM assignments WHERE timetable_id = ?', [timetableId]).n;
    if (existing) {
      snapshot(timetableId, {
        label: 'Before generation',
        reason: 'Automatic snapshot taken before re-generating this timetable',
        userId,
      });
    }

    const keepClauses = [];
    if (keepLocked) keepClauses.push('is_locked = 1');
    if (keepManual) keepClauses.push('is_manual = 1');
    const keepSql = keepClauses.length ? ` AND NOT (${keepClauses.join(' OR ')})` : '';
    db.run(`DELETE FROM assignments WHERE timetable_id = ?${keepSql}`, [timetableId]);

    const sql = `INSERT INTO assignments
       (timetable_id, college_id, course_id, section_id, sub_section_id, faculty_id, room_id,
        day_of_week, start_time, end_time, slot_index, periods, component, group_key,
        is_locked, is_manual, status, score, warnings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'SCHEDULED', ?, ?)`;

    for (const a of result.assignments) {
      db.run(sql, [
        timetableId, collegeId, a.courseId, a.sectionId, a.subSectionId || null,
        a.facultyId || null, a.roomId || null, a.day, a.startTime, a.endTime,
        a.slotIndex, a.periods, a.component, a.groupKey || null,
        a.score != null ? a.score : null,
        JSON.stringify(a.warnings || []),
      ]);
    }

    db.run(
      `UPDATE timetables SET quality_score = ?, mode = ?, updated_at = datetime('now') WHERE id = ?`,
      [result.qualityScore, timetable.mode, timetableId]
    );

    db.run(
      `INSERT INTO generation_runs (timetable_id, college_id, request_json, result_json, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        timetableId, collegeId,
        JSON.stringify(request || {}),
        JSON.stringify({
          stats: result.stats,
          qualityScore: result.qualityScore,
          unscheduled: result.unscheduled,
          issues: result.issues,
          warnings: result.warnings,
        }),
        userId,
      ]
    );

    audit({
      timetableId,
      collegeId,
      action: 'GENERATE',
      userId,
      after: { stats: result.stats, qualityScore: result.qualityScore, keptLocked: keepLocked },
    });

    const kept = db.get(
      'SELECT COUNT(*) AS n FROM assignments WHERE timetable_id = ? AND (is_locked = 1 OR is_manual = 1)',
      [timetableId]
    ).n;
    return { written: result.assignments.length, keptFixed: kept };
  });
}

module.exports = {
  getAssignment,
  getTimetable,
  slotTimes,
  validateProposal,
  validateAssignment,
  validateTimetable,
  moveAssignment,
  changeFaculty,
  changeRoom,
  editAssignment,
  setLock,
  cancelAssignment,
  restoreAssignment,
  deleteAssignment,
  duplicateAssignment,
  createAssignment,
  persistGeneration,
};
