'use strict';

/**
 * Backup, restore and reset endpoints (Section 15).
 *
 *   GET    /              database size, counts, the backups already on disk
 *   POST   /              make a backup now
 *   GET    /download/:name  download one (so a LAN client can take a copy home)
 *   GET    /inspect/:name   what is inside a backup, before restoring it
 *   POST   /restore         replace the live database with a backup
 *   DELETE /:name           delete a backup file
 *   POST   /reset           remove all university data ("Reset to empty")
 *
 * Restoring and resetting replace or destroy everything, so both are reserved for
 * the Super Admin and both take an explicit confirmation string rather than
 * trusting a single click.
 */

const express = require('express');
const backup = require('../services/backup');
const settings = require('../services/settings');
const { httpError, requireCoordinator, requireSuperAdmin } = require('../auth/middleware');

const router = express.Router();

const RESET_PHRASE = 'DELETE EVERYTHING';

router.get('/', requireCoordinator, (req, res, next) => {
  try {
    res.json(backup.info());
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCoordinator, (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(201).json(backup.create({
      label: body.label,
      // A desktop "Save As" path arrives from the Electron main process only.
      targetPath: body.targetPath,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/download/:name', requireCoordinator, (req, res, next) => {
  try {
    const file = backup.readBackup(req.params.name);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.type('application/octet-stream').send(file.buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/inspect/:name', requireCoordinator, (req, res, next) => {
  try {
    res.json(backup.inspect(req.params.name));
  } catch (err) {
    next(err);
  }
});

router.post('/restore', requireSuperAdmin, (req, res, next) => {
  try {
    const body = req.body || {};
    const source = body.path || body.name;
    if (!source) throw httpError(400, 'Choose the backup to restore.', 'VALIDATION');
    if (body.confirm !== true && body.confirm !== 'true') {
      throw httpError(400,
        'Restoring replaces everything currently in the database. Confirm to continue.',
        'CONFIRM_REQUIRED');
    }
    const result = backup.restore(source, { allowVersionMismatch: !!body.allowVersionMismatch });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/:name', requireSuperAdmin, (req, res, next) => {
  try {
    res.json(backup.remove(req.params.name));
  } catch (err) {
    next(err);
  }
});

/**
 * Section 15's "Reset to empty" -- the way out of the seeded demo colleges.
 * The account that performs it is kept so the machine is not locked out.
 */
router.post('/reset', requireSuperAdmin, (req, res, next) => {
  try {
    const body = req.body || {};
    if (String(body.confirm || '').trim().toUpperCase() !== RESET_PHRASE) {
      const err = httpError(400,
        `This removes every college, course, room, timetable and student on this machine. `
        + `Type "${RESET_PHRASE}" to confirm.`, 'CONFIRM_REQUIRED');
      err.details = [`Expected confirmation phrase: ${RESET_PHRASE}`];
      throw err;
    }
    const result = backup.resetToEmpty({ keepUserId: req.user.id });
    res.json({ ...result, seeded: settings.getBool('seeded') });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
