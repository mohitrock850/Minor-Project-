'use strict';

/**
 * Bulk import and export (Section 10).
 *
 * The flow is deliberately three separate calls so nothing is ever written
 * before the user has seen what would happen:
 *
 *   1. GET  /template/:entity   an empty workbook whose headers are exactly the
 *                               entity's fields (optionally pre-filled with the
 *                               data already in the system)
 *   2. POST /validate           the pre-import report: per-row errors, duplicates,
 *                               unknown columns, template-version mismatch
 *   3. POST /commit             writes it, all-or-nothing unless the user opted
 *                               into "import the valid rows only"
 *
 * Uploads arrive as base64 inside JSON rather than as multipart form data: this
 * app has no multipart dependency, the files are spreadsheets of at most a few
 * thousand rows, and it keeps the renderer's fetch call to a single JSON POST.
 * A raw binary body is accepted too for anything that would rather stream.
 */

const express = require('express');
const db = require('../db/connection');
const { httpError, requireCollege, requireCoordinator } = require('../auth/middleware');
const templates = require('../services/templates');

const router = express.Router();
router.use(requireCoordinator);

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Pulls the uploaded file out of the request, whichever way it was sent.
 * @returns {{entityKey:string, filename:string, buffer:Buffer}}
 */
function readUpload(req) {
  // Raw binary: POST /validate?entity=rooms&filename=rooms.xlsx
  if (Buffer.isBuffer(req.body) && req.body.length) {
    const entityKey = String(req.query.entity || '');
    if (!entityKey) throw httpError(400, 'Say which kind of data this file holds.', 'VALIDATION');
    return {
      entityKey,
      filename: String(req.query.filename || 'upload.xlsx'),
      buffer: req.body,
    };
  }

  const body = req.body || {};
  const entityKey = String(body.entity || req.query.entity || '');
  if (!entityKey) throw httpError(400, 'Say which kind of data this file holds.', 'VALIDATION');

  const encoded = body.dataBase64 || body.data || body.file;
  if (!encoded || typeof encoded !== 'string') {
    throw httpError(400, 'Choose a file to import first.', 'NO_FILE');
  }
  // A browser FileReader data URL is accepted as-is.
  const comma = encoded.indexOf(',');
  const payload = encoded.startsWith('data:') && comma > 0 ? encoded.slice(comma + 1) : encoded;

  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw httpError(400, 'That file could not be read. Try downloading a fresh template.', 'BAD_UPLOAD');
  }
  if (!buffer.length) throw httpError(400, 'That file is empty.', 'EMPTY_FILE');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw httpError(400,
      `That file is ${Math.round(buffer.length / 1024 / 1024)} MB. Please import at most `
      + `${MAX_UPLOAD_BYTES / 1024 / 1024} MB at a time.`, 'FILE_TOO_LARGE');
  }
  return { entityKey, filename: String(body.filename || 'upload.xlsx'), buffer };
}

// ---------------------------------------------------------------------------
// What can be imported
// ---------------------------------------------------------------------------
router.get('/entities', (req, res, next) => {
  try {
    res.json({
      templateVersion: templates.TEMPLATE_VERSION,
      format: templates.excelAvailable() ? 'xlsx' : 'csv',
      excelAvailable: templates.excelAvailable(),
      formatNote: templates.excelAvailable()
        ? 'Templates are Excel workbooks with the valid values listed on a second sheet.'
        : 'Excel support is unavailable in this build, so templates are CSV files. They import the same way.',
      entities: templates.importableEntities(),
      steps: [
        'Download the template for the kind of data you want to add.',
        'Fill it in offline. Do not rename or reorder the columns.',
        'Upload it here and read the validation report.',
        'Import once the report looks right.',
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 1. Download a template
// ---------------------------------------------------------------------------
router.get('/template/:entity', async (req, res, next) => {
  try {
    const withData = req.query.withData === '1' || req.query.withData === 'true';
    const result = await templates.buildTemplate(req, req.params.entity, { withData });
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Template-Version', String(templates.TEMPLATE_VERSION));
    res.type(result.mimeType).send(result.buffer);
  } catch (err) {
    next(err);
  }
});

/** The column list on its own, so the screen can show it before downloading. */
router.get('/columns/:entity', (req, res, next) => {
  try {
    const { getEntity } = require('../services/entityRegistry');
    const entity = getEntity(req.params.entity);
    const collegeId = entity.collegeScoped ? requireCollege(req) : null;
    res.json({
      entity: entity.key,
      entityLabel: entity.label,
      templateVersion: templates.TEMPLATE_VERSION,
      columns: templates.templateColumns(entity).map((c) => ({
        key: c.key, header: c.header, required: c.required, hint: c.hint, type: c.field.type,
      })),
      // The valid values for every reference column, which is what people get
      // wrong most often when filling a sheet in offline.
      references: entity.collegeScoped ? templates.referenceData(entity, collegeId) : [],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 2. Validate -- the pre-import report, nothing is written
// ---------------------------------------------------------------------------
router.post('/validate', async (req, res, next) => {
  try {
    const { entityKey, filename, buffer } = readUpload(req);
    const report = await templates.validateImport(req, entityKey, buffer, filename);
    res.json({
      ...report,
      // Echoed back so Commit imports exactly the file that was validated.
      upload: { filename, bytes: buffer.length },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 3. Commit
// ---------------------------------------------------------------------------
router.post('/commit', async (req, res, next) => {
  try {
    const { entityKey, filename, buffer } = readUpload(req);
    const allowPartial = !!((req.body && req.body.allowPartial) || req.query.allowPartial === '1');
    const result = await templates.commitImport(req, entityKey, buffer, filename, { allowPartial });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
router.get('/batches', (req, res, next) => {
  try {
    const { scope } = req;
    const collegeId = scope.isSuperAdmin ? scope.activeCollegeId : scope.homeCollegeId;
    res.json({
      batches: templates.listBatches(collegeId, req.query.limit ? Number(req.query.limit) : 50),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/batches/:id', (req, res, next) => {
  try {
    const { scope } = req;
    const row = db.get('SELECT * FROM import_batches WHERE id = ?', [Number(req.params.id)]);
    if (!row) throw httpError(404, 'That import was not found.');
    if (!scope.isSuperAdmin && Number(row.college_id) !== scope.homeCollegeId) {
      throw httpError(403, 'That import belongs to another college.', 'COLLEGE_FORBIDDEN');
    }
    let report = null;
    try { report = JSON.parse(row.report_json); } catch { report = null; }
    res.json({ ...row, report });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
