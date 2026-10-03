'use strict';

/**
 * Scheduling context.
 *
 * Loads every row the constraint engine needs for one college in a handful of
 * queries and exposes it as indexed lookups plus human-readable naming helpers.
 * Building this once per request keeps the solver's inner loop free of database
 * access, which is what makes backtracking cheap enough to be interactive.
 */

const db = require('../db/connection');
const { buildGrid } = require('./timing');
const { RULE_CATALOGUE, DAY_NAMES } = require('./entityRegistry');
const { ResourceCalendar } = require('./constraints');
const { evaluateRoom } = require('./roomFit');

function loadRules(collegeId) {
  const rows = db.all('SELECT rule_key, rule_value, enabled FROM scheduling_rules WHERE college_id = ?', [collegeId]);
  const byKey = new Map(rows.map((r) => [r.rule_key, r]));

  const value = (key) => {
    const def = RULE_CATALOGUE.find((r) => r.key === key);
    const row = byKey.get(key);
    if (!row || !row.enabled) return def ? def.default : null;
    return row.rule_value != null && row.rule_value !== '' ? row.rule_value : (def ? def.default : null);
  };
  const num = (key) => Number(value(key)) || 0;
  const bool = (key) => {
    const v = value(key);
    return v === '1' || v === 1 || v === true || v === 'true';
  };

  const disallowed = new Set(
    String(value('disallowed_slots') || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+:\d+$/.test(s))
  );

  return {
    capacityTolerancePercent: num('capacity_tolerance_percent'),
    maxConsecutiveTeacherPeriods: num('max_consecutive_teacher_periods'),
    maxTeacherPeriodsPerDay: num('max_teacher_periods_per_day'),
    maxSectionPeriodsPerDay: num('max_section_periods_per_day'),
    minGapSectionMinutes: num('min_gap_section_minutes'),
    preferParallelSubsections: bool('prefer_parallel_subsections'),
    allowCapacityOverflow: bool('allow_capacity_overflow'),
    avoidLastPeriod: bool('avoid_last_period'),
    spreadCourseAcrossDays: bool('spread_course_across_days'),
    respectFacultyMaxHours: bool('respect_faculty_max_hours'),
    disallowedSlots: disallowed,
    raw: Object.fromEntries(RULE_CATALOGUE.map((r) => [r.key, value(r.key)])),
  };
}

function loadTimingGrid(collegeId) {
  const timing = db.get(
    `SELECT * FROM college_timings
      WHERE college_id = ? AND status = 'ACTIVE'
      ORDER BY id LIMIT 1`,
    [collegeId]
  );
  if (!timing) {
    const err = new Error('This college has no Timing Configuration set up.');
    err.status = 400;
    err.code = 'NO_TIMING_CONFIG';
    throw err;
  }
  const breaks = db.all('SELECT * FROM college_breaks WHERE timing_id = ? ORDER BY start_time', [timing.id]);
  return { timing, breaks, grid: buildGrid(timing, breaks) };
}

/**
 * @param {object} opts
 *   collegeId              -- required
 *   excludeTimetableId     -- assignments of this timetable are NOT loaded as
 *                             occupancy (we are regenerating it), except locked
 *                             rows when keepLocked is true
 *   keepLocked             -- load locked rows of the excluded timetable
 */
function buildContext(opts) {
  const collegeId = Number(opts.collegeId);
  const college = db.get('SELECT * FROM colleges WHERE id = ?', [collegeId]);
  if (!college) {
    const err = new Error('College not found.');
    err.status = 404;
    throw err;
  }

  const { timing, breaks, grid } = loadTimingGrid(collegeId);
  const rules = loadRules(collegeId);

  const sectionList = db.all('SELECT * FROM sections WHERE college_id = ?', [collegeId]);
  const subSectionList = db.all('SELECT * FROM sub_sections WHERE college_id = ?', [collegeId]);
  const courseList = db.all('SELECT * FROM courses WHERE college_id = ?', [collegeId]);
  const facultyList = db.all('SELECT * FROM faculty WHERE college_id = ?', [collegeId]);
  const roomList = db.all('SELECT * FROM rooms WHERE college_id = ?', [collegeId]);
  const buildingList = db.all('SELECT * FROM buildings WHERE college_id = ?', [collegeId]);
  const floorList = db.all('SELECT * FROM floors WHERE college_id = ?', [collegeId]);
  const semesterList = db.all('SELECT * FROM semesters WHERE college_id = ?', [collegeId]);
  const programList = db.all('SELECT * FROM programs WHERE college_id = ?', [collegeId]);
  const departmentList = db.all('SELECT * FROM departments WHERE college_id = ?', [collegeId]);
  const facultyCourseRows = db.all('SELECT * FROM faculty_courses WHERE college_id = ?', [collegeId]);
  const facultyAvailRows = db.all('SELECT * FROM faculty_availability WHERE college_id = ?', [collegeId]);
  const roomAvailRows = db.all('SELECT * FROM room_availability WHERE college_id = ?', [collegeId]);

  const index = (list) => new Map(list.map((r) => [r.id, r]));
  const groupBy = (list, key) => {
    const m = new Map();
    for (const row of list) {
      const k = row[key];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(row);
    }
    return m;
  };

  const sectionById = index(sectionList);
  const subSectionById = index(subSectionList);
  const courseById = index(courseList);
  const facultyById = index(facultyList);
  const roomById = index(roomList);
  const buildingById = index(buildingList);
  const floorById = index(floorList);

  const subSectionsBySection = groupBy(subSectionList, 'section_id');
  const subSectionIdsBySection = new Map(
    [...subSectionsBySection.entries()].map(([k, v]) => [k, v.map((s) => s.id)])
  );
  const facultyByCourse = groupBy(facultyCourseRows, 'course_id');
  const facultyAvailability = groupBy(facultyAvailRows, 'faculty_id');
  const roomAvailability = groupBy(roomAvailRows, 'room_id');

  const ctx = {
    collegeId,
    college,
    timing,
    breaks,
    grid,
    rules,

    sectionList, subSectionList, courseList, facultyList, roomList,
    buildingList, floorList, semesterList, programList, departmentList,

    sectionById, subSectionById, courseById, facultyById, roomById,
    buildingById, floorById,
    subSectionsBySection, subSectionIdsBySection,
    facultyByCourse, facultyAvailability, roomAvailability,

    dayName: (d) => DAY_NAMES[Number(d)] || `Day ${d}`,
    facultyName: (id) => {
      const f = facultyById.get(Number(id));
      return f ? f.name : `Faculty #${id}`;
    },
    roomName: (id) => {
      const r = roomById.get(Number(id));
      return r ? r.name : `Room #${id}`;
    },
    courseName: (id) => {
      const c = courseById.get(Number(id));
      return c ? `${c.code} ${c.name}` : `Course #${id}`;
    },
    sectionName: (id) => {
      const s = sectionById.get(Number(id));
      return s ? s.name : `Section #${id}`;
    },
    subSectionName: (id) => {
      const s = subSectionById.get(Number(id));
      return s ? s.name : `Sub-Section #${id}`;
    },
    /** "Section B / B1" style label used in every conflict message. */
    groupLabel: (x) => {
      if (!x) return 'a class';
      const sec = x.sectionId != null ? x.sectionId : x.section_id;
      const sub = x.subSectionId != null ? x.subSectionId : x.sub_section_id;
      const secName = sec != null ? ctx.sectionName(sec) : '';
      if (sub) return `${secName} / ${ctx.subSectionName(sub)}`;
      return secName || 'a class';
    },
    slotByIndex: (i) => grid.slots.find((s) => s.index === Number(i)) || null,
  };

  // Memoised room suitability: keyed by the only inputs it depends on, so the
  // solver can evaluate thousands of candidate placements without re-deriving
  // capacity / AC / facility verdicts each time.
  const roomVerdictCache = new Map();
  ctx.roomVerdictFor = (occ, room) => {
    const key = `${room.id}|${occ.strength}|${occ.acRequirement}|${occ.requiredRoomType || ''}|`
      + `${Array.isArray(occ.requiredFacilities) ? occ.requiredFacilities.join(',') : (occ.requiredFacilities || '')}`;
    let hit = roomVerdictCache.get(key);
    if (!hit) {
      hit = evaluateRoom(room, {
        strength: occ.strength,
        acRequirement: occ.acRequirement,
        requiredFacilities: occ.requiredFacilities,
        requiredRoomType: occ.requiredRoomType,
      }, { tolerancePercent: rules.capacityTolerancePercent, allowOverflow: rules.allowCapacityOverflow });
      roomVerdictCache.set(key, hit);
    }
    return hit;
  };

  ctx.calendar = loadCalendar(ctx, opts);
  return ctx;
}

/**
 * Loads existing assignments into a ResourceCalendar so a new generation never
 * double-books a teacher or room that another timetable in the same college has
 * already claimed.
 */
function loadCalendar(ctx, opts = {}) {
  const cal = new ResourceCalendar();
  const exclude = opts.excludeTimetableId != null ? Number(opts.excludeTimetableId) : null;
  const keepLocked = opts.keepLocked !== false;

  const rows = db.all(
    `SELECT a.* FROM assignments a
       JOIN timetables t ON t.id = a.timetable_id
      WHERE a.college_id = ?
        AND a.status = 'SCHEDULED'
        AND t.status <> 'ARCHIVED'`,
    [ctx.collegeId]
  );

  for (const row of rows) {
    if (exclude != null && row.timetable_id === exclude) {
      if (!(keepLocked && row.is_locked)) continue;
    }
    cal.add(assignmentToPlacement(row, ctx));
  }
  return cal;
}

/** Converts a stored assignment row into the placement shape the engine uses. */
function assignmentToPlacement(row, ctx) {
  const startIdx = ctx.grid.slots.findIndex((s) => s.index === Number(row.slot_index));
  const periods = [];
  if (startIdx >= 0) {
    for (let i = startIdx; i < startIdx + (Number(row.periods) || 1) && i < ctx.grid.slots.length; i += 1) {
      periods.push(ctx.grid.slots[i].index);
    }
  } else {
    periods.push(Number(row.slot_index));
  }
  const room = row.room_id ? ctx.roomById.get(row.room_id) : null;
  return {
    id: `db${row.id}`,
    assignmentId: row.id,
    timetableId: row.timetable_id,
    day: Number(row.day_of_week),
    periods,
    facultyId: row.faculty_id || null,
    roomId: row.room_id || null,
    buildingId: room ? room.building_id || null : null,
    sectionId: row.section_id || null,
    subSectionId: row.sub_section_id || null,
    courseId: row.course_id || null,
    component: row.component,
    isLocked: !!row.is_locked,
    external: true,
  };
}

module.exports = { buildContext, loadRules, loadTimingGrid, loadCalendar, assignmentToPlacement };
