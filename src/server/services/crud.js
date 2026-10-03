'use strict';

/**
 * Generic CRUD over the entity registry.
 *
 * One implementation serves all of Section 1, which is what makes the Data
 * Management hub consistent and keeps validation, college scoping and reference
 * integrity from drifting between entity screens.
 */

const db = require('../db/connection');
const { getEntity, ENTITIES } = require('./entityRegistry');
const { ROLES, httpError, assertCollegeAccess } = require('../auth/middleware');
const { toMinutes } = require('./timing');

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Whether `req` may perform `action` on `entity` (and optionally a specific row).
 * Faculty get exactly one narrow write: their own availability record.
 */
function assertEntityAccess(req, entity, action, row = null) {
  const { scope } = req;
  const isRead = action === 'read';

  if (scope.role === ROLES.STUDENT) {
    throw httpError(403, 'Students have read-only access to their own section timetable.', 'ROLE_FORBIDDEN');
  }

  if (scope.role === ROLES.FACULTY) {
    if (entity.key === 'faculty_availability') {
      if (!scope.canEditOwnAvailability && !isRead) {
        throw httpError(403, 'Editing your availability has been disabled by the administrator.', 'ROLE_FORBIDDEN');
      }
      if (scope.facultyId == null) {
        throw httpError(403, 'Your account is not linked to a faculty record.', 'NO_FACULTY_LINK');
      }
      if (row && Number(row.faculty_id) !== scope.facultyId) {
        throw httpError(403, 'You may only manage your own availability.', 'ROLE_FORBIDDEN');
      }
      return;
    }
    throw httpError(403, 'Faculty accounts have view-only access to timetable data.', 'ROLE_FORBIDDEN');
  }

  if (!isRead && !scope.canWrite) {
    throw httpError(403, 'Your role does not permit changes.', 'ROLE_FORBIDDEN');
  }

  if (entity.superAdminOnly && !scope.isSuperAdmin) {
    throw httpError(403, `Only a Super Admin can manage ${entity.label}.`, 'ROLE_FORBIDDEN');
  }
  if (entity.superAdminCreateOnly && !scope.isSuperAdmin && (action === 'create' || action === 'delete')) {
    throw httpError(403, `Only a Super Admin can ${action} a ${entity.singular}.`, 'ROLE_FORBIDDEN');
  }
}

// ---------------------------------------------------------------------------
// Value coercion + validation
// ---------------------------------------------------------------------------
function coerceField(field, value, entity, errors, ctx = {}) {
  const label = field.label;
  const empty = value === undefined || value === null || value === '';

  if (empty) {
    if (field.required && !ctx.partial) errors.push(`${label} is required.`);
    if (field.default !== undefined && !ctx.partial) return field.default;
    return null;
  }

  switch (field.type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push(`${label} must be a number.`);
        return null;
      }
      if (n < 0) errors.push(`${label} cannot be negative.`);
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value ? 1 : 0;
      const s = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes', 'y', 'ac'].includes(s)) return 1;
      if (['0', 'false', 'no', 'n', 'non-ac', 'nonac'].includes(s)) return 0;
      errors.push(`${label} must be Yes or No.`);
      return 0;
    }
    case 'enum': {
      const s = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (!field.values.map(String).includes(s)) {
        errors.push(`${label} must be one of: ${field.values.join(', ')}.`);
        return null;
      }
      return s;
    }
    case 'day': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        errors.push(`${label} must be a day number 1 (Monday) to 7 (Sunday).`);
        return null;
      }
      return n;
    }
    case 'time': {
      const s = String(value).trim();
      const m = /^(\d{1,2}):(\d{2})$/.exec(s);
      if (!m || toMinutes(s) == null) {
        errors.push(`${label} must be a time in HH:MM form.`);
        return null;
      }
      return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
    }
    case 'date': {
      const s = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        errors.push(`${label} must be a date in YYYY-MM-DD form.`);
        return null;
      }
      return s;
    }
    case 'csv': {
      const parts = (Array.isArray(value) ? value : String(value).split(','))
        .map((p) => String(p).trim().toUpperCase().replace(/[\s-]+/g, '_'))
        .filter(Boolean);
      if (field.values) {
        const allowed = field.values.map(String);
        const bad = parts.filter((p) => !allowed.includes(p));
        if (bad.length) errors.push(`${label} contains unknown value(s): ${bad.join(', ')}.`);
      }
      return parts.join(',');
    }
    case 'ref': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        errors.push(`${label} must reference an existing ${field.ref}.`);
        return null;
      }
      return n;
    }
    default:
      return String(value);
  }
}

/** References must exist and must belong to the same college. */
function validateReferences(entity, values, collegeId, errors) {
  for (const field of entity.fields) {
    if (field.type !== 'ref') continue;
    const id = values[field.key];
    if (id == null) continue;

    const target = ENTITIES[field.ref];
    if (!target) continue;
    const row = db.get(`SELECT * FROM ${target.table} WHERE id = ?`, [id]);
    if (!row) {
      errors.push(`${field.label}: no ${target.singular} with id ${id} exists.`);
      continue;
    }
    if (target.collegeScoped && collegeId != null && Number(row.college_id) !== Number(collegeId)) {
      errors.push(`${field.label}: that ${target.singular} belongs to a different college.`);
    }
  }
}

function buildValues(entity, body, { partial = false, collegeId = null } = {}) {
  const errors = [];
  const values = {};
  for (const field of entity.fields) {
    if (partial && !(field.key in body)) continue;
    values[field.key] = coerceField(field, body[field.key], entity, errors, { partial });
  }
  if (!errors.length) validateReferences(entity, values, collegeId, errors);
  return { values, errors };
}

// ---------------------------------------------------------------------------
// Reference label resolution -- lists show names, not ids
// ---------------------------------------------------------------------------
function attachRefLabels(entity, rows) {
  if (!rows.length) return rows;
  const refFields = entity.fields.filter((x) => x.type === 'ref');
  if (!refFields.length) return rows;

  for (const field of refFields) {
    const target = ENTITIES[field.ref];
    if (!target) continue;
    const ids = [...new Set(rows.map((r) => r[field.key]).filter((v) => v != null))];
    if (!ids.length) continue;
    const placeholders = ids.map(() => '?').join(',');
    const titleCol = target.titleField || 'name';
    const found = db.all(
      `SELECT id, ${titleCol} AS title FROM ${target.table} WHERE id IN (${placeholders})`,
      ids
    );
    const byId = new Map(found.map((r) => [r.id, `${target.titlePrefix || ''}${r.title}`]));
    for (const row of rows) {
      if (!row._labels) row._labels = {};
      if (row[field.key] != null) row._labels[field.key] = byId.get(row[field.key]) || null;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------
function scopeClause(req, entity) {
  const { scope } = req;
  if (entity.collegeScoped) {
    if (scope.isSuperAdmin) {
      if (scope.activeCollegeId != null) return { sql: 'college_id = ?', params: [scope.activeCollegeId] };
      return { sql: '1 = 1', params: [] };
    }
    if (scope.homeCollegeId == null) return { sql: '1 = 0', params: [] };
    return { sql: 'college_id = ?', params: [scope.homeCollegeId] };
  }
  // Non-scoped entities: universities (super admin only) and colleges.
  if (entity.key === 'colleges') {
    if (scope.isSuperAdmin) return { sql: '1 = 1', params: [] };
    if (scope.homeCollegeId == null) return { sql: '1 = 0', params: [] };
    return { sql: 'id = ?', params: [scope.homeCollegeId] };
  }
  if (entity.key === 'universities') {
    if (scope.isSuperAdmin) return { sql: '1 = 1', params: [] };
    if (scope.homeCollegeId == null) return { sql: '1 = 0', params: [] };
    return {
      sql: 'id IN (SELECT university_id FROM colleges WHERE id = ?)',
      params: [scope.homeCollegeId],
    };
  }
  return { sql: '1 = 1', params: [] };
}

function listRows(req, entityKey, query = {}) {
  const entity = getEntity(entityKey);
  assertEntityAccess(req, entity, 'read');

  const where = [];
  const params = [];
  const scope = scopeClause(req, entity);
  where.push(scope.sql);
  params.push(...scope.params);

  // Faculty may read only their own availability rows.
  if (req.scope.role === ROLES.FACULTY && entity.key === 'faculty_availability') {
    where.push('faculty_id = ?');
    params.push(req.scope.facultyId);
  }

  // Free-text search across the entity's declared searchable columns.
  const q = String(query.q || '').trim();
  if (q && entity.searchable && entity.searchable.length) {
    const ors = entity.searchable.map((c) => `${c} LIKE ?`);
    where.push(`(${ors.join(' OR ')})`);
    entity.searchable.forEach(() => params.push(`%${q}%`));
  }

  // filter_<column>=value
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('filter_')) continue;
    const col = key.slice(7);
    if (!entity.fields.some((x) => x.key === col) && col !== 'id') continue;
    if (value === '' || value == null) continue;
    where.push(`${col} = ?`);
    params.push(value);
  }

  const sortField = entity.fields.some((x) => x.key === query.sort) ? query.sort : null;
  const dir = String(query.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy = sortField ? `${sortField} ${dir}` : `${entity.titleField || 'id'} ASC`;

  const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));
  const offset = Math.max(0, Number(query.offset) || 0);

  const total = db.get(
    `SELECT COUNT(*) AS n FROM ${entity.table} WHERE ${where.join(' AND ')}`,
    params
  ).n;

  const rows = db.all(
    `SELECT * FROM ${entity.table} WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { rows: attachRefLabels(entity, rows), total, limit, offset };
}

function getRow(req, entityKey, id) {
  const entity = getEntity(entityKey);
  assertEntityAccess(req, entity, 'read');
  const scope = scopeClause(req, entity);
  const row = db.get(
    `SELECT * FROM ${entity.table} WHERE id = ? AND ${scope.sql}`,
    [id, ...scope.params]
  );
  if (!row) throw httpError(404, `${entity.singular} not found.`);
  if (req.scope.role === ROLES.FACULTY && entity.key === 'faculty_availability'
    && Number(row.faculty_id) !== req.scope.facultyId) {
    throw httpError(403, 'You may only view your own availability.', 'ROLE_FORBIDDEN');
  }
  return attachRefLabels(entity, [row])[0];
}

function resolveTargetCollege(req, entity, body) {
  if (!entity.collegeScoped) return null;
  const { scope } = req;
  if (scope.isSuperAdmin) {
    const requested = body.college_id != null ? Number(body.college_id) : scope.activeCollegeId;
    if (requested == null) {
      throw httpError(400, 'Select a college first using the college switcher.', 'NO_ACTIVE_COLLEGE');
    }
    return assertCollegeAccess(req, requested);
  }
  if (scope.homeCollegeId == null) {
    throw httpError(403, 'Your account is not linked to a college.', 'NO_COLLEGE');
  }
  // A coordinator's college_id is forced, whatever the client sent.
  return scope.homeCollegeId;
}

function createRow(req, entityKey, body = {}) {
  const entity = getEntity(entityKey);
  assertEntityAccess(req, entity, 'create');

  const collegeId = resolveTargetCollege(req, entity, body);
  const { values, errors } = buildValues(entity, body, { collegeId });
  if (errors.length) throw validationError(errors);

  const cols = Object.keys(values);
  const params = cols.map((c) => values[c]);
  if (entity.collegeScoped) {
    cols.push('college_id');
    params.push(collegeId);
  }

  applyEntityInvariants(entity, values, collegeId, req);

  const sql = `INSERT INTO ${entity.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  let info;
  try {
    info = db.run(sql, params);
  } catch (err) {
    throw translateDbError(err, entity);
  }
  return getRow(req, entityKey, info.lastInsertRowid);
}

function updateRow(req, entityKey, id, body = {}) {
  const entity = getEntity(entityKey);
  const existing = getRow(req, entityKey, id);
  assertEntityAccess(req, entity, 'update', existing);

  const collegeId = entity.collegeScoped ? Number(existing.college_id) : null;
  if (collegeId != null) assertCollegeAccess(req, collegeId);
  if (entity.key === 'colleges') assertCollegeAccess(req, existing.id);

  const { values, errors } = buildValues(entity, body, { partial: true, collegeId });
  if (errors.length) throw validationError(errors);

  const cols = Object.keys(values);
  if (!cols.length) return existing;

  applyEntityInvariants(entity, { ...existing, ...values }, collegeId, req, id);

  const sql = `UPDATE ${entity.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  try {
    db.run(sql, [...cols.map((c) => values[c]), id]);
  } catch (err) {
    throw translateDbError(err, entity);
  }
  return getRow(req, entityKey, id);
}

function deleteRow(req, entityKey, id) {
  const entity = getEntity(entityKey);
  const existing = getRow(req, entityKey, id);
  assertEntityAccess(req, entity, 'delete', existing);
  if (entity.collegeScoped) assertCollegeAccess(req, existing.college_id);
  if (entity.key === 'colleges') assertCollegeAccess(req, existing.id);

  try {
    db.run(`DELETE FROM ${entity.table} WHERE id = ?`, [id]);
  } catch (err) {
    throw translateDbError(err, entity);
  }
  return { deleted: true, id: Number(id) };
}

/**
 * Cross-field rules that the schema cannot express on its own.
 */
function applyEntityInvariants(entity, values, collegeId, req, existingId = null) {
  if (entity.key === 'college_timings') {
    const start = toMinutes(values.start_time);
    const end = toMinutes(values.end_time);
    if (start != null && end != null && end <= start) {
      throw validationError(['College End Time must be after College Start Time.']);
    }
  }
  if (entity.key === 'college_breaks' || entity.key === 'faculty_availability'
    || entity.key === 'room_availability') {
    const start = toMinutes(values.start_time);
    const end = toMinutes(values.end_time);
    if (start != null && end != null && end <= start) {
      throw validationError(['End Time must be after Start Time.']);
    }
  }
  if (entity.key === 'sub_sections' && values.section_id) {
    const section = db.get('SELECT * FROM sections WHERE id = ?', [values.section_id]);
    if (section) {
      const siblings = db.all(
        `SELECT id, student_count FROM sub_sections WHERE section_id = ?${existingId ? ' AND id <> ?' : ''}`,
        existingId ? [values.section_id, existingId] : [values.section_id]
      );
      const total = siblings.reduce((n, s) => n + (Number(s.student_count) || 0), 0)
        + (Number(values.student_count) || 0);
      if (Number(section.student_count) && total > Number(section.student_count)) {
        throw validationError([
          `Sub-section student counts total ${total}, which exceeds ${section.name}'s `
          + `${section.student_count} students.`,
        ]);
      }
    }
  }
  if (entity.key === 'courses') {
    const hours = (Number(values.lecture_hours) || 0)
      + (Number(values.tutorial_hours) || 0)
      + (Number(values.lab_hours) || 0);
    if (hours === 0) {
      // Not fatal -- the engine infers a single class -- but worth blocking silently
      // creating a course that schedules nothing unexpected.
      values._zeroHours = true;
    }
    if (values.split_mode === 'SPLIT_SUB_SECTIONS' && values.section_id) {
      const subs = db.get(
        'SELECT COUNT(*) AS n FROM sub_sections WHERE section_id = ?',
        [values.section_id]
      ).n;
      if (!subs) {
        throw validationError([
          'Split Mode is "Split into Sub-Sections" but the selected section has no '
          + 'sub-sections yet. Create them first.',
        ]);
      }
    }
  }
  delete values._zeroHours;
}

function validationError(errors) {
  const err = httpError(400, errors[0], 'VALIDATION');
  err.details = errors;
  return err;
}

function translateDbError(err, entity) {
  const msg = String(err && err.message || err);
  if (/UNIQUE constraint failed/i.test(msg)) {
    const col = (msg.split(':')[1] || '').trim();
    return httpError(409, `A ${entity.singular} with the same ${col || 'unique value'} already exists.`, 'DUPLICATE');
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return httpError(409,
      `This ${entity.singular} is still referenced by other records. Remove those first.`, 'IN_USE');
  }
  if (/NOT NULL constraint failed/i.test(msg)) {
    const col = (msg.split(':')[1] || '').trim();
    return httpError(400, `${col || 'A required field'} cannot be empty.`, 'VALIDATION');
  }
  return err;
}

module.exports = {
  listRows,
  getRow,
  createRow,
  updateRow,
  deleteRow,
  assertEntityAccess,
  attachRefLabels,
  buildValues,
  coerceField,
  scopeClause,
  validationError,
  translateDbError,
  resolveTargetCollege,
};
