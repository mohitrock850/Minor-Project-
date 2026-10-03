'use strict';

/**
 * The local backend.
 *
 * The renderer never touches SQLite directly: it calls this HTTP API, which the
 * Electron main process starts on a loopback port. One consequence is worth the
 * indirection -- the same code path serves all three installation modes from
 * Section 15 (this machine only, this machine hosting for the LAN, this machine
 * using another as its host), and the Section 12 role rules are enforced in one
 * place that no window can bypass.
 *
 * In LOCAL mode the server binds to 127.0.0.1, so nothing is reachable from the
 * network at all. Only HOST mode binds to every interface, and only after the
 * Super Admin has explicitly switched it on.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const db = require('./db/connection');
const settings = require('./services/settings');

// Spreadsheets are uploaded as base64 inside JSON (see routes/importExport.js),
// which inflates them by a third, so the limit has to be generous.
const BODY_LIMIT = '32mb';

const BINARY_TYPES = [
  'application/octet-stream',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
];

/**
 * Cross-origin headers exist for one case only: a machine in CLIENT mode, whose
 * renderer is loaded from its own disk, calling the host's API. Authentication
 * is a bearer token rather than a cookie, so no credentialed-origin echo is
 * needed and none is granted.
 */
function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Active-College');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Template-Version');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

/**
 * Turns a thrown error into the shape the renderer expects. Every service in
 * this project reports failure by throwing an Error carrying `status`, `code`
 * and often `details`, so this is the only place that formats one.
 */
function errorHandler(err, req, res, next) {  // eslint-disable-line no-unused-vars
  const status = Number(err && err.status) || 500;

  if (status >= 500) {
    // Unexpected: worth a trace in the log the desktop app writes.
    console.error(`[api] ${req.method} ${req.originalUrl}`, err);
  }

  const body = {
    error: true,
    status,
    code: err.code || (status === 500 ? 'INTERNAL' : 'ERROR'),
    message: status === 500 && !err.expose
      ? 'Something went wrong inside the application. Nothing was saved.'
      : String(err.message || 'Request failed.'),
  };

  // Everything the interface can act on is passed through verbatim.
  if (Array.isArray(err.details) && err.details.length) body.details = err.details;
  if (err.violations) body.violations = err.violations;
  if (err.canOverride) {
    body.canOverride = true;
    body.overrideHint = err.overrideHint
      || 'You can do this anyway as the coordinator -- the conflict will be recorded.';
  }
  if (err.report) body.report = err.report;          // readiness / import reports
  if (err.aiStatus) body.aiStatus = err.aiStatus;
  if (err.cause && status >= 500) body.cause = String(err.cause);
  if (status === 500 && process.env.TMS_DEBUG) body.stack = String(err.stack || '');

  res.status(status).json(body);
}

/**
 * Builds the express application.
 * @param {object} opts staticDir -- built renderer to serve, when present
 */
function createApp(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(cors);
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.raw({ type: BINARY_TYPES, limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

  app.use('/api', require('./routes'));

  // Serving the built renderer is a convenience: in the desktop app the window
  // loads it from disk, but a browser on the LAN can use the host this way too.
  const staticDir = opts.staticDir
    || path.join(__dirname, '..', '..', 'dist', 'renderer');
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: 'index.html' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      return res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

/**
 * Opens the database, prepares first-run state and starts listening.
 *
 * @param {object} opts
 *   dbPath     required -- where the SQLite file lives (chosen by the main process)
 *   port       0 lets the OS pick a free one, which is what LOCAL mode wants
 *   host       overrides the mode's default binding
 *   staticDir  built renderer
 *   seed       load the demo colleges on a brand-new database (default true)
 * @returns {Promise<{app, server, port, host, url, mode, close}>}
 */
async function startServer(opts = {}) {
  if (!opts.dbPath) throw new Error('startServer needs a dbPath.');

  db.openDatabase(opts.dbPath, {
    log: typeof opts.log === 'function' ? opts.log : (message) => console.log(`[server] ${message}`),
  });
  // The token signing secret is created on demand by auth/tokens.js, so nothing
  // needs to be prepared here beyond opening the file.

  const mode = settings.getSetting('network_mode') || 'LOCAL';

  // First run: create the demo universities, colleges and timetables described
  // in the acceptance scenario, plus one login per role.
  if (opts.seed !== false && !settings.getBool('seeded')) {
    try {
      // eslint-disable-next-line global-require
      const { seedDemoData } = require('./db/seed');
      const result = seedDemoData();
      console.log(`[server] ${result.message}`);
    } catch (err) {
      // A failed seed must never stop the application from opening -- the user
      // can still create their own data, or reset and try again.
      console.error('[server] The demo data could not be loaded:', err.message);
    }
  }

  const app = createApp({ staticDir: opts.staticDir });

  // LOCAL and CLIENT installations must not be reachable from the network.
  const host = opts.host || (mode === 'HOST' ? '0.0.0.0' : '127.0.0.1');
  const requestedPort = opts.port != null
    ? Number(opts.port)
    : (mode === 'HOST' ? settings.getNumber('network_port') : 0);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(requestedPort, host, () => resolve(s));
    s.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${requestedPort} is already in use, so the timetable service could not start. `
          + 'Another copy of the application may already be running, or choose a different LAN port '
          + 'in Settings.'
        ));
      } else {
        reject(err);
      }
    });
  });

  const { port } = server.address();
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  return {
    app,
    server,
    port,
    host,
    url,
    mode,
    databasePath: opts.dbPath,
    driver: db.getDriverName(),
    close: () => new Promise((resolve) => {
      // Shutting down has to be quick and certain. `server.close()` alone waits
      // for every keep-alive socket the window is holding, which can be many
      // seconds -- and an application that appears to hang on quit gets killed,
      // which is exactly how the database driver's lock gets left behind. So the
      // sockets are dropped, and there is a deadline regardless.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        db.closeDatabase();
        resolve();
      };
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(finish);
      const deadline = setTimeout(finish, 2000);
      if (typeof deadline.unref === 'function') deadline.unref();
    }),
  };
}

module.exports = { createApp, startServer, errorHandler, BODY_LIMIT };
