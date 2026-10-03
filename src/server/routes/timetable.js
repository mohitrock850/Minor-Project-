'use strict';

/**
 * Timetables, views, card actions, versions and export
 * (Sections 7 and 8).
 *
 * Every mutation goes through services/editing.js, which runs the same
 * validation the generator uses. A coordinator may override a hard conflict by
 * re-sending the request with `force: true`; the reason is then stored on the
 * assignment and in the audit trail rather than being silently swallowed.
 */

const express = require('express');
const db = require('../db/connection');
const {
  ROLES, httpError, requireCollege, requireCoordinator,
} = require('../auth/middleware');
const editing = require('../services/editing');
const { buildContext } = require('../services/context');
const { findAlternativesForAssignment } = require('../services/alternatives');
const { buildView, facultyWorkload, roomUtilisation } = require('../services/views');
const versions = require('../services/versions');
const exporters = require('../services/exporters');
const settings = require('../services/settings');
const { DAY_NAMES } = require('../services/entityRegistry');

const router = express.Router();

const VIEW_TYPES = [
  'college', 'department', 'program', 'semester', 'section', 'sub_section',
  'faculty', 'room', 'course', 'student',
];

// ---------------------------------------------------------------------------
// Views (Section 7.1) -- registered before /:id so "views" is never read as an id
// ---------------------------------------------------------------------------

/**
 * Section 12 in practice: faculty and students may only ask for their own row.
 * The subject of the view is taken from the token, not from the URL, so editing
 * the address bar changes nothing.
 */
function resolveViewRequest(req) {
  const { scope } = req;
  const requestedType = String(req.params.type || 'college');
  const requestedId = req.params.id != null && req.params.id !== '' ? Number(req.params.id) : null;

  if (scope.role === ROLES.FACULTY) {
    if (scope.facultyId == null) {
      throw httpError(403, 'Your login is not linked to a faculty record yet.', 'NO_FACULTY_LINK');
    }
    if (requestedType === 'faculty' && requestedId !== null && requestedId !== scope.facultyId) {
      throw httpError(403, 'You can only view your own timetable.', 'SCOPE_FORBIDDEN');
    }
    // Any other request is answered with their own week rather than refused --
    // there is nothing else a read-only account is entitled to see.
    return { type: 'faculty', id: scope.facultyId };
  }

  if (scope.role === ROLES.STUDENT) {
    if (scope.studentId == null) {
      throw httpError(403, 'Your login is not linked to a student record yet.', 'NO_STUDENT_LINK');
    }
    return { type: 'student', id: scope.studentId };
  }

  if (!VIEW_TYPES.includes(requestedType)) {
    throw httpError(400, `View type must be one of: ${VIEW_TYPES.join(', ')}.`, 'VALIDATION');
  }
  if (requestedType !== 'college' && requestedId == null) {
    throw httpError(400, 'Choose what the view should be about.', 'VALIDATION');
  }
  return { type: requestedType, id: requestedId };
}

function loadView(req) {
  const collegeId = requireCollege(req);
  const target = resolveViewRequest(req);
  const view = buildView({
    collegeId,
    timetableId: req.query.timetableId ? Number(req.query.timetableId) : null,
    type: target.type,
    id: target.id,
    includeCancelled: req.query.includeCancelled === '1' || req.query.includeCancelled === 'true',
  });
  // Tells the renderer whether to draw the card actions at all. It is a
  // convenience, not the guard: the action endpoints check the role themselves,
  // so a faculty or student token is refused even if the buttons are forced on.
  return {
    ...view,
    canEdit: req.scope.canWrite === true,
    viewer: { role: req.scope.role, readOnly: req.scope.canWrite !== true },
  };
}

router.get('/views/:type/:id?', (req, res, next) => {
  try {
    res.json(loadView(req));
  } catch (err) {
    next(err);
  }
});

/** The list of things a coordinator can build a view of, for the view picker. */
router.get('/view-targets', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const { scope } = req;
    if (scope.role === ROLES.FACULTY) {
      return res.json({
        types: ['faculty'],
        faculty: db.all('SELECT id, name AS label FROM faculty WHERE id = ?', [scope.facultyId]),
      });
    }
    if (scope.role === ROLES.STUDENT) {
      return res.json({
        types: ['student'],
        student: db.all('SELECT id, name AS label FROM students WHERE id = ?', [scope.studentId]),
      });
    }
    return res.json({
      types: VIEW_TYPES,
      department: db.all('SELECT id, name AS label FROM departments WHERE college_id = ? ORDER BY name', [collegeId]),
      program: db.all('SELECT id, name AS label FROM programs WHERE college_id = ? ORDER BY name', [collegeId]),
      semester: db.all(
        `SELECT sem.id, 'Semester ' || sem.semester_number || COALESCE(' - ' || p.name, '') AS label
           FROM semesters sem LEFT JOIN programs p ON p.id = sem.program_id
          WHERE sem.college_id = ? ORDER BY p.name, sem.semester_number`,
        [collegeId]
      ),
      section: db.all('SELECT id, name AS label FROM sections WHERE college_id = ? ORDER BY name', [collegeId]),
      sub_section: db.all(
        `SELECT ss.id, s.name || ' / ' || ss.name AS label
           FROM sub_sections ss JOIN sections s ON s.id = ss.section_id
          WHERE ss.college_id = ? ORDER BY s.name, ss.name`,
        [collegeId]
      ),
      faculty: db.all('SELECT id, name AS label FROM faculty WHERE college_id = ? ORDER BY name', [collegeId]),
      room: db.all(
        `SELECT id, name || ' (' || CASE WHEN is_ac = 1 THEN 'AC' ELSE 'Non-AC' END || ')' AS label
           FROM rooms WHERE college_id = ? ORDER BY name`,
        [collegeId]
      ),
      course: db.all("SELECT id, code || ' - ' || name AS label FROM courses WHERE college_id = ? ORDER BY code", [collegeId]),
      student: [],
    });
  } catch (err) {
    return next(err);
  }
});

/** Section 7.3: the utilisation tables shown beside the grid. */
router.get('/analysis', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const timetableId = req.query.timetableId ? Number(req.query.timetableId) : null;
    res.json({
      faculty: facultyWorkload(collegeId, timetableId),
      rooms: roomUtilisation(collegeId, timetableId),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Export (Section 8.5)
// ---------------------------------------------------------------------------
function exportMeta(collegeId, timetableId) {
  const college = db.get('SELECT * FROM colleges WHERE id = ?', [collegeId]);
  const tt = timetableId ? db.get('SELECT * FROM timetables WHERE id = ?', [timetableId]) : null;
  return {
    collegeName: college ? college.name : 'College',
    timetableName: tt ? tt.name : null,
    academicSession: (tt && tt.academic_session) || settings.getSetting('academic_session') || null,
    generatedAt: new Date().toLocaleString(),
    // iCal needs a real first week; without one it falls back to "this week".
    termStart: settings.getSetting('term_start_date', '') || null,
    weeks: Number(settings.getSetting('term_weeks', 16)) || 16,
  };
}

/**
 * `format` is one of html | pdf | excel | csv | ical.
 * PDF is returned as print-ready HTML: the Electron main process turns it into a
 * real PDF with printToPDF, which keeps the renderer free of a PDF library.
 */
router.get('/export/:format/:type/:id?', async (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const view = loadView(req);
    const meta = exportMeta(collegeId, view.timetableId);
    const format = String(req.params.format || 'html').toLowerCase();
    const base = exporters.slug(`${meta.collegeName}-${view.scope.label || 'timetable'}`);

    if (format === 'html' || format === 'pdf') {
      const html = exporters.toHtml(view, meta);
      if (req.query.download === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${base}.html"`);
      }
      res.type('html').send(html);
      return;
    }
    if (format === 'csv') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      res.type('text/csv').send(exporters.toCsv(view));
      return;
    }
    if (format === 'ical' || format === 'ics') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.ics"`);
      res.type('text/calendar').send(exporters.toIcal(view, meta));
      return;
    }
    if (format === 'excel' || format === 'xlsx') {
      const buffer = await exporters.toExcel(view, meta);
      res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
      return;
    }
    throw httpError(400, 'Export format must be pdf, excel, csv or ical.', 'VALIDATION');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Assignment card actions (Section 8.1-8.3)
// ---------------------------------------------------------------------------
const cards = express.Router();

/** Every write below belongs to the coordinator / super admin only. */
cards.use((req, res, next) => {
  if (req.method === 'GET') return next();
  return requireCoordinator(req, res, next);
});

function cardOf(collegeId, id) {
  const row = editing.getAssignment(collegeId, id);
  const view = buildView({
    collegeId, timetableId: row.timetable_id, type: 'course', id: row.course_id, includeCancelled: true,
  });
  return view.cards.find((c) => c.id === row.id) || null;
}

cards.get('/:id', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const id = Number(req.params.id);
    const row = editing.getAssignment(collegeId, id);
    const ctx = buildContext({ collegeId });
    res.json({
      assignment: row,
      card: cardOf(collegeId, id),
      validation: editing.validateAssignment(ctx, row),
      history: db.all(
        `SELECT a.*, u.full_name AS actor_name, u.username
           FROM assignment_audit a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.assignment_id = ? ORDER BY a.id DESC LIMIT 50`,
        [id]
      ),
    });
  } catch (err) {
    next(err);
  }
});

/** Section 8.2: Find Alternatives -- other slots, other teachers, other rooms. */
cards.get('/:id/alternatives', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getAssignment(collegeId, Number(req.params.id));
    const ctx = buildContext({ collegeId });
    res.json(findAlternativesForAssignment(ctx, row, {
      limit: req.query.limit ? Number(req.query.limit) : 10,
    }));
  } catch (err) {
    next(err);
  }
});

/** Dry run: what would happen if this change were applied? */
cards.post('/:id/check', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getAssignment(collegeId, Number(req.params.id));
    const ctx = buildContext({ collegeId });
    const result = editing.validateProposal(ctx, row, req.body || {});
    res.json({
      ...result,
      canOverride: !result.ok,
      overrideHint: result.ok
        ? null
        : 'You can still apply this change -- re-send it with "force" and the conflict will be '
          + 'recorded on the class and in the activity log.',
    });
  } catch (err) {
    next(err);
  }
});

const ACTIONS = {
  move: (collegeId, id, body, user) => editing.moveAssignment(collegeId, id, body, user),
  'change-teacher': (collegeId, id, body, user) => editing.changeFaculty(collegeId, id, body, user),
  'change-room': (collegeId, id, body, user) => editing.changeRoom(collegeId, id, body, user),
  edit: (collegeId, id, body, user) => editing.editAssignment(collegeId, id, body, user),
  cancel: (collegeId, id, body, user) => editing.cancelAssignment(collegeId, id, body, user),
  restore: (collegeId, id, body, user) => editing.restoreAssignment(collegeId, id, user),
  duplicate: (collegeId, id, body, user) => editing.duplicateAssignment(collegeId, id, body, user),
};

for (const [action, handler] of Object.entries(ACTIONS)) {
  cards.post(`/:id/${action}`, (req, res, next) => {
    try {
      const collegeId = requireCollege(req);
      const id = Number(req.params.id);
      const result = handler(collegeId, id, req.body || {}, req.user);
      // Some helpers return the row itself, others return the row plus the
      // validation result; and Duplicate returns a different row than it was
      // given, so the refreshed card is always taken from what came back.
      const payload = result && result.assignment ? result : { assignment: result };
      res.json({
        action,
        ...payload,
        card: payload.assignment ? cardOf(collegeId, payload.assignment.id) : null,
      });
    } catch (err) {
      next(err);
    }
  });
}

cards.post('/:id/lock', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const id = Number(req.params.id);
    const locked = !(req.body && (req.body.locked === false || req.body.locked === 0));
    const assignment = editing.setLock(collegeId, id, locked, req.user);
    res.json({
      action: locked ? 'lock' : 'unlock',
      assignment,
      card: cardOf(collegeId, id),
      message: locked
        ? 'Locked. Re-generating the timetable will leave this class exactly where it is.'
        : 'Unlocked. Re-generating the timetable may move this class.',
    });
  } catch (err) {
    next(err);
  }
});

cards.delete('/:id', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    res.json(editing.deleteAssignment(collegeId, Number(req.params.id), req.user));
  } catch (err) {
    next(err);
  }
});

/** Manual creation of a single class (Section 6.1). */
cards.post('/', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const result = editing.createAssignment(collegeId, req.body || {}, req.user);
    res.status(201).json({
      ...result,
      card: result.assignment ? cardOf(collegeId, result.assignment.id) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.use('/assignments', cards);

// ---------------------------------------------------------------------------
// Versions and activity (Section 8.4)
// ---------------------------------------------------------------------------
/** A version belongs to a college, so one lookup enforces the scoping. */
function ownedVersion(collegeId, versionId) {
  const row = db.get(
    'SELECT * FROM timetable_versions WHERE id = ? AND college_id = ?', [versionId, collegeId]
  );
  if (!row) throw httpError(404, 'Version not found.');
  return row;
}

router.get('/versions/:versionId', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = ownedVersion(collegeId, Number(req.params.versionId));
    const { snapshot: raw, ...rest } = row;
    let parsed = { assignments: [] };
    try { parsed = JSON.parse(raw); } catch { /* an unreadable snapshot is reported as empty */ }
    res.json({
      ...rest,
      qualityScore: parsed.quality_score ?? null,
      assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/versions/:versionId/restore', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const version = ownedVersion(collegeId, Number(req.params.versionId));
    res.json(versions.restoreVersion(version.id, { userId: req.user.id }));
  } catch (err) {
    next(err);
  }
});

router.delete('/versions/:versionId', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const version = ownedVersion(collegeId, Number(req.params.versionId));
    res.json(versions.deleteVersion(version.id));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Timetables
// ---------------------------------------------------------------------------
function summary(collegeId, row) {
  const counts = db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'SCHEDULED' THEN 1 ELSE 0 END) AS scheduled,
            SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN is_locked = 1 THEN 1 ELSE 0 END) AS locked,
            SUM(CASE WHEN is_manual = 1 THEN 1 ELSE 0 END) AS manual
       FROM assignments WHERE timetable_id = ?`,
    [row.id]
  );
  return {
    ...row,
    counts: {
      total: counts.total || 0,
      scheduled: counts.scheduled || 0,
      cancelled: counts.cancelled || 0,
      locked: counts.locked || 0,
      manual: counts.manual || 0,
    },
  };
}

router.get('/', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const rows = db.all(
      `SELECT * FROM timetables WHERE college_id = ?${req.query.includeArchived === '1' ? '' : " AND status <> 'ARCHIVED'"}
        ORDER BY CASE status WHEN 'PUBLISHED' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,
                 updated_at DESC, id DESC`,
      [collegeId]
    );
    res.json({ rows: rows.map((r) => summary(collegeId, r)), total: rows.length });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'Give this timetable a name.', 'VALIDATION');
    const mode = String(body.mode || 'HYBRID').toUpperCase();
    if (!['AUTOMATIC', 'MANUAL', 'HYBRID'].includes(mode)) {
      throw httpError(400, 'Mode must be AUTOMATIC, MANUAL or HYBRID.', 'VALIDATION');
    }
    const info = db.run(
      `INSERT INTO timetables
         (college_id, department_id, program_id, semester_id, academic_session, name, mode, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
      [
        collegeId,
        body.departmentId != null ? Number(body.departmentId) : null,
        body.programId != null ? Number(body.programId) : null,
        body.semesterId != null ? Number(body.semesterId) : null,
        body.academicSession || settings.getSetting('academic_session') || null,
        name, mode, req.user.id,
      ]
    );
    const row = db.get('SELECT * FROM timetables WHERE id = ?', [info.lastInsertRowid]);
    versions.audit({
      timetableId: row.id, collegeId, action: 'CREATE_TIMETABLE', userId: req.user.id, after: row,
    });
    res.status(201).json(summary(collegeId, row));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    res.json({
      ...summary(collegeId, row),
      versions: versions.listVersions(row.id),
      runs: db.all(
        `SELECT id, created_at, created_by, result_json FROM generation_runs
          WHERE timetable_id = ? ORDER BY id DESC LIMIT 10`,
        [row.id]
      ).map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        createdBy: r.created_by,
        result: (() => { try { return JSON.parse(r.result_json); } catch { return null; } })(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    const body = req.body || {};
    const sets = [];
    const params = [];
    const set = (col, v) => { sets.push(`${col} = ?`); params.push(v); };

    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) throw httpError(400, 'The name cannot be empty.', 'VALIDATION');
      set('name', name);
    }
    if (body.mode !== undefined) {
      const mode = String(body.mode).toUpperCase();
      if (!['AUTOMATIC', 'MANUAL', 'HYBRID'].includes(mode)) {
        throw httpError(400, 'Mode must be AUTOMATIC, MANUAL or HYBRID.', 'VALIDATION');
      }
      set('mode', mode);
    }
    if (body.academicSession !== undefined) set('academic_session', body.academicSession || null);
    if (body.departmentId !== undefined) set('department_id', body.departmentId != null ? Number(body.departmentId) : null);
    if (body.programId !== undefined) set('program_id', body.programId != null ? Number(body.programId) : null);
    if (body.semesterId !== undefined) set('semester_id', body.semesterId != null ? Number(body.semesterId) : null);

    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) {
        throw httpError(400, 'Status must be DRAFT, PUBLISHED or ARCHIVED.', 'VALIDATION');
      }
      if (status === 'PUBLISHED') {
        const check = editing.validateTimetable(collegeId, row.id);
        if (check.hardConflicts && !body.force) {
          const err = httpError(409,
            `This timetable still has ${check.hardConflicts} unresolved conflict(s). Fix them, or `
            + 'publish anyway to accept them on the record.', 'CONFLICT');
          err.details = check.problems.slice(0, 10).map(
            (p) => `${p.label}: ${p.violations.map((v) => v.message).join('; ')}`
          );
          err.violations = check.problems;
          err.canOverride = true;
          throw err;
        }
        // Publishing is the moment worth being able to roll back to.
        versions.snapshot(row.id, {
          label: `Published ${row.name}`,
          reason: 'Automatic snapshot taken when publishing',
          userId: req.user.id,
        });
      }
      set('status', status);
    }

    if (!sets.length) return res.json(summary(collegeId, row));
    db.run(`UPDATE timetables SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      [...params, row.id]);
    const after = db.get('SELECT * FROM timetables WHERE id = ?', [row.id]);
    versions.audit({
      timetableId: row.id, collegeId, action: 'UPDATE_TIMETABLE', userId: req.user.id, before: row, after,
    });
    return res.json(summary(collegeId, after));
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    db.run('DELETE FROM timetables WHERE id = ?', [row.id]);
    res.json({ deleted: true, id: row.id, name: row.name });
  } catch (err) {
    next(err);
  }
});

/** Section 13: re-run the full checklist over a saved timetable. */
router.get('/:id/validate', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    const report = editing.validateTimetable(collegeId, row.id);
    res.json({
      timetable: { id: row.id, name: row.name, status: row.status },
      ...report,
      verdict: report.hardConflicts
        ? `${report.hardConflicts} class(es) break a hard rule.`
        : (report.softWarnings
          ? `No conflicts. ${report.softWarnings} class(es) have a preference warning.`
          : 'No conflicts and no warnings.'),
    });
  } catch (err) {
    next(err);
  }
});

/** Everything on this timetable as flat cards -- the Manual Builder's data source. */
router.get('/:id/assignments', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    const view = buildView({ collegeId, timetableId: row.id, type: 'college', includeCancelled: true });
    res.json({
      timetable: summary(collegeId, row),
      grid: view.grid,
      cards: view.cards,
      cells: view.cells,
      stats: view.stats,
      dayNames: DAY_NAMES,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/versions', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    res.json({ timetableId: row.id, versions: versions.listVersions(row.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/versions', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    const body = req.body || {};
    res.status(201).json(versions.snapshot(row.id, {
      label: body.label || null,
      reason: body.reason || 'Saved by hand',
      userId: req.user.id,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    res.json({
      timetableId: row.id,
      entries: versions.listAudit(row.id, req.query.limit ? Number(req.query.limit) : 100),
    });
  } catch (err) {
    next(err);
  }
});

/** Wipe every class but keep the timetable (and snapshot first). */
router.post('/:id/clear', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const row = editing.getTimetable(collegeId, Number(req.params.id));
    const keepLocked = !(req.body && req.body.keepLocked === false);
    const out = db.transaction(() => {
      const before = db.get('SELECT COUNT(*) AS n FROM assignments WHERE timetable_id = ?', [row.id]).n;
      if (before) {
        versions.snapshot(row.id, {
          label: 'Before clearing', reason: 'Automatic snapshot taken before clearing', userId: req.user.id,
        });
      }
      db.run(
        `DELETE FROM assignments WHERE timetable_id = ?${keepLocked ? ' AND is_locked = 0' : ''}`, [row.id]
      );
      const after = db.get('SELECT COUNT(*) AS n FROM assignments WHERE timetable_id = ?', [row.id]).n;
      db.run("UPDATE timetables SET quality_score = NULL, updated_at = datetime('now') WHERE id = ?", [row.id]);
      return { removed: before - after, kept: after };
    });
    versions.audit({
      timetableId: row.id, collegeId, action: 'CLEAR', userId: req.user.id, after: out,
    });
    res.json({ ...out, keptLocked: keepLocked, timetable: summary(collegeId, db.get('SELECT * FROM timetables WHERE id = ?', [row.id])) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
