'use strict';

/**
 * The Generation Wizard (Section 5).
 *
 * The wizard is six steps in the UI but only three things on the server:
 *
 *   GET  /wizard    everything the six steps need to draw themselves
 *   POST /preview   derive the class list from the request without placing it
 *   POST /run       place it, and optionally write it into a timetable
 *
 * Section 5's `AUTO` rule is enforced in one place, `normaliseRequest`: a field
 * the coordinator left empty is stripped from the request entirely, which is how
 * the engine is told "you decide this one". An empty field is never an error.
 */

const express = require('express');
const db = require('../db/connection');
const { httpError, requireCollege, requireCoordinator } = require('../auth/middleware');
const { buildContext } = require('../services/context');
const { generate } = require('../services/scheduler');
const {
  buildOccurrences, componentPlan, eligibleFacultyForCourse, COMPONENT_LABEL,
} = require('../services/occurrences');
const { checkCollege, assertReadyToGenerate } = require('../services/readiness');
const editing = require('../services/editing');
const { displayRows } = require('../services/timing');
const { DAY_NAMES, ENUMS } = require('../services/entityRegistry');
const settings = require('../services/settings');

const router = express.Router();

// Every endpoint here writes or prepares a write.
router.use(requireCoordinator);

const AC_LABEL = {
  REQUIRED: 'AC Required',
  PREFERRED: 'AC Preferred',
  NOT_REQUIRED: 'AC Not Required',
};

// ---------------------------------------------------------------------------
// Step data
// ---------------------------------------------------------------------------
router.get('/wizard', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const readiness = checkCollege(collegeId);

    // The wizard is still useful when the data is incomplete -- it shows what is
    // missing -- so a blocked college gets the report instead of an error.
    if (!readiness.canGenerate) {
      return res.json({
        canGenerate: false,
        readiness,
        message: readiness.summary,
      });
    }

    const ctx = buildContext({ collegeId });
    const grid = ctx.grid;

    const sections = db.all(
      `SELECT s.*, p.name AS program_name, sem.semester_number,
              (SELECT COUNT(*) FROM sub_sections ss WHERE ss.section_id = s.id AND ss.status = 'ACTIVE') AS sub_sections,
              (SELECT COUNT(*) FROM students st WHERE st.section_id = s.id) AS students
         FROM sections s
         LEFT JOIN programs p ON p.id = s.program_id
         LEFT JOIN semesters sem ON sem.id = s.semester_id
        WHERE s.college_id = ? AND s.status = 'ACTIVE'
        ORDER BY p.name, sem.semester_number, s.name`,
      [collegeId]
    );
    const subSections = db.all(
      `SELECT * FROM sub_sections WHERE college_id = ? AND status = 'ACTIVE' ORDER BY section_id, name`,
      [collegeId]
    );

    const courses = db.all(
      `SELECT c.*, d.name AS department_name, p.name AS program_name, sem.semester_number,
              sec.name AS section_name
         FROM courses c
         LEFT JOIN departments d ON d.id = c.department_id
         LEFT JOIN programs p ON p.id = c.program_id
         LEFT JOIN semesters sem ON sem.id = c.semester_id
         LEFT JOIN sections sec ON sec.id = c.section_id
        WHERE c.college_id = ? AND c.status = 'ACTIVE'
        ORDER BY p.name, sem.semester_number, c.code`,
      [collegeId]
    ).map((course) => {
      const plan = componentPlan(course);
      const pool = eligibleFacultyForCourse(ctx, course);
      const fixedRows = (ctx.facultyByCourse.get(course.id) || []).filter((r) => r.is_fixed);
      return {
        ...course,
        // Steps 2-5 all edit the same per-course object; these are its defaults.
        plan: plan.map((p) => ({ ...p, label: COMPONENT_LABEL[p.component] || p.component })),
        classesPerWeek: plan.length,
        periodsPerWeek: plan.reduce((n, p) => n + p.periods, 0),
        acLabel: AC_LABEL[String(course.ac_requirement || 'NOT_REQUIRED').toUpperCase()],
        canSplit: String(course.split_mode) === 'SPLIT_SUB_SECTIONS',
        eligibleFaculty: pool.ids.map((id) => {
          const fac = ctx.facultyById.get(id);
          return {
            id,
            name: fac ? fac.name : `Faculty #${id}`,
            isFixed: fixedRows.some((r) => r.faculty_id === id),
          };
        }),
        facultyFixedInData: !!pool.dataFixed,
        facultyFromFallback: !!pool.fallback,
        facultyNote: pool.dataFixed
          ? 'A Fixed Faculty is recorded for this course, so the engine will not choose anyone else.'
          : pool.fallback
            ? 'No teachers are assigned to this course yet, so every active teacher in its '
              + 'department is treated as eligible.'
            : null,
      };
    });

    const rooms = db.all(
      `SELECT r.*, b.name AS building_name, f.name AS floor_name
         FROM rooms r
         LEFT JOIN buildings b ON b.id = r.building_id
         LEFT JOIN floors f ON f.id = r.floor_id
        WHERE r.college_id = ? AND r.status = 'ACTIVE'
        ORDER BY r.name`,
      [collegeId]
    ).map((r) => ({
      ...r,
      acLabel: r.is_ac ? 'AC' : 'Non-AC',
      capacity: r.max_capacity || r.seating_capacity || null,
    }));

    return res.json({
      canGenerate: true,
      readiness,
      // --- Step 1: scope ---------------------------------------------------
      scope: {
        departments: db.all('SELECT id, name FROM departments WHERE college_id = ? ORDER BY name', [collegeId]),
        programs: db.all('SELECT id, name, department_id FROM programs WHERE college_id = ? ORDER BY name', [collegeId]),
        semesters: db.all(
          // A semester belongs to a program, and the department comes with it --
          // step 1 filters by department, so it is resolved here.
          `SELECT sem.id, sem.semester_number, sem.program_id, sem.academic_session,
                  p.department_id
             FROM semesters sem
             LEFT JOIN programs p ON p.id = sem.program_id
            WHERE sem.college_id = ?
            ORDER BY sem.program_id, sem.semester_number`,
          [collegeId]
        ),
        sections,
        subSections,
      },
      timetables: db.all(
        `SELECT id, name, mode, status, quality_score,
                (SELECT COUNT(*) FROM assignments a WHERE a.timetable_id = t.id AND a.status = 'SCHEDULED') AS classes,
                (SELECT COUNT(*) FROM assignments a WHERE a.timetable_id = t.id AND a.is_locked = 1) AS locked
           FROM timetables t WHERE t.college_id = ? AND t.status <> 'ARCHIVED'
          ORDER BY t.updated_at DESC`,
        [collegeId]
      ),
      // --- Step 2: courses -------------------------------------------------
      courses,
      // --- Step 3/4: teachers and rooms ------------------------------------
      faculty: ctx.facultyList
        .filter((f) => f.status === 'ACTIVE')
        .map((f) => ({
          id: f.id, name: f.name, employee_id: f.employee_id,
          department_id: f.department_id, max_weekly_hours: f.max_weekly_hours,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      rooms,
      roomTypes: ENUMS.ROOM_TYPE,
      facilities: ENUMS.FACILITY,
      selectionModes: ENUMS.SELECTION_MODE,
      acRequirements: Object.entries(AC_LABEL).map(([value, label]) => ({ value, label })),
      // --- Step 5: time ----------------------------------------------------
      timing: {
        name: ctx.timing.name,
        workingDays: grid.workingDays,
        dayNames: grid.workingDays.map((d) => DAY_NAMES[d]),
        slots: grid.slots,
        rows: displayRows(grid),
        slotMinutes: grid.slotMinutes,
        weeklyCapacity: grid.workingDays.length * grid.slots.length,
        warnings: grid.warnings,
      },
      // --- Step 6: review --------------------------------------------------
      rules: ctx.rules.raw,
      modes: [
        { value: 'AUTOMATIC', label: 'Automatic', help: 'The engine decides everything you left empty.' },
        { value: 'MANUAL', label: 'Manual', help: 'You place every class yourself in the Manual Builder.' },
        { value: 'HYBRID', label: 'Hybrid (recommended)', help: 'Fix what matters, let the engine fill the rest around it.' },
      ],
      autoNote: 'Leave any field empty to let the scheduler decide it. An empty field is never '
        + 'invalid -- it means "you choose".',
      academicSession: settings.getSetting('academic_session') || null,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Request normalisation -- Section 5's AUTO semantics
// ---------------------------------------------------------------------------
const isAuto = (v) => v === undefined || v === null || v === '' || v === 'AUTO'
  || (Array.isArray(v) && v.length === 0);

const numList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((x) => Number(x)).filter((n) => Number.isFinite(n));

/**
 * Strips every "let the engine decide" field out of the request and records what
 * was left to the engine, so the results panel can say so afterwards.
 */
function normaliseRequest(body) {
  const decided = { faculty: 0, room: 0, time: 0, total: 0 };
  const courses = [];

  for (const raw of (body.courses || [])) {
    if (raw.include === false) continue;
    const cfg = { courseId: Number(raw.courseId), include: true };
    if (!Number.isFinite(cfg.courseId)) continue;

    if (!isAuto(raw.sectionIds)) cfg.sectionIds = numList(raw.sectionIds);
    if (!isAuto(raw.subSectionIds)) cfg.subSectionIds = numList(raw.subSectionIds);
    if (raw.splitIntoSubSections !== undefined && raw.splitIntoSubSections !== null) {
      cfg.splitIntoSubSections = !!raw.splitIntoSubSections;
    }
    if (!isAuto(raw.splitComponents)) cfg.splitComponents = raw.splitComponents;
    if (!isAuto(raw.acRequirement)) cfg.acRequirement = String(raw.acRequirement).toUpperCase();
    if (!isAuto(raw.requiredRoomType)) cfg.requiredRoomType = raw.requiredRoomType;
    if (!isAuto(raw.requiredFacilities)) cfg.requiredFacilities = raw.requiredFacilities;

    // --- Teacher (step 3) ---
    const facultyMode = String(raw.facultyMode || 'AUTOMATIC').toUpperCase();
    if (facultyMode !== 'AUTOMATIC' && !isAuto(raw.facultyIds)) {
      cfg.facultyMode = facultyMode;
      cfg.facultyIds = numList(raw.facultyIds);
    } else if (facultyMode !== 'AUTOMATIC' && !isAuto(raw.subSectionFaculty)) {
      cfg.facultyMode = facultyMode;
    } else {
      decided.faculty += 1;
    }
    if (!isAuto(raw.subSectionFaculty)) {
      cfg.subSectionFaculty = {};
      for (const [k, v] of Object.entries(raw.subSectionFaculty)) {
        if (!isAuto(v)) cfg.subSectionFaculty[k] = numList(v);
      }
    }

    // --- Room (step 4) ---
    const roomMode = String(raw.roomMode || 'AUTOMATIC').toUpperCase();
    if (roomMode !== 'AUTOMATIC' && !isAuto(raw.roomIds)) {
      cfg.roomMode = roomMode;
      cfg.roomIds = numList(raw.roomIds);
    } else if (roomMode !== 'AUTOMATIC' && roomMode !== 'ANY') {
      cfg.roomMode = roomMode;
    } else {
      decided.room += 1;
    }
    if (!isAuto(raw.subSectionRooms)) {
      cfg.subSectionRooms = {};
      for (const [k, v] of Object.entries(raw.subSectionRooms)) {
        if (!isAuto(v)) cfg.subSectionRooms[k] = numList(v);
      }
    }

    // --- Time (step 5) ---
    const timeMode = String(raw.timeMode || 'AUTOMATIC').toUpperCase();
    let timeFixed = false;
    if (timeMode === 'FIXED') {
      const slots = Array.isArray(raw.fixedSlots) ? raw.fixedSlots : [];
      const clean = slots
        .map((s) => ({ day: Number(s.day), periodIndex: Number(s.periodIndex) }))
        .filter((s) => Number.isFinite(s.day) && Number.isFinite(s.periodIndex));
      if (clean.length) { cfg.timeMode = 'FIXED'; cfg.fixedSlots = clean; timeFixed = true; }
      if (!isAuto(raw.fixedDay)) { cfg.timeMode = 'FIXED'; cfg.fixedDay = Number(raw.fixedDay); timeFixed = true; }
      if (!isAuto(raw.fixedPeriodIndex)) {
        cfg.timeMode = 'FIXED'; cfg.fixedPeriodIndex = Number(raw.fixedPeriodIndex); timeFixed = true;
      }
    } else if (timeMode === 'PREFERRED' || timeMode === 'WINDOW') {
      if (!isAuto(raw.preferredDays)) { cfg.timeMode = timeMode; cfg.preferredDays = numList(raw.preferredDays); timeFixed = true; }
      if (!isAuto(raw.windowStart)) { cfg.timeMode = timeMode; cfg.windowStart = raw.windowStart; timeFixed = true; }
      if (!isAuto(raw.windowEnd)) { cfg.timeMode = timeMode; cfg.windowEnd = raw.windowEnd; timeFixed = true; }
    }
    if (!timeFixed) decided.time += 1;

    decided.total += 1;
    courses.push(cfg);
  }

  const scope = {};
  if (!isAuto(body.scope && body.scope.sectionIds)) scope.sectionIds = numList(body.scope.sectionIds);

  return {
    request: {
      courses,
      scope,
      mode: String(body.mode || 'HYBRID').toUpperCase(),
      departmentId: body.departmentId != null ? Number(body.departmentId) : null,
      programId: body.programId != null ? Number(body.programId) : null,
      semesterId: body.semesterId != null ? Number(body.semesterId) : null,
    },
    decided,
  };
}

/** Plain-English summary of what the coordinator handed to the engine. */
function autoSummary(decided) {
  if (!decided.total) return [];
  const lines = [];
  if (decided.faculty) lines.push(`${decided.faculty} of ${decided.total} course(s): the engine picks the teacher.`);
  if (decided.room) lines.push(`${decided.room} of ${decided.total} course(s): the engine picks the room.`);
  if (decided.time) lines.push(`${decided.time} of ${decided.total} course(s): the engine picks the day and period.`);
  if (lines.length === 0) lines.push('You fixed the teacher, the room and the time for every course.');
  return lines;
}

// ---------------------------------------------------------------------------
// POST /preview -- step 6's "what will be generated" panel
// ---------------------------------------------------------------------------
router.post('/preview', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const body = req.body || {};
    const { request, decided } = normaliseRequest(body);
    if (!request.courses.length) {
      throw httpError(400, 'Select at least one course to schedule.', 'VALIDATION');
    }

    const ctx = buildContext({
      collegeId,
      excludeTimetableId: body.timetableId != null ? Number(body.timetableId) : null,
      keepLocked: body.keepLocked !== false,
    });
    const { occurrences, issues, warnings, groups } = buildOccurrences(ctx, request);

    // Capacity arithmetic, so an impossible request is visible before it runs.
    const periodsNeeded = occurrences.reduce((n, o) => n + o.periods, 0);
    const roomCount = ctx.roomList.filter((r) => r.status === 'ACTIVE').length;
    const supply = roomCount * ctx.grid.workingDays.length * ctx.grid.slots.length;
    const alreadyUsed = db.get(
      `SELECT COALESCE(SUM(a.periods), 0) AS n FROM assignments a
         JOIN timetables t ON t.id = a.timetable_id
        WHERE a.college_id = ? AND a.status = 'SCHEDULED' AND t.status <> 'ARCHIVED'
          ${body.timetableId ? 'AND (a.timetable_id <> ? OR a.is_locked = 1)' : ''}`,
      body.timetableId ? [collegeId, Number(body.timetableId)] : [collegeId]
    ).n;

    const byCourse = new Map();
    for (const occ of occurrences) {
      if (!byCourse.has(occ.courseId)) byCourse.set(occ.courseId, []);
      byCourse.get(occ.courseId).push(occ);
    }

    res.json({
      classesToSchedule: occurrences.length,
      periodsNeeded,
      capacity: {
        rooms: roomCount,
        workingDays: ctx.grid.workingDays.length,
        periodsPerDay: ctx.grid.slots.length,
        roomPeriodsAvailable: supply,
        roomPeriodsAlreadyUsed: alreadyUsed,
        utilisationPercent: supply ? Math.round(((periodsNeeded + alreadyUsed) / supply) * 100) : null,
        feasible: supply === 0 ? false : (periodsNeeded + alreadyUsed) <= supply,
      },
      parallelGroups: groups.size,
      // The class-by-class list behind those totals. Step 6 of the wizard shows
      // it so the coordinator can see the split halves as separate classes --
      // "Computer Networks Lab (B1)" and "(B2)" -- before anything is placed.
      classes: occurrences.map((occ) => ({
        id: occ.id,
        label: occ.label,
        courseId: occ.courseId,
        courseCode: occ.course ? occ.course.code : null,
        courseName: occ.course ? occ.course.name : null,
        sectionId: occ.sectionId,
        sectionName: occ.section ? occ.section.name : null,
        subSectionId: occ.subSectionId,
        subSectionName: occ.subSection ? occ.subSection.name : null,
        component: occ.component,
        componentLabel: occ.componentLabel,
        instance: occ.instance,
        periods: occ.periods,
        students: occ.strength,
        acRequirement: AC_LABEL[String(occ.acRequirement).toUpperCase()] || null,
        requiredRoomType: occ.requiredRoomType || null,
        requiredFacilities: occ.requiredFacilities || [],
        // Named when the choice is already settled, counted when the engine is
        // the one that will decide.
        teacher: occ.facultyCandidates.length === 1
          ? ctx.facultyName(occ.facultyCandidates[0])
          : null,
        teacherChoices: occ.facultyCandidates.length,
        roomChoices: occ.roomCandidates.length,
        // Non-null means this class may share its slot with its siblings.
        parallelGroup: occ.groupKey || null,
        feasible: occ.feasible,
      })),
      courses: [...byCourse.entries()].map(([courseId, list]) => {
        const course = ctx.courseById.get(courseId);
        return {
          courseId,
          code: course ? course.code : `#${courseId}`,
          name: course ? course.name : null,
          classes: list.length,
          periods: list.reduce((n, o) => n + o.periods, 0),
          sections: [...new Set(list.map((o) => o.sectionId))].length,
          split: list.some((o) => o.subSectionId != null),
          components: [...new Set(list.map((o) => COMPONENT_LABEL[o.component] || o.component))],
          acRequirement: AC_LABEL[String(course && course.ac_requirement).toUpperCase()] || null,
        };
      }),
      issues,
      warnings,
      engineWillDecide: autoSummary(decided),
      decided,
      canRun: issues.length === 0 && occurrences.length > 0,
      verdict: occurrences.length === 0
        ? 'Nothing would be scheduled. Check the selected courses and sections.'
        : issues.length
          ? `${issues.length} problem(s) must be fixed before this can run.`
          : `${occurrences.length} class(es) will be scheduled across ${byCourse.size} course(s).`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /run -- generate, and write it unless this is a dry run
// ---------------------------------------------------------------------------
router.post('/run', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const body = req.body || {};
    assertReadyToGenerate(collegeId);

    const { request, decided } = normaliseRequest(body);
    if (!request.courses.length) {
      throw httpError(400, 'Select at least one course to schedule.', 'VALIDATION');
    }

    const dryRun = body.dryRun === true;
    const keepLocked = body.keepLocked !== false;   // Section 8.3 default
    const keepManual = body.keepManual === true;

    let timetableId = body.timetableId != null ? Number(body.timetableId) : null;
    let createdTimetable = null;
    if (!dryRun) {
      if (timetableId == null) {
        const name = String(body.timetableName || '').trim() || `Timetable ${new Date().toLocaleDateString()}`;
        const info = db.run(
          `INSERT INTO timetables
             (college_id, department_id, program_id, semester_id, academic_session, name, mode, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
          [
            collegeId, request.departmentId, request.programId, request.semesterId,
            body.academicSession || settings.getSetting('academic_session') || null,
            name, request.mode, req.user.id,
          ]
        );
        timetableId = info.lastInsertRowid;
        createdTimetable = db.get('SELECT * FROM timetables WHERE id = ?', [timetableId]);
      } else {
        editing.getTimetable(collegeId, timetableId);   // 404s if it is another college's
      }
    }

    // Existing classes are loaded as occupancy; the timetable being rebuilt is
    // excluded except for its locked rows, which is what makes Hybrid work.
    const ctx = buildContext({ collegeId, excludeTimetableId: timetableId, keepLocked });
    const started = Date.now();
    const result = generate(ctx, request, {
      timeBudgetMs: body.timeBudgetMs != null ? Number(body.timeBudgetMs) : undefined,
    });
    const elapsedMs = Date.now() - started;

    let persisted = null;
    if (!dryRun) {
      persisted = editing.persistGeneration(collegeId, {
        timetableId, result, request, userId: req.user.id, keepLocked, keepManual,
      });
    }

    const timetable = timetableId
      ? db.get('SELECT * FROM timetables WHERE id = ?', [timetableId])
      : null;
    const validation = (!dryRun && timetableId)
      ? editing.validateTimetable(collegeId, timetableId)
      : null;

    res.json({
      dryRun,
      timetable,
      createdTimetable: !!createdTimetable,
      persisted,
      // --- Section 5.6: the Generation Results panel ------------------------
      qualityScore: result.qualityScore,
      ok: result.ok,
      stats: result.stats,
      assignments: dryRun ? result.assignments : undefined,
      unscheduled: result.unscheduled,
      issues: result.issues,
      warnings: result.warnings,
      validation,
      elapsedMs,
      engineDecided: autoSummary(decided),
      headline: result.ok
        ? `All ${result.stats.classesScheduled} class(es) were scheduled. Quality score `
          + `${result.qualityScore}/100.`
        : `${result.stats.classesScheduled} of ${result.stats.classesRequired} class(es) were `
          + `scheduled. ${result.stats.classesUnscheduled} could not be placed -- each one lists why below.`,
      nextSteps: result.ok
        ? ['Review the timetable', 'Lock anything you want protected', 'Publish when you are happy with it']
        : [
          'Open each unscheduled class to see its reason',
          'Use Find Best Slot in the Manual Builder to place it by hand',
          'Or relax a constraint (add a room, widen the day, free a teacher) and generate again',
        ],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------
router.get('/runs', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const rows = db.all(
      `SELECT r.id, r.timetable_id, r.created_at, r.created_by, r.result_json,
              t.name AS timetable_name, u.full_name AS created_by_name
         FROM generation_runs r
         LEFT JOIN timetables t ON t.id = r.timetable_id
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.college_id = ?
        ORDER BY r.id DESC LIMIT ?`,
      [collegeId, req.query.limit ? Number(req.query.limit) : 25]
    );
    res.json({
      runs: rows.map((r) => {
        let result = null;
        try { result = JSON.parse(r.result_json); } catch { result = null; }
        return {
          id: r.id,
          timetableId: r.timetable_id,
          timetableName: r.timetable_name,
          createdAt: r.created_at,
          createdBy: r.created_by_name || null,
          qualityScore: result ? result.qualityScore : null,
          stats: result ? result.stats : null,
          unscheduled: result && result.unscheduled ? result.unscheduled.length : null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/runs/:id', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = db.get(
      'SELECT * FROM generation_runs WHERE id = ? AND college_id = ?',
      [Number(req.params.id), collegeId]
    );
    if (!row) throw httpError(404, 'That generation run was not found.');
    const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    res.json({
      id: row.id,
      timetableId: row.timetable_id,
      createdAt: row.created_at,
      request: parse(row.request_json),
      result: parse(row.result_json),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
