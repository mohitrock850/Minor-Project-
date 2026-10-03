'use strict';

/**
 * Database layer.
 *
 * The whole server talks to SQLite through the small adapter exported here
 * (`all` / `get` / `run` / `exec` / `transaction`) and never touches a driver
 * object directly. That indirection exists for a concrete reason: the default
 * driver is `node-sqlite3-wasm`, a WebAssembly build of SQLite that needs no
 * native compilation, so `npm install` and the electron-builder packaging step
 * work on a plain Windows machine with no Visual Studio C++ toolchain. If a
 * native `better-sqlite3` is present it is preferred automatically for speed.
 *
 * See DECISIONS.md ("SQLite driver") for the full rationale.
 *
 * All SQL in this project uses positional `?` parameters so that neither
 * driver's named-parameter dialect can leak into query code.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = '1.0.0';

// How long SQLite waits on a lock held by someone else before giving up.
const BUSY_TIMEOUT_MS = 5000;

let driverName = null;
let raw = null;         // the underlying driver database object
let dbFilePath = null;
let impl = null;        // normalised { all, get, run, exec, close }
let exitHookInstalled = false;

// ---------------------------------------------------------------------------
// Driver loading
// ---------------------------------------------------------------------------
function loadDriver(filePath) {
  // 1. Native better-sqlite3, if it happens to be installed and built.
  try {
    const Native = require('better-sqlite3');
    const db = new Native(filePath);
    db.pragma('journal_mode = WAL');
    return {
      name: 'better-sqlite3',
      raw: db,
      impl: {
        all: (sql, params) => db.prepare(sql).all(...params),
        get: (sql, params) => db.prepare(sql).get(...params),
        run: (sql, params) => {
          const info = db.prepare(sql).run(...params);
          return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
        },
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
      },
    };
  } catch {
    /* fall through to the WASM driver */
  }

  // 2. WASM SQLite -- no native build step, works everywhere.
  const { Database } = require('node-sqlite3-wasm');
  const db = new Database(filePath);
  return {
    name: 'node-sqlite3-wasm',
    raw: db,
    impl: {
      all: (sql, params) => db.all(sql, params),
      get: (sql, params) => db.get(sql, params),
      run: (sql, params) => {
        const info = db.run(sql, params);
        return {
          changes: info ? info.changes : 0,
          lastInsertRowid: info ? Number(info.lastInsertRowid) : 0,
        };
      },
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    },
  };
}

// ---------------------------------------------------------------------------
// Locks left behind by a process that is gone
//
// `node-sqlite3-wasm` cannot use the operating system's file locks from inside
// WebAssembly, so it locks by creating a *directory* beside the database and
// removing it again afterwards:
//
//     lock:   fs.mkdirSync(`${file}.lock`)   -- EEXIST means "someone else has it"
//     unlock: fs.rmdirSync(`${file}.lock`)
//
// The existence of that directory is the whole lock, and it records nothing
// about who holds it. So if a process dies without unlocking -- a crash, End
// Task, a power cut, or the installer stopping a running copy in order to
// replace it -- the directory survives and every later start fails with
// "database is locked", for ever, with no way out but deleting it by hand. A
// busy timeout cannot help: nothing is going to release it.
//
// So the missing half of the lock is recorded here. While the database is open
// there is a `<file>.owner` file naming the process that opened it, removed on
// close. On hitting a lock we can then tell the two situations apart: a live
// owner means a genuine second copy and is reported as such, while no owner (or
// a dead one) means the lock is debris and is cleared so the application opens.
// ---------------------------------------------------------------------------

const lockPathFor = (file) => `${file}.lock`;
const ownerPathFor = (file) => `${file}.owner`;

function readOwner(file) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPathFor(file), 'utf8'));
    return owner && typeof owner === 'object' ? owner : null;
  } catch {
    return null; // absent, unreadable or not ours to interpret
  }
}

function writeOwner(file) {
  try {
    fs.writeFileSync(ownerPathFor(file), `${JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      since: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch {
    // Not fatal: without it a future stale lock is simply assumed stale, which
    // is the same conclusion this file would have led to.
  }
}

function clearOwner(file) {
  try { fs.rmSync(ownerPathFor(file), { force: true }); } catch { /* nothing there */ }
}

/** True while the process that opened the database is still running. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 tests for existence without touching it
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // alive, but owned by another user
  }
}

function isLockedError(err) {
  const message = String((err && err.message) || err || '').toLowerCase();
  return message.includes('database is locked')
    || message.includes('sqlite_busy')
    || (err && err.code === 'SQLITE_BUSY');
}

/**
 * Removes the lock directory when whoever made it is demonstrably gone.
 *
 * @returns {string|null} why it was cleared, or null to leave it alone.
 */
function clearStaleLock(file) {
  const lock = lockPathFor(file);
  let stat;
  try {
    stat = fs.statSync(lock);
  } catch {
    return null; // no lock: whatever went wrong, it was not this
  }
  if (!stat.isDirectory()) return null;
  // The driver only ever makes this empty. Anything inside it was put there by
  // something else, and deleting other people's files is not this function's
  // job.
  try {
    if (fs.readdirSync(lock).length) return null;
  } catch {
    return null;
  }

  const owner = readOwner(file);
  let why;
  if (!owner) {
    why = 'nothing claimed it';
  } else if (owner.host && owner.host !== os.hostname()) {
    return null; // another machine's, over a shared folder: not ours to clear
  } else if (!processAlive(owner.pid)) {
    why = `process ${owner.pid} is no longer running`;
  } else {
    return null; // genuinely in use
  }

  try {
    fs.rmdirSync(lock);
  } catch (err) {
    if (err && err.code !== 'ENOENT') return null;
  }
  clearOwner(file);
  return why;
}

/** The message for a lock that is real, in place of "database is locked". */
function inUseError(file) {
  const owner = readOwner(file);
  const who = owner && owner.pid
    ? ` It is open in process ${owner.pid}${owner.host ? ` on ${owner.host}` : ''}`
      + `${owner.since ? `, since ${owner.since}` : ''}.`
    : '';
  const err = new Error(
    'The database is already in use by another copy of the application.'
    + `${who} Close it and try again.`
  );
  err.code = 'DATABASE_IN_USE';
  err.databasePath = file;
  return err;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** One attempt: open, configure, apply the schema. Leaves nothing behind if it throws. */
function openOnce(filePath) {
  const loaded = loadDriver(filePath);
  driverName = loaded.name;
  raw = loaded.raw;
  impl = loaded.impl;

  try {
    // Waiting is right for a lock somebody is about to release; it does nothing
    // for an abandoned one, which is what clearStaleLock is for.
    impl.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    impl.exec('PRAGMA foreign_keys = ON');

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    impl.exec(schema);

    run(
      `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [SCHEMA_VERSION]
    );
  } catch (err) {
    try { impl.close(); } catch { /* it may never have opened */ }
    impl = null;
    raw = null;
    driverName = null;
    throw err;
  }
  return module.exports;
}

/**
 * Opens the database, recovering by itself from a lock left behind by a process
 * that is no longer running.
 *
 * @param {string} filePath
 * @param {{log?: (message: string) => void}} [options] `log` is told about any
 *   recovery, so the reason ends up in the application log rather than nowhere.
 */
function openDatabase(filePath, options = {}) {
  if (impl) return module.exports;
  const log = typeof options.log === 'function' ? options.log : () => {};
  dbFilePath = filePath;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // A lock whose owner is gone can be cleared before trying, so the first
  // attempt is also the successful one.
  const before = clearStaleLock(filePath);
  if (before) log(`database: cleared a lock left behind (${before})`);

  let result;
  try {
    result = openOnce(filePath);
  } catch (err) {
    if (!isLockedError(err)) throw err;
    // Something acquired it between the check above and here, or the lock was
    // taken mid-open. One more look, then report it honestly.
    const why = clearStaleLock(filePath);
    if (!why) throw inUseError(filePath);
    log(`database: cleared a lock left behind (${why})`);
    result = openOnce(filePath);
  }

  writeOwner(filePath);
  installExitHook();
  return result;
}

/**
 * Last resort against leaking a lock: closing is synchronous, so it can still
 * run while the process is on its way out, which an async quit handler cannot
 * be relied upon to do. It cannot help a process that is killed outright --
 * that is what the recovery above is for.
 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    try { closeDatabase(); } catch { /* going away regardless */ }
  });
}

function ensureOpen() {
  if (!impl) throw new Error('Database has not been opened yet.');
}

// ---------------------------------------------------------------------------
// Query surface
// ---------------------------------------------------------------------------
function all(sql, params = []) {
  ensureOpen();
  return impl.all(sql, normalise(params)) || [];
}

function get(sql, params = []) {
  ensureOpen();
  // The two drivers disagree on "no row" (undefined vs null); callers see null.
  const row = impl.get(sql, normalise(params));
  return row === undefined ? null : row;
}

function run(sql, params = []) {
  ensureOpen();
  return impl.run(sql, normalise(params));
}

function exec(sql) {
  ensureOpen();
  return impl.exec(sql);
}

/** Booleans and undefined are not portable across drivers -- normalise them. */
function normalise(params) {
  if (!Array.isArray(params)) return [params === undefined ? null : params];
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

let txDepth = 0;

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction via
 * savepoints so services can compose without worrying about who started it.
 */
function transaction(fn) {
  ensureOpen();
  const depth = txDepth;
  const savepoint = `sp_${depth}`;
  if (depth === 0) exec('BEGIN');
  else exec(`SAVEPOINT ${savepoint}`);
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    if (depth === 0) exec('COMMIT');
    else exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    txDepth -= 1;
    try {
      if (depth === 0) exec('ROLLBACK');
      else exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      /* the outer handler reports the original error */
    }
    throw err;
  }
}

function closeDatabase() {
  if (!impl) return;
  try {
    impl.close();
  } finally {
    impl = null;
    raw = null;
    // The driver removes its own lock on close. The owner record is ours, and a
    // leftover one would make a future real lock look abandoned.
    if (dbFilePath) clearOwner(dbFilePath);
  }
}

function getDbPath() {
  return dbFilePath;
}

function getDriverName() {
  return driverName;
}

function isOpen() {
  return !!impl;
}

module.exports = {
  SCHEMA_VERSION,
  openDatabase,
  closeDatabase,
  getDbPath,
  getDriverName,
  isOpen,
  all,
  get,
  run,
  exec,
  transaction,
  // Exposed for the tests that prove a stale lock is recovered from and a live
  // one is not: they need to be able to make and inspect both.
  lockPathFor,
  ownerPathFor,
  clearStaleLock,
  isLockedError,
};
