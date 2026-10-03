'use strict';

/**
 * Occurrence expansion.
 *
 * A course does not map to one class -- it maps to N weekly classes, one per
 * lecture/tutorial/lab hour, and a lab may additionally fan out into one class
 * per sub-section (Section 3). This module turns a generation request into the
 * flat list of "occurrences" the solver actually places.
 *
 * Key design point from Section 3: splitting is decided *per course occurrence*,
 * not permanently on the Section. A course can therefore have a whole-section
 * Lecture and split B1/B2 Labs at the same time.
 */

const { blockStarts, toMinutes } = require('./timing');
const { evaluateRoom, parseFacilityList } = require('./roomFit');

const COMPONENT_LABEL = {
  LECTURE: 'Lecture',
  TUTORIAL: 'Tutorial',
  LAB: 'Lab',
  PRACTICAL: 'Practical',
  SEMINAR: 'Seminar',
  WORKSHOP: 'Workshop',
  PROJECT: 'Project',
  OTHER: 'Class',
};

/** Maps a course's weekly hours onto component blocks. */
function componentPlan(course) {
  const plan = [];
  const lecture = Math.max(0, Number(course.lecture_hours) || 0);
  const tutorial = Math.max(0, Number(course.tutorial_hours) || 0);
  const lab = Math.max(0, Number(course.lab_hours) || 0);
  const labBlock = Math.max(1, Number(course.lab_block_periods) || 2);

  for (let i = 0; i < lecture; i += 1) plan.push({ component: 'LECTURE', periods: 1, instance: i });
  for (let i = 0; i < tutorial; i += 1) plan.push({ component: 'TUTORIAL', periods: 1, instance: i });

  let remaining = lab;
  let idx = 0;
  while (remaining > 0) {
    const periods = Math.min(labBlock, remaining);
    plan.push({ component: 'LAB', periods, instance: idx });
    remaining -= periods;
    idx += 1;
  }

  // A course with no hours recorded but a concrete type still needs one class,
  // otherwise the coordinator's selection would silently produce nothing.
  if (!plan.length) {
    const type = String(course.course_type || 'LECTURE').toUpperCase();
    const component = type === 'LABORATORY' ? 'LAB' : (COMPONENT_LABEL[type] ? type : 'LECTURE');
    plan.push({ component, periods: 1, instance: 0, inferred: true });
  }
  return plan;
}

/** Resolves the eligible faculty pool for a course, honouring data-level Fixed Faculty. */
function eligibleFacultyForCourse(ctx, course) {
  const rows = ctx.facultyByCourse.get(course.id) || [];
  const fixed = rows.filter((r) => r.is_fixed);
  if (fixed.length) {
    return { ids: fixed.map((r) => r.faculty_id), dataFixed: true };
  }
  if (rows.length) {
    return { ids: rows.map((r) => r.faculty_id), dataFixed: false };
  }
  // No explicit pool: fall back to the department's active faculty so that an
  // otherwise-complete setup still generates, and flag it as a soft issue.
  const fallback = ctx.facultyList
    .filter((fac) => fac.status === 'ACTIVE'
      && (!course.department_id || fac.department_id === course.department_id))
    .map((fac) => fac.id);
  return { ids: fallback, dataFixed: false, fallback: true };
}

function resolveFacultyCandidates(ctx, course, cfg, subSectionId, issues, label) {
  const { ids: eligible, dataFixed, fallback } = eligibleFacultyForCourse(ctx, course);
  const mode = String(cfg.facultyMode || 'AUTOMATIC').toUpperCase();

  const selected = (subSectionId != null && cfg.subSectionFaculty && cfg.subSectionFaculty[subSectionId])
    ? cfg.subSectionFaculty[subSectionId].map(Number)
    : (cfg.facultyIds || []).map(Number);

  const warnings = [];
  let candidates;

  if (mode === 'FIXED') {
    if (!selected.length) {
      issues.push({
        code: 'NO_FIXED_FACULTY',
        message: `${label}: Faculty Mode is Fixed but no faculty were selected.`,
      });
      return { candidates: [], mode, selected, warnings };
    }
    candidates = selected;
    const outside = selected.filter((id) => !eligible.includes(id));
    if (outside.length && !fallback) {
      warnings.push(
        `${label}: ${outside.map((id) => ctx.facultyName(id)).join(', ')} `
        + 'are not in this course\'s eligible faculty list but were fixed explicitly.'
      );
    }
  } else if (mode === 'PREFERRED') {
    const rest = eligible.filter((id) => !selected.includes(id));
    candidates = [...selected, ...rest];
  } else {
    candidates = eligible.length ? eligible : selected;
  }

  candidates = candidates.filter((id, i, arr) => ctx.facultyById.has(id) && arr.indexOf(id) === i);

  if (!candidates.length) {
    issues.push({
      code: 'NO_ELIGIBLE_FACULTY',
      message: `${label}: no eligible faculty. Assign faculty to this course first.`,
    });
  }
  if (dataFixed) {
    warnings.push(`${label}: course has Fixed Faculty configured -- no substitution will be considered.`);
  }
  if (fallback && candidates.length) {
    warnings.push(
      `${label}: no faculty-course assignment exists, so all active `
      + 'faculty in the department were considered.'
    );
  }

  return { candidates, mode, selected, warnings };
}

function resolveRoomCandidates(ctx, need, cfg, subSectionId, issues, label) {
  const mode = String(cfg.roomMode || 'AUTOMATIC').toUpperCase();
  const selected = (subSectionId != null && cfg.subSectionRooms && cfg.subSectionRooms[subSectionId])
    ? cfg.subSectionRooms[subSectionId].map(Number)
    : (cfg.roomIds || []).map(Number);

  const warnings = [];
  const suitable = [];
  const rejected = [];

  for (const room of ctx.roomList) {
    if (room.status !== 'ACTIVE') continue;
    const verdict = evaluateRoom(room, need, {
      tolerancePercent: ctx.rules.capacityTolerancePercent,
      allowOverflow: ctx.rules.allowCapacityOverflow,
    });
    if (verdict.ok) suitable.push(room.id);
    else rejected.push({ id: room.id, reasons: verdict.reasons });
  }

  let candidates;
  if (mode === 'FIXED') {
    if (!selected.length) {
      issues.push({ code: 'NO_FIXED_ROOM', message: `${label}: Room Mode is Fixed but no room was selected.` });
      return { candidates: [], mode, selected, warnings };
    }
    // Keep unsuitable fixed rooms in the list so the engine reports the precise
    // reason rather than a bare "no room available".
    candidates = selected;
    const bad = selected.filter((id) => !suitable.includes(id));
    bad.forEach((id) => {
      const r = rejected.find((x) => x.id === id);
      warnings.push(`${label}: fixed room ${ctx.roomName(id)} is not suitable -- ${
        r ? r.reasons.join(' ') : 'unknown reason'}`);
    });
  } else if (mode === 'PREFERRED') {
    const pref = selected.filter((id) => suitable.includes(id));
    candidates = [...pref, ...suitable.filter((id) => !pref.includes(id))];
  } else {
    candidates = suitable;
  }

  candidates = candidates.filter((id, i, arr) => ctx.roomById.has(id) && arr.indexOf(id) === i);

  if (!candidates.length) {
    const typeHint = need.requiredRoomType ? ` of type ${need.requiredRoomType}` : '';
    const acHint = need.acRequirement === 'REQUIRED' ? ' with AC' : '';
    issues.push({
      code: 'NO_SUITABLE_ROOM',
      message: `${label}: no suitable room${typeHint}${acHint} for ${need.strength} students. `
        + 'Add a room or relax the requirement.',
    });
  }

  return { candidates, mode, selected, warnings };
}

function resolveSlotCandidates(ctx, cfg, periods, instance) {
  const mode = String(cfg.timeMode || 'AUTOMATIC').toUpperCase();
  const grid = ctx.grid;
  const starts = blockStarts(grid.slots, periods);

  const allowed = (day, startIdx) => {
    for (let i = startIdx; i < startIdx + periods; i += 1) {
      if (ctx.rules.disallowedSlots.has(`${day}:${grid.slots[i].index}`)) return false;
    }
    return true;
  };

  const base = [];
  for (const day of grid.workingDays) {
    for (const startIdx of starts) {
      if (allowed(day, startIdx)) base.push({ day, startIdx });
    }
  }

  if (mode === 'FIXED') {
    const list = Array.isArray(cfg.fixedSlots) && cfg.fixedSlots.length
      ? cfg.fixedSlots
      : (cfg.fixedDay && cfg.fixedPeriodIndex ? [{ day: cfg.fixedDay, periodIndex: cfg.fixedPeriodIndex }] : []);
    const pick = list[instance];
    if (pick) {
      const startIdx = grid.slots.findIndex((s) => s.index === Number(pick.periodIndex));
      const match = base.find((c) => c.day === Number(pick.day) && c.startIdx === startIdx);
      // A fixed slot that is not in `base` is still returned so the engine can
      // explain exactly which rule the coordinator's choice breaks.
      return {
        mode,
        candidates: match ? [match] : [{ day: Number(pick.day), startIdx, forced: true }],
        exhaustive: false,
      };
    }
    // More classes than fixed slots supplied -> the remainder is AUTO.
    return { mode: 'AUTOMATIC', candidates: base, exhaustive: true, downgraded: true };
  }

  if (mode === 'PREFERRED') {
    const days = (cfg.preferredDays || []).map(Number).filter(Boolean);
    const ws = cfg.windowStart ? toMinutes(cfg.windowStart) : null;
    const we = cfg.windowEnd ? toMinutes(cfg.windowEnd) : null;
    const inWindow = (c) => {
      if (ws == null || we == null) return true;
      const s = grid.slots[c.startIdx];
      const e = grid.slots[c.startIdx + periods - 1];
      return s.startMin >= ws && e.endMin <= we;
    };
    const preferred = base.filter((c) => (!days.length || days.includes(c.day)) && inWindow(c));
    const rest = base.filter((c) => !preferred.includes(c));
    return { mode, candidates: [...preferred, ...rest], exhaustive: true };
  }

  return { mode: 'AUTOMATIC', candidates: base, exhaustive: true };
}

/**
 * @returns {{occurrences:Array, issues:Array, warnings:string[], groups:Map}}
 */
function buildOccurrences(ctx, request) {
  const occurrences = [];
  const issues = [];
  const warnings = [];
  const groups = new Map();
  let seq = 0;

  const scopeSectionIds = (request.scope && request.scope.sectionIds || []).map(Number);

  for (const cfg of (request.courses || [])) {
    if (cfg.include === false) continue;
    const course = ctx.courseById.get(Number(cfg.courseId));
    if (!course) {
      issues.push({ code: 'COURSE_MISSING', message: `Course ${cfg.courseId} does not exist in this college.` });
      continue;
    }

    // Which sections does this course run for?
    let targets;
    if (course.section_id) {
      targets = [Number(course.section_id)];
    } else if (Array.isArray(cfg.sectionIds) && cfg.sectionIds.length) {
      targets = cfg.sectionIds.map(Number);
    } else {
      targets = scopeSectionIds.length
        ? scopeSectionIds
        : ctx.sectionList.filter((s) => s.semester_id === course.semester_id).map((s) => s.id);
    }
    if (scopeSectionIds.length) targets = targets.filter((id) => scopeSectionIds.includes(id));
    targets = targets.filter((id, i, arr) => ctx.sectionById.has(id) && arr.indexOf(id) === i);

    if (!targets.length) {
      issues.push({
        code: 'NO_TARGET_SECTION',
        message: `${course.code} ${course.name}: no section in the selected scope. `
          + 'Create a section or widen the scope.',
      });
      continue;
    }

    const splitComponents = new Set(
      parseFacilityList(cfg.splitComponents != null ? cfg.splitComponents : course.split_components)
    );
    const splitRequested = cfg.splitIntoSubSections != null
      ? !!cfg.splitIntoSubSections
      : String(course.split_mode) === 'SPLIT_SUB_SECTIONS';

    const acRequirement = String(cfg.acRequirement || course.ac_requirement || 'NOT_REQUIRED').toUpperCase();
    const requiredRoomType = cfg.requiredRoomType !== undefined
      ? cfg.requiredRoomType : course.required_room_type;
    const requiredFacilities = cfg.requiredFacilities !== undefined
      ? cfg.requiredFacilities : course.required_facilities;

    for (const sectionId of targets) {
      const section = ctx.sectionById.get(sectionId);
      const allSubs = (ctx.subSectionsBySection.get(sectionId) || [])
        .filter((ss) => ss.status === 'ACTIVE');
      const chosenSubs = Array.isArray(cfg.subSectionIds) && cfg.subSectionIds.length
        ? allSubs.filter((ss) => cfg.subSectionIds.map(Number).includes(ss.id))
        : allSubs;

      const plan = componentPlan(course);

      for (const step of plan) {
        const splitThis = splitRequested
          && splitComponents.has(step.component)
          && chosenSubs.length > 0;

        if (splitRequested && splitComponents.has(step.component) && !chosenSubs.length) {
          warnings.push(
            `${course.code} ${section.name}: split into sub-sections was requested for `
            + `${COMPONENT_LABEL[step.component]} but ${section.name} has no sub-sections -- `
            + 'the whole section will be scheduled together.'
          );
        }

        const members = splitThis ? chosenSubs : [null];
        const groupKey = splitThis
          ? `g${course.id}-${sectionId}-${step.component}-${step.instance}`
          : null;
        const groupMemberIds = [];

        for (const sub of members) {
          const strength = sub
            ? (Number(sub.student_count) || 0)
            : (Number(course.student_strength) || Number(section.student_count) || 0);

          const label = `${course.code} ${COMPONENT_LABEL[step.component]} `
            + `(${section.name}${sub ? ` / ${sub.name}` : ''})`;

          if (!strength) {
            issues.push({
              code: 'NO_STRENGTH',
              message: `${label}: no student count recorded. Set the student count on `
                + `${sub ? 'the sub-section' : 'the section'} or the course.`,
            });
          }

          const need = { strength, acRequirement, requiredRoomType, requiredFacilities };
          const fac = resolveFacultyCandidates(ctx, course, cfg, sub ? sub.id : null, issues, label);
          const room = resolveRoomCandidates(ctx, need, cfg, sub ? sub.id : null, issues, label);
          const slot = resolveSlotCandidates(ctx, cfg, step.periods, step.instance);

          fac.warnings.forEach((w) => warnings.push(w));
          room.warnings.forEach((w) => warnings.push(w));
          if (slot.downgraded) {
            warnings.push(
              `${label}: fewer fixed slots were supplied than this course needs, so the `
              + 'remaining classes were scheduled automatically.'
            );
          }

          seq += 1;
          const occ = {
            id: `o${seq}`,
            courseId: course.id,
            course,
            sectionId,
            section,
            subSectionId: sub ? sub.id : null,
            subSection: sub || null,
            component: step.component,
            componentLabel: COMPONENT_LABEL[step.component],
            instance: step.instance,
            periods: step.periods,
            strength,
            label,
            groupKey,
            acRequirement,
            requiredRoomType,
            requiredFacilities,
            facultyCandidates: fac.candidates,
            facultyMode: fac.mode,
            preferredFacultyIds: fac.selected,
            roomCandidates: room.candidates,
            roomMode: room.mode,
            preferredRoomIds: room.selected,
            slotCandidates: slot.candidates,
            timeMode: slot.mode,
            preferredDays: (cfg.preferredDays || []).map(Number),
            windowStartMin: cfg.windowStart ? toMinutes(cfg.windowStart) : null,
            windowEndMin: cfg.windowEnd ? toMinutes(cfg.windowEnd) : null,
            feasible: fac.candidates.length > 0 && room.candidates.length > 0 && slot.candidates.length > 0,
          };
          occurrences.push(occ);
          if (groupKey) groupMemberIds.push(occ.id);
        }

        if (groupKey) {
          groups.set(groupKey, {
            key: groupKey,
            courseId: course.id,
            sectionId,
            component: step.component,
            memberIds: groupMemberIds,
          });
        }
      }
    }
  }

  return { occurrences, issues, warnings, groups };
}

module.exports = {
  COMPONENT_LABEL,
  componentPlan,
  buildOccurrences,
  eligibleFacultyForCourse,
};
