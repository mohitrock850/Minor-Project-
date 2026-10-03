'use strict';

/**
 * Candidate scoring (Section 13.15).
 *
 * Hard constraints are handled in constraints.js -- anything that reaches here is
 * already feasible. This module only ranks feasible options so the engine can
 * prefer *good* timetables over merely *valid* ones, and so "Find Alternatives"
 * and "Change Room" can show a meaningful Score column.
 *
 * Scores are 0-100. Every adjustment is recorded in `breakdown` so the UI can
 * explain a ranking instead of showing an unexplained number.
 */

const { evaluateCapacity } = require('./roomFit');
const { toMinutes } = require('./timing');

function scoreCandidate(cand, occ, cal, ctx, softWarnings = []) {
  const { rules, grid } = ctx;
  const breakdown = [];
  let score = 100;

  const penalise = (points, label) => {
    if (!points) return;
    score -= points;
    breakdown.push({ label, delta: -points });
  };
  const reward = (points, label) => {
    if (!points) return;
    score += points;
    breakdown.push({ label, delta: points });
  };

  // --- Room fit ------------------------------------------------------------
  const room = cand.roomId ? ctx.roomById.get(cand.roomId) : null;
  if (room) {
    const cap = evaluateCapacity(room, occ.strength, {
      tolerancePercent: rules.capacityTolerancePercent,
      allowOverflow: rules.allowCapacityOverflow,
    });
    // Ideal utilisation band is 70-100%. Wasting seats and overflowing both cost.
    const util = cap.utilizationPercent;
    if (util > 100) {
      penalise(Math.min(25, Math.round((util - 100) * 1.5)), `Room over capacity (${util}% utilisation)`);
    } else if (util >= 70) {
      reward(6, `Well-fitting room (${util}% utilisation)`);
    } else if (util >= 45) {
      penalise(4, `Room larger than needed (${util}% utilisation)`);
    } else {
      penalise(Math.min(14, Math.round((70 - util) / 4)), `Room much larger than needed (${util}% utilisation)`);
    }

    // AC (Section 2). Required is a hard rule; Preferred is scored here.
    if (occ.acRequirement === 'PREFERRED') {
      if (room.is_ac) reward(6, 'AC room for an AC-preferred class');
      else penalise(8, 'NON-AC room for an AC-preferred class');
    }

    if (occ.requiredRoomType
      && String(room.room_type).toUpperCase() === String(occ.requiredRoomType).toUpperCase()) {
      reward(3, 'Exact room type match');
    }

    // Keep a section's day in one building where possible.
    if (room.building_id && occ.sectionId) {
      if (cal.sectionHasRoomOnDay(occ.sectionId, cand.day)) {
        const sameBuilding = cal.sectionClassesInBuildingOnDay(occ.sectionId, cand.day, room.building_id) > 0;
        if (sameBuilding) reward(3, 'Same building as the rest of the day');
        else penalise(3, 'Different building from the rest of the day');
      }
    }
  }

  // --- Faculty preferences -------------------------------------------------
  if (cand.facultyId) {
    const rows = ctx.facultyAvailability.get(cand.facultyId) || [];
    const preferred = rows.some((r) => (
      r.kind === 'PREFERRED'
      && Number(r.day_of_week) === Number(cand.day)
      && cand.startMin >= toMinutes(r.start_time)
      && cand.endMin <= toMinutes(r.end_time)
    ));
    if (preferred) reward(8, 'Inside the teacher\'s preferred hours');

    const fac = ctx.facultyById.get(cand.facultyId);
    const pref = Number(fac && fac.preferred_hours) || 0;
    if (pref > 0) {
      const after = cal.facultyPeriodsInWeek(cand.facultyId) + cand.periods.length;
      if (after > pref) penalise(Math.min(10, (after - pref) * 2), 'Beyond the teacher\'s preferred weekly load');
    }

    const run = cal.consecutiveRunFor(cand.facultyId, cand.day, cand.periods, grid.slots.length);
    if (run >= 3) penalise((run - 2) * 3, `${run} consecutive periods for the teacher`);

    // Prefer the explicitly selected faculty when the mode was PREFERRED.
    if (occ.facultyMode === 'PREFERRED' && occ.preferredFacultyIds
      && occ.preferredFacultyIds.includes(cand.facultyId)) {
      reward(10, 'Preferred teacher selected by the coordinator');
    }
  }

  // --- Room mode preference ------------------------------------------------
  if (occ.roomMode === 'PREFERRED' && occ.preferredRoomIds && occ.preferredRoomIds.includes(cand.roomId)) {
    reward(10, 'Preferred room selected by the coordinator');
  }

  // --- Time preferences ----------------------------------------------------
  const lastIndex = grid.slots[grid.slots.length - 1].index;
  if (rules.avoidLastPeriod && cand.periods.includes(lastIndex)) {
    penalise(6, 'Last period of the day');
  }
  if (occ.timeMode === 'PREFERRED') {
    if (occ.preferredDays && occ.preferredDays.length && occ.preferredDays.includes(Number(cand.day))) {
      reward(8, 'Inside the preferred day set');
    }
    if (occ.windowStartMin != null && occ.windowEndMin != null
      && cand.startMin >= occ.windowStartMin && cand.endMin <= occ.windowEndMin) {
      reward(8, 'Inside the preferred time window');
    }
  }

  // --- Distribution --------------------------------------------------------
  if (rules.spreadCourseAcrossDays && occ.courseId) {
    const same = cal.courseClassesOnDay(occ.courseId, occ.sectionId, cand.day);
    if (same > 0) penalise(10 * same, 'Another class of this course on the same day');
  }
  // Even daily load for the section.
  if (occ.sectionId) {
    const onDay = cal.sectionPeriodsOnDay(occ.sectionId, cand.day);
    if (onDay >= 5) penalise((onDay - 4) * 2, 'Section already has a heavy day');
  }
  // Gaps in a section's day are worse than a compact day.
  if (occ.sectionId && cand.periods.length) {
    const first = Math.min(...cand.periods);
    const prevBooked = first > 1 && (
      cal.sectionWholeAt(cand.day, first - 1, occ.sectionId)
      || (occ.subSectionId && cal.subSectionAt(cand.day, first - 1, occ.subSectionId))
    );
    if (prevBooked) reward(4, 'Keeps the section\'s day compact');
  }

  // --- Parallel sub-sections (Section 3) -----------------------------------
  if (cand.parallelWithSiblings) {
    reward(8, 'Sub-sections running in parallel in one slot');
  }

  softWarnings.forEach((w) => {
    if (w.code === 'ROOM_SOFT') penalise(4, w.message);
  });

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    breakdown,
  };
}

/**
 * Timetable-level quality score: the mean assignment score, reduced for anything
 * left unscheduled and for outstanding soft warnings.
 */
function timetableQuality({ assignments, unscheduledCount, warningCount }) {
  if (!assignments.length) return 0;
  const mean = assignments.reduce((sum, a) => sum + (Number(a.score) || 0), 0) / assignments.length;
  const total = assignments.length + unscheduledCount;
  const coverage = total ? assignments.length / total : 0;
  const warningPenalty = Math.min(15, (warningCount / Math.max(1, assignments.length)) * 15);
  return Math.max(0, Math.min(100, Math.round(mean * coverage - warningPenalty)));
}

module.exports = { scoreCandidate, timetableQuality };
