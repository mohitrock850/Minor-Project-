'use strict';

/**
 * Reference data for the renderer: the entity registry, the college switcher,
 * dropdown options, the data-readiness gate, global search and the four role
 * dashboards (Sections 7, 9, 11, 12).
 */

const express = require('express');
const db = require('../db/connection');
const {
  ROLES, httpError, requireCollege, visibleColleges, collegeFilter,
} = require('../auth/middleware');
const { publicRegistry, ENTITIES, getEntity, DAY_NAMES } = require('../services/entityRegistry');
const { checkCollege } = require('../services/readiness');
const { search } = require('../services/search');
const { buildView, facultyWorkload, roomUtilisation } = require('../services/views');
const { loadTimingGrid } = require('../services/context');
const { displayRows } = require('../services/timing');
const { validateTimetable } = require('../services/editing');
const { listAudit } = require('../services/versions');
const settings = require('../services/settings');

const router = express.Router();

/** The whole registry, so the UI can render every entity form generically. */
router.get('/registry', (req, res) => {
  res.json(publicRegistry());
});

router.get('/colleges', (req, res, next) => {
  try {
    res.json({
      colleges: visibleColleges(req),
      activeCollegeId: req.scope.activeCollegeId,
      canSwitch: req.scope.isSuperAdmin,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Options for a reference field: [{id, label, ...row}].
 * Scoped exactly like the entity itself, so a picker can never offer another
 * college's rows.
 */
router.get('/options/:entity', (req, res, next) => {
  try {
    const entity = getEntity(req.params.entity);
    const { scope } = req;

    const where = [];
    const params = [];
    if (entity.collegeScoped) {
      const collegeId = scope.isSuperAdmin ? scope.activeCollegeId : scope.homeCollegeId;
      if (collegeId == null) return res.json({ options: [] });
      where.push('college_id = ?');
      params.push(collegeId);
    } else if (entity.key === 'colleges' && !scope.isSuperAdmin) {
      if (scope.homeCollegeId == null) return res.json({ options: [] });
      where.push('id = ?');
      params.push(scope.homeCollegeId);
    }

    // filter_<column>=value narrows dependent pickers (sections of a semester,
    // sub-sections of a section, floors of a building, ...).
    for (const [key, value] of Object.entries(req.query)) {
      if (!key.startsWith('filter_') || value === '' || value == null) continue;
      const col = key.slice(7);
      if (!entity.fields.some((f) => f.key === col)) continue;
      where.push(`${col} = ?`);
      params.push(value);
    }

    const titleField = entity.titleField || 'name';
    const rows = db.all(
      `SELECT * FROM ${entity.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} `
      + `ORDER BY ${titleField}`,
      params
    );

    return res.json({
      options: rows.map((row) => ({
        id: row.id,
        label: `${entity.titlePrefix || ''}${row[titleField] ?? `#${row.id}`}`,
        sublabel: (entity.subtitleFields || []).map((k) => row[k]).filter((v) => v != null && v !== '').join(' - '),
        row,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

/** Section 9: the pre-generation data dependency gate + Data Setup Progress. */
router.get('/readiness', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    res.json(checkCollege(collegeId));
  } catch (err) {
    next(err);
  }
});

/** Section 11: global search, grouped by category, scoped by role. */
router.get('/search', (req, res, next) => {
  try {
    res.json(search(req.scope, req.query.q, {
      limit: req.query.limit,
      entities: req.query.entities ? String(req.query.entities).split(',') : null,
    }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Section 7.2 -- one dashboard shape per role
// ---------------------------------------------------------------------------
function collegeCounts(collegeId) {
  const counts = {};
  for (const entity of Object.values(ENTITIES)) {
    if (!entity.collegeScoped) continue;
    counts[entity.key] = db.get(
      `SELECT COUNT(*) AS n FROM ${entity.table} WHERE college_id = ?`, [collegeId]
    ).n;
  }
  return counts;
}

function timetableSummaries(collegeId) {
  return db.all(
    `SELECT t.*, (SELECT COUNT(*) FROM assignments a WHERE a.timetable_id = t.id
                    AND a.status = 'SCHEDULED') AS classes
       FROM timetables t WHERE t.college_id = ? ORDER BY t.updated_at DESC, t.id DESC`,
    [collegeId]
  );
}

function activeTimetable(collegeId) {
  return db.get(
    `SELECT * FROM timetables WHERE college_id = ? AND status <> 'ARCHIVED'
      ORDER BY CASE status WHEN 'PUBLISHED' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1`,
    [collegeId]
  );
}

/** "What is on today" -- used by the faculty and student dashboards. */
function todaysClasses(cards) {
  // JS Sunday = 0; the application uses 1 = Monday .. 7 = Sunday.
  const jsDay = new Date().getDay();
  const today = jsDay === 0 ? 7 : jsDay;
  return {
    today,
    todayName: DAY_NAMES[today],
    classes: cards.filter((c) => c.day === today),
  };
}

router.get('/dashboard', (req, res, next) => {
  try {
    const { scope } = req;

    // --- Super Admin: the university-wide roll-up -------------------------
    if (scope.role === ROLES.SUPER_ADMIN && scope.activeCollegeId == null) {
      const colleges = visibleColleges(req).map((college) => {
        const report = (() => {
          try { return checkCollege(college.id); } catch { return null; }
        })();
        const tt = activeTimetable(college.id);
        return {
          ...college,
          readiness: report ? { canGenerate: report.canGenerate, percent: report.progress.percent } : null,
          timetable: tt ? { id: tt.id, name: tt.name, status: tt.status, qualityScore: tt.quality_score } : null,
          counts: {
            faculty: db.get('SELECT COUNT(*) AS n FROM faculty WHERE college_id = ?', [college.id]).n,
            students: db.get('SELECT COUNT(*) AS n FROM students WHERE college_id = ?', [college.id]).n,
            rooms: db.get('SELECT COUNT(*) AS n FROM rooms WHERE college_id = ?', [college.id]).n,
            sections: db.get('SELECT COUNT(*) AS n FROM sections WHERE college_id = ?', [college.id]).n,
            classes: db.get(
              `SELECT COUNT(*) AS n FROM assignments a JOIN timetables t ON t.id = a.timetable_id
                WHERE a.college_id = ? AND a.status = 'SCHEDULED' AND t.status <> 'ARCHIVED'`,
              [college.id]
            ).n,
          },
        };
      });
      return res.json({
        kind: 'SUPER_ADMIN_ALL_COLLEGES',
        universities: db.all('SELECT * FROM universities ORDER BY name'),
        colleges,
        totals: {
          colleges: colleges.length,
          faculty: colleges.reduce((n, c) => n + c.counts.faculty, 0),
          students: colleges.reduce((n, c) => n + c.counts.students, 0),
          rooms: colleges.reduce((n, c) => n + c.counts.rooms, 0),
          classes: colleges.reduce((n, c) => n + c.counts.classes, 0),
        },
        settings: { institutionName: settings.getSetting('institution_name'), session: settings.getSetting('academic_session') },
      });
    }

    const collegeId = requireCollege(req);
    const college = db.get('SELECT * FROM colleges WHERE id = ?', [collegeId]);
    const tt = activeTimetable(collegeId);

    // --- Faculty: my own week ---------------------------------------------
    if (scope.role === ROLES.FACULTY) {
      if (scope.facultyId == null) {
        throw httpError(403, 'Your login is not linked to a faculty record yet.', 'NO_FACULTY_LINK');
      }
      const view = buildView({ collegeId, type: 'faculty', id: scope.facultyId });
      const load = facultyWorkload(collegeId).find((f) => f.id === scope.facultyId) || null;
      return res.json({
        kind: 'FACULTY',
        college,
        timetable: tt,
        me: db.get('SELECT * FROM faculty WHERE id = ?', [scope.facultyId]),
        view,
        workload: load,
        ...todaysClasses(view.cards),
        canEditOwnAvailability: !!scope.canEditOwnAvailability,
      });
    }

    // --- Student: my own section ------------------------------------------
    if (scope.role === ROLES.STUDENT) {
      if (scope.studentId == null) {
        throw httpError(403, 'Your login is not linked to a student record yet.', 'NO_STUDENT_LINK');
      }
      const view = buildView({ collegeId, type: 'student', id: scope.studentId });
      const me = db.get(
        `SELECT s.*, sec.name AS section_name, ss.name AS sub_section_name
           FROM students s
           LEFT JOIN sections sec ON sec.id = s.section_id
           LEFT JOIN sub_sections ss ON ss.id = s.sub_section_id
          WHERE s.id = ?`,
        [scope.studentId]
      );
      return res.json({
        kind: 'STUDENT', college, timetable: tt, me, view, ...todaysClasses(view.cards),
      });
    }

    // --- Coordinator / Super Admin working inside one college -------------
    const report = (() => {
      try { return checkCollege(collegeId); } catch (err) { return { error: err.message }; }
    })();
    let grid = null;
    try {
      const loaded = loadTimingGrid(collegeId);
      grid = {
        name: loaded.timing.name,
        workingDays: loaded.grid.workingDays.map((d) => DAY_NAMES[d]),
        periods: loaded.grid.slots.length,
        slotMinutes: loaded.grid.slotMinutes,
        rows: displayRows(loaded.grid),
      };
    } catch (err) {
      grid = { error: err.message };
    }

    const conflicts = tt ? (() => {
      try { return validateTimetable(collegeId, tt.id); } catch { return null; }
    })() : null;

    return res.json({
      kind: 'COORDINATOR',
      college,
      counts: collegeCounts(collegeId),
      readiness: report,
      timing: grid,
      timetables: timetableSummaries(collegeId),
      timetable: tt,
      conflicts: conflicts && {
        classes: conflicts.classes,
        hardConflicts: conflicts.hardConflicts,
        softWarnings: conflicts.softWarnings,
        averageScore: conflicts.averageScore,
      },
      workload: facultyWorkload(collegeId, tt ? tt.id : null),
      rooms: roomUtilisation(collegeId, tt ? tt.id : null),
      recentActivity: tt ? listAudit(tt.id, 15) : [],
      lastBackupAt: settings.getSetting('last_backup_at') || null,
    });
  } catch (err) {
    return next(err);
  }
});

/** Counts behind the Data Management hub tiles. */
router.get('/counts', (req, res, next) => {
  try {
    const { scope } = req;
    const out = {};
    for (const entity of Object.values(ENTITIES)) {
      const filter = collegeFilter(req);
      if (entity.collegeScoped) {
        out[entity.key] = db.get(
          `SELECT COUNT(*) AS n FROM ${entity.table} WHERE ${filter.sql}`, filter.params
        ).n;
      } else if (entity.key === 'colleges') {
        out[entity.key] = scope.isSuperAdmin
          ? db.get('SELECT COUNT(*) AS n FROM colleges').n
          : (scope.homeCollegeId != null ? 1 : 0);
      } else if (entity.key === 'universities') {
        out[entity.key] = scope.isSuperAdmin ? db.get('SELECT COUNT(*) AS n FROM universities').n : 0;
      }
    }
    res.json({ counts: out });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
