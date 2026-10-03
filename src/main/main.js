'use strict';

/**
 * The Electron main process: one window, one local backend, no internet.
 *
 * Responsibilities, and deliberately nothing more:
 *   - start the backend (or point at a host machine) before the window opens
 *   - create the window with node integration off and context isolation on
 *   - answer the small list of IPC requests declared in preload.js
 *   - write a startup log next to the database, since a packaged application has
 *     no console to print to
 *
 * No university data is touched here. Every read and write goes through the HTTP
 * API, which is where the Section 12 role rules live.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const paths = require('./appPaths');
const serverControl = require('./serverControl');
const { buildMenu } = require('./menu');

const DEV_SERVER = process.env.TMS_DEV_SERVER || null;
const isDev = !app.isPackaged;

let mainWindow = null;
let startupError = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  if (isDev) console.log(line);
  try {
    fs.appendFileSync(paths.logPath(), `${line}${os.EOL}`, 'utf8');
  } catch {
    // A log that cannot be written must never stop the application.
  }
}

/** Keeps the log from growing without bound across years of daily use. */
function trimLog() {
  try {
    const file = paths.logPath();
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.slice(-512 * 1024), 'utf8');
    }
  } catch {
    // No log yet, which is fine.
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(runtime) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f8fafc',
    title: app.getName(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // the preload needs ipcRenderer
      spellcheck: false,
      webviewTag: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (process.env.TMS_MAXIMISED === '1') win.maximize();
  });

  // Anything that is not this application opens in the user's own browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current && !url.startsWith('file://') && !url.startsWith('http://localhost:5173')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { mainWindow = null; });

  if (DEV_SERVER) {
    win.loadURL(DEV_SERVER);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const index = paths.rendererIndex();
    if (index) {
      win.loadFile(index);
    } else {
      // The renderer was not built. Say so in the window rather than showing a
      // blank page, because this is the one failure a developer will hit often.
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
        '<body style="font:15px system-ui;padding:40px;color:#0f172a">'
        + '<h2>The interface has not been built yet.</h2>'
        + '<p>Run <code>npm run build:renderer</code> (or <code>npm run dev</code> for the '
        + 'live-reloading version) and start the application again.</p></body>'
      )}`);
    }
  }

  buildMenu(win, {
    isDev,
    mode: runtime && runtime.mode,
    databasePath: runtime && runtime.databasePath,
    driver: runtime && runtime.driver,
  });

  return win;
}

/**
 * Shown when the backend could not start at all -- almost always a CLIENT
 * installation whose host is switched off. The user is offered the two ways out
 * rather than being left with a dead window.
 */
async function showStartupFailure(err) {
  const bootstrap = paths.readBootstrap();
  const isClient = bootstrap.mode === 'CLIENT';
  const buttons = isClient
    ? ['Use This Machine\'s Own Database', 'Try Again', 'Close']
    : ['Try Again', 'Close'];

  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'The timetable service could not start',
    message: 'The application could not open.',
    detail: String(err && err.message ? err.message : err),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });

  if (isClient && response === 0) {
    paths.writeBootstrap({ mode: 'LOCAL' });
    log('startup: switched this installation back to LOCAL mode after a host failure');
    return 'retry';
  }
  if (buttons[response] === 'Try Again') return 'retry';
  return 'quit';
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
const SAFE_FILTERS = {
  db: [{ name: 'Timetable Backup', extensions: ['db'] }],
  excel: [{ name: 'Excel Workbook', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }],
  csv: [{ name: 'CSV', extensions: ['csv'] }],
  pdf: [{ name: 'PDF Document', extensions: ['pdf'] }],
  ical: [{ name: 'Calendar', extensions: ['ics'] }],
  html: [{ name: 'Web Page', extensions: ['html'] }],
  any: [{ name: 'All Files', extensions: ['*'] }],
};

function filtersFor(kind, filename) {
  if (SAFE_FILTERS[kind]) return SAFE_FILTERS[kind];
  const ext = String(path.extname(filename || '')).replace('.', '').toLowerCase();
  if (ext) return [{ name: ext.toUpperCase(), extensions: [ext] }, ...SAFE_FILTERS.any];
  return SAFE_FILTERS.any;
}

function registerIpc() {
  ipcMain.handle('runtime:get', () => {
    const runtime = serverControl.runtime();
    return {
      apiBase: runtime ? runtime.apiBase : null,
      mode: runtime ? runtime.mode : paths.readBootstrap().mode,
      local: runtime ? runtime.local : true,
      hostUrl: runtime ? runtime.hostUrl : null,
      databasePath: runtime ? runtime.databasePath : null,
      driver: runtime ? runtime.driver : null,
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      isDev,
      startupError: startupError ? String(startupError.message || startupError) : null,
    };
  });

  ipcMain.handle('runtime:paths', () => ({
    dataDir: paths.dataDir(),
    databasePath: paths.databasePath(),
    backupDir: paths.backupDir(),
    logPath: paths.logPath(),
    installationFile: paths.bootstrapPath(),
  }));

  // --- Files --------------------------------------------------------------
  ipcMain.handle('file:save', async (event, opts = {}) => {
    const { filename, data, text, kind, title } = opts;
    if (data == null && text == null) throw new Error('Nothing was given to save.');

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: title || 'Save',
      defaultPath: path.join(app.getPath('documents'), filename || 'timetable.txt'),
      filters: filtersFor(kind, filename),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { saved: false, cancelled: true };

    const buffer = data != null
      ? Buffer.from(String(data), 'base64')
      : Buffer.from(String(text), 'utf8');
    fs.writeFileSync(filePath, buffer);
    log('saved', filePath, `${buffer.length} bytes`);
    return { saved: true, path: filePath, bytes: buffer.length };
  });

  ipcMain.handle('file:open', async (event, opts = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || 'Open',
      defaultPath: opts.defaultPath || app.getPath('documents'),
      filters: filtersFor(opts.kind, opts.filename),
      properties: ['openFile'],
    });
    if (canceled || !filePaths || !filePaths.length) return { opened: false, cancelled: true };

    const filePath = filePaths[0];
    const stat = fs.statSync(filePath);
    const limit = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 64 * 1024 * 1024;
    if (stat.size > limit) {
      throw new Error(`That file is ${(stat.size / 1024 / 1024).toFixed(1)} MB, which is larger than `
        + `the ${(limit / 1024 / 1024).toFixed(0)} MB limit.`);
    }
    const buffer = fs.readFileSync(filePath);
    return {
      opened: true,
      path: filePath,
      name: path.basename(filePath),
      bytes: stat.size,
      data: buffer.toString('base64'),
    };
  });

  /**
   * The export endpoint returns print-ready HTML; turning it into a PDF is the
   * one job that needs a browser engine, so it is done here in an offscreen
   * window rather than by shipping a PDF library.
   */
  ipcMain.handle('file:print-pdf', async (event, opts = {}) => {
    const { html, filename, landscape } = opts;
    if (!html) throw new Error('There was nothing to print.');

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Timetable As PDF',
      defaultPath: path.join(app.getPath('documents'), filename || 'timetable.pdf'),
      filters: SAFE_FILTERS.pdf,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { saved: false, cancelled: true };

    const printer = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, javascript: false, images: true },
    });
    try {
      // A temporary file rather than a data: URL, because a full timetable's
      // markup can exceed the practical length of a URL.
      const temp = path.join(app.getPath('temp'), `tms-print-${process.pid}-${Date.now()}.html`);
      fs.writeFileSync(temp, html, 'utf8');
      await printer.loadFile(temp);
      const pdf = await printer.webContents.printToPDF({
        printBackground: true,
        landscape: landscape !== false,   // timetables are wide
        pageSize: 'A4',
        margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      });
      fs.writeFileSync(filePath, pdf);
      try { fs.unlinkSync(temp); } catch { /* the temp folder is cleaned by the OS */ }
      log('printed pdf', filePath, `${pdf.length} bytes`);
      return { saved: true, path: filePath, bytes: pdf.length };
    } finally {
      printer.destroy();
    }
  });

  // --- Shell --------------------------------------------------------------
  ipcMain.handle('shell:reveal', async (event, target) => {
    const known = new Set([paths.dataDir(), paths.backupDir(), paths.databasePath(), paths.logPath()]);
    const chosen = target && known.has(target) ? target : paths.dataDir();
    if (fs.existsSync(chosen) && fs.statSync(chosen).isDirectory()) await shell.openPath(chosen);
    else shell.showItemInFolder(chosen);
    return { revealed: chosen };
  });

  ipcMain.handle('shell:open-external', async (event, url) => {
    if (!/^https:\/\//i.test(String(url || ''))) {
      throw new Error('Only secure web addresses can be opened.');
    }
    await shell.openExternal(String(url));
    return { opened: true };
  });

  // --- Installation mode --------------------------------------------------
  ipcMain.handle('install:get', () => {
    const bootstrap = paths.readBootstrap();
    const runtime = serverControl.runtime();
    return {
      ...bootstrap,
      running: runtime ? runtime.mode : null,
      restartRequired: !!(runtime && runtime.mode !== bootstrap.mode),
    };
  });

  ipcMain.handle('install:probe', (event, hostUrl) => serverControl.probeHost(hostUrl));

  ipcMain.handle('install:set', async (event, cfg = {}) => {
    const mode = String(cfg.mode || '').toUpperCase();
    if (!['LOCAL', 'HOST', 'CLIENT'].includes(mode)) throw new Error('Choose one of the three modes.');

    if (mode === 'CLIENT') {
      const probe = await serverControl.probeHost(cfg.hostUrl);
      if (!probe.ok) {
        const err = new Error(probe.message);
        err.code = 'HOST_UNREACHABLE';
        throw err;
      }
      const saved = paths.writeBootstrap({ mode, hostUrl: probe.hostUrl });
      log('installation mode ->', mode, saved.hostUrl);
      return { ...saved, restartRequired: true, host: probe.health };
    }

    const saved = paths.writeBootstrap({
      mode,
      port: cfg.port != null ? Number(cfg.port) : undefined,
    });
    log('installation mode ->', mode, mode === 'HOST' ? `port ${saved.port}` : '');
    return { ...saved, restartRequired: true };
  });

  ipcMain.handle('app:restart', () => {
    log('restarting at the user\'s request');
    app.relaunch();
    // quit, not exit: `app.exit` skips 'before-quit', which is where the backend
    // is shut down, and a database left open leaves a lock behind that would
    // stop the very restart being asked for.
    app.quit();
    return { restarting: true };
  });

  ipcMain.handle('dialog:confirm', async (event, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: opts.danger ? 'warning' : 'question',
      title: opts.title || 'Please confirm',
      message: opts.message || 'Are you sure?',
      detail: opts.detail || undefined,
      buttons: [opts.confirmLabel || 'Continue', 'Cancel'],
      defaultId: opts.danger ? 1 : 0,
      cancelId: 1,
      noLink: true,
    });
    return { confirmed: response === 0 };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  // A second copy would open the same SQLite file twice; the first window is
  // brought forward instead.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    trimLog();
    log('starting', app.getName(), app.getVersion(), isDev ? '(development)' : '');
    registerIpc();

    // Keep trying until the backend is up or the user gives up: a CLIENT machine
    // whose host is offline should be able to switch itself back to LOCAL and
    // carry on without reinstalling.
    for (;;) {
      try {
        const runtime = await serverControl.start({ log });
        startupError = null;
        log('backend ready:', runtime.mode, runtime.apiBase, runtime.driver || '');
        mainWindow = createWindow(runtime);
        break;
      } catch (err) {
        startupError = err;
        log('backend failed:', err.message);
        // eslint-disable-next-line no-await-in-loop
        const next = await showStartupFailure(err);
        if (next === 'quit') { app.quit(); return; }
      }
    }
  });

  // Shutting down has to finish, not merely start. Electron does not wait for an
  // async 'before-quit' listener, so a quit from the menu, from Windows signing
  // out, or from the installer replacing a running copy would previously exit
  // while the backend was still closing -- and the database driver locks by
  // creating a directory, so an unclosed database leaves a lock behind that
  // makes every later start fail. The quit is held back once, until the backend
  // is actually down.
  //
  // One promise, shared: whoever asks second waits for the first attempt rather
  // than starting a second one.
  let closing = null;
  let closed = false;

  const shutDown = (why) => {
    if (!closing) {
      closing = serverControl.stop().then(() => {
        closed = true;
        log('closed', why);
      }, (err) => {
        closed = true;
        log('closed with an error', String(err && err.message ? err.message : err));
      });
    }
    return closing;
  };

  app.on('window-all-closed', () => {
    shutDown('(all windows closed)').then(() => app.quit());
  });

  app.on('before-quit', (event) => {
    if (closed) return; // the backend is down: let the quit through
    event.preventDefault();
    shutDown('(quitting)').then(() => app.quit());
  });

  // Ctrl+C in a development terminal, and Windows asking processes to stop.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { app.quit(); });
  }

  process.on('uncaughtException', (err) => {
    log('uncaught exception:', err && err.stack ? err.stack : String(err));
  });
  process.on('unhandledRejection', (reason) => {
    log('unhandled rejection:', reason && reason.stack ? reason.stack : String(reason));
  });
}
