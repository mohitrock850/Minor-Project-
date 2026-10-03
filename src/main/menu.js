'use strict';

/**
 * The application menu.
 *
 * Kept deliberately short (Section 16: a very simple, clean interface). Anything
 * that changes university data lives in the window, where the role rules apply;
 * the menu only holds window-level conveniences and the two file operations that
 * genuinely need the operating system.
 *
 * Menu items talk to the renderer by sending it a command, rather than acting on
 * the database themselves -- that way a menu click goes through exactly the same
 * permission checks as a click on a button.
 */

const { Menu, shell, dialog, app } = require('electron');

function send(win, command, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('menu:command', { command, payload });
}

function buildMenu(win, ctx = {}) {
  const isDev = !!ctx.isDev;

  const template = [
    {
      label: '&File',
      submenu: [
        {
          label: 'Back Up Database...',
          accelerator: 'CmdOrCtrl+B',
          click: () => send(win, 'backup'),
        },
        {
          label: 'Restore From Backup...',
          click: () => send(win, 'restore'),
        },
        { type: 'separator' },
        {
          label: 'Import From Excel...',
          accelerator: 'CmdOrCtrl+I',
          click: () => send(win, 'import'),
        },
        {
          label: 'Export Current View...',
          accelerator: 'CmdOrCtrl+E',
          click: () => send(win, 'export'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '&Go',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => send(win, 'go', '/') },
        { label: 'Data Management', accelerator: 'CmdOrCtrl+2', click: () => send(win, 'go', '/data') },
        { label: 'Generate Timetable', accelerator: 'CmdOrCtrl+3', click: () => send(win, 'go', '/generate') },
        { label: 'Manual Builder', accelerator: 'CmdOrCtrl+4', click: () => send(win, 'go', '/manual') },
        { label: 'Timetable Views', accelerator: 'CmdOrCtrl+5', click: () => send(win, 'go', '/views') },
        { type: 'separator' },
        { label: 'Search...', accelerator: 'CmdOrCtrl+K', click: () => send(win, 'search') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send(win, 'go', '/settings') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Getting Started', click: () => send(win, 'go', '/help') },
        { label: 'Where Is My Data?', click: () => send(win, 'reveal-data') },
        { type: 'separator' },
        {
          label: `About ${app.getName()}`,
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: `About ${app.getName()}`,
              message: app.getName(),
              detail: [
                `Version ${app.getVersion()}`,
                ctx.databasePath ? `Database: ${ctx.databasePath}` : 'Database: hosted on another machine',
                ctx.driver ? `SQLite driver: ${ctx.driver}` : null,
                `Mode: ${ctx.mode || 'LOCAL'}`,
                '',
                'Works entirely offline. Only the optional AI Assistant contacts the internet.',
              ].filter(Boolean).join('\n'),
              buttons: ['Close'],
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu, openExternal: shell.openExternal };
