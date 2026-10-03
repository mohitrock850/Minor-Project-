'use strict';

/**
 * The only bridge between the window and the operating system.
 *
 * Node integration is off and context isolation is on in the window, so the
 * renderer cannot require anything, touch the filesystem or open a socket. It
 * gets this small, named list of desktop favours instead -- saving a file the
 * user asked for, opening one they picked, printing to PDF, and reading the
 * runtime description that tells it which API to call.
 *
 * Nothing here takes a filesystem path from the renderer: every read and write
 * goes through a dialog the user themselves confirms, so a bug in the interface
 * cannot quietly overwrite a file.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('tms', {
  isDesktop: true,

  /** { apiBase, mode, local, hostUrl, databasePath, driver, version, platform } */
  getRuntime: () => invoke('runtime:get'),

  /** Where this installation keeps its files, for the About and Backup panels. */
  getPaths: () => invoke('runtime:paths'),

  /**
   * Save As. `data` is base64; `text` is a string. One or the other.
   * @returns {Promise<{saved:boolean, path?:string, cancelled?:boolean}>}
   */
  saveFile: (opts) => invoke('file:save', opts),

  /** Open a file and return it as base64, for restoring a backup or importing. */
  openFile: (opts) => invoke('file:open', opts),

  /** Renders HTML (from the export endpoint) into a PDF the user saves. */
  printToPdf: (opts) => invoke('file:print-pdf', opts),

  /** Shows a folder in Explorer, or reveals a file inside it. */
  reveal: (target) => invoke('shell:reveal', target),

  /** Opens an http(s) address in the user's own browser, never in this window. */
  openExternal: (url) => invoke('shell:open-external', url),

  // --- Installation mode (Section 15) ---------------------------------------
  /** The mode this machine will use next time it starts. */
  getInstallation: () => invoke('install:get'),
  /** Checks a host machine is reachable before committing to CLIENT mode. */
  probeHost: (hostUrl) => invoke('install:probe', hostUrl),
  /** Writes the mode/host/port, then optionally restarts to apply it. */
  setInstallation: (cfg) => invoke('install:set', cfg),
  restart: () => invoke('app:restart'),

  /** A confirmation dialog drawn by the OS, for genuinely destructive actions. */
  confirm: (opts) => invoke('dialog:confirm', opts),

  /**
   * Menu clicks. menu.js sends { command, payload } rather than acting on the
   * database itself, so a menu item goes through the same permission checks as
   * the equivalent button in the window.
   *
   * The listener is wrapped so the renderer never receives Electron's event
   * object (which carries a live IPC handle), and the channel name is fixed here
   * rather than passed in, so the renderer cannot subscribe to anything else.
   *
   * @returns {() => void} unsubscribe
   */
  onMenuCommand: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, message) => {
      const { command, payload } = message || {};
      handler(String(command || ''), payload);
    };
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
});
