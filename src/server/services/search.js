'use strict';

/**
 * Global search (Section 11).
 *
 * One query box, results grouped by category. The searchable columns come from
 * the entity registry, so a field added there becomes searchable automatically.
 *
 * Scoping is enforced here in SQL, not by hiding results afterwards (Section 12):
 *   - Super Admin      -- every college, or the active one if the switcher is set
 *   - Coordinator      -- their own college only
 *   - Faculty          -- what appears on their own timetable, plus their own record
 *   - Student          -- what appears on their own section's timetable
 */

const db = require('../db/connection');
const { ENTITIES, DAY_NAMES } = require('./entityRegistry');
const { ROLES } = require('../auth/middleware');

/** Order in which categories are shown; also the entities that are searchable. */
const CATEGORIES = [
  'courses', 'faculty', 'sections', 'sub_sections', 'students',
  'rooms', 'buildings', 'departments', 'programs', 'semesters',
  'student_batches', 'floors', 'colleges', 'universities',
];

const ICONS = {
  courses: 'course', faculty: 'faculty', sections: 'section', sub_sections: 'section',
  students: 'student', rooms: 'room', buildings: 'building', departments: 'department',
  programs: 'program', semesters: 'semester', student_batches: 'batch', floors: 'building',
  colleges: 'college', universities: 'university', assignments: 'class',
};

/**
 * The extra restriction a read-only role needs on top of college scoping.
 * Returns null when the role may not search that entity at all.
 */
function roleRestriction(scope, entityKey) {
  if (scope.role === ROLES.SUPER_ADMIN || scope.role === ROLES.COLLEGE_ADMIN) {
    return { sql: null, params: [] };
  }

  if (scope.role === ROLES.FACULTY) {
    const fid = scope.facultyId;
    if (fid == null) return null;
    switch (entityKey) {
      case 'faculty':
        return { sql: 't.id = ?', params: [fid] };
      case 'courses':
        return {
          sql: '(t.id IN (SELECT course_id FROM faculty_courses WHERE faculty_id = ?) '
            + 'OR t.id IN (SELECT course_id FROM assignments WHERE faculty_id = ?))',
          params: [fid, fid],
        };
      case 'sections':
        return { sql: 't.id IN (SELECT section_id FROM assignments WHERE faculty_id = ?)', params: [fid] };
      case 'sub_sections':
        return {
          sql: 't.id IN (SELECT sub_section_id FROM assignments WHERE faculty_id = ? AND sub_section_id IS NOT NULL)',
          params: [fid],
        };
      case 'rooms':
        return { sql: 't.id IN (SELECT room_id FROM assignments WHERE faculty_id = ?)', params: [fid] };
      case 'departments':
      case 'programs':
      case 'semesters':
      case 'buildings':
        return { sql: null, params: [] };
      default:
        // Student rolls, batches, other teachers' records: not theirs to browse.
        return null;
    }
  }

  if (scope.role === ROLES.STUDENT) {
    const sectionId = scope.sectionId;
    if (sectionId == null) return null;
    const own = 'SELECT %COL% FROM assignments WHERE section_id = ?';
    switch (entityKey) {
      case 'courses':
        return { sql: `t.id IN (${own.replace('%COL%', 'course_id')})`, params: [sectionId] };
      case 'faculty':
        return { sql: `t.id IN (${own.replace('%COL%', 'faculty_id')})`, params: [sectionId] };
      case 'rooms':
        return { sql: `t.id IN (${own.replace('%COL%', 'room_id')})`, params: [sectionId] };
      case 'sections':
        return { sql: 't.id = ?', params: [sectionId] };
      case 'sub_sections':
        return scope.subSectionId != null
          ? { sql: 't.id = ?', params: [scope.subSectionId] }
          : null;
      default:
        return null;
    }
  }

  return null;
}

function collegeRestriction(scope, entity) {
  if (entity.collegeScoped) {
    if (scope.isSuperAdmin) {
      return scope.activeCollegeId != null
        ? { sql: 't.college_id = ?', params: [scope.activeCollegeId] }
        : { sql: null, params: [] };
    }
    if (scope.homeCollegeId == null) return { sql: '1 = 0', params: [] };
    return { sql: 't.college_id = ?', params: [scope.homeCollegeId] };
  }
  if (entity.key === 'colleges') {
    if (scope.isSuperAdmin) return { sql: null, params: [] };
    if (scope.homeCollegeId == null) return { sql: '1 = 0', params: [] };
    return { sql: 't.id = ?', params: [scope.homeCollegeId] };
  }
  if (entity.key === 'universities') {
    if (scope.isSuperAdmin) return { sql: null, params: [] };
    if (scope.homeCollegeId == null) return { sql: '1 = 0', params: [] };
    return { sql: 't.id IN (SELECT university_id FROM colleges WHERE id = ?)', params: [scope.homeCollegeId] };
  }
  return { sql: null, params: [] };
}

/** Builds the display title/subtitle for one hit. */
function describe(entity, row) {
  const titleField = entity.titleField || 'name';
  const title = `${entity.titlePrefix || ''}${row[titleField] ?? `#${row.id}`}`;
  const subtitle = (entity.subtitleFields || [])
    .map((k) => row[k])
    .filter((v) => v != null && v !== '')
    .join(' - ');
  return { title, subtitle };
}

function searchEntity(scope, entityKey, term, limit) {
  const entity = ENTITIES[entityKey];
  if (!entity || !entity.searchable || !entity.searchable.length) return null;

  const role = roleRestriction(scope, entityKey);
  if (!role) return null;

  const where = [];
  const params = [];

  const ors = entity.searchable.map((c) => `t.${c} LIKE ?`);
  where.push(`(${ors.join(' OR ')})`);
  entity.searchable.forEach(() => params.push(`%${term}%`));

  const college = collegeRestriction(scope, entity);
  if (college.sql) { where.push(college.sql); params.push(...college.params); }
  if (role.sql) { where.push(role.sql); params.push(...role.params); }

  const total = db.get(
    `SELECT COUNT(*) AS n FROM ${entity.table} t WHERE ${where.join(' AND ')}`, params
  ).n;
  if (!total) return null;

  const rows = db.all(
    `SELECT t.* FROM ${entity.table} t WHERE ${where.join(' AND ')} `
    + `ORDER BY t.${entity.titleField || 'id'} LIMIT ?`,
    [...params, limit]
  );

  return {
    key: entity.key,
    label: entity.label,
    group: entity.group,
    icon: ICONS[entity.key] || 'record',
    total,
    results: rows.map((row) => {
      const { title, subtitle } = describe(entity, row);
      return {
        id: row.id,
        entity: entity.key,
        title,
        subtitle,
        status: row.status || null,
        collegeId: row.college_id ?? null,
        // Where clicking this result should take the user.
        route: `/data/${entity.key}/${row.id}`,
        // Entities that also have a timetable view get a second action.
        viewRoute: viewRouteFor(entity.key, row.id),
      };
    }),
  };
}

function viewRouteFor(entityKey, id) {
  const viewable = {
    sections: 'section', sub_sections: 'sub_section', faculty: 'faculty',
    rooms: 'room', courses: 'course', departments: 'department',
    semesters: 'semester', programs: 'program', students: 'student',
  };
  return viewable[entityKey] ? `/timetable/view/${viewable[entityKey]}/${id}` : null;
}

/** Scheduled classes matching the term -- searched by course, teacher or room. */
function searchAssignments(scope, term, limit) {
  const where = [
    "a.status = 'SCHEDULED'",
    "t.status <> 'ARCHIVED'",
    '(c.code LIKE ? OR c.name LIKE ? OR f.name LIKE ? OR r.name LIKE ? OR s.name LIKE ?)',
  ];
  const params = Array(5).fill(`%${term}%`);

  if (scope.isSuperAdmin) {
    if (scope.activeCollegeId != null) { where.push('a.college_id = ?'); params.push(scope.activeCollegeId); }
  } else if (scope.homeCollegeId != null) {
    where.push('a.college_id = ?');
    params.push(scope.homeCollegeId);
  } else {
    return null;
  }

  if (scope.role === ROLES.FACULTY) {
    if (scope.facultyId == null) return null;
    where.push('a.faculty_id = ?');
    params.push(scope.facultyId);
  } else if (scope.role === ROLES.STUDENT) {
    if (scope.sectionId == null) return null;
    if (scope.subSectionId != null) {
      where.push('(a.sub_section_id = ? OR (a.sub_section_id IS NULL AND a.section_id = ?))');
      params.push(scope.subSectionId, scope.sectionId);
    } else {
      where.push('a.section_id = ?');
      params.push(scope.sectionId);
    }
  }

  const sql = `
    SELECT a.id, a.day_of_week, a.start_time, a.end_time, a.periods, a.component,
           a.section_id, a.sub_section_id, a.college_id,
           c.code AS course_code, c.name AS course_name,
           f.name AS faculty_name, r.name AS room_name, r.is_ac AS room_is_ac,
           s.name AS section_name, ss.name AS sub_section_name
      FROM assignments a
      JOIN timetables t ON t.id = a.timetable_id
      LEFT JOIN courses c ON c.id = a.course_id
      LEFT JOIN faculty f ON f.id = a.faculty_id
      LEFT JOIN rooms r ON r.id = a.room_id
      LEFT JOIN sections s ON s.id = a.section_id
      LEFT JOIN sub_sections ss ON ss.id = a.sub_section_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.day_of_week, a.slot_index LIMIT ?`;

  const rows = db.all(sql, [...params, limit]);
  if (!rows.length) return null;

  return {
    key: 'assignments',
    label: 'Scheduled Classes',
    group: 'Timetable',
    icon: 'class',
    total: rows.length,
    results: rows.map((row) => ({
      id: row.id,
      entity: 'assignments',
      title: `${row.course_code || ''} ${row.course_name || ''}`.trim() || `Class #${row.id}`,
      subtitle: [
        DAY_NAMES[row.day_of_week],
        `${row.start_time}-${row.end_time}`,
        row.sub_section_name ? `${row.section_name} / ${row.sub_section_name}` : row.section_name,
        row.faculty_name,
        row.room_name ? `${row.room_name} (${row.room_is_ac ? 'AC' : 'NON-AC'})` : null,
      ].filter(Boolean).join(' - '),
      collegeId: row.college_id,
      route: row.sub_section_id
        ? `/timetable/view/sub_section/${row.sub_section_id}`
        : `/timetable/view/section/${row.section_id}`,
      viewRoute: null,
    })),
  };
}

/**
 * @param {object} scope   req.scope, built from the signed token
 * @param {string} term    what the user typed
 * @param {object} opts    { limit, entities }
 */
function search(scope, term, opts = {}) {
  const q = String(term || '').trim();
  if (q.length < 2) {
    return { query: q, groups: [], total: 0, message: 'Type at least two characters to search.' };
  }
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 8));
  const wanted = opts.entities && opts.entities.length
    ? CATEGORIES.filter((k) => opts.entities.includes(k))
    : CATEGORIES;

  const groups = [];
  const classes = searchAssignments(scope, q, limit);
  if (classes) groups.push(classes);

  for (const key of wanted) {
    const group = searchEntity(scope, key, q, limit);
    if (group) groups.push(group);
  }

  const total = groups.reduce((n, g) => n + g.total, 0);
  return {
    query: q,
    groups,
    total,
    message: total ? null : `Nothing found for "${q}".`,
  };
}

module.exports = { search, CATEGORIES, roleRestriction };
