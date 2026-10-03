'use strict';

/**
 * Role and scope enforcement (Section 12).
 *
 * This is the authoritative layer: every read and write goes through
 * `req.scope`, which is derived from the signed token and never from anything
 * the client sends. Hiding controls in the UI is treated as cosmetic only.
 *
 *   SUPER_ADMIN     -- any college; picks the active one via the college switcher
 *   COLLEGE_ADMIN   -- pinned to exactly one college ("Timetable Coordinator")
 *   FACULTY         -- read-only, own timetable; may edit only own availability
 *   STUDENT         -- read-only, own section's timetable
 */

const db = require('../db/connection');
const { verifyToken } = require('./tokens');

const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  COLLEGE_ADMIN: 'COLLEGE_ADMIN',
  FACULTY: 'FACULTY',
  STUDENT: 'STUDENT',
};

/** Roles allowed to create/modify data and timetables. */
const WRITE_ROLES = [ROLES.SUPER_ADMIN, ROLES.COLLEGE_ADMIN];

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function readToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}

function requireAuth(req, res, next) {
  const token = readToken(req);
  const payload = verifyToken(token);
  if (!payload) {
    return next(httpError(401, 'Your session has expired. Please sign in again.', 'UNAUTHENTICATED'));
  }
  const user = db.get(
    `SELECT id, username, role, full_name, email, college_id, faculty_id, student_id,
            can_edit_own_availability, status
       FROM users WHERE id = ?`,
    [payload.sub]
  );
  if (!user || user.status !== 'ACTIVE') {
    return next(httpError(401, 'This account is no longer active.', 'ACCOUNT_INACTIVE'));
  }

  req.user = user;
  req.scope = buildScope(req, user);
  return next();
}

/**
 * Determines the college the request operates in.
 * Non-super-admins can never widen this, whatever they send.
 */
function buildScope(req, user) {
  const isSuper = user.role === ROLES.SUPER_ADMIN;

  let activeCollegeId = null;
  if (isSuper) {
    const requested = req.get('x-active-college')
      || (req.query && req.query.collegeId)
      || (req.body && req.body.collegeId);
    activeCollegeId = requested != null && requested !== '' ? Number(requested) : null;
    if (activeCollegeId != null && Number.isNaN(activeCollegeId)) activeCollegeId = null;
  } else {
    activeCollegeId = user.college_id != null ? Number(user.college_id) : null;
  }

  // Section 12: a student is scoped by section_id, so resolve it here once from
  // their linked record rather than trusting anything the client sends.
  let sectionId = null;
  let subSectionId = null;
  if (user.role === ROLES.STUDENT && user.student_id != null) {
    const student = db.get(
      'SELECT section_id, sub_section_id FROM students WHERE id = ?', [user.student_id]
    );
    if (student) {
      sectionId = student.section_id != null ? Number(student.section_id) : null;
      subSectionId = student.sub_section_id != null ? Number(student.sub_section_id) : null;
    }
  }

  return {
    userId: user.id,
    role: user.role,
    isSuperAdmin: isSuper,
    isCoordinator: user.role === ROLES.COLLEGE_ADMIN,
    canWrite: WRITE_ROLES.includes(user.role),
    homeCollegeId: user.college_id != null ? Number(user.college_id) : null,
    activeCollegeId,
    facultyId: user.faculty_id != null ? Number(user.faculty_id) : null,
    studentId: user.student_id != null ? Number(user.student_id) : null,
    sectionId,
    subSectionId,
    canEditOwnAvailability: !!user.can_edit_own_availability,
  };
}

/** Requires an explicit college context and that the caller may use it. */
function requireCollege(req) {
  const { scope } = req;
  if (scope.activeCollegeId == null) {
    throw httpError(
      400,
      scope.isSuperAdmin
        ? 'Select a college first using the college switcher.'
        : 'Your account is not linked to a college. Ask a Super Admin to assign one.',
      'NO_ACTIVE_COLLEGE'
    );
  }
  assertCollegeAccess(req, scope.activeCollegeId);
  return scope.activeCollegeId;
}

/** Throws unless the caller is entitled to touch `collegeId`. */
function assertCollegeAccess(req, collegeId) {
  const { scope } = req;
  const id = Number(collegeId);
  if (scope.isSuperAdmin) return id;
  if (scope.homeCollegeId != null && scope.homeCollegeId === id) return id;
  throw httpError(403, 'You do not have access to this college\'s data.', 'COLLEGE_FORBIDDEN');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'Authentication required.'));
    if (!roles.includes(req.user.role)) {
      return next(httpError(403, 'Your role does not permit this action.', 'ROLE_FORBIDDEN'));
    }
    return next();
  };
}

/** Data management + timetable authoring: Super Admin or the college's coordinator. */
const requireCoordinator = requireRole(ROLES.SUPER_ADMIN, ROLES.COLLEGE_ADMIN);

const requireSuperAdmin = requireRole(ROLES.SUPER_ADMIN);

/**
 * Every college-scoped read is filtered through this so a Timetable Coordinator
 * physically cannot receive another college's rows.
 */
function collegeFilter(req, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const { scope } = req;
  if (scope.isSuperAdmin) {
    if (scope.activeCollegeId != null) {
      return { sql: `${prefix}college_id = ?`, params: [scope.activeCollegeId] };
    }
    return { sql: '1 = 1', params: [] };     // university-wide roll-up
  }
  if (scope.homeCollegeId == null) {
    return { sql: '1 = 0', params: [] };     // linked to nothing -> sees nothing
  }
  return { sql: `${prefix}college_id = ?`, params: [scope.homeCollegeId] };
}

/** Colleges the caller may see, for the switcher and for roll-up views. */
function visibleColleges(req) {
  const { scope } = req;
  if (scope.isSuperAdmin) {
    return db.all(
      `SELECT c.*, u.name AS university_name FROM colleges c
         LEFT JOIN universities u ON u.id = c.university_id
        ORDER BY u.name, c.name`
    );
  }
  if (scope.homeCollegeId == null) return [];
  return db.all(
    `SELECT c.*, u.name AS university_name FROM colleges c
       LEFT JOIN universities u ON u.id = c.university_id
      WHERE c.id = ?`,
    [scope.homeCollegeId]
  );
}

module.exports = {
  ROLES,
  WRITE_ROLES,
  httpError,
  requireAuth,
  requireRole,
  requireCoordinator,
  requireSuperAdmin,
  requireCollege,
  assertCollegeAccess,
  collegeFilter,
  visibleColleges,
  buildScope,
};
