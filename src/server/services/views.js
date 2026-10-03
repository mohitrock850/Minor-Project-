'use strict';

/**
 * Timetable view builders (Section 7).
 *
 * Every view is the same shape -- a period grid plus cards indexed by
 * "day:slotIndex" -- so the renderer has one grid component and one card
 * component regardless of whether you are looking at a section, a teacher, a
 * room, a course, a department, a semester or a whole college.
 *
 * Sub-section classes always roll up: they appear in the parent Section view
 * (labelled "Section B / B1"), and in the Faculty and Room views of whoever is
 * actually teaching them (Section 3.4).
 */

const db = require('../db/connection');
const { loadTimingGrid } = require('./context');
const { displayRows } = require('./timing');
const { DAY_NAMES } = require('./entityRegistry');
const { roomCard } = require('./roomFit');

const CARD_SQL = `
  SELECT a.*,
         c.code            AS course_code,
         c.name            AS course_name,
         c.course_type     AS course_type,
         c.ac_requirement  AS ac_requirement,
         f.name            AS faculty_name,
         f.employee_id     AS faculty_employee_id,
         r.name            AS room_name,
         r.room_number     AS room_number,
         r.room_type       AS room_type,
         r.is_ac           AS room_is_ac,
         r.seating_capacity AS room_capacity,
         r.max_capacity    AS room_max_capacity,
         b.name            AS building_name,
         s.name            AS section_name,
         s.student_count   AS section_student_count,
         ss.name           AS sub_section_name,
         ss.student_count  AS sub_section_student_count,
         sem.semester_number AS semester_number,
         p.name            AS program_name,
         d.name            AS department_name,
         t.name            AS timetable_name,
         t.status          AS timetable_status
    FROM assignments a
    JOIN timetables t   ON t.id = a.timetable_id
    LEFT JOIN courses c ON c.id = a.course_id
    LEFT JOIN faculty f ON f.id = a.faculty_id
    LEFT JOIN rooms r   ON r.id = a.room_id
    LEFT JOIN buildings b ON b.id = r.building_id
    LEFT JOIN sections s  ON s.id = a.section_id
    LEFT JOIN sub_sections ss ON ss.id = a.sub_section_id
    LEFT JOIN semesters sem ON sem.id = s.semester_id
    LEFT JOIN programs p   ON p.id = s.program_id
    LEFT JOIN departments d ON d.id = COALESCE(s.department_id, p.department_id)
`;

/** Turns a joined assignment row into the card the UI renders. */
function toCard(row, grid) {
  const startIdx = grid.slots.findIndex((s) => s.index === Number(row.slot_index));
  const span = Math.max(1, Number(row.periods) || 1);
  const slotIndices = [];
  for (let i = startIdx; i >= 0 && i < startIdx + span && i < grid.slots.length; i += 1) {
    slotIndices.push(grid.slots[i].index);
  }
  const first = startIdx >= 0 ? grid.slots[startIdx] : null;
  const last = slotIndices.length ? grid.slots[startIdx + slotIndices.length - 1] : null;

  let warnings = [];
  if (row.warnings) {
    try {
      warnings = JSON.parse(row.warnings);
    } catch {
      warnings = [String(row.warnings)];
    }
  }

  return {
    id: row.id,
    timetableId: row.timetable_id,
    timetableName: row.timetable_name,
    timetableStatus: row.timetable_status,
    status: row.status,
    day: Number(row.day_of_week),
    dayName: DAY_NAMES[Number(row.day_of_week)] || `Day ${row.day_of_week}`,
    slotIndex: Number(row.slot_index),
    slotIndices,
    periods: span,
    startTime: first ? first.start : null,
    endTime: last ? last.end : null,
    timeLabel: first && last ? `${first.start} - ${last.end}` : null,

    courseId: row.course_id,
    courseCode: row.course_code,
    courseName: row.course_name,
    courseType: row.course_type,
    component: row.component,

    facultyId: row.faculty_id,
    facultyName: row.faculty_name,
    facultyEmployeeId: row.faculty_employee_id,

    roomId: row.room_id,
    roomName: row.room_name,
    roomNumber: row.room_number,
    roomType: row.room_type,
    // Section 16: AC vs Non-AC must be unmissable, so the badge text is
    // pre-computed here rather than left to each view.
    roomIsAc: row.room_id ? !!row.room_is_ac : null,
    acLabel: row.room_id ? (row.room_is_ac ? 'AC' : 'NON-AC') : null,
    acRequirement: row.ac_requirement,
    roomCapacity: row.room_capacity,
    roomMaxCapacity: row.room_max_capacity,
    buildingName: row.building_name,

    sectionId: row.section_id,
    sectionName: row.section_name,
    subSectionId: row.sub_section_id,
    subSectionName: row.sub_section_name,
    groupLabel: row.sub_section_name
      ? `${row.section_name} / ${row.sub_section_name}`
      : (row.section_name || ''),
    isSplit: !!row.sub_section_id,
    groupKey: row.group_key,

    semesterNumber: row.semester_number,
    programName: row.program_name,
    departmentName: row.department_name,

    studentCount: row.sub_section_id ? row.sub_section_student_count : row.section_student_count,
    isLocked: !!row.is_locked,
    isManual: !!row.is_manual,
    score: row.score,
    warnings,
    note: row.notes,
  };
}

/**
 * Places cards into a day x period matrix.
 * A card occupies every period it spans, but is flagged so the renderer draws
 * one merged block for a multi-period lab instead of N identical tiles.
 */
function buildCells(cards, grid) {
  const cells = {};
  for (const day of grid.workingDays) {
    for (const slot of grid.slots) {
      cells[`${day}:${slot.index}`] = [];
    }
  }
  for (const card of cards) {
    card.slotIndices.forEach((slotIndex, offset) => {
      const key = `${card.day}:${slotIndex}`;
      if (!cells[key]) cells[key] = [];
      cells[key].push({ ...card, continuation: offset > 0, spanOffset: offset });
    });
  }
  return cells;
}

function summarise(cards, grid) {
  const classes = cards.length;
  const periods = cards.reduce((n, c) => n + c.periods, 0);
  const parallel = new Set();
  const byGroup = new Map();
  for (const card of cards) {
    if (!card.groupKey) continue;
    if (!byGroup.has(card.groupKey)) byGroup.set(card.groupKey, []);
    byGroup.get(card.groupKey).push(card);
  }
  for (const [key, members] of byGroup) {
    if (members.length > 1 && members.every((m) => m.subSectionId)) {
      const slots = new Set(members.map((m) => `${m.day}:${m.slotIndex}`));
      if (slots.size === 1) parallel.add(key);
    }
  }
  const capacity = grid.workingDays.length * grid.slots.length;
  const locked = cards.filter((c) => c.isLocked).length;
  const withWarnings = cards.filter((c) => c.warnings && c.warnings.length).length;
  const scores = cards.map((c) => Number(c.score)).filter((n) => Number.isFinite(n));
  return {
    classes,
    periods,
    locked,
    withWarnings,
    parallelGroups: parallel.size,
    freePeriods: Math.max(0, capacity - periods),
    utilizationPercent: capacity ? Math.round((periods / capacity) * 100) : 0,
    averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
  };
}

/**
 * @param {object} opts
 *   collegeId    required
 *   timetableId  optional -- omit to see every non-archived timetable of the college
 *   type         'section' | 'sub_section' | 'faculty' | 'room' | 'course'
 *                | 'department' | 'semester' | 'college' | 'student'
 *   id           the subject of the view
 *   includeCancelled
 */
function buildView(opts) {
  const collegeId = Number(opts.collegeId);
  const { grid } = loadTimingGrid(collegeId);

  const where = ['a.college_id = ?'];
  const params = [collegeId];

  if (opts.timetableId) {
    where.push('a.timetable_id = ?');
    params.push(Number(opts.timetableId));
  } else {
    where.push("t.status <> 'ARCHIVED'");
  }
  if (!opts.includeCancelled) where.push("a.status = 'SCHEDULED'");

  const type = opts.type || 'college';
  const id = opts.id != null ? Number(opts.id) : null;

  switch (type) {
    case 'section':
      // Roll-up: the section's own classes AND its sub-sections' classes.
      where.push('a.section_id = ?');
      params.push(id);
      break;
    case 'sub_section':
      where.push('(a.sub_section_id = ? OR (a.sub_section_id IS NULL AND a.section_id = '
        + '(SELECT section_id FROM sub_sections WHERE id = ?)))');
      params.push(id, id);
      break;
    case 'faculty':
      where.push('a.faculty_id = ?');
      params.push(id);
      break;
    case 'room':
      where.push('a.room_id = ?');
      params.push(id);
      break;
    case 'course':
      where.push('a.course_id = ?');
      params.push(id);
      break;
    case 'department':
      where.push('COALESCE(s.department_id, p.department_id, c.department_id) = ?');
      params.push(id);
      break;
    case 'semester':
      where.push('COALESCE(s.semester_id, c.semester_id) = ?');
      params.push(id);
      break;
    case 'program':
      where.push('COALESCE(s.program_id, c.program_id) = ?');
      params.push(id);
      break;
    case 'student': {
      const student = db.get('SELECT * FROM students WHERE id = ? AND college_id = ?', [id, collegeId]);
      if (!student) {
        const err = new Error('Student not found.');
        err.status = 404;
        throw err;
      }
      if (student.sub_section_id) {
        where.push('(a.sub_section_id = ? OR (a.sub_section_id IS NULL AND a.section_id = ?))');
        params.push(student.sub_section_id, student.section_id);
      } else {
        where.push('a.section_id = ?');
        params.push(student.section_id);
      }
      break;
    }
    case 'college':
    default:
      break;
  }

  const rows = db.all(
    `${CARD_SQL} WHERE ${where.join(' AND ')} ORDER BY a.day_of_week, a.slot_index, a.id`,
    params
  );
  const cards = rows.map((r) => toCard(r, grid));

  return {
    scope: { type, id, label: scopeLabel(type, id, collegeId) },
    collegeId,
    timetableId: opts.timetableId ? Number(opts.timetableId) : null,
    grid: {
      slots: grid.slots,
      workingDays: grid.workingDays,
      dayNames: grid.workingDays.map((d) => DAY_NAMES[d]),
      rows: displayRows(grid),
      slotMinutes: grid.slotMinutes,
    },
    cards,
    cells: buildCells(cards, grid),
    stats: summarise(cards, grid),
  };
}

function scopeLabel(type, id, collegeId) {
  const one = (sql, params) => {
    const row = db.get(sql, params);
    return row ? row.label : null;
  };
  switch (type) {
    case 'section':
      return one('SELECT name AS label FROM sections WHERE id = ?', [id]) || `Section #${id}`;
    case 'sub_section':
      return one(
        `SELECT s.name || ' / ' || ss.name AS label FROM sub_sections ss
           JOIN sections s ON s.id = ss.section_id WHERE ss.id = ?`, [id]
      ) || `Sub-Section #${id}`;
    case 'faculty':
      return one('SELECT name AS label FROM faculty WHERE id = ?', [id]) || `Faculty #${id}`;
    case 'room':
      return one('SELECT name AS label FROM rooms WHERE id = ?', [id]) || `Room #${id}`;
    case 'course':
      return one("SELECT code || ' - ' || name AS label FROM courses WHERE id = ?", [id]) || `Course #${id}`;
    case 'department':
      return one('SELECT name AS label FROM departments WHERE id = ?', [id]) || `Department #${id}`;
    case 'program':
      return one('SELECT name AS label FROM programs WHERE id = ?', [id]) || `Program #${id}`;
    case 'semester':
      return one(
        `SELECT 'Semester ' || sem.semester_number || ' - ' || p.name AS label
           FROM semesters sem LEFT JOIN programs p ON p.id = sem.program_id WHERE sem.id = ?`, [id]
      ) || `Semester #${id}`;
    case 'student':
      return one('SELECT name AS label FROM students WHERE id = ?', [id]) || `Student #${id}`;
    default:
      return one('SELECT name AS label FROM colleges WHERE id = ?', [collegeId]) || 'College';
  }
}

/**
 * Room-utilisation table for the Room view / dashboards: which rooms are busy,
 * which are idle, and how the AC stock is being used.
 */
function roomUtilisation(collegeId, timetableId = null) {
  const { grid } = loadTimingGrid(collegeId);
  const capacity = grid.workingDays.length * grid.slots.length;
  const rooms = db.all(
    `SELECT * FROM rooms WHERE college_id = ? AND status = 'ACTIVE' ORDER BY name`, [collegeId]
  );
  const usage = db.all(
    `SELECT a.room_id, SUM(a.periods) AS periods, COUNT(*) AS classes
       FROM assignments a JOIN timetables t ON t.id = a.timetable_id
      WHERE a.college_id = ? AND a.status = 'SCHEDULED' AND t.status <> 'ARCHIVED'
        ${timetableId ? 'AND a.timetable_id = ?' : ''}
      GROUP BY a.room_id`,
    timetableId ? [collegeId, Number(timetableId)] : [collegeId]
  );
  const byRoom = new Map(usage.map((u) => [u.room_id, u]));
  return rooms.map((room) => {
    const u = byRoom.get(room.id) || { periods: 0, classes: 0 };
    return {
      ...roomCard(room),
      periodsUsed: u.periods || 0,
      classes: u.classes || 0,
      periodsAvailable: capacity,
      utilizationPercent: capacity ? Math.round(((u.periods || 0) / capacity) * 100) : 0,
    };
  });
}

/** Teacher workload table: periods scheduled against their declared maximum. */
function facultyWorkload(collegeId, timetableId = null) {
  const faculty = db.all(
    `SELECT * FROM faculty WHERE college_id = ? AND status = 'ACTIVE' ORDER BY name`, [collegeId]
  );
  const usage = db.all(
    `SELECT a.faculty_id, SUM(a.periods) AS periods, COUNT(*) AS classes,
            COUNT(DISTINCT a.day_of_week) AS days
       FROM assignments a JOIN timetables t ON t.id = a.timetable_id
      WHERE a.college_id = ? AND a.status = 'SCHEDULED' AND t.status <> 'ARCHIVED'
        ${timetableId ? 'AND a.timetable_id = ?' : ''}
      GROUP BY a.faculty_id`,
    timetableId ? [collegeId, Number(timetableId)] : [collegeId]
  );
  const byFaculty = new Map(usage.map((u) => [u.faculty_id, u]));
  return faculty.map((f) => {
    const u = byFaculty.get(f.id) || { periods: 0, classes: 0, days: 0 };
    const max = Number(f.max_weekly_hours) || 0;
    return {
      id: f.id,
      name: f.name,
      employeeId: f.employee_id,
      designation: f.designation,
      periods: u.periods || 0,
      classes: u.classes || 0,
      daysUsed: u.days || 0,
      maxWeeklyHours: max || null,
      preferredHours: Number(f.preferred_hours) || null,
      loadPercent: max ? Math.round(((u.periods || 0) / max) * 100) : null,
      overloaded: max ? (u.periods || 0) > max : false,
    };
  });
}

module.exports = { buildView, buildCells, toCard, summarise, roomUtilisation, facultyWorkload, CARD_SQL };
