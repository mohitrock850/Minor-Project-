'use strict';

/**
 * The Manual Builder (Section 6).
 *
 * This is the same engine the wizard uses, driven one class at a time:
 *
 *   GET  /setup                    the pickers: courses, sections, what is left to place
 *   POST /occurrence               what a proposed class would look like (periods, strength, pools)
 *   POST /find-best-slot           ranked slots for a class that does not exist yet
 *   POST /faculty  POST /rooms     Change Teacher / Change Room lists for a proposed slot
 *   POST /check                    would this placement be legal? (dry run)
 *
 * Creating the class itself is POST /api/timetable/assignments, so there is
 * exactly one write path whether the class came from the builder, from Duplicate
 * or from the engine.
 */

const express = require('express');
const db = require('../db/connection');
const { httpError, requireCollege, requireCoordinator } = require('../auth/middleware');
const { buildContext } = require('../services/context');
const {
  occurrenceForRequest, findSlots, findFaculty, findRooms, evaluateAt, suitableRoomIds,
} = require('../services/alternatives');
const { componentPlan, COMPONENT_LABEL } = require('../services/occurrences');
const { DAY_NAMES, ENUMS } = require('../services/entityRegistry');
const { displayRows } = require('../services/timing');
const editing = require('../services/editing');

const router = express.Router();
router.use(requireCoordinator);

/**
 * Builds the engine context for a request.
 *
 * The timetable being built is deliberately *not* excluded from the calendar:
 * its own classes must block new ones, otherwise the builder would happily
 * double-book a teacher against a class it placed a moment ago.
 */
function contextFor(req) {
  const collegeId = requireCollege(req);
  return { collegeId, ctx: buildContext({ collegeId }) };
}

/** Turns the request body into an occurrence, with a clear error if it cannot. */
function occurrenceFrom(ctx, body) {
  if (body.courseId == null) throw httpError(400, 'Select a course first.', 'VALIDATION');
  if (body.sectionId == null) throw httpError(400, 'Select a section first.', 'VALIDATION');
  return occurrenceForRequest(ctx, {
    courseId: body.courseId,
    sectionId: body.sectionId,
    subSectionId: body.subSectionId != null && body.subSectionId !== '' ? body.subSectionId : null,
    component: body.component,
    periods: body.periods,
    facultyId: body.facultyId != null && body.facultyId !== '' ? body.facultyId : null,
    roomId: body.roomId != null && body.roomId !== '' ? body.roomId : null,
    acRequirement: body.acRequirement,
    requiredRoomType: body.requiredRoomType,
    requiredFacilities: body.requiredFacilities,
    preferredDays: body.preferredDays,
    groupKey: body.groupKey,
  });
}

// ---------------------------------------------------------------------------
// GET /setup -- what the builder's left-hand panel needs
// ---------------------------------------------------------------------------
router.get('/setup', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const timetableId = req.query.timetableId ? Number(req.query.timetableId) : null;
    if (timetableId) editing.getTimetable(collegeId, timetableId);
    const ctx = buildContext({ collegeId });

    const sections = db.all(
      `SELECT s.*, p.name AS program_name, sem.semester_number
         FROM sections s
         LEFT JOIN programs p ON p.id = s.program_id
         LEFT JOIN semesters sem ON sem.id = s.semester_id
        WHERE s.college_id = ? AND s.status = 'ACTIVE'
        ORDER BY p.name, sem.semester_number, s.name`,
      [collegeId]
    );

    /**
     * Section 6.2's "what is still missing": for each course and section, how
     * many periods the data says are needed versus how many are already placed.
     */
    const placed = timetableId
      ? db.all(
        `SELECT course_id, section_id, sub_section_id, component, SUM(periods) AS periods, COUNT(*) AS classes
           FROM assignments
          WHERE timetable_id = ? AND status = 'SCHEDULED'
          GROUP BY course_id, section_id, sub_section_id, component`,
        [timetableId]
      )
      : [];
    const placedKey = (r) => `${r.course_id}:${r.section_id}:${r.component}`;
    const placedMap = new Map();
    for (const row of placed) {
      const key = placedKey(row);
      const prev = placedMap.get(key) || { periods: 0, classes: 0 };
      placedMap.set(key, { periods: prev.periods + row.periods, classes: prev.classes + row.classes });
    }

    const outstanding = [];
    for (const course of ctx.courseList) {
      if (course.status !== 'ACTIVE') continue;
      const targets = course.section_id
        ? [course.section_id]
        : sections.filter((s) => s.semester_id === course.semester_id).map((s) => s.id);
      const plan = componentPlan(course);
      const byComponent = new Map();
      for (const step of plan) {
        const prev = byComponent.get(step.component) || 0;
        byComponent.set(step.component, prev + step.periods);
      }
      for (const sectionId of targets) {
        const section = ctx.sectionById.get(sectionId);
        if (!section) continue;
        for (const [component, needed] of byComponent.entries()) {
          const done = placedMap.get(`${course.id}:${sectionId}:${component}`) || { periods: 0 };
          outstanding.push({
            courseId: course.id,
            code: course.code,
            name: course.name,
            sectionId,
            sectionName: section.name,
            component,
            componentLabel: COMPONENT_LABEL[component] || component,
            periodsNeeded: needed,
            periodsPlaced: done.periods,
            remaining: Math.max(0, needed - done.periods),
            acRequirement: course.ac_requirement,
            splitsIntoSubSections: String(course.split_mode) === 'SPLIT_SUB_SECTIONS',
            labBlockPeriods: course.lab_block_periods,
          });
        }
      }
    }

    res.json({
      timetableId,
      timetables: db.all(
        `SELECT id, name, mode, status FROM timetables WHERE college_id = ? AND status <> 'ARCHIVED'
          ORDER BY updated_at DESC`,
        [collegeId]
      ),
      grid: {
        workingDays: ctx.grid.workingDays,
        dayNames: ctx.grid.workingDays.map((d) => DAY_NAMES[d]),
        slots: ctx.grid.slots,
        rows: displayRows(ctx.grid),
        slotMinutes: ctx.grid.slotMinutes,
      },
      courses: ctx.courseList
        .filter((c) => c.status === 'ACTIVE')
        .map((c) => ({
          id: c.id, code: c.code, name: c.name, semester_id: c.semester_id,
          section_id: c.section_id, ac_requirement: c.ac_requirement,
          required_room_type: c.required_room_type, lab_block_periods: c.lab_block_periods,
          split_mode: c.split_mode,
          components: [...new Set(componentPlan(c).map((p) => p.component))],
        })),
      sections,
      subSections: ctx.subSectionList.filter((s) => s.status === 'ACTIVE'),
      components: ENUMS.COMPONENT,
      outstanding: outstanding.filter((o) => o.remaining > 0),
      complete: outstanding.filter((o) => o.remaining === 0).length,
      summary: (() => {
        const remaining = outstanding.reduce((n, o) => n + o.remaining, 0);
        return remaining
          ? `${remaining} period(s) still to place.`
          : 'Every course period the data calls for has been placed.';
      })(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /occurrence -- resolve a proposed class before any slot is chosen
// ---------------------------------------------------------------------------
router.post('/occurrence', (req, res, next) => {
  try {
    const body = req.body || {};
    const { ctx } = contextFor(req);
    const occ = occurrenceFrom(ctx, body);
    res.json({
      label: occ.label,
      courseId: occ.courseId,
      sectionId: occ.sectionId,
      subSectionId: occ.subSectionId,
      component: occ.component,
      componentLabel: occ.componentLabel,
      periods: occ.periods,
      strength: occ.strength,
      acRequirement: occ.acRequirement,
      requiredRoomType: occ.requiredRoomType || null,
      requiredFacilities: occ.requiredFacilities || null,
      eligibleFaculty: occ.facultyCandidates.map((id) => ({ id, name: ctx.facultyName(id) })),
      suitableRooms: suitableRoomIds(ctx, {
        strength: occ.strength,
        acRequirement: occ.acRequirement,
        requiredRoomType: occ.requiredRoomType,
        requiredFacilities: occ.requiredFacilities,
      }).map((id) => {
        const room = ctx.roomById.get(id);
        return {
          id,
          name: room.name,
          isAc: !!room.is_ac,
          acLabel: room.is_ac ? 'AC' : 'Non-AC',
          capacity: room.max_capacity || room.seating_capacity || null,
          roomType: room.room_type,
        };
      }),
      note: occ.facultyCandidates.length
        ? null
        : 'No teacher is eligible for this course yet. Assign one under People > Faculty-Course, '
          + 'or the class cannot be placed.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /find-best-slot -- Section 6.3
// ---------------------------------------------------------------------------
router.post('/find-best-slot', (req, res, next) => {
  try {
    const body = req.body || {};
    const { ctx } = contextFor(req);
    const occ = occurrenceFrom(ctx, body);
    const result = findSlots(ctx, occ, {
      limit: body.limit != null ? Number(body.limit) : 12,
      facultyId: body.facultyId != null && body.facultyId !== '' ? Number(body.facultyId) : undefined,
      roomId: body.roomId != null && body.roomId !== '' ? Number(body.roomId) : undefined,
    });

    // Explaining an empty result matters more than the result itself: the reasons
    // are what tell the coordinator which constraint to relax.
    const reasonTally = new Map();
    for (const b of result.blocked) {
      for (const reason of b.reasons) reasonTally.set(reason, (reasonTally.get(reason) || 0) + 1);
    }

    res.json({
      label: occ.label,
      periods: occ.periods,
      strength: occ.strength,
      acRequirement: occ.acRequirement,
      best: result.options[0] || null,
      options: result.options,
      totalFeasible: result.totalFeasible,
      blockedSlots: result.blocked.length,
      whyNot: [...reasonTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, slots: count })),
      verdict: result.options.length
        ? `${result.totalFeasible} slot(s) work. The best one is `
          + `${result.options[0].dayName} ${result.options[0].timeLabel}.`
        : 'No slot in the week can take this class as specified. The reasons below say why -- '
          + 'freeing a teacher, adding a suitable room or widening the day will usually fix it.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /faculty and POST /rooms -- the pickers for a chosen slot
// ---------------------------------------------------------------------------
function targetFrom(ctx, body, occ) {
  if (body.day == null || body.slotIndex == null) {
    throw httpError(400, 'Choose a day and a period first.', 'VALIDATION');
  }
  const day = Number(body.day);
  const startIdx = ctx.grid.slots.findIndex((s) => s.index === Number(body.slotIndex));
  if (!ctx.grid.workingDays.includes(day)) {
    throw httpError(400, `${DAY_NAMES[day] || `Day ${day}`} is not a working day at this college.`, 'VALIDATION');
  }
  if (startIdx < 0) throw httpError(400, 'That period does not exist in this college\'s day.', 'VALIDATION');
  if (startIdx + occ.periods > ctx.grid.slots.length) {
    throw httpError(400,
      `This class needs ${occ.periods} consecutive periods and the day ends before that.`, 'VALIDATION');
  }
  return {
    day,
    startIdx,
    facultyId: body.facultyId != null && body.facultyId !== '' ? Number(body.facultyId) : null,
    roomId: body.roomId != null && body.roomId !== '' ? Number(body.roomId) : null,
  };
}

router.post('/faculty', (req, res, next) => {
  try {
    const body = req.body || {};
    const { ctx } = contextFor(req);
    const occ = occurrenceFrom(ctx, { ...body, facultyId: null });
    const target = targetFrom(ctx, body, occ);
    res.json({ label: occ.label, ...findFaculty(ctx, occ, target, { currentFacultyId: body.facultyId }) });
  } catch (err) {
    next(err);
  }
});

router.post('/rooms', (req, res, next) => {
  try {
    const body = req.body || {};
    const { ctx } = contextFor(req);
    const occ = occurrenceFrom(ctx, { ...body, roomId: null });
    const target = targetFrom(ctx, body, occ);
    res.json({ label: occ.label, ...findRooms(ctx, occ, target, { currentRoomId: body.roomId }) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /check -- dry run for a class that does not exist yet
// ---------------------------------------------------------------------------
router.post('/check', (req, res, next) => {
  try {
    const body = req.body || {};
    const { ctx } = contextFor(req);
    const occ = occurrenceFrom(ctx, body);
    const target = targetFrom(ctx, body, occ);
    const result = evaluateAt(ctx, occ, target, ctx.calendar, null);
    const slot = ctx.grid.slots[target.startIdx];
    const endSlot = ctx.grid.slots[target.startIdx + occ.periods - 1];
    res.json({
      label: occ.label,
      slot: {
        day: target.day,
        dayName: DAY_NAMES[target.day],
        slotIndex: slot.index,
        periods: occ.periods,
        startTime: slot.start,
        endTime: endSlot.end,
        timeLabel: `${slot.start} - ${endSlot.end}`,
      },
      ok: result.ok,
      score: result.score,
      breakdown: result.breakdown,
      violations: result.violations,
      warnings: result.warnings,
      parallelWithSiblings: !!(result.candidate && result.candidate.parallelWithSiblings),
      canOverride: !result.ok,
      overrideHint: result.ok
        ? null
        : 'You can place it anyway by sending the same request with "force" -- the conflict will be '
          + 'recorded on the class and in the activity log.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
