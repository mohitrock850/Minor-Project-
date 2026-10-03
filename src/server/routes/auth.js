'use strict';

/**
 * Authentication and user accounts (Section 12).
 *
 * Login is the only unauthenticated endpoint in the whole API. Everything else
 * derives its permissions from the signed token, never from the request body.
 */

const express = require('express');
const db = require('../db/connection');
const { hashPassword, verifyPassword, issueToken, TOKEN_TTL_SECONDS } = require('../auth/tokens');
const {
  ROLES, httpError, requireAuth, requireCoordinator, visibleColleges, assertCollegeAccess,
} = require('../auth/middleware');

const router = express.Router();

const PUBLIC_USER_COLUMNS = `id, username, role, full_name, email, college_id, faculty_id,
  student_id, can_edit_own_availability, status, last_login_at, created_at`;

function publicUser(row) {
  if (!row) return null;
  const { password_hash: _ignored, ...rest } = row;
  return rest;
}

/** What the shell needs on every page: who am I, where can I work, what may I do. */
function sessionPayload(req, user) {
  const colleges = visibleColleges(req);
  return {
    user: publicUser(user),
    scope: req.scope,
    colleges,
    permissions: {
      canManageData: req.scope.canWrite,
      canGenerate: req.scope.canWrite,
      canEditTimetable: req.scope.canWrite,
      canSwitchCollege: req.scope.isSuperAdmin,
      canManageUsers: req.scope.canWrite,
      canManageUniversities: req.scope.isSuperAdmin,
      canEditOwnAvailability: req.scope.role === ROLES.FACULTY && req.scope.canEditOwnAvailability,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post('/login', (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) {
      throw httpError(400, 'Enter your username and password.', 'VALIDATION');
    }

    const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
    // Same message either way: never reveal whether a username exists.
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw httpError(401, 'Incorrect username or password.', 'BAD_CREDENTIALS');
    }
    if (user.status !== 'ACTIVE') {
      throw httpError(403, 'This account has been deactivated. Ask an administrator to re-enable it.', 'ACCOUNT_INACTIVE');
    }

    db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [user.id]);
    const token = issueToken(user);

    // Build the scope for the response using the freshly-issued identity.
    const { buildScope } = require('../auth/middleware');
    req.user = user;
    req.scope = buildScope(req, user);

    res.json({
      token,
      expiresInSeconds: TOKEN_TTL_SECONDS,
      ...sessionPayload(req, user),
    });
  } catch (err) {
    next(err);
  }
});

// Everything below needs a valid token.
router.use(requireAuth);

router.get('/me', (req, res, next) => {
  try {
    res.json(sessionPayload(req, req.user));
  } catch (err) {
    next(err);
  }
});

/** Change your own password. */
router.post('/password', (req, res, next) => {
  try {
    const current = String((req.body && req.body.currentPassword) || '');
    const next_ = String((req.body && req.body.newPassword) || '');
    const row = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(current, row.password_hash)) {
      throw httpError(400, 'Your current password is not correct.', 'BAD_CREDENTIALS');
    }
    if (next_.length < 6) {
      throw httpError(400, 'Choose a password of at least 6 characters.', 'VALIDATION');
    }
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(next_), req.user.id]);
    res.json({ changed: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// User accounts -- Super Admin (any college) / Coordinator (own college)
// ---------------------------------------------------------------------------
router.use('/users', requireCoordinator);

/** A coordinator may never create or touch an account outside their college. */
function assertUserManageable(req, target) {
  const { scope } = req;
  if (scope.isSuperAdmin) return;
  if (target.role === ROLES.SUPER_ADMIN) {
    throw httpError(403, 'Only a Super Admin can manage Super Admin accounts.', 'ROLE_FORBIDDEN');
  }
  if (target.college_id == null || Number(target.college_id) !== scope.homeCollegeId) {
    throw httpError(403, 'That account belongs to another college.', 'COLLEGE_FORBIDDEN');
  }
}

router.get('/users', (req, res, next) => {
  try {
    const { scope } = req;
    const where = [];
    const params = [];
    if (!scope.isSuperAdmin) {
      where.push('college_id = ?');
      params.push(scope.homeCollegeId);
      where.push('role <> ?');
      params.push(ROLES.SUPER_ADMIN);
    } else if (scope.activeCollegeId != null) {
      where.push('(college_id = ? OR role = ?)');
      params.push(scope.activeCollegeId, ROLES.SUPER_ADMIN);
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push('(username LIKE ? OR full_name LIKE ? OR email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const sql = `SELECT ${PUBLIC_USER_COLUMNS} FROM users`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY role, username';
    const rows = db.all(sql, params);

    // The link targets a coordinator needs when creating faculty/student logins.
    res.json({
      rows,
      total: rows.length,
      roles: Object.values(ROLES),
      linkable: {
        faculty: scope.activeCollegeId || scope.homeCollegeId
          ? db.all(
            `SELECT f.id, f.name, f.employee_id,
                    (SELECT COUNT(*) FROM users u WHERE u.faculty_id = f.id) AS has_login
               FROM faculty f WHERE f.college_id = ? ORDER BY f.name`,
            [scope.activeCollegeId || scope.homeCollegeId]
          )
          : [],
        students: scope.activeCollegeId || scope.homeCollegeId
          ? db.all(
            `SELECT s.id, s.name, s.enrollment_number, s.section_id,
                    (SELECT COUNT(*) FROM users u WHERE u.student_id = s.id) AS has_login
               FROM students s WHERE s.college_id = ? ORDER BY s.name LIMIT 2000`,
            [scope.activeCollegeId || scope.homeCollegeId]
          )
          : [],
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/users', (req, res, next) => {
  try {
    const { scope } = req;
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || '').toUpperCase();

    if (!username) throw httpError(400, 'A username is required.', 'VALIDATION');
    if (password.length < 6) throw httpError(400, 'Choose a password of at least 6 characters.', 'VALIDATION');
    if (!Object.values(ROLES).includes(role)) {
      throw httpError(400, `Role must be one of: ${Object.values(ROLES).join(', ')}.`, 'VALIDATION');
    }
    if (role === ROLES.SUPER_ADMIN && !scope.isSuperAdmin) {
      throw httpError(403, 'Only a Super Admin can create another Super Admin.', 'ROLE_FORBIDDEN');
    }

    let collegeId = null;
    if (role !== ROLES.SUPER_ADMIN) {
      collegeId = scope.isSuperAdmin
        ? (body.collegeId != null ? Number(body.collegeId) : scope.activeCollegeId)
        : scope.homeCollegeId;
      if (collegeId == null) {
        throw httpError(400, 'Select the college this account belongs to.', 'NO_ACTIVE_COLLEGE');
      }
      assertCollegeAccess(req, collegeId);
    }

    let facultyId = null;
    let studentId = null;
    if (role === ROLES.FACULTY) {
      facultyId = body.facultyId != null ? Number(body.facultyId) : null;
      if (facultyId == null) throw httpError(400, 'Link this login to a faculty record.', 'VALIDATION');
      const fac = db.get('SELECT * FROM faculty WHERE id = ? AND college_id = ?', [facultyId, collegeId]);
      if (!fac) throw httpError(400, 'That faculty record is not in this college.', 'VALIDATION');
    }
    if (role === ROLES.STUDENT) {
      studentId = body.studentId != null ? Number(body.studentId) : null;
      if (studentId == null) throw httpError(400, 'Link this login to a student record.', 'VALIDATION');
      const stu = db.get('SELECT * FROM students WHERE id = ? AND college_id = ?', [studentId, collegeId]);
      if (!stu) throw httpError(400, 'That student record is not in this college.', 'VALIDATION');
    }

    if (db.get('SELECT id FROM users WHERE username = ?', [username])) {
      throw httpError(409, `The username "${username}" is already taken.`, 'DUPLICATE');
    }

    const info = db.run(
      `INSERT INTO users
         (username, password_hash, role, full_name, email, college_id, faculty_id, student_id,
          can_edit_own_availability, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username, hashPassword(password), role,
        body.fullName || body.full_name || null, body.email || null,
        collegeId, facultyId, studentId,
        body.canEditOwnAvailability === false ? 0 : 1,
        body.status ? String(body.status).toUpperCase() : 'ACTIVE',
      ]
    );
    res.status(201).json(db.get(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`, [info.lastInsertRowid]));
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const target = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) throw httpError(404, 'User not found.');
    assertUserManageable(req, target);

    const body = req.body || {};
    const sets = [];
    const params = [];
    const set = (col, value) => { sets.push(`${col} = ?`); params.push(value); };

    if (body.fullName !== undefined || body.full_name !== undefined) {
      set('full_name', body.fullName ?? body.full_name ?? null);
    }
    if (body.email !== undefined) set('email', body.email || null);
    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!['ACTIVE', 'INACTIVE'].includes(status)) {
        throw httpError(400, 'Status must be ACTIVE or INACTIVE.', 'VALIDATION');
      }
      if (status !== 'ACTIVE' && id === req.user.id) {
        throw httpError(400, 'You cannot deactivate your own account.', 'VALIDATION');
      }
      set('status', status);
    }
    if (body.canEditOwnAvailability !== undefined) {
      set('can_edit_own_availability', body.canEditOwnAvailability ? 1 : 0);
    }
    if (body.role !== undefined && String(body.role).toUpperCase() !== target.role) {
      const role = String(body.role).toUpperCase();
      if (!Object.values(ROLES).includes(role)) throw httpError(400, 'Unknown role.', 'VALIDATION');
      if ((role === ROLES.SUPER_ADMIN || target.role === ROLES.SUPER_ADMIN) && !req.scope.isSuperAdmin) {
        throw httpError(403, 'Only a Super Admin can change Super Admin accounts.', 'ROLE_FORBIDDEN');
      }
      if (id === req.user.id) throw httpError(400, 'You cannot change your own role.', 'VALIDATION');
      set('role', role);
    }
    if (!sets.length) return res.json(db.get(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`, [id]));

    db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return res.json(db.get(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`, [id]));
  } catch (err) {
    return next(err);
  }
});

/** Administrative password reset. */
router.post('/users/:id/password', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const target = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) throw httpError(404, 'User not found.');
    assertUserManageable(req, target);
    const password = String((req.body && req.body.password) || '');
    if (password.length < 6) throw httpError(400, 'Choose a password of at least 6 characters.', 'VALIDATION');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), id]);
    res.json({ reset: true, username: target.username });
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) throw httpError(400, 'You cannot delete the account you are signed in with.', 'VALIDATION');
    const target = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!target) throw httpError(404, 'User not found.');
    assertUserManageable(req, target);
    if (target.role === ROLES.SUPER_ADMIN) {
      const others = db.get(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' AND id <> ?", [id]
      ).n;
      if (!others) throw httpError(400, 'This is the last active Super Admin -- create another one first.', 'VALIDATION');
    }
    db.run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ deleted: true, id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
