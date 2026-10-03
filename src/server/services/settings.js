'use strict';

/**
 * Application settings (key/value in `app_settings`).
 *
 * Everything that is a machine-level preference rather than university data
 * lives here: the AI Assistant's model and privacy switches, the LAN sharing
 * mode, backup bookkeeping, and the first-run seed marker.
 *
 * Secrets never live here in readable form -- see services/secrets.js.
 */

const db = require('../db/connection');

/**
 * Declared settings, so the Settings screen can be generated and so a fresh
 * install has sensible values without a migration step.
 */
const DEFINITIONS = {
  // --- Section 14: AI Timetable Assistant --------------------------------
  ai_enabled: {
    label: 'Enable the AI Timetable Assistant',
    type: 'boolean', default: '1', group: 'AI Assistant',
    help: 'When off, the Assistant is hidden entirely and no external call is ever made.',
  },
  ai_model: {
    label: 'OpenAI Model',
    type: 'enum', default: 'gpt-4o-mini', group: 'AI Assistant',
    // OpenAI's catalogue changes over time, so the field accepts a typed value
    // too rather than hard-locking the app to this list.
    values: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    allowCustom: true,
    help: 'Used only by the Assistant. Billed to your own OpenAI account.',
  },
  ai_privacy_mode: {
    label: 'Privacy Mode (recommended)',
    type: 'boolean', default: '1', group: 'AI Assistant',
    help: 'Removes student names and IDs from anything sent to OpenAI. Counts and section names are kept.',
  },
  ai_include_faculty_names: {
    label: 'Include faculty, course and room names',
    type: 'boolean', default: '1', group: 'AI Assistant',
    help: 'Turn off to send anonymised labels (Teacher 1, Room 3) instead of real names.',
  },
  ai_max_context_classes: {
    label: 'Maximum classes sent as context',
    type: 'number', default: '400', group: 'AI Assistant',
    help: 'Caps how much of the timetable is described to the model, which caps the cost per question.',
  },

  // --- Section 15: install mode ------------------------------------------
  network_mode: {
    label: 'Database Mode',
    type: 'enum', default: 'LOCAL', group: 'Network',
    values: ['LOCAL', 'HOST', 'CLIENT'],
    help: 'LOCAL: this machine only. HOST: share this machine\'s database over the LAN. '
      + 'CLIENT: use another machine as the host.',
  },
  network_port: {
    label: 'LAN Port',
    type: 'number', default: '4713', group: 'Network',
  },
  network_host_url: {
    label: 'Host Address',
    type: 'text', default: '', group: 'Network',
    help: 'Used in CLIENT mode, e.g. http://192.168.1.24:4713',
  },

  // --- Housekeeping -------------------------------------------------------
  institution_name: { label: 'Institution Name', type: 'text', default: '', group: 'General' },
  academic_session: { label: 'Current Academic Session', type: 'text', default: '', group: 'General' },
  term_start_date: {
    label: 'Term Start Date', type: 'text', default: '', group: 'General',
    help: 'YYYY-MM-DD. Used by the calendar (iCal) export so classes repeat from the right week. '
      + 'Leave blank to export from the coming Monday.',
  },
  term_weeks: {
    label: 'Term Length (weeks)', type: 'number', default: '16', group: 'General',
    help: 'How many weeks the calendar export repeats each weekly class for.',
  },
  seeded: { label: 'Demo data loaded', type: 'boolean', default: '0', group: 'Internal', internal: true },
  auth_token_secret: { label: 'Session signing secret', type: 'text', default: '', group: 'Internal', internal: true },
  openai_api_key_enc: { label: 'OpenAI key (encrypted)', type: 'text', default: '', group: 'Internal', internal: true },
  last_backup_at: { label: 'Last backup', type: 'text', default: '', group: 'Internal', internal: true },
  auto_update: {
    label: 'Check for updates automatically',
    type: 'boolean', default: '0', group: 'General',
    help: 'Requires an internet connection. Everything else in the app works offline.',
  },
};

function getSetting(key, fallback = undefined) {
  const row = db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
  if (row && row.value != null) return row.value;
  if (fallback !== undefined) return fallback;
  const def = DEFINITIONS[key];
  return def ? def.default : null;
}

function setSetting(key, value) {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, value == null ? null : String(value)]
  );
  return getSetting(key);
}

const getBool = (key) => {
  const v = String(getSetting(key) ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

const getNumber = (key) => {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : Number(DEFINITIONS[key] ? DEFINITIONS[key].default : 0);
};

/** Everything the Settings screen needs, internal keys excluded. */
function publicSettings() {
  const out = [];
  for (const [key, def] of Object.entries(DEFINITIONS)) {
    if (def.internal) continue;
    out.push({
      key,
      label: def.label,
      type: def.type,
      group: def.group,
      help: def.help || null,
      values: def.values || null,
      allowCustom: !!def.allowCustom,
      value: getSetting(key),
      default: def.default,
    });
  }
  return out;
}

function updateSettings(patch) {
  const applied = {};
  const errors = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const def = DEFINITIONS[key];
    if (!def || def.internal) {
      errors.push(`"${key}" is not a setting that can be changed here.`);
      continue;
    }
    let next = value;
    if (def.type === 'boolean') next = (value === true || value === 1 || value === '1' || value === 'true') ? '1' : '0';
    if (def.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) { errors.push(`${def.label} must be a number.`); continue; }
      next = String(n);
    }
    if (def.type === 'enum' && !def.allowCustom && !def.values.includes(String(value))) {
      errors.push(`${def.label} must be one of: ${def.values.join(', ')}.`);
      continue;
    }
    setSetting(key, next);
    applied[key] = next;
  }
  if (errors.length) {
    const err = new Error(errors[0]);
    err.status = 400;
    err.details = errors;
    err.code = 'VALIDATION';
    throw err;
  }
  return applied;
}

module.exports = {
  DEFINITIONS,
  getSetting,
  setSetting,
  getBool,
  getNumber,
  publicSettings,
  updateSettings,
};
