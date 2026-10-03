'use strict';

/**
 * Timetable versioning and audit (Section 8.4).
 *
 * Every change that could lose work takes a snapshot first, so "revert to the
 * previous version" is always available. A snapshot is the complete set of
 * assignment rows as JSON -- small enough for a college timetable and immune to
 * later schema-level churn in the live tables.
 */

const db = require('../db/connection');

const SNAPSHOT_COLUMNS = [
  'course_id', 'section_id', 'sub_section_id', 'faculty_id', 'room_id',
  'day_of_week', 'start_time', 'end_time', 'slot_index', 'periods',
  'component', 'group_key', 'is_locked', 'is_manual', 'status', 'score',
  'warnings', 'notes',
];

function nextVersionNo(timetableId) {
  const row = db.get(
    'SELECT COALESCE(MAX(version_no), 0) AS n FROM timetable_versions WHERE timetable_id = ?',
    [timetableId]
  );
  return (row.n || 0) + 1;
}

/**
 * Captures the current state of a timetable.
 * @returns {{id:number, versionNo:number, assignments:number}}
 */
function snapshot(timetableId, { label = null, reason = null, userId = null } = {}) {
  const timetable = db.get('SELECT * FROM timetables WHERE id = ?', [timetableId]);
  if (!timetable) {
    const err = new Error('Timetable not found.');
    err.status = 404;
    throw err;
  }
  const rows = db.all('SELECT * FROM assignments WHERE timetable_id = ? ORDER BY id', [timetableId]);
  const payload = rows.map((r) => {
    const out = {};
    for (const col of SNAPSHOT_COLUMNS) out[col] = r[col];
    return out;
  });

  const versionNo = nextVersionNo(timetableId);
  const info = db.run(
    `INSERT INTO timetable_versions
       (timetable_id, college_id, version_no, label, reason, snapshot, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      timetableId, timetable.college_id, versionNo,
      label || `Version ${versionNo}`, reason,
      JSON.stringify({ quality_score: timetable.quality_score, assignments: payload }),
      userId,
    ]
  );
  return { id: info.lastInsertRowid, versionNo, assignments: payload.length };
}

function listVersions(timetableId) {
  const rows = db.all(
    `SELECT v.id, v.version_no, v.label, v.reason, v.created_at, v.created_by,
            u.full_name AS created_by_name, v.snapshot
       FROM timetable_versions v
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.timetable_id = ?
      ORDER BY v.version_no DESC`,
    [timetableId]
  );
  // The snapshot itself is never sent to the client -- only its size and the
  // number of classes it holds, which is all the Versions list needs.
  return rows.map(({ snapshot: raw, ...rest }) => {
    let count = null;
    try {
      const parsed = JSON.parse(raw);
      count = Array.isArray(parsed.assignments) ? parsed.assignments.length : null;
    } catch {
      count = null;
    }
    return { ...rest, assignments: count, size: raw ? raw.length : 0 };
  });
}

/**
 * Restores a version. The state being replaced is itself snapshotted first, so a
 * restore is never a one-way door.
 */
function restoreVersion(versionId, { userId = null } = {}) {
  const version = db.get('SELECT * FROM timetable_versions WHERE id = ?', [versionId]);
  if (!version) {
    const err = new Error('Version not found.');
    err.status = 404;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(version.snapshot);
  } catch {
    const err = new Error('This version\'s snapshot is unreadable.');
    err.status = 500;
    throw err;
  }
  const assignments = Array.isArray(parsed.assignments) ? parsed.assignments : [];

  return db.transaction(() => {
    snapshot(version.timetable_id, {
      label: 'Before restore',
      reason: `Automatic snapshot taken before restoring version ${version.version_no}`,
      userId,
    });

    db.run('DELETE FROM assignments WHERE timetable_id = ?', [version.timetable_id]);
    const cols = ['timetable_id', 'college_id', ...SNAPSHOT_COLUMNS];
    const sql = `INSERT INTO assignments (${cols.join(', ')}) `
      + `VALUES (${cols.map(() => '?').join(', ')})`;
    for (const a of assignments) {
      db.run(sql, [version.timetable_id, version.college_id, ...SNAPSHOT_COLUMNS.map((c) => a[c] ?? null)]);
    }
    if (parsed.quality_score != null) {
      db.run("UPDATE timetables SET quality_score = ?, updated_at = datetime('now') WHERE id = ?",
        [parsed.quality_score, version.timetable_id]);
    } else {
      db.run("UPDATE timetables SET updated_at = datetime('now') WHERE id = ?", [version.timetable_id]);
    }

    audit({
      timetableId: version.timetable_id,
      collegeId: version.college_id,
      action: 'RESTORE_VERSION',
      userId,
      after: { versionId, versionNo: version.version_no, assignments: assignments.length },
    });

    return { restored: assignments.length, versionNo: version.version_no };
  });
}

function deleteVersion(versionId) {
  db.run('DELETE FROM timetable_versions WHERE id = ?', [versionId]);
  return { deleted: true };
}

/** Append-only trail of who changed what. */
function audit({ timetableId = null, assignmentId = null, collegeId = null, action, userId = null, before = null, after = null }) {
  db.run(
    `INSERT INTO assignment_audit
       (timetable_id, assignment_id, college_id, action, actor_user_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      timetableId, assignmentId, collegeId, action, userId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ]
  );
}

function listAudit(timetableId, limit = 100) {
  return db.all(
    `SELECT a.*, u.full_name AS actor_name
       FROM assignment_audit a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.timetable_id = ?
      ORDER BY a.id DESC LIMIT ?`,
    [timetableId, limit]
  );
}

module.exports = {
  SNAPSHOT_COLUMNS,
  snapshot,
  listVersions,
  restoreVersion,
  deleteVersion,
  audit,
  listAudit,
};
