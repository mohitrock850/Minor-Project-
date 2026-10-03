'use strict';

/**
 * Starting, stopping and describing the local backend (Section 15).
 *
 * Three installation modes, one code path:
 *
 *   LOCAL   the backend runs here and listens on 127.0.0.1 with an OS-assigned
 *           port. Nothing is reachable from the network.
 *   HOST    the backend runs here and listens on every interface on the chosen
 *           port, so other machines can sign in to this one.
 *   CLIENT  no backend runs here at all. The window talks to another machine's,
 *           and this installation stores nothing of its own.
 *
 * The window is given an `apiBase` and never learns which of the three it is
 * using, so the renderer has no mode-specific code.
 */

const { startServer } = require('../server');
const paths = require('./appPaths');

let current = null;

/** Trims a user-typed host address into something fetch() will accept. */
function normaliseHostUrl(raw) {
  let value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  // "http://192.168.1.5" with no port means the default LAN port.
  try {
    const url = new URL(value);
    if (!url.port) url.port = String(paths.readBootstrap().port);
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Confirms a host machine is actually running this application before the
 * window is pointed at it, so a wrong address produces a clear message rather
 * than a blank screen.
 */
async function probeHost(hostUrl, timeoutMs = 5000) {
  const base = normaliseHostUrl(hostUrl);
  if (!base) return { ok: false, message: 'That host address could not be understood.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/health`, { signal: controller.signal });
    if (!res.ok) return { ok: false, message: `The host answered with status ${res.status}.` };
    const body = await res.json();
    if (!body || body.app !== 'University Timetable Management') {
      return { ok: false, message: 'Something is running at that address, but it is not this application.' };
    }
    return { ok: true, health: body, apiBase: `${base}/api`, hostUrl: base };
  } catch (err) {
    return {
      ok: false,
      message: err.name === 'AbortError'
        ? 'The host did not answer in time. Check that it is switched on and sharing its database.'
        : `The host could not be reached: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Brings the backend up according to the bootstrap record.
 * @returns {Promise<object>} the runtime description handed to the renderer
 */
async function start(options = {}) {
  if (current) return current;
  const bootstrap = paths.readBootstrap();

  if (bootstrap.mode === 'CLIENT') {
    const probe = await probeHost(bootstrap.hostUrl);
    if (!probe.ok) {
      const err = new Error(
        `${probe.message}\n\nThis installation is set to use ${bootstrap.hostUrl || 'another machine'} `
        + 'as its host. You can point it at a different machine, or switch it back to using its own '
        + 'database, from the start-up screen.'
      );
      err.code = 'HOST_UNREACHABLE';
      err.bootstrap = bootstrap;
      throw err;
    }
    current = {
      mode: 'CLIENT',
      apiBase: probe.apiBase,
      hostUrl: probe.hostUrl,
      local: false,
      databasePath: null,
      driver: probe.health.driver || null,
      port: null,
      close: async () => {},
    };
    return current;
  }

  const started = await startServer({
    dbPath: paths.databasePath(),
    staticDir: paths.rendererDir() || undefined,
    // LOCAL takes any free port; HOST uses the configured one so clients have a
    // stable address to type.
    port: bootstrap.mode === 'HOST' ? bootstrap.port : 0,
    host: bootstrap.mode === 'HOST' ? '0.0.0.0' : '127.0.0.1',
    // So that recovering from an abandoned lock is recorded in application.log
    // rather than only on a console nobody sees.
    log: options.log,
  });

  current = {
    mode: bootstrap.mode,
    apiBase: `${started.url}/api`,
    hostUrl: bootstrap.mode === 'HOST' ? started.url : null,
    local: true,
    databasePath: started.databasePath,
    driver: started.driver,
    port: started.port,
    close: started.close,
  };
  return current;
}

async function stop() {
  if (!current) return;
  const { close } = current;
  current = null;
  try {
    await close();
  } catch {
    // Shutting down: a failure here must not keep the process alive.
  }
}

const runtime = () => current;

module.exports = { start, stop, runtime, probeHost, normaliseHostUrl };
