'use strict';

/**
 * Ranked suggestions: Find Best Slot (Section 6.2), Find Alternatives,
 * Change Teacher and Change Room (Section 8.1).
 *
 * All four are the same question asked with a different variable held free, so
 * they share one code path: build an occurrence, hold the fixed parts, and rank
 * every feasible value of the free part with the same checker and scorer the
 * automatic engine uses. That is what makes a manual edit and an automatic
 * placement judged by identical rules.
 */

const { checkPlacement } = require('./constraints');
const { scoreCandidate } = require('./scoring');
const { materialiseSlot } = require('./scheduler');
const { blockStarts } = require('./timing');
const { evaluateRoom, roomCard, parseFacilityList } = require('./roomFit');
const { COMPONENT_LABEL, eligibleFacultyForCourse } = require('./occurrences');
const { DAY_NAMES } = require('./entityRegistry');

/** Placement id used for assignments loaded from the database. */
const placementIdFor = (assignmentId) => `db${assignmentId}`;

/**
 * Rebuilds the occurrence an existing assignment represents, so a stored row can
 * be re-validated and re-ranked exactly as if the engine were placing it now.
 */
function occurrenceForAssignment(ctx, row) {
  const course = ctx.courseById.get(row.course_id) || {};
  const section = ctx.sectionById.get(row.section_id) || {};
  const sub = row.sub_section_id ? ctx.subSectionById.get(row.sub_section_id) : null;
  const strength = sub
    ? (Number(sub.student_count) || 0)
    : (Number(course.student_strength) || Number(section.student_count) || 0);

  const { ids: eligible } = eligibleFacultyForCourse(ctx, course);
  const facultyCandidates = eligible.length ? eligible : (row.faculty_id ? [row.faculty_id] : []);

  return {
    id: `a${row.id}`,
    assignmentId: row.id,
    courseId: row.course_id,
    course,
    sectionId: row.section_id,
    section,
    subSectionId: row.sub_section_id || null,
    subSection: sub,
    component: row.component,
    componentLabel: COMPONENT_LABEL[row.component] || 'Class',
    periods: Math.max(1, Number(row.periods) || 1),
    strength,
    label: `${course.code || 'Course'} ${COMPONENT_LABEL[row.component] || 'Class'} `
      + `(${section.name || 'Section'}${sub ? ` / ${sub.name}` : ''})`,
    acRequirement: String(course.ac_requirement || 'NOT_REQUIRED').toUpperCase(),
    requiredRoomType: course.required_room_type || null,
    requiredFacilities: course.required_facilities || null,
    facultyCandidates,
    facultyMode: 'AUTOMATIC',
    preferredFacultyIds: row.faculty_id ? [row.faculty_id] : [],
    roomCandidates: suitableRoomIds(ctx, {
      strength,
      acRequirement: String(course.ac_requirement || 'NOT_REQUIRED').toUpperCase(),
      requiredRoomType: course.required_room_type || null,
      requiredFacilities: course.required_facilities || null,
    }),
    roomMode: 'AUTOMATIC',
    preferredRoomIds: row.room_id ? [row.room_id] : [],
    slotCandidates: [],
    timeMode: 'AUTOMATIC',
    preferredDays: [],
    windowStartMin: null,
    windowEndMin: null,
    groupKey: row.group_key || null,
  };
}

/**
 * Occurrence for a class the coordinator is about to add by hand (Section 6.1),
 * before anything is persisted.
 */
function occurrenceForRequest(ctx, req) {
  const course = ctx.courseById.get(Number(req.courseId));
  if (!course) {
    const err = new Error('Select a course first.');
    err.status = 400;
    throw err;
  }
  const section = ctx.sectionById.get(Number(req.sectionId));
  if (!section) {
    const err = new Error('Select a section first.');
    err.status = 400;
    throw err;
  }
  const sub = req.subSectionId ? ctx.subSectionById.get(Number(req.subSectionId)) : null;
  if (req.subSectionId && (!sub || Number(sub.section_id) !== Number(req.sectionId))) {
    const err = new Error('That sub-section does not belong to the selected section.');
    err.status = 400;
    throw err;
  }

  const component = String(req.component || (Number(course.lab_hours) > 0 ? 'LAB' : 'LECTURE')).toUpperCase();
  const periods = Math.max(1, Number(req.periods)
    || (component === 'LAB' ? Math.max(1, Number(course.lab_block_periods) || 2) : 1));
  const strength = sub
    ? (Number(sub.student_count) || 0)
    : (Number(course.student_strength) || Number(section.student_count) || 0);

  const acRequirement = String(req.acRequirement || course.ac_requirement || 'NOT_REQUIRED').toUpperCase();
  const requiredRoomType = req.requiredRoomType !== undefined ? req.requiredRoomType : course.required_room_type;
  const requiredFacilities = req.requiredFacilities !== undefined
    ? req.requiredFacilities : course.required_facilities;

  const { ids: eligible } = eligibleFacultyForCourse(ctx, course);

  return {
    id: 'manual',
    courseId: course.id,
    course,
    sectionId: section.id,
    section,
    subSectionId: sub ? sub.id : null,
    subSection: sub,
    component,
    componentLabel: COMPONENT_LABEL[component] || 'Class',
    periods,
    strength,
    label: `${course.code} ${COMPONENT_LABEL[component] || 'Class'} `
      + `(${section.name}${sub ? ` / ${sub.name}` : ''})`,
    acRequirement,
    requiredRoomType,
    requiredFacilities,
    facultyCandidates: req.facultyId ? [Number(req.facultyId)] : eligible,
    facultyMode: req.facultyId ? 'FIXED' : 'AUTOMATIC',
    preferredFacultyIds: req.facultyId ? [Number(req.facultyId)] : [],
    roomCandidates: req.roomId
      ? [Number(req.roomId)]
      : suitableRoomIds(ctx, { strength, acRequirement, requiredRoomType, requiredFacilities }),
    roomMode: req.roomId ? 'FIXED' : 'AUTOMATIC',
    preferredRoomIds: req.roomId ? [Number(req.roomId)] : [],
    slotCandidates: [],
    timeMode: 'AUTOMATIC',
    preferredDays: (req.preferredDays || []).map(Number),
    windowStartMin: null,
    windowEndMin: null,
    groupKey: req.groupKey || null,
  };
}

function suitableRoomIds(ctx, need) {
  const ids = [];
  for (const room of ctx.roomList) {
    if (room.status !== 'ACTIVE') continue;
    const verdict = evaluateRoom(room, need, {
      tolerancePercent: ctx.rules.capacityTolerancePercent,
      allowOverflow: ctx.rules.allowCapacityOverflow,
    });
    if (verdict.ok) ids.push(room.id);
  }
  return ids;
}

/** Every legal (day, startIdx) position for a block of `periods` length. */
function allSlotPositions(ctx, periods) {
  const out = [];
  const starts = blockStarts(ctx.grid.slots, periods);
  for (const day of ctx.grid.workingDays) {
    for (const startIdx of starts) out.push({ day, startIdx });
  }
  return out;
}

/** True when a sibling sub-section already occupies this exact slot. */
function parallelWithSiblings(ctx, occ, base, cal, ignore) {
  if (!occ.subSectionId || !occ.sectionId) return false;
  const subs = (ctx.subSectionIdsBySection.get(occ.sectionId) || [])
    .filter((id) => id !== occ.subSectionId);
  if (!subs.length) return false;
  return base.periods.some((period) => cal
    .siblingsAt(base.day, period, occ.sectionId, subs)
    .some((p) => !(ignore && ignore.has(p.id))));
}

function evaluateAt(ctx, occ, target, cal, ignore) {
  const base = materialiseSlot(ctx, { day: target.day, startIdx: target.startIdx }, occ.periods);
  if (!base) {
    return {
      ok: false,
      violations: [{
        code: 'BLOCK_DOES_NOT_FIT',
        message: `A ${occ.periods}-period block does not fit starting at that position.`,
      }],
      warnings: [],
      score: 0,
      breakdown: [],
    };
  }
  const cand = {
    ...base,
    facultyId: target.facultyId != null ? Number(target.facultyId) : null,
    roomId: target.roomId != null ? Number(target.roomId) : null,
    parallelWithSiblings: parallelWithSiblings(ctx, occ, base, cal, ignore),
  };
  const check = checkPlacement(cand, occ, cal, ctx, ignore);
  const scored = check.ok
    ? scoreCandidate(cand, occ, cal, ctx, check.warnings)
    : { score: 0, breakdown: [] };
  return {
    ok: check.ok,
    violations: check.violations,
    warnings: check.warnings,
    score: scored.score,
    breakdown: scored.breakdown,
    slot: base,
    candidate: cand,
  };
}

/**
 * Find Best Slot / Find Alternatives.
 *
 * Holds whatever the caller pins (`keepFaculty`, `keepRoom`) and ranks the rest.
 * Returns feasible options best-first, plus the blocked positions with reasons so
 * the UI can grey out cells and explain why on hover.
 */
function findSlots(ctx, occ, opts = {}) {
  const cal = opts.calendar || ctx.calendar;
  const ignore = opts.ignore || null;
  const limit = opts.limit || 20;

  const facultyChoices = opts.facultyId != null
    ? [Number(opts.facultyId)]
    : occ.facultyCandidates;
  const roomChoices = opts.roomId != null
    ? [Number(opts.roomId)]
    : occ.roomCandidates;

  const options = [];
  const blocked = [];

  for (const pos of allSlotPositions(ctx, occ.periods)) {
    const base = materialiseSlot(ctx, pos, occ.periods);
    if (!base) continue;

    // Cheap group-level rejection first: no teacher or room can rescue a slot the
    // student group itself cannot use.
    const groupCheck = checkPlacement(
      { ...base, facultyId: null, roomId: null }, occ, cal, ctx, ignore
    );
    if (!groupCheck.ok) {
      blocked.push({
        day: pos.day, startIdx: pos.startIdx, slotIndex: base.periods[0],
        reasons: groupCheck.violations.map((v) => v.message),
      });
      continue;
    }

    let bestHere = null;
    const localReasons = [];
    for (const fid of facultyChoices) {
      for (const rid of roomChoices) {
        const res = evaluateAt(ctx, occ, { ...pos, facultyId: fid, roomId: rid }, cal, ignore);
        if (!res.ok) {
          localReasons.push(...res.violations.map((v) => v.message));
          continue;
        }
        if (!bestHere || res.score > bestHere.score) {
          bestHere = {
            day: pos.day,
            dayName: DAY_NAMES[pos.day],
            startIdx: pos.startIdx,
            slotIndex: base.periods[0],
            slotIndices: base.periods,
            periods: occ.periods,
            startTime: base.startTime,
            endTime: base.endTime,
            timeLabel: `${base.startTime} - ${base.endTime}`,
            facultyId: fid,
            facultyName: fid ? ctx.facultyName(fid) : null,
            roomId: rid,
            roomName: rid ? ctx.roomName(rid) : null,
            roomIsAc: rid ? !!ctx.roomById.get(rid).is_ac : null,
            acLabel: rid ? (ctx.roomById.get(rid).is_ac ? 'AC' : 'NON-AC') : null,
            score: res.score,
            breakdown: res.breakdown,
            warnings: res.warnings,
            parallelWithSiblings: !!res.candidate.parallelWithSiblings,
          };
        }
      }
    }

    if (bestHere) options.push(bestHere);
    else {
      blocked.push({
        day: pos.day, startIdx: pos.startIdx, slotIndex: base.periods[0],
        reasons: [...new Set(localReasons)].slice(0, 4),
      });
    }
  }

  options.sort((a, b) => b.score - a.score || a.day - b.day || a.startIdx - b.startIdx);
  return { options: options.slice(0, limit), blocked, totalFeasible: options.length };
}

/**
 * Change Teacher: every eligible teacher for this class in its current slot,
 * with the ones who cannot take it listed alongside the reason.
 */
function findFaculty(ctx, occ, target, opts = {}) {
  const cal = opts.calendar || ctx.calendar;
  const ignore = opts.ignore || null;
  const available = [];
  const unavailable = [];

  for (const fid of occ.facultyCandidates) {
    const res = evaluateAt(ctx, occ, { ...target, facultyId: fid }, cal, ignore);
    const fac = ctx.facultyById.get(fid) || {};
    const entry = {
      facultyId: fid,
      name: ctx.facultyName(fid),
      employeeId: fac.employee_id || null,
      designation: fac.designation || null,
      periodsThisWeek: cal.facultyPeriodsInWeek(fid),
      maxWeeklyHours: Number(fac.max_weekly_hours) || null,
      periodsThisDay: cal.facultyPeriodsOnDay(fid, target.day),
      isCurrent: opts.currentFacultyId != null && Number(opts.currentFacultyId) === fid,
      score: res.score,
      breakdown: res.breakdown,
      warnings: res.warnings,
    };
    if (res.ok) available.push(entry);
    else unavailable.push({ ...entry, reasons: res.violations.map((v) => v.message) });
  }

  available.sort((a, b) => b.score - a.score || a.periodsThisWeek - b.periodsThisWeek);
  return { available, unavailable };
}

/**
 * Change Room: the Section 2 room comparison card for every room, feasible ones
 * first, each with its full capacity arithmetic and an unmissable AC badge.
 */
function findRooms(ctx, occ, target, opts = {}) {
  const cal = opts.calendar || ctx.calendar;
  const ignore = opts.ignore || null;
  const need = {
    strength: occ.strength,
    acRequirement: occ.acRequirement,
    requiredRoomType: occ.requiredRoomType,
    requiredFacilities: occ.requiredFacilities,
  };
  const available = [];
  const unavailable = [];

  for (const room of ctx.roomList) {
    const verdict = evaluateRoom(room, need, {
      tolerancePercent: ctx.rules.capacityTolerancePercent,
      allowOverflow: ctx.rules.allowCapacityOverflow,
    });
    const res = evaluateAt(ctx, occ, { ...target, roomId: room.id }, cal, ignore);
    const card = {
      ...roomCard(room, {
        buildingName: room.building_id
          ? (ctx.buildingById.get(room.building_id) || {}).name || null
          : null,
        floorName: room.floor_id ? (ctx.floorById.get(room.floor_id) || {}).name || null : null,
      }),
      requiredStrength: occ.strength,
      capacityCheck: verdict.capacity,
      acCheck: verdict.ac,
      facilityCheck: verdict.facilities,
      isCurrent: opts.currentRoomId != null && Number(opts.currentRoomId) === room.id,
      score: res.score,
      breakdown: res.breakdown,
      warnings: [...(res.warnings || []), ...verdict.warnings.map((m) => ({ code: 'ROOM_SOFT', message: m }))],
    };
    if (res.ok) available.push(card);
    else unavailable.push({ ...card, reasons: res.violations.map((v) => v.message) });
  }

  available.sort((a, b) => b.score - a.score);
  unavailable.sort((a, b) => (a.capacity || 0) - (b.capacity || 0));
  return { available, unavailable, requirement: { ...need, requiredFacilities: parseFacilityList(need.requiredFacilities) } };
}

/**
 * Find Alternatives for an existing card: better slots (keeping the current
 * teacher and room where they still work), plus teacher-only and room-only swaps
 * that leave the time untouched.
 */
function findAlternativesForAssignment(ctx, row, opts = {}) {
  const occ = occurrenceForAssignment(ctx, row);
  const ignore = new Set([placementIdFor(row.id)]);
  const startIdx = ctx.grid.slots.findIndex((s) => s.index === Number(row.slot_index));
  const target = {
    day: Number(row.day_of_week),
    startIdx,
    facultyId: row.faculty_id,
    roomId: row.room_id,
  };

  const current = evaluateAt(ctx, occ, target, ctx.calendar, ignore);

  return {
    assignmentId: row.id,
    label: occ.label,
    current: {
      day: target.day,
      dayName: DAY_NAMES[target.day],
      slotIndex: Number(row.slot_index),
      periods: occ.periods,
      facultyId: row.faculty_id,
      facultyName: row.faculty_id ? ctx.facultyName(row.faculty_id) : null,
      roomId: row.room_id,
      roomName: row.room_id ? ctx.roomName(row.room_id) : null,
      valid: current.ok,
      score: current.score,
      breakdown: current.breakdown,
      violations: current.violations,
      warnings: current.warnings,
    },
    // Same teacher and room, different time.
    slotsKeepingBoth: findSlots(ctx, occ, {
      ignore, facultyId: row.faculty_id, roomId: row.room_id, limit: opts.limit || 10,
    }),
    // Free choice of teacher and room.
    slotsAnyResource: findSlots(ctx, occ, { ignore, limit: opts.limit || 10 }),
    faculty: findFaculty(ctx, occ, target, { ignore, currentFacultyId: row.faculty_id }),
    rooms: findRooms(ctx, occ, target, { ignore, currentRoomId: row.room_id }),
  };
}

module.exports = {
  placementIdFor,
  occurrenceForAssignment,
  occurrenceForRequest,
  suitableRoomIds,
  allSlotPositions,
  evaluateAt,
  findSlots,
  findFaculty,
  findRooms,
  findAlternativesForAssignment,
  parallelWithSiblings,
};
