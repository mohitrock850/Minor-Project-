'use strict';

/**
 * Settings, the OpenAI key, and the LAN sharing mode (Sections 14.1 and 15).
 *
 *   GET    /                machine settings, grouped, plus what the screen needs
 *   PUT    /                change settings
 *   POST   /ai-key          store the OpenAI key (OS-encrypted, never echoed back)
 *   DELETE /ai-key          forget it
 *   GET    /network         current mode plus this machine's LAN addresses
 *   PUT    /network         switch between local / host / client
 *   GET    /system          driver, database file, versions -- for the About panel
 *
 * The key is written through services/secrets.js, which refuses to store it at
 * all unless the operating system can encrypt it. No route in this file ever
 * returns the key: the most anyone gets back is "sk-...1234".
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('../db/connection');
const settings = require('../services/settings');
const secrets = require('../services/secrets');
const ai = require('../services/ai');
const { httpError, requireCoordinator, requireSuperAdmin } = require('../auth/middleware');

const router = express.Router();

/** LAN addresses of this machine, so the host can be told what to type. */
function lanAddresses() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nics)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ interface: name, address: addr.address });
    }
  }
  return out;
}

function networkInfo() {
  const mode = settings.getSetting('network_mode');
  const port = settings.getNumber('network_port');
  const addresses = lanAddresses();
  return {
    mode,
    port,
    hostUrl: settings.getSetting('network_host_url') || '',
    addresses,
    // What a client machine should be given, once this one is hosting.
    shareUrls: addresses.map((a) => `http://${a.address}:${port}`),
    modes: [
      {
        value: 'LOCAL',
        label: 'This machine only',
        description: 'The database lives in this machine\'s application data folder. Nothing listens '
          + 'on the network. This is the default and it is enough for a single coordinator.',
      },
      {
        value: 'HOST',
        label: 'Share this machine\'s database over the LAN',
        description: 'Other machines on the same network sign in to this one. Keep this machine '
          + 'switched on while others are using it, and keep taking backups here.',
      },
      {
        value: 'CLIENT',
        label: 'Use another machine as the host',
        description: 'This installation stores nothing of its own -- it reads and writes the host\'s '
          + 'database. If the host is unreachable, this machine cannot open the timetable.',
      },
    ],
    restartRequired: false,
    note: 'Changing the database mode takes effect when the application is restarted.',
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
router.get('/', requireCoordinator, (req, res, next) => {
  try {
    const list = settings.publicSettings();
    const groups = [];
    for (const item of list) {
      let group = groups.find((g) => g.name === item.group);
      if (!group) { group = { name: item.group, settings: [] }; groups.push(group); }
      group.settings.push(item);
    }
    res.json({
      settings: list,
      groups,
      ai: ai.status(),
      network: networkInfo(),
      lastBackupAt: settings.getSetting('last_backup_at') || null,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/', requireCoordinator, (req, res, next) => {
  try {
    const patch = (req.body && req.body.settings) || req.body || {};
    // Whoever changes the network mode changes it for every user of this
    // installation, so that one is reserved for the Super Admin.
    const networkKeys = ['network_mode', 'network_port', 'network_host_url'];
    if (networkKeys.some((k) => k in patch) && !req.scope.isSuperAdmin) {
      throw httpError(403, 'Only the Super Admin can change how the database is shared.', 'SUPER_ADMIN_ONLY');
    }
    const applied = settings.updateSettings(patch);
    res.json({
      applied,
      settings: settings.publicSettings(),
      ai: ai.status(),
      restartRequired: networkKeys.some((k) => k in applied),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The OpenAI key
// ---------------------------------------------------------------------------
router.post('/ai-key', requireCoordinator, (req, res, next) => {
  try {
    const key = req.body && req.body.key;
    if (!key) throw httpError(400, 'Paste your OpenAI API key.', 'VALIDATION');
    const result = secrets.setKey(key);
    res.json({
      ...result,
      status: ai.status(),
      message: 'Saved. The key is encrypted with Windows\' own credential protection and stays on '
        + 'this machine -- it is only ever sent to api.openai.com.',
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/ai-key', requireCoordinator, (req, res, next) => {
  try {
    res.json({
      ...secrets.clearKey(),
      status: ai.status(),
      message: 'The stored key has been removed. The Assistant is switched off until a new one is added.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// LAN mode
// ---------------------------------------------------------------------------
router.get('/network', requireCoordinator, (req, res, next) => {
  try {
    res.json(networkInfo());
  } catch (err) {
    next(err);
  }
});

router.put('/network', requireSuperAdmin, (req, res, next) => {
  try {
    const body = req.body || {};
    const mode = String(body.mode || body.network_mode || '').toUpperCase();
    if (!['LOCAL', 'HOST', 'CLIENT'].includes(mode)) {
      throw httpError(400, 'Choose Local, Host or Client.', 'VALIDATION');
    }
    const port = body.port != null && body.port !== '' ? Number(body.port) : settings.getNumber('network_port');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw httpError(400, 'The LAN port must be a whole number between 1024 and 65535.', 'VALIDATION');
    }
    let hostUrl = body.hostUrl != null ? String(body.hostUrl).trim() : settings.getSetting('network_host_url');
    if (mode === 'CLIENT') {
      if (!hostUrl) {
        throw httpError(400,
          'Enter the host machine\'s address, for example http://192.168.1.24:4713.', 'VALIDATION');
      }
      if (!/^https?:\/\//i.test(hostUrl)) hostUrl = `http://${hostUrl}`;
      try {
        // eslint-disable-next-line no-new
        new URL(hostUrl);
      } catch {
        throw httpError(400, `"${hostUrl}" is not a valid address.`, 'VALIDATION');
      }
    } else {
      hostUrl = '';
    }

    settings.updateSettings({ network_mode: mode, network_port: port, network_host_url: hostUrl });
    res.json({
      ...networkInfo(),
      restartRequired: true,
      message: mode === 'LOCAL'
        ? 'This machine will use its own database only. Restart the application to apply it.'
        : (mode === 'HOST'
          ? 'This machine will share its database on the LAN after a restart. Give the other machines '
            + 'one of the addresses listed here.'
          : 'This machine will use the host\'s database after a restart.'),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------
router.get('/system', requireCoordinator, (req, res, next) => {
  try {
    const dbPath = db.getDbPath();
    let bytes = null;
    try { bytes = dbPath ? fs.statSync(dbPath).size : null; } catch { bytes = null; }
    let appVersion = null;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      appVersion = require(path.join(__dirname, '..', '..', '..', 'package.json')).version;
    } catch { appVersion = null; }

    res.json({
      appVersion,
      schemaVersion: db.SCHEMA_VERSION,
      sqliteDriver: db.getDriverName(),
      databasePath: dbPath,
      databaseBytes: bytes,
      databaseSize: bytes != null ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : null,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      node: process.versions.node,
      electron: process.versions.electron || null,
      chrome: process.versions.chrome || null,
      network: networkInfo(),
      encryption: secrets.encryptionStatus(),
      offlineNote: 'Every feature except the AI Assistant works with no internet connection.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
