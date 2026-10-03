'use strict';

/**
 * Where this installation keeps its files, and the small bootstrap record that
 * has to be readable *before* the database is opened.
 *
 * Everything lives under Electron's per-user application data folder, so an
 * ordinary user account can install and run the application without needing
 * administrator rights, and an uninstall leaves the data behind on purpose
 * (electron-builder.yml sets deleteAppDataOnUninstall: false).
 *
 * The bootstrap file exists for one reason: the database mode from Section 15 is
 * stored *in* the database, and a machine in CLIENT mode never opens a database
 * of its own. So the mode, the host address and the LAN port are mirrored into a
 * tiny JSON file that the main process reads at startup. It holds no university
 * data and no secrets.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DB_FILE = 'timetable.db';
const BOOTSTRAP_FILE = 'installation.json';
const LOG_FILE = 'application.log';

const DEFAULT_BOOTSTRAP = {
  mode: 'LOCAL',
  hostUrl: '',
  port: 4123,
};

function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function databasePath() {
  // TMS_DB_PATH lets a developer or a support engineer point the application at
  // a copy of someone's database without touching the installed one.
  return process.env.TMS_DB_PATH || path.join(dataDir(), DB_FILE);
}

function backupDir() {
  const dir = path.join(path.dirname(databasePath()), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function bootstrapPath() {
  return path.join(dataDir(), BOOTSTRAP_FILE);
}

function logPath() {
  return path.join(dataDir(), LOG_FILE);
}

/** Never throws: an unreadable or corrupt file falls back to a local install. */
function readBootstrap() {
  try {
    const raw = fs.readFileSync(bootstrapPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const mode = String(parsed.mode || '').toUpperCase();
    return {
      mode: ['LOCAL', 'HOST', 'CLIENT'].includes(mode) ? mode : 'LOCAL',
      hostUrl: typeof parsed.hostUrl === 'string' ? parsed.hostUrl.trim() : '',
      port: Number(parsed.port) > 0 ? Number(parsed.port) : DEFAULT_BOOTSTRAP.port,
    };
  } catch {
    return { ...DEFAULT_BOOTSTRAP };
  }
}

function writeBootstrap(next) {
  const merged = { ...readBootstrap(), ...next };
  const value = {
    mode: String(merged.mode || 'LOCAL').toUpperCase(),
    hostUrl: String(merged.hostUrl || '').trim().replace(/\/+$/, ''),
    port: Number(merged.port) > 0 ? Number(merged.port) : DEFAULT_BOOTSTRAP.port,
  };
  fs.writeFileSync(bootstrapPath(), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return value;
}

/** The built renderer, or null while running against the Vite dev server. */
function rendererIndex() {
  const candidates = [
    path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'),
    path.join(process.resourcesPath || '', 'app', 'dist', 'renderer', 'index.html'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function rendererDir() {
  const index = rendererIndex();
  return index ? path.dirname(index) : null;
}

module.exports = {
  DEFAULT_BOOTSTRAP,
  dataDir,
  databasePath,
  backupDir,
  bootstrapPath,
  logPath,
  readBootstrap,
  writeBootstrap,
  rendererIndex,
  rendererDir,
};
