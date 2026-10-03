'use strict';

/**
 * API surface.
 *
 * Login is the only unauthenticated route. Everything mounted after
 * `requireAuth` receives `req.user` and `req.scope`, and every college-scoped
 * query is filtered by that scope on the server -- Section 12 is enforced here,
 * not in the interface.
 *
 *   /api/auth        sign in, own account, user administration
 *   /api/meta        registry, colleges, dropdown options, readiness, search, dashboards
 *   /api/entities    generic CRUD for all 19 entity types (Section 1)
 *   /api/config      college timing configuration and scheduling rules (Sections 4, 13)
 *   /api/generate    the six-step generation wizard (Section 5)
 *   /api/manual      the manual builder (Section 6)
 *   /api/timetable   views, card actions, versions, exports (Sections 7, 8)
 *   /api/import      Excel templates, validation reports, bulk import (Section 10)
 *   /api/assistant   the AI Assistant (Section 14) -- the only outbound network use
 *   /api/settings    machine settings, the OpenAI key, LAN mode (Sections 14, 15)
 *   /api/backup      backup, restore, reset to empty (Section 15)
 */

const express = require('express');
const db = require('../db/connection');
const settings = require('../services/settings');
const seed = require('../db/seed');
const { requireAuth, httpError } = require('../auth/middleware');

const router = express.Router();

/**
 * Unauthenticated, deliberately: a machine in CLIENT mode probes this to find
 * out whether the host is reachable before showing a login form. It reveals
 * nothing beyond "an installation of this application is answering here".
 *
 * The one addition is `seed`: while this machine still holds the shipped demo
 * dataset, the sign-in screen needs some way to tell the user how to get in.
 * demoAccounts() returns an empty list the moment those rows are gone, so a
 * machine holding real data advertises nothing.
 */
router.get('/health', (req, res) => {
  const seeded = settings.getBool('seeded');
  const accounts = seeded ? seed.demoAccounts() : [];
  res.json({
    ok: true,
    app: 'University Timetable Management',
    schemaVersion: db.SCHEMA_VERSION,
    databaseOpen: db.isOpen(),
    driver: db.getDriverName(),
    networkMode: settings.getSetting('network_mode'),
    seeded,
    seed: accounts.length ? { accounts, password: seed.DEMO_PASSWORD } : null,
  });
});

// Login lives inside this router; it applies requireAuth to its own
// authenticated half.
router.use('/auth', require('./auth'));

// ---------------------------------------------------------------------------
// Everything below requires a valid session
// ---------------------------------------------------------------------------
router.use(requireAuth);

router.use('/meta', require('./meta'));
router.use('/entities', require('./entities'));
router.use('/config', require('./config'));
router.use('/generate', require('./generate'));
router.use('/manual', require('./manual'));
router.use('/timetable', require('./timetable'));
router.use('/import', require('./importExport'));
router.use('/assistant', require('./assistant'));
router.use('/settings', require('./settings'));
router.use('/backup', require('./backup'));

router.use((req, res, next) => {
  next(httpError(404, `No API endpoint matches ${req.method} ${req.originalUrl}.`, 'NOT_FOUND'));
});

module.exports = router;
