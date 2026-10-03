'use strict';

/**
 * Constraint engine (Section 13).
 *
 * `Occupancy` is the mutable resource calendar the solver pushes and pops
 * placements against. Every hard rule in Section 13 is implemented as a check
 * that returns `{ok:false, code, message}` so the UI can always tell the user
 * *why* something is invalid rather than just refusing.
 *
 * The sub-section parallel rule (Section 3 / rule 14) is the subtle one:
 *   - a WHOLE-section class blocks the section AND all of its sub-sections
 *   - a SUB-SECTION class blocks that sub-section and the parent section's
 *     whole-section classes, but NOT its sibling sub-sections
 *   - siblings sharing a slot are legal only with a different teacher AND a
 *     different room, which the faculty/room checks already guarantee -- we
 *     detect that case explicitly so the error message names the real problem.
 */

const { toMinutes, overlaps } = require('./timing');
const { evaluateRoom } = require('./roomFit');

const slotKey = (day, period) => `${day}#${period}`;

class ResourceCalendar {
  constructor() {
    /** @type {Map<string, Map<number, object>>} */
    this.facultySlots = new Map();
    /** @type {Map<string, Map<number, object>>} */
    this.roomSlots = new Map();
    /** slotKey -> Map<sectionId, placement> for whole-section classes */
    this.sectionWholeSlots = new Map();
    /** slotKey -> Map<subSectionId, placement> */
    this.subSectionSlots = new Map();

    this.facultyDayCount = new Map();   // `${facultyId}#${day}` -> periods
    this.facultyWeekCount = new Map();  // facultyId -> periods
    /**
     * `${sectionId}#${day}` -> Map<period, placements in that period>.
     *
     * A section's daily load is how many periods its students actually sit in,
     * which is not the same as the number of class-periods booked: when B1 and B2
     * run in parallel for two periods, the section is occupied for two periods,
     * not four. Counting distinct periods is the only measure that matches what a
     * student experiences, so the map is keyed by period rather than summed.
     */
    this.sectionDaySlots = new Map();
    this.courseDayCount = new Map();    // `${courseId}#${sectionId}#${day}` -> classes
    // `${sectionId}#${day}` -> `${buildingId}` -> count. Kept incrementally so the
    // "same building as the rest of the day" score is O(1) instead of a scan.
    this.sectionDayBuildings = new Map();
    this.placements = new Map();        // placementId -> placement
  }

  // -- internal helpers ----------------------------------------------------
  static _bump(map, key, delta) {
    const next = (map.get(key) || 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  static _put(map, key, id, value) {
    let inner = map.get(key);
    if (!inner) {
      inner = new Map();
      map.set(key, inner);
    }
    inner.set(id, value);
  }

  static _drop(map, key, id) {
    const inner = map.get(key);
    if (!inner) return;
    inner.delete(id);
    if (!inner.size) map.delete(key);
  }

  static _peek(map, key, id) {
    const inner = map.get(key);
    return inner ? inner.get(id) || null : null;
  }

  /** Marks/unmarks one period of a section's day, keeping a reference count. */
  static _markSectionPeriod(map, key, period, delta) {
    let inner = map.get(key);
    if (!inner) {
      if (delta < 0) return;
      inner = new Map();
      map.set(key, inner);
    }
    const next = (inner.get(period) || 0) + delta;
    if (next <= 0) inner.delete(period);
    else inner.set(period, next);
    if (!inner.size) map.delete(key);
  }

  /**
   * @param {object} p placement:
   *   {id, day, periods:number[], facultyId, roomId, sectionId, subSectionId,
   *    courseId, component, isLocked, external}
   */
  add(p) {
    this.placements.set(p.id, p);
    for (const period of p.periods) {
      const k = slotKey(p.day, period);
      if (p.facultyId) ResourceCalendar._put(this.facultySlots, k, p.facultyId, p);
      if (p.roomId) ResourceCalendar._put(this.roomSlots, k, p.roomId, p);
      if (p.subSectionId) ResourceCalendar._put(this.subSectionSlots, k, p.subSectionId, p);
      else if (p.sectionId) ResourceCalendar._put(this.sectionWholeSlots, k, p.sectionId, p);
    }
    const n = p.periods.length;
    if (p.facultyId) {
      ResourceCalendar._bump(this.facultyDayCount, `${p.facultyId}#${p.day}`, n);
      ResourceCalendar._bump(this.facultyWeekCount, String(p.facultyId), n);
    }
    if (p.sectionId) {
      for (const period of p.periods) {
        ResourceCalendar._markSectionPeriod(this.sectionDaySlots, `${p.sectionId}#${p.day}`, period, 1);
      }
    }
    if (p.courseId) {
      ResourceCalendar._bump(this.courseDayCount, `${p.courseId}#${p.sectionId}#${p.day}`, 1);
    }
    if (p.sectionId && p.buildingId) {
      ResourceCalendar._bump(this.sectionDayBuildings, `${p.sectionId}#${p.day}#${p.buildingId}`, 1);
    }
  }

  remove(placementId) {
    const p = this.placements.get(placementId);
    if (!p) return;
    this.placements.delete(placementId);
    for (const period of p.periods) {
      const k = slotKey(p.day, period);
      if (p.facultyId) ResourceCalendar._drop(this.facultySlots, k, p.facultyId);
      if (p.roomId) ResourceCalendar._drop(this.roomSlots, k, p.roomId);
      if (p.subSectionId) ResourceCalendar._drop(this.subSectionSlots, k, p.subSectionId);
      else if (p.sectionId) ResourceCalendar._drop(this.sectionWholeSlots, k, p.sectionId);
    }
    const n = p.periods.length;
    if (p.facultyId) {
      ResourceCalendar._bump(this.facultyDayCount, `${p.facultyId}#${p.day}`, -n);
      ResourceCalendar._bump(this.facultyWeekCount, String(p.facultyId), -n);
    }
    if (p.sectionId) {
      for (const period of p.periods) {
        ResourceCalendar._markSectionPeriod(this.sectionDaySlots, `${p.sectionId}#${p.day}`, period, -1);
      }
    }
    if (p.courseId) {
      ResourceCalendar._bump(this.courseDayCount, `${p.courseId}#${p.sectionId}#${p.day}`, -1);
    }
    if (p.sectionId && p.buildingId) {
      ResourceCalendar._bump(this.sectionDayBuildings, `${p.sectionId}#${p.day}#${p.buildingId}`, -1);
    }
  }

  facultyAt(day, period, facultyId) {
    return ResourceCalendar._peek(this.facultySlots, slotKey(day, period), facultyId);
  }
  roomAt(day, period, roomId) {
    return ResourceCalendar._peek(this.roomSlots, slotKey(day, period), roomId);
  }
  sectionWholeAt(day, period, sectionId) {
    return ResourceCalendar._peek(this.sectionWholeSlots, slotKey(day, period), sectionId);
  }
  subSectionAt(day, period, subSectionId) {
    return ResourceCalendar._peek(this.subSectionSlots, slotKey(day, period), subSectionId);
  }
  /** All sub-section placements of `sectionId` sitting in this slot. */
  siblingsAt(day, period, sectionId, subSectionIdsOfSection) {
    const inner = this.subSectionSlots.get(slotKey(day, period));
    if (!inner) return [];
    const out = [];
    for (const ssId of subSectionIdsOfSection) {
      const hit = inner.get(ssId);
      if (hit) out.push(hit);
    }
    return out;
  }

  facultyPeriodsOnDay(facultyId, day) {
    return this.facultyDayCount.get(`${facultyId}#${day}`) || 0;
  }
  facultyPeriodsInWeek(facultyId) {
    return this.facultyWeekCount.get(String(facultyId)) || 0;
  }
  /** Distinct periods this section's students are occupied for on `day`. */
  sectionPeriodsOnDay(sectionId, day) {
    const inner = this.sectionDaySlots.get(`${sectionId}#${day}`);
    return inner ? inner.size : 0;
  }

  /**
   * What the section's day would total if `periods` were added to it. Periods it
   * already occupies do not count twice, which is what makes a parallel
   * sub-section class free as far as the section's daily load is concerned.
   */
  sectionPeriodsOnDayWith(sectionId, day, periods) {
    const inner = this.sectionDaySlots.get(`${sectionId}#${day}`);
    if (!inner) return periods.length;
    let extra = 0;
    for (const period of periods) if (!inner.has(period)) extra += 1;
    return inner.size + extra;
  }
  courseClassesOnDay(courseId, sectionId, day) {
    return this.courseDayCount.get(`${courseId}#${sectionId}#${day}`) || 0;
  }
  /** How many of a section's classes that day already sit in `buildingId`. */
  sectionClassesInBuildingOnDay(sectionId, day, buildingId) {
    return this.sectionDayBuildings.get(`${sectionId}#${day}#${buildingId}`) || 0;
  }
  /** True when the section already has any room booked that day. */
  sectionHasRoomOnDay(sectionId, day) {
    const prefix = `${sectionId}#${day}#`;
    for (const key of this.sectionDayBuildings.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Longest run of consecutive booked periods a teacher would have. */
  consecutiveRunFor(facultyId, day, periods, slotCount) {
    const booked = new Set(periods);
    for (let i = 1; i <= slotCount; i += 1) {
      if (this.facultyAt(day, i, facultyId)) booked.add(i);
    }
    let best = 0;
    let run = 0;
    for (let i = 1; i <= slotCount; i += 1) {
      if (booked.has(i)) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    return best;
  }

  clone() {
    const c = new ResourceCalendar();
    for (const p of this.placements.values()) c.add(p);
    return c;
  }
}

// ---------------------------------------------------------------------------
// Availability windows
// ---------------------------------------------------------------------------

/**
 * Availability semantics (documented in DECISIONS.md):
 *   UNAVAILABLE -> hard block, always.
 *   AVAILABLE   -> an explicit whitelist. If a resource has ANY availability
 *                  rows of kind AVAILABLE, a slot must fall inside one of them.
 *   PREFERRED   -> soft bonus only, never a block.
 */
function checkAvailabilityWindows(rows, day, startMin, endMin, label) {
  if (!rows || !rows.length) return { ok: true, preferred: false };

  for (const r of rows) {
    if (r.kind !== 'UNAVAILABLE') continue;
    if (Number(r.day_of_week) !== Number(day)) continue;
    if (overlaps(startMin, endMin, toMinutes(r.start_time), toMinutes(r.end_time))) {
      return {
        ok: false,
        code: 'UNAVAILABLE_WINDOW',
        message: `${label} is marked unavailable ${r.start_time}-${r.end_time}${r.note ? ` (${r.note})` : ''}.`,
      };
    }
  }

  const whitelist = rows.filter((r) => r.kind === 'AVAILABLE');
  if (whitelist.length) {
    const inside = whitelist.some((r) => (
      Number(r.day_of_week) === Number(day)
      && toMinutes(r.start_time) <= startMin
      && toMinutes(r.end_time) >= endMin
    ));
    if (!inside) {
      return {
        ok: false,
        code: 'OUTSIDE_AVAILABILITY',
        message: `${label} has no declared availability covering this time.`,
      };
    }
  }

  const preferred = rows.some((r) => (
    r.kind === 'PREFERRED'
    && Number(r.day_of_week) === Number(day)
    && overlaps(startMin, endMin, toMinutes(r.start_time), toMinutes(r.end_time))
  ));

  return { ok: true, preferred };
}

// ---------------------------------------------------------------------------
// Hard checks
// ---------------------------------------------------------------------------

/**
 * Validates one candidate placement against the calendar and the college rules.
 *
 * @param {object} cand   {day, startIdx, periods:number[], startMin, endMin, facultyId, roomId}
 * @param {object} occ    the occurrence being placed
 * @param {ResourceCalendar} cal
 * @param {object} ctx    scheduling context (grid, rules, lookups, availability)
 * @param {Set<number>} ignorePlacements placement ids to treat as absent (used when moving)
 * @returns {{ok:boolean, violations:Array, warnings:Array}}
 */
function checkPlacement(cand, occ, cal, ctx, ignorePlacements = null) {
  const violations = [];
  const warnings = [];
  const { rules, grid } = ctx;
  const ignore = (p) => !!(p && ignorePlacements && ignorePlacements.has(p.id));

  // --- Rule 9/10: working day, working hours, breaks -----------------------
  if (!grid.workingDays.includes(Number(cand.day))) {
    violations.push({
      code: 'NON_WORKING_DAY',
      message: `${ctx.dayName(cand.day)} is not a working day for ${ctx.college.name}.`,
    });
  }
  for (const period of cand.periods) {
    if (!grid.slots.some((s) => s.index === period)) {
      violations.push({
        code: 'OUTSIDE_WORKING_HOURS',
        message: `Period ${period} is outside ${ctx.college.name}'s configured working hours.`,
      });
    }
  }
  // A multi-period block must not straddle a break window.
  for (const br of grid.breaks) {
    if (overlaps(cand.startMin, cand.endMin, br.start, br.end)) {
      violations.push({
        code: 'BREAK_WINDOW',
        message: `This class would run through ${ctx.college.name}'s ${br.name} (${minToHHMM(br.start)}-${minToHHMM(br.end)}).`,
      });
      break;
    }
  }
  if (rules.disallowedSlots.size) {
    for (const period of cand.periods) {
      if (rules.disallowedSlots.has(`${cand.day}:${period}`)) {
        violations.push({
          code: 'DISALLOWED_SLOT',
          message: `${ctx.dayName(cand.day)} period ${period} is disallowed by this college's scheduling rules.`,
        });
        break;
      }
    }
  }

  // --- Rule 11: teacher conflicts ----------------------------------------
  if (cand.facultyId) {
    for (const period of cand.periods) {
      const clash = cal.facultyAt(cand.day, period, cand.facultyId);
      if (clash && !ignore(clash)) {
        const sameParent = occ.sectionId && clash.sectionId === occ.sectionId
          && occ.subSectionId && clash.subSectionId && clash.subSectionId !== occ.subSectionId;
        violations.push({
          code: sameParent ? 'SUBSECTION_SAME_TEACHER' : 'FACULTY_CONFLICT',
          message: sameParent
            ? `${ctx.facultyName(cand.facultyId)} cannot teach ${ctx.groupLabel(clash)} and `
              + `${ctx.groupLabel(occ)} in the same slot -- parallel sub-sections need different teachers.`
            : `${ctx.facultyName(cand.facultyId)} is already teaching `
              + `${ctx.courseName(clash.courseId)} (${ctx.groupLabel(clash)}) at this time.`,
        });
        break;
      }
    }
    const avail = checkAvailabilityWindows(
      ctx.facultyAvailability.get(cand.facultyId), cand.day,
      cand.startMin, cand.endMin, ctx.facultyName(cand.facultyId)
    );
    if (!avail.ok) violations.push({ code: avail.code, message: avail.message });

    // Rule 1.10: weekly / daily load caps
    if (rules.respectFacultyMaxHours) {
      const fac = ctx.facultyById.get(cand.facultyId);
      const max = Number(fac && fac.max_weekly_hours) || 0;
      if (max > 0) {
        const already = cal.facultyPeriodsInWeek(cand.facultyId);
        if (already + cand.periods.length > max) {
          violations.push({
            code: 'FACULTY_MAX_HOURS',
            message: `${ctx.facultyName(cand.facultyId)} would exceed their maximum of ${max} periods/week `
              + `(already ${already}).`,
          });
        }
      }
    }
    if (rules.maxTeacherPeriodsPerDay > 0) {
      const onDay = cal.facultyPeriodsOnDay(cand.facultyId, cand.day);
      if (onDay + cand.periods.length > rules.maxTeacherPeriodsPerDay) {
        violations.push({
          code: 'FACULTY_DAY_LOAD',
          message: `${ctx.facultyName(cand.facultyId)} would exceed ${rules.maxTeacherPeriodsPerDay} `
            + `periods on ${ctx.dayName(cand.day)}.`,
        });
      }
    }
    if (rules.maxConsecutiveTeacherPeriods > 0) {
      const run = cal.consecutiveRunFor(cand.facultyId, cand.day, cand.periods, grid.slots.length);
      if (run > rules.maxConsecutiveTeacherPeriods) {
        violations.push({
          code: 'FACULTY_CONSECUTIVE',
          message: `${ctx.facultyName(cand.facultyId)} would teach ${run} periods back-to-back `
            + `(limit ${rules.maxConsecutiveTeacherPeriods}).`,
        });
      }
    }
  }

  // --- Rules 4, 12, 14: student group conflicts ---------------------------
  if (occ.subSectionId) {
    for (const period of cand.periods) {
      const own = cal.subSectionAt(cand.day, period, occ.subSectionId);
      if (own && !ignore(own)) {
        violations.push({
          code: 'SUBSECTION_CONFLICT',
          message: `${ctx.groupLabel(occ)} already has ${ctx.courseName(own.courseId)} at this time.`,
        });
        break;
      }
      const parentWhole = cal.sectionWholeAt(cand.day, period, occ.sectionId);
      if (parentWhole && !ignore(parentWhole)) {
        violations.push({
          code: 'PARENT_SECTION_BUSY',
          message: `${ctx.sectionName(occ.sectionId)} has a whole-section class `
            + `(${ctx.courseName(parentWhole.courseId)}) at this time, so ${ctx.groupLabel(occ)} cannot run.`,
        });
        break;
      }
    }
  } else if (occ.sectionId) {
    for (const period of cand.periods) {
      const own = cal.sectionWholeAt(cand.day, period, occ.sectionId);
      if (own && !ignore(own)) {
        violations.push({
          code: 'SECTION_CONFLICT',
          message: `${ctx.sectionName(occ.sectionId)} already has ${ctx.courseName(own.courseId)} at this time.`,
        });
        break;
      }
      const subs = ctx.subSectionIdsBySection.get(occ.sectionId) || [];
      const busySiblings = cal.siblingsAt(cand.day, period, occ.sectionId, subs).filter((p) => !ignore(p));
      if (busySiblings.length) {
        violations.push({
          code: 'SUBSECTION_BUSY',
          message: `${busySiblings.map((p) => ctx.groupLabel(p)).join(', ')} `
            + `${busySiblings.length > 1 ? 'are' : 'is'} already scheduled at this time, so a whole-section `
            + `class for ${ctx.sectionName(occ.sectionId)} cannot run.`,
        });
        break;
      }
    }
  }

  if (rules.maxSectionPeriodsPerDay > 0 && occ.sectionId) {
    // The union, not the sum: a sub-section class running alongside its sibling
    // adds nothing to the section's day, because the same students are already
    // in class during those periods.
    const total = cal.sectionPeriodsOnDayWith(occ.sectionId, cand.day, cand.periods);
    if (total > rules.maxSectionPeriodsPerDay) {
      violations.push({
        code: 'SECTION_DAY_LOAD',
        message: `${ctx.sectionName(occ.sectionId)} would be in class for ${total} periods on `
          + `${ctx.dayName(cand.day)}, and the limit is ${rules.maxSectionPeriodsPerDay}.`,
      });
    }
  }

  // --- Rule 13: room conflicts, plus 5/6/7/8 room suitability ------------
  if (cand.roomId) {
    for (const period of cand.periods) {
      const clash = cal.roomAt(cand.day, period, cand.roomId);
      if (clash && !ignore(clash)) {
        const sameParent = occ.subSectionId && clash.subSectionId
          && clash.sectionId === occ.sectionId && clash.subSectionId !== occ.subSectionId;
        violations.push({
          code: sameParent ? 'SUBSECTION_SAME_ROOM' : 'ROOM_CONFLICT',
          message: sameParent
            ? `${ctx.roomName(cand.roomId)} cannot host ${ctx.groupLabel(clash)} and ${ctx.groupLabel(occ)} `
              + 'in the same slot -- parallel sub-sections need different rooms.'
            : `${ctx.roomName(cand.roomId)} is already booked for `
              + `${ctx.courseName(clash.courseId)} (${ctx.groupLabel(clash)}) at this time.`,
        });
        break;
      }
    }

    const room = ctx.roomById.get(cand.roomId);
    if (!room) {
      violations.push({ code: 'ROOM_MISSING', message: 'The selected room no longer exists.' });
    } else {
      // Room suitability depends only on (room, occurrence), never on the slot,
      // so it is memoised per request -- this is the solver's hottest path.
      const verdict = ctx.roomVerdictFor
        ? ctx.roomVerdictFor(occ, room)
        : evaluateRoom(room, {
          strength: occ.strength,
          acRequirement: occ.acRequirement,
          requiredFacilities: occ.requiredFacilities,
          requiredRoomType: occ.requiredRoomType,
        }, { tolerancePercent: rules.capacityTolerancePercent, allowOverflow: rules.allowCapacityOverflow });

      verdict.reasons.forEach((message) => violations.push({ code: 'ROOM_UNSUITABLE', message }));
      verdict.warnings.forEach((message) => warnings.push({ code: 'ROOM_SOFT', message }));

      const ra = checkAvailabilityWindows(
        ctx.roomAvailability.get(cand.roomId), cand.day,
        cand.startMin, cand.endMin, room.name
      );
      if (!ra.ok) violations.push({ code: ra.code, message: ra.message });
      if (room.status && room.status !== 'ACTIVE') {
        violations.push({ code: 'ROOM_INACTIVE', message: `${room.name} is marked ${room.status}.` });
      }
    }
  }

  // --- Soft preferences ---------------------------------------------------
  if (rules.minGapSectionMinutes > 0 && occ.sectionId) {
    const before = grid.slots.find((s) => s.endMin <= cand.startMin
      && cand.startMin - s.endMin < rules.minGapSectionMinutes
      && (cal.sectionWholeAt(cand.day, s.index, occ.sectionId)
        || (occ.subSectionId && cal.subSectionAt(cand.day, s.index, occ.subSectionId))));
    if (before) {
      warnings.push({
        code: 'MIN_GAP',
        message: `Less than the configured ${rules.minGapSectionMinutes} minute gap after the previous class.`,
      });
    }
  }
  if (rules.avoidLastPeriod && cand.periods.includes(grid.slots[grid.slots.length - 1].index)) {
    warnings.push({ code: 'LAST_PERIOD', message: 'Scheduled in the last period of the day.' });
  }
  if (rules.spreadCourseAcrossDays && occ.courseId) {
    const same = cal.courseClassesOnDay(occ.courseId, occ.sectionId, cand.day);
    if (same > 0) {
      warnings.push({
        code: 'SAME_DAY_REPEAT',
        message: `${ctx.courseName(occ.courseId)} already has a class for this section on ${ctx.dayName(cand.day)}.`,
      });
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

function minToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Explicit implementation of rule 14 used when a whole parallel group is placed
 * at once: siblings must differ in BOTH teacher and room.
 */
function checkParallelGroup(members) {
  const violations = [];
  const seenFaculty = new Map();
  const seenRoom = new Map();
  for (const m of members) {
    if (m.facultyId != null) {
      if (seenFaculty.has(m.facultyId)) {
        violations.push({
          code: 'SUBSECTION_SAME_TEACHER',
          message: `${m.label} and ${seenFaculty.get(m.facultyId)} are parallel sub-sections of the same `
            + 'section and cannot share the same teacher.',
        });
      } else {
        seenFaculty.set(m.facultyId, m.label);
      }
    }
    if (m.roomId != null) {
      if (seenRoom.has(m.roomId)) {
        violations.push({
          code: 'SUBSECTION_SAME_ROOM',
          message: `${m.label} and ${seenRoom.get(m.roomId)} are parallel sub-sections of the same `
            + 'section and cannot share the same room.',
        });
      } else {
        seenRoom.set(m.roomId, m.label);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

module.exports = {
  ResourceCalendar,
  Occupancy: ResourceCalendar,
  slotKey,
  checkAvailabilityWindows,
  checkPlacement,
  checkParallelGroup,
};
