'use strict';

/**
 * Bulk data entry via Excel (Section 10).
 *
 * The flow is deliberately three-legged:
 *   1. Export a blank template whose headers exactly match the entity's fields
 *   2. The user fills it offline
 *   3. Import -> validate -> show a report -> only then commit
 *
 * Nothing is written to the database until the coordinator has seen the
 * validation report and pressed Import, so a bad spreadsheet can never leave
 * the data half-loaded (Section 10.3).
 *
 * Two decisions worth knowing about:
 *   - Reference columns are filled in with the target's own code or name, never
 *     a database id, because someone filling a spreadsheet offline has no way to
 *     know internal ids. The "Reference Data" sheet lists exactly what to type.
 *   - If exceljs is unavailable (a stripped install), templates fall back to CSV
 *     rather than the feature disappearing. Both formats import.
 */

const db = require('../db/connection');
const {
  getEntity, ENTITIES, bulkEntities, DAY_NAMES,
} = require('./entityRegistry');
const { buildValues, assertEntityAccess, resolveTargetCollege, translateDbError } = require('./crud');
const { httpError } = require('../auth/middleware');

/**
 * Bumped whenever a template's column set changes, so a spreadsheet filled from
 * an older build is flagged instead of silently mis-mapped (Section 10.4).
 */
const TEMPLATE_VERSION = 1;
const META_SHEET = 'Template Info';
const MAX_IMPORT_ROWS = 5000;

let excelJs;
let excelChecked = false;
function getExcel() {
  if (!excelChecked) {
    excelChecked = true;
    try {
      excelJs = require('exceljs');
    } catch {
      excelJs = null;
    }
  }
  return excelJs;
}

const excelAvailable = () => !!getExcel();

// ---------------------------------------------------------------------------
// Column model
// ---------------------------------------------------------------------------

/** The natural key a user types for a reference: prefer a code, else the name. */
function refKeyFields(target) {
  const has = (k) => target.fields.some((x) => x.key === k);
  const keys = [];
  if (has('code')) keys.push('code');
  if (has('employee_id')) keys.push('employee_id');
  if (has('roll_number')) keys.push('roll_number');
  if (has('room_number')) keys.push('room_number');
  if (has('name')) keys.push('name');
  if (!keys.length) keys.push(target.titleField || 'name');
  return keys;
}

function fieldHint(field) {
  switch (field.type) {
    case 'enum':
      return `One of: ${field.values.join(' | ')}`;
    case 'boolean':
      return 'Yes or No';
    case 'time':
      return 'HH:MM (24-hour), e.g. 09:30';
    case 'date':
      return 'YYYY-MM-DD';
    case 'day':
      return '1=Monday ... 7=Sunday';
    case 'csv':
      return field.values
        ? `Comma-separated, from: ${field.values.join(' | ')}`
        : 'Comma-separated list';
    case 'ref': {
      const target = ENTITIES[field.ref];
      if (!target) return 'Reference';
      return `${target.singular} ${refKeyFields(target)[0].replace(/_/g, ' ')} `
        + '(see the Reference Data sheet)';
    }
    case 'number':
      return 'Whole number';
    default:
      return field.required ? 'Required' : '';
  }
}

/**
 * The template's columns, in order. `college_id` is never exposed: it is forced
 * from the importing user's own scope (Section 12).
 */
function templateColumns(entity) {
  return entity.fields
    .filter((field) => field.key !== 'college_id' && !field.computed && !field.noImport)
    .map((field) => ({
      key: field.key,
      // Section 10.1: the header IS the field's label, verbatim.
      header: field.label,
      field,
      required: !!field.required,
      hint: fieldHint(field),
    }));
}

/** Existing rows the user may reference, grouped by referenced entity. */
function referenceData(entity, collegeId) {
  const out = [];
  const seen = new Set();
  for (const field of entity.fields) {
    if (field.type !== 'ref') continue;
    const target = ENTITIES[field.ref];
    if (!target || seen.has(target.key)) continue;
    seen.add(target.key);

    const keys = refKeyFields(target);
    const cols = [...new Set([...keys, target.titleField || 'name'])]
      .filter((c) => c === 'id' || target.fields.some((x) => x.key === c));
    const scoped = target.collegeScoped && collegeId != null;
    const rows = db.all(
      `SELECT ${cols.join(', ')} FROM ${target.table}`
      + `${scoped ? ' WHERE college_id = ?' : ''} ORDER BY ${cols[0]} LIMIT 500`,
      scoped ? [collegeId] : []
    );
    out.push({
      forField: field.label,
      entity: target.key,
      label: target.label,
      typeThis: keys[0],
      columns: cols,
      rows,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template export
// ---------------------------------------------------------------------------
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsvTemplate(entity, columns) {
  return `${columns.map((c) => csvCell(c.header)).join(',')}\n`;
}

/**
 * Excel forbids : \ / ? * [ ] in a sheet name and caps it at 31 characters, so
 * an entity label like "Rooms / LTs / Labs" cannot be used as-is.
 */
function sheetName(label) {
  const cleaned = String(label || 'Sheet1').replace(/[:\\/?*[\]]/g, '-').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

async function buildTemplate(req, entityKey, opts = {}) {
  const entity = getEntity(entityKey);
  assertEntityAccess(req, entity, 'create');
  if (!entity.bulk) {
    throw httpError(400, `${entity.label} is not set up for bulk import -- add these one at a time.`);
  }
  const collegeId = entity.collegeScoped
    ? resolveTargetCollege(req, entity, {})
    : null;
  const columns = templateColumns(entity);
  const withData = !!opts.withData;

  const excel = getExcel();
  if (!excel) {
    return {
      filename: `${entity.key}-template-v${TEMPLATE_VERSION}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(buildCsvTemplate(entity, columns), 'utf8'),
      format: 'csv',
    };
  }

  const wb = new excel.Workbook();
  wb.creator = 'University Timetable Management';
  wb.description = `Import template for ${entity.label} (v${TEMPLATE_VERSION})`;

  // --- Sheet 1: the data sheet the user fills in ---------------------------
  const ws = wb.addWorksheet(sheetName(entity.label));
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.max(14, Math.min(40, c.header.length + 6)),
  }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.height = 22;
  head.alignment = { vertical: 'middle' };
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      // Required columns get a darker header so nothing mandatory is missed.
      fgColor: { argb: c.required ? 'FF1D4ED8' : 'FF475569' },
    };
    if (c.hint) cell.note = `${c.required ? 'Required. ' : 'Optional. '}${c.hint}`;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  // Dropdowns and range checks for the first 1000 data rows.
  columns.forEach((c, i) => {
    const letter = ws.getColumn(i + 1).letter;
    const range = `${letter}2:${letter}1001`;
    if (c.field.type === 'enum') {
      ws.dataValidations.add(range, {
        type: 'list',
        allowBlank: !c.required,
        formulae: [`"${c.field.values.join(',')}"`],
        showErrorMessage: true,
        errorTitle: c.header,
        error: `Choose one of: ${c.field.values.join(', ')}`,
      });
    } else if (c.field.type === 'boolean') {
      ws.dataValidations.add(range, {
        type: 'list',
        allowBlank: !c.required,
        formulae: ['"Yes,No"'],
        showErrorMessage: true,
        errorTitle: c.header,
        error: 'Enter Yes or No.',
      });
    } else if (c.field.type === 'day') {
      ws.dataValidations.add(range, {
        type: 'list',
        allowBlank: !c.required,
        formulae: [`"${Object.values(DAY_NAMES).join(',')}"`],
        showErrorMessage: false,
      });
    }
  });

  if (withData && entity.collegeScoped && collegeId != null) {
    const rows = db.all(`SELECT * FROM ${entity.table} WHERE college_id = ? ORDER BY id`, [collegeId]);
    for (const row of rows) ws.addRow(exportRow(entity, columns, row));
  } else if (withData) {
    const rows = db.all(`SELECT * FROM ${entity.table} ORDER BY id`);
    for (const row of rows) ws.addRow(exportRow(entity, columns, row));
  }

  // --- Sheet 2: instructions ---------------------------------------------
  const info = wb.addWorksheet(META_SHEET);
  info.columns = [
    { header: 'Column', key: 'col', width: 30 },
    { header: 'Required', key: 'req', width: 12 },
    { header: 'What to enter', key: 'hint', width: 70 },
  ];
  info.getRow(1).font = { bold: true };
  columns.forEach((c) => info.addRow({ col: c.header, req: c.required ? 'Yes' : 'No', hint: c.hint }));
  info.addRow({});
  info.addRow({ col: 'Entity', req: entity.key, hint: 'Do not change this sheet -- it identifies the template.' });
  info.addRow({ col: 'Template version', req: String(TEMPLATE_VERSION), hint: 'The app checks this on import.' });
  info.addRow({
    col: 'How to use',
    req: '',
    hint: 'Fill one row per record on the first sheet. Leave optional cells blank. '
      + 'Then use Data Management > Import and choose this file.',
  });

  // --- Sheet 3: what may be referenced ------------------------------------
  const refs = referenceData(entity, collegeId);
  if (refs.length) {
    const rs = wb.addWorksheet('Reference Data');
    let cursor = 1;
    for (const ref of refs) {
      const title = rs.getCell(cursor, 1);
      title.value = `${ref.label} -- enter the "${ref.typeThis}" value in the `
        + `"${ref.forField}" column`;
      title.font = { bold: true };
      cursor += 1;
      const headerRow = rs.getRow(cursor);
      ref.columns.forEach((c, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = c;
        cell.font = { bold: true, italic: true };
      });
      cursor += 1;
      for (const row of ref.rows) {
        const r = rs.getRow(cursor);
        ref.columns.forEach((c, i) => { r.getCell(i + 1).value = row[c]; });
        cursor += 1;
      }
      if (!ref.rows.length) {
        rs.getCell(cursor, 1).value = '(none yet -- create these first)';
        cursor += 1;
      }
      cursor += 1;
    }
    rs.getColumn(1).width = 46;
    rs.getColumn(2).width = 32;
    rs.getColumn(3).width = 32;
  }

  const buffer = await wb.xlsx.writeBuffer();
  return {
    filename: `${entity.key}-${withData ? 'export' : 'template'}-v${TEMPLATE_VERSION}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(buffer),
    format: 'xlsx',
  };
}

/** Turns a stored row back into template-shaped cells (for "export with data"). */
function exportRow(entity, columns, row) {
  const out = {};
  for (const c of columns) {
    const raw = row[c.key];
    if (raw == null) { out[c.key] = null; continue; }
    if (c.field.type === 'ref') {
      const target = ENTITIES[c.field.ref];
      if (target) {
        const keys = refKeyFields(target);
        const found = db.get(`SELECT ${keys.join(', ')} FROM ${target.table} WHERE id = ?`, [raw]);
        out[c.key] = found ? found[keys[0]] : raw;
        continue;
      }
    }
    if (c.field.type === 'boolean') { out[c.key] = raw ? 'Yes' : 'No'; continue; }
    if (c.field.type === 'day') { out[c.key] = DAY_NAMES[raw] || raw; continue; }
    out[c.key] = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing an uploaded file
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    // exceljs rich text / formula / hyperlink cells
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if (value.text != null) return String(value.text);
    if (value.result != null) return String(value.result);
    if (value instanceof Date) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
    }
    return '';
  }
  return String(value);
}

/**
 * Reads an uploaded file into `{headers, rows, templateVersion}`.
 * Accepts .xlsx and .csv, and never trusts the sheet name or column order.
 */
async function parseUpload(buffer, filename = '') {
  const isCsv = /\.csv$/i.test(filename)
    || (buffer.length > 1 && buffer[0] !== 0x50); // xlsx is a zip: starts with "PK"

  if (isCsv) {
    const grid = parseCsv(buffer.toString('utf8'));
    if (!grid.length) throw httpError(400, 'That file has no rows in it.');
    const headers = grid[0].map((h) => String(h).trim());
    return {
      headers,
      rows: grid.slice(1).map((r) => headers.map((_, i) => (r[i] == null ? '' : String(r[i]).trim()))),
      templateVersion: null,
      format: 'csv',
    };
  }

  const excel = getExcel();
  if (!excel) {
    throw httpError(400,
      'Excel support is unavailable in this build. Save the file as CSV and import that instead.');
  }
  const wb = new excel.Workbook();
  await wb.xlsx.load(buffer);

  let templateVersion = null;
  const meta = wb.getWorksheet(META_SHEET);
  if (meta) {
    meta.eachRow((r) => {
      if (String(cellText(r.getCell(1).value)).trim().toLowerCase() === 'template version') {
        const n = Number(cellText(r.getCell(2).value));
        if (Number.isFinite(n)) templateVersion = n;
      }
    });
  }

  const ws = wb.worksheets.find((s) => s.name !== META_SHEET && s.name !== 'Reference Data')
    || wb.worksheets[0];
  if (!ws) throw httpError(400, 'That workbook has no sheets in it.');

  const headers = [];
  const headerRow = ws.getRow(1);
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cellText(cell.value).trim();
  });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (!headers.length) throw httpError(400, 'The first row of the sheet must contain the column headers.');

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = headers.map((_, i) => cellText(row.getCell(i + 1).value).trim());
    if (values.some((v) => v !== '')) rows.push(values);
  });

  return { headers, rows, templateVersion, format: 'xlsx', sheet: ws.name };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Maps the file's headers onto registry fields, tolerating label or key form. */
function mapHeaders(columns, headers) {
  const byLabel = new Map(columns.map((c) => [norm(c.header), c]));
  const byKey = new Map(columns.map((c) => [norm(c.key), c]));
  const mapping = [];
  const unknown = [];

  headers.forEach((header, index) => {
    const n = norm(header);
    const col = byLabel.get(n) || byKey.get(n);
    if (col) mapping.push({ index, column: col, header });
    else if (header) unknown.push(header);
  });

  const matched = new Set(mapping.map((m) => m.column.key));
  const missingRequired = columns.filter((c) => c.required && !matched.has(c.key)).map((c) => c.header);
  return { mapping, unknown, missingRequired };
}

/** Resolves a typed reference value ("CSE", "Room 101") to an id. */
function resolveRef(field, raw, collegeId, cache) {
  const target = ENTITIES[field.ref];
  if (!target) return { id: null, error: `${field.label}: unknown reference type.` };
  const text = String(raw).trim();

  const cacheKey = `${target.key}|${collegeId}`;
  if (!cache.has(cacheKey)) {
    const keys = refKeyFields(target);
    const cols = [...new Set(['id', ...keys, target.titleField || 'name'])]
      .filter((c) => c === 'id' || target.fields.some((x) => x.key === c));
    const scoped = target.collegeScoped && collegeId != null;
    const rows = db.all(
      `SELECT ${cols.join(', ')} FROM ${target.table}${scoped ? ' WHERE college_id = ?' : ''}`,
      scoped ? [collegeId] : []
    );
    const index = new Map();
    for (const row of rows) {
      for (const col of cols) {
        if (col === 'id') continue;
        const k = norm(row[col]);
        if (!k) continue;
        if (!index.has(k)) index.set(k, []);
        if (!index.get(k).includes(row.id)) index.get(k).push(row.id);
      }
      index.set(`#${row.id}`, [row.id]);
    }
    cache.set(cacheKey, { index, keys, count: rows.length });
  }
  const { index, keys, count } = cache.get(cacheKey);

  // An explicit numeric id is accepted too, for round-tripping an export.
  if (/^\d+$/.test(text) && index.has(`#${Number(text)}`)) return { id: Number(text) };

  const hits = index.get(norm(text));
  if (!hits || !hits.length) {
    return {
      id: null,
      error: count
        ? `${field.label}: no ${target.singular} matches "${text}". `
          + `Enter its ${keys[0].replace(/_/g, ' ')} exactly as it appears in the Reference Data sheet.`
        : `${field.label}: there are no ${target.label} in this college yet -- create them first.`,
    };
  }
  if (hits.length > 1) {
    return {
      id: null,
      error: `${field.label}: "${text}" matches ${hits.length} different ${target.label}. `
        + 'Use a value that is unique, or the numeric id.',
    };
  }
  return { id: hits[0] };
}

/** Day columns accept "Monday", "Mon" or 1-7. */
function normaliseDay(raw) {
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return text;
  const n = norm(text);
  for (const [num, name] of Object.entries(DAY_NAMES)) {
    if (norm(name) === n || norm(name).startsWith(n)) return num;
  }
  return text;
}

/**
 * The Section 10.3 pre-import validation report. Reads the file, checks every
 * row, and returns what would happen -- without writing anything.
 */
async function validateImport(req, entityKey, buffer, filename) {
  const entity = getEntity(entityKey);
  assertEntityAccess(req, entity, 'create');
  if (!entity.bulk) {
    throw httpError(400, `${entity.label} is not set up for bulk import -- add these one at a time.`);
  }
  const collegeId = entity.collegeScoped ? resolveTargetCollege(req, entity, {}) : null;

  const parsed = await parseUpload(buffer, filename);
  const columns = templateColumns(entity);
  const { mapping, unknown, missingRequired } = mapHeaders(columns, parsed.headers);

  const fileWarnings = [];
  if (unknown.length) {
    fileWarnings.push(`These columns are not part of ${entity.label} and will be ignored: ${unknown.join(', ')}.`);
  }
  if (parsed.templateVersion != null && parsed.templateVersion !== TEMPLATE_VERSION) {
    fileWarnings.push(
      `This file was made from template version ${parsed.templateVersion}; the current version is `
      + `${TEMPLATE_VERSION}. Download a fresh template if any column looks wrong.`
    );
  }

  if (missingRequired.length) {
    return {
      entity: entity.key,
      entityLabel: entity.label,
      filename: filename || null,
      collegeId,
      format: parsed.format,
      templateVersion: parsed.templateVersion,
      canImport: false,
      headers: parsed.headers,
      unknownColumns: unknown,
      fileErrors: [
        `Required column(s) missing: ${missingRequired.join(', ')}. `
        + 'Download a fresh template and copy your data into it.',
      ],
      fileWarnings,
      totalRows: parsed.rows.length,
      validRows: 0,
      errorRows: parsed.rows.length,
      duplicateRows: 0,
      rows: [],
    };
  }

  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw httpError(400,
      `That file has ${parsed.rows.length} rows. Please import at most ${MAX_IMPORT_ROWS} at a time.`);
  }

  const refCache = new Map();
  // Duplicate detection uses the entity's real uniqueness rule, which may be a
  // combination of columns (e.g. a course code is unique per semester+section).
  const dupFields = (entity.duplicateKey || [])
    .map((key) => entity.fields.find((x) => x.key === key))
    .filter(Boolean);
  const seenKeys = new Map();
  const results = [];
  let validRows = 0;
  let duplicateRows = 0;

  parsed.rows.forEach((cells, i) => {
    const rowNumber = i + 2; // +1 for the header, +1 because spreadsheets are 1-based
    const errors = [];
    const warnings = [];
    const body = {};

    for (const m of mapping) {
      const raw = cells[m.index];
      if (raw === undefined || raw === '') continue;
      const field = m.column.field;
      if (field.type === 'ref') {
        const { id, error } = resolveRef(field, raw, collegeId, refCache);
        if (error) errors.push(error);
        else body[field.key] = id;
      } else if (field.type === 'day') {
        body[field.key] = normaliseDay(raw);
      } else {
        body[field.key] = raw;
      }
    }

    const built = buildValues(entity, body, { collegeId });
    errors.push(...built.errors);

    // Duplicate detection -- both within the file and against what is stored.
    let isDuplicate = false;
    if (dupFields.length && !errors.length) {
      const parts = dupFields.map((field) => built.values[field.key]);
      // A key with a NULL part is not a duplicate as far as SQLite is concerned.
      if (parts.every((v) => v != null && v !== '')) {
        const key = parts.map(norm).join(String.fromCharCode(0));
        const describe = dupFields
          .map((field, idx) => `${field.label} "${parts[idx]}"`)
          .join(' + ');

        if (seenKeys.has(key)) {
          errors.push(`${describe} is already used on row ${seenKeys.get(key)} of this file.`);
          isDuplicate = true;
        } else {
          seenKeys.set(key, rowNumber);
        }

        const scoped = entity.collegeScoped && collegeId != null;
        const clauses = dupFields.map((field) => `${field.key} = ?`);
        const params = [...parts];
        if (scoped) { clauses.push('college_id = ?'); params.push(collegeId); }
        const existing = db.get(
          `SELECT id FROM ${entity.table} WHERE ${clauses.join(' AND ')}`, params
        );
        if (existing) {
          errors.push(`A ${entity.singular} with ${describe} already exists (id ${existing.id}).`);
          isDuplicate = true;
        }
      }
    }
    if (isDuplicate) duplicateRows += 1;
    if (!errors.length) validRows += 1;

    results.push({
      rowNumber,
      ok: errors.length === 0,
      duplicate: isDuplicate,
      errors,
      warnings,
      values: built.values,
      preview: previewOf(entity, built.values),
    });
  });

  const errorRows = results.length - validRows;
  return {
    entity: entity.key,
    entityLabel: entity.label,
    filename: filename || null,
    collegeId,
    format: parsed.format,
    templateVersion: parsed.templateVersion,
    // A partial import is allowed, but only deliberately: the UI asks.
    canImport: validRows > 0,
    headers: parsed.headers,
    unknownColumns: unknown,
    fileErrors: [],
    fileWarnings,
    totalRows: results.length,
    validRows,
    errorRows,
    duplicateRows,
    duplicateKey: (entity.duplicateKey || []).map((key) => {
      const field = entity.fields.find((x) => x.key === key);
      return field ? field.label : key;
    }),
    summary: results.length === 0
      ? 'That file has no data rows.'
      : `${validRows} of ${results.length} row(s) are ready to import`
        + (errorRows ? `; ${errorRows} row(s) have problems and will be skipped.` : '.'),
    rows: results,
  };
}

function previewOf(entity, values) {
  const title = values[entity.titleField || 'name'];
  const bits = (entity.subtitleFields || []).map((k) => values[k]).filter(Boolean);
  return [title, ...bits].filter(Boolean).join(' - ') || '(unnamed)';
}

/**
 * Commits a previously validated report. Re-validates from the file rather than
 * trusting a client-supplied row list, so nothing can be smuggled in between the
 * preview and the commit.
 */
async function commitImport(req, entityKey, buffer, filename, opts = {}) {
  const entity = getEntity(entityKey);
  const report = await validateImport(req, entityKey, buffer, filename);

  if (report.fileErrors.length) {
    const err = httpError(400, report.fileErrors[0], 'IMPORT_FILE_INVALID');
    err.details = report.fileErrors;
    err.report = report;
    throw err;
  }
  if (!report.validRows) {
    const err = httpError(400, 'No row in that file can be imported yet.', 'IMPORT_NO_VALID_ROWS');
    err.details = report.rows.flatMap((r) => r.errors).slice(0, 10);
    err.report = report;
    throw err;
  }
  if (report.errorRows && !opts.allowPartial) {
    const err = httpError(400,
      `${report.errorRows} row(s) have problems. Fix them, or choose "Import valid rows only".`,
      'IMPORT_HAS_ERRORS');
    err.details = report.rows.filter((r) => !r.ok).slice(0, 10)
      .map((r) => `Row ${r.rowNumber}: ${r.errors[0]}`);
    err.report = report;
    throw err;
  }

  const good = report.rows.filter((r) => r.ok);
  const cols = [
    ...new Set(good.flatMap((r) => Object.keys(r.values))),
  ].filter((c) => entity.fields.some((x) => x.key === c));
  if (entity.collegeScoped) cols.push('college_id');

  const sql = `INSERT INTO ${entity.table} (${cols.join(', ')}) `
    + `VALUES (${cols.map(() => '?').join(', ')})`;

  const inserted = [];
  let failedRow = null;
  try {
    db.transaction(() => {
      for (const row of good) {
        const params = cols.map((c) => (c === 'college_id' ? report.collegeId : (row.values[c] ?? null)));
        try {
          const info = db.run(sql, params);
          inserted.push({ rowNumber: row.rowNumber, id: info.lastInsertRowid, preview: row.preview });
        } catch (err) {
          // All-or-nothing: rolling back is safer than leaving the data half
          // loaded, and the row number tells the user exactly what to fix.
          failedRow = { rowNumber: row.rowNumber, preview: row.preview, cause: translateDbError(err, entity) };
          throw failedRow.cause;
        }
      }
    });
  } catch (err) {
    inserted.length = 0;
    db.run(
      `INSERT INTO import_batches
         (college_id, entity, filename, total_rows, valid_rows, error_rows, status, report_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'FAILED', ?, ?)`,
      [
        report.collegeId, entity.key, filename || null,
        report.totalRows, 0, report.totalRows,
        JSON.stringify({ failedRow: failedRow ? failedRow.rowNumber : null, message: String(err.message || err) }),
        req.user ? req.user.id : null,
      ]
    );
    const wrapped = httpError(
      err.status || 409,
      failedRow
        ? `Row ${failedRow.rowNumber} (${failedRow.preview}) could not be saved: ${err.message} `
          + 'Nothing was imported.'
        : `The import could not be completed: ${err.message} Nothing was imported.`,
      err.code || 'IMPORT_FAILED'
    );
    wrapped.report = report;
    throw wrapped;
  }

  const batch = db.run(
    `INSERT INTO import_batches
       (college_id, entity, filename, total_rows, valid_rows, error_rows, status, report_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'COMMITTED', ?, ?)`,
    [
      report.collegeId, entity.key, filename || null,
      report.totalRows, inserted.length, report.errorRows,
      JSON.stringify({
        summary: report.summary,
        fileWarnings: report.fileWarnings,
        skipped: report.rows.filter((r) => !r.ok).map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })),
      }),
      req.user ? req.user.id : null,
    ]
  );

  return {
    batchId: batch.lastInsertRowid,
    entity: entity.key,
    entityLabel: entity.label,
    imported: inserted.length,
    skipped: report.errorRows,
    inserted,
    report,
    message: `Imported ${inserted.length} ${entity.label.toLowerCase()}`
      + (report.errorRows ? `, skipped ${report.errorRows} row(s) with problems.` : '.'),
  };
}

function listBatches(collegeId, limit = 50) {
  return db.all(
    `SELECT b.id, b.entity, b.filename, b.total_rows, b.valid_rows, b.error_rows,
            b.status, b.created_at, u.full_name AS created_by_name
       FROM import_batches b
       LEFT JOIN users u ON u.id = b.created_by
      WHERE (? IS NULL OR b.college_id = ?)
      ORDER BY b.id DESC LIMIT ?`,
    [collegeId ?? null, collegeId ?? null, limit]
  );
}

/** What the Import/Export screen lists. */
function importableEntities() {
  return bulkEntities().map((e) => ({
    key: e.key,
    label: e.label,
    singular: e.singular,
    group: e.group,
    duplicateKey: (e.duplicateKey || []).map((key) => {
      const field = e.fields.find((x) => x.key === key);
      return field ? field.label : key;
    }),
    columns: templateColumns(e).map((c) => ({
      key: c.key, header: c.header, required: c.required, hint: c.hint, type: c.field.type,
    })),
  }));
}

module.exports = {
  TEMPLATE_VERSION,
  excelAvailable,
  templateColumns,
  referenceData,
  buildTemplate,
  parseUpload,
  mapHeaders,
  resolveRef,
  validateImport,
  commitImport,
  listBatches,
  importableEntities,
};
