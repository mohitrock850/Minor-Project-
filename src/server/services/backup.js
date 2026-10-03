'use strict';

/**
 * Backup, restore and reset (Section 15).
 *
 * A backup is simply a copy of the SQLite file. That is the whole point of using
 * an embedded database: one file holds every college, every timetable and every
 * version, so a copy of it is a complete, self-contained snapshot that can be put
 * on a USB stick and restored onto another machine.
 *
 * Restoring is deliberately careful. Before anything is overwritten the current
 * database is copied aside as a safety snapshot, the incoming file is opened
 * read-only and checked for our schema (so a random .db cannot be loaded by
 * mistake), and only then is the live file replaced and reopened.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./../db/connection');
const settings = require('./settings');

const BACKUP_DIR_NAME = 'backups';
const FILE_PREFIX = 'timetable-backup';

/** Tables that hold university data, as opposed to machine settings. */
const KEEP_TABLES = new Set(['schema_meta', 'app_settings']);

function dbPath() {
  const p = db.getDbPath();
  if (!p) {
    const err = new Error('The database is not open, so it cannot be backed up.');
    err.status = 500;
    throw err;
  }
  return p;
}

function backupDir() {
  const dir = path.join(path.dirname(dbPath()), BACKUP_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `timetable-backup-2026-05-04-1712.db` -- sortable and readable. */
function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Flushes anything sitting in the write-ahead log into the main file so that a
 * plain file copy is complete on its own.
 */
function checkpoint() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Not in WAL mode (the WASM driver's default), so there is nothing to flush.
  }
}

function describeFile(filePath) {
  let stat = null;
  try { stat = fs.statSync(filePath); } catch { return null; }
  return {
    name: path.basename(filePath),
    path: filePath,
    bytes: stat.size,
    size: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
    createdAt: stat.mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
function info() {
  const live = describeFile(dbPath());
  const counts = {};
  for (const key of ['colleges', 'courses', 'faculty', 'rooms', 'sections', 'students', 'assignments']) {
    try { counts[key] = db.get(`SELECT COUNT(*) AS n FROM ${key}`).n; } catch { counts[key] = null; }
  }
  return {
    database: live,
    directory: backupDir(),
    driver: db.getDriverName(),
    schemaVersion: db.SCHEMA_VERSION,
    lastBackupAt: settings.getSetting('last_backup_at') || null,
    seeded: settings.getBool('seeded'),
    counts,
    backups: list(),
    note: 'A backup is one file containing everything. Keep a copy somewhere other than this machine.',
  };
}

function list() {
  let names = [];
  try { names = fs.readdirSync(backupDir()); } catch { return []; }
  return names
    .filter((n) => /\.(db|sqlite|sqlite3)$/i.test(n))
    .map((n) => describeFile(path.join(backupDir(), n)))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function resolveBackup(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== String(name)) {
    const err = new Error('That is not a backup in this folder.');
    err.status = 400;
    err.code = 'VALIDATION';
    throw err;
  }
  const full = path.join(backupDir(), base);
  if (!fs.existsSync(full)) {
    const err = new Error(`"${base}" no longer exists in the backup folder.`);
    err.status = 404;
    throw err;
  }
  return full;
}

/** The bytes of a backup, so a machine on the LAN can download one. */
function readBackup(name) {
  const full = resolveBackup(name);
  return { filename: path.basename(full), buffer: fs.readFileSync(full) };
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *   label      optional text folded into the filename
 *   targetPath optional absolute path (used by the desktop "Save As" dialog)
 */
function create(opts = {}) {
  checkpoint();
  const source = dbPath();
  const label = String(opts.label || '').trim().replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, '-');
  const filename = `${FILE_PREFIX}-${stamp()}${label ? `-${label}` : ''}.db`;
  const target = opts.targetPath ? String(opts.targetPath) : path.join(backupDir(), filename);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);

  const now = new Date().toISOString();
  settings.setSetting('last_backup_at', now);

  return {
    ...describeFile(target),
    createdAt: now,
    message: `Backed up to ${target}`,
  };
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/**
 * Opens a candidate file with the same driver and checks it is one of ours.
 * Done before the live database is touched, so a bad file changes nothing.
 */
function inspectCandidate(filePath) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
    const err = new Error('That file is not a SQLite database, so it is not a backup of this application.');
    err.status = 400;
    err.code = 'NOT_A_BACKUP';
    throw err;
  }

  // Open it separately -- never through the live connection.
  let probe = null;
  let read = null;
  // A backup file carries no lock of its own, but one can be left beside it by a
  // process that died while it was being inspected. Clearing that first stops an
  // interrupted inspection from making a perfectly good backup look unreadable.
  db.clearStaleLock(filePath);
  try {
    // eslint-disable-next-line global-require
    const { Database } = require('node-sqlite3-wasm');
    probe = new Database(filePath);
    read = (sql) => probe.get(sql, []);
  } catch {
    try {
      // eslint-disable-next-line global-require
      const Native = require('better-sqlite3');
      probe = new Native(filePath, { readonly: true });
      read = (sql) => probe.prepare(sql).get();
    } catch (err) {
      const e = new Error('That backup could not be opened for checking.');
      e.status = 400;
      e.code = 'NOT_A_BACKUP';
      e.details = [String(err.message || err)];
      throw e;
    }
  }

  try {
    const table = read(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assignments'`
    );
    if (!table) {
      const err = new Error(
        'That database does not contain this application\'s tables, so it is not a timetable backup.'
      );
      err.status = 400;
      err.code = 'NOT_A_BACKUP';
      throw err;
    }
    let version = null;
    try {
      const row = read(`SELECT value FROM schema_meta WHERE key = 'schema_version'`);
      version = row ? row.value : null;
    } catch { version = null; }
    const counts = {};
    for (const key of ['colleges', 'assignments', 'courses', 'faculty', 'rooms']) {
      try { counts[key] = read(`SELECT COUNT(*) AS n FROM ${key}`).n; } catch { counts[key] = null; }
    }
    return {
      schemaVersion: version,
      versionMatches: version === db.SCHEMA_VERSION,
      counts,
    };
  } finally {
    try { probe.close(); } catch { /* nothing useful to do */ }
  }
}

/** Read a backup's details without restoring it -- powers the confirmation dialog. */
function inspect(filePathOrName) {
  const full = path.isAbsolute(String(filePathOrName))
    ? String(filePathOrName)
    : resolveBackup(filePathOrName);
  if (!fs.existsSync(full)) {
    const err = new Error('That file no longer exists.');
    err.status = 404;
    throw err;
  }
  const details = inspectCandidate(full);
  return {
    ...describeFile(full),
    ...details,
    warning: details.versionMatches
      ? null
      : `This backup was made by schema version ${details.schemaVersion || 'unknown'} and this `
        + `application is version ${db.SCHEMA_VERSION}. Restoring it may not work.`,
  };
}

/**
 * Replaces the live database with a backup.
 *
 * @param {string} filePathOrName absolute path, or a filename in the backup folder
 * @param {object} opts  allowVersionMismatch -- restore even if the schema version differs
 * @returns {{restored:true, from:object, safetyCopy:string}}
 */
function restore(filePathOrName, opts = {}) {
  const source = path.isAbsolute(String(filePathOrName))
    ? String(filePathOrName)
    : resolveBackup(filePathOrName);
  const details = inspect(source);
  if (!details.versionMatches && !opts.allowVersionMismatch) {
    const err = new Error(details.warning);
    err.status = 400;
    err.code = 'SCHEMA_MISMATCH';
    err.canOverride = true;
    err.overrideHint = 'Restore it anyway by confirming the version warning.';
    throw err;
  }

  const live = dbPath();
  checkpoint();

  // Safety net: whatever is being replaced is kept, so a mistaken restore is
  // itself undoable.
  const safety = path.join(backupDir(), `${FILE_PREFIX}-replaced-${stamp()}.db`);
  fs.copyFileSync(live, safety);

  db.closeDatabase();
  try {
    fs.copyFileSync(source, live);
    // Any journal left over from the old database would contradict the new file.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { fs.rmSync(`${live}${suffix}`, { force: true }); } catch { /* nothing to remove */ }
    }
  } catch (err) {
    // Put back what was there before failing.
    try { fs.copyFileSync(safety, live); } catch { /* the safety copy is still on disk */ }
    db.openDatabase(live);
    const e = new Error(`The backup could not be restored: ${err.message}`);
    e.status = 500;
    throw e;
  }
  db.openDatabase(live);

  return {
    restored: true,
    from: details,
    safetyCopy: safety,
    message: `Restored from ${path.basename(source)}. The database that was replaced was saved as `
      + `${path.basename(safety)} in case you need it back.`,
  };
}

// ---------------------------------------------------------------------------
// Reset to empty
// ---------------------------------------------------------------------------

/**
 * Clears every piece of university data, leaving the machine settings and one
 * login so nobody is locked out. Used to get rid of the demo colleges.
 *
 * @param {object} opts keepUserId -- the account performing the reset
 */
function resetToEmpty(opts = {}) {
  const auto = create({ label: 'before-reset' });

  const tables = db.all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  ).map((r) => r.name).filter((n) => !KEEP_TABLES.has(n));

  const keepUserId = opts.keepUserId != null ? Number(opts.keepUserId) : null;
  const keptUser = keepUserId != null ? db.get('SELECT * FROM users WHERE id = ?', [keepUserId]) : null;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const table of tables) db.run(`DELETE FROM ${table}`);
      if (keptUser) {
        // The account doing the reset survives, detached from any college so it
        // can still sign in and start again.
        db.run(
          `INSERT INTO users (id, username, password_hash, full_name, email, role, college_id,
                              faculty_id, student_id, status)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'ACTIVE')`,
          [
            keptUser.id, keptUser.username, keptUser.password_hash, keptUser.full_name,
            keptUser.email, keptUser.role,
          ]
        );
      }
      // Reclaim the autoincrement counters so a fresh start really looks fresh.
      try { db.run(`DELETE FROM sqlite_sequence`); } catch { /* table absent without AUTOINCREMENT */ }
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  settings.setSetting('seeded', '0');

  return {
    reset: true,
    tablesCleared: tables.length,
    keptUser: keptUser ? { id: keptUser.id, username: keptUser.username, role: keptUser.role } : null,
    backup: auto,
    message: 'Every college, course, room and timetable has been removed. A backup of what was there '
      + `was saved as ${auto.name} first.`
      + (keptUser ? ' Your own login still works.' : ''),
  };
}

function remove(name) {
  const full = resolveBackup(name);
  fs.rmSync(full, { force: true });
  return { deleted: true, name: path.basename(full) };
}

module.exports = {
  info,
  list,
  create,
  inspect,
  restore,
  resetToEmpty,
  remove,
  readBackup,
  backupDir,
};
