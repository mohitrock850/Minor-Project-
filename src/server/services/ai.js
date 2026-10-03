'use strict';

/**
 * AI Timetable Assistant (Section 14).
 *
 * The ONLY module in this application that talks to the internet. It talks to
 * exactly one host -- api.openai.com -- using the administrator's own key, which
 * is read from OS-encrypted storage at the moment of the call and never held
 * anywhere else. No other provider is supported, and every other feature in the
 * product works with the network unplugged.
 *
 * What gets sent is assembled here, deliberately, in `buildAiContext`: a compact
 * digest of the timetable, never raw table dumps. Privacy Mode removes student
 * names and identifiers entirely, and optionally replaces faculty, course and
 * room names with stable labels which are translated back in the reply.
 */

const db = require('../db/connection');
const settings = require('./settings');
const secrets = require('./secrets');
const { buildView, facultyWorkload, roomUtilisation } = require('./views');
const { loadTimingGrid } = require('./context');
const { toHHMM } = require('./timing');
const { checkCollege } = require('./readiness');
const { validateTimetable } = require('./editing');
const { DAY_NAMES } = require('./entityRegistry');

const OPENAI_HOST = 'https://api.openai.com';
const REQUEST_TIMEOUT_MS = 60000;
const MAX_HISTORY = 8;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function status() {
  const encryption = secrets.encryptionStatus();
  const enabled = settings.getBool('ai_enabled');
  const configured = secrets.hasKey();
  const def = settings.DEFINITIONS.ai_model;

  let message = null;
  if (!enabled) {
    message = 'The AI Assistant is switched off in Settings.';
  } else if (!encryption.available) {
    message = encryption.reason;
  } else if (!configured) {
    message = 'Add your own OpenAI API key in Settings to use the Assistant. '
      + 'Everything else in the application works without it.';
  }

  return {
    enabled,
    configured,
    available: enabled && configured && encryption.available,
    encryption,
    provider: 'OpenAI',
    endpoint: `${OPENAI_HOST}/v1/chat/completions`,
    keyHint: secrets.getHint(),
    model: settings.getSetting('ai_model'),
    models: def.values,
    allowCustomModel: true,
    privacyMode: settings.getBool('ai_privacy_mode'),
    includeNames: settings.getBool('ai_include_faculty_names'),
    maxContextClasses: settings.getNumber('ai_max_context_classes'),
    billingNote: 'Requests are billed to the OpenAI account that owns this key. '
      + 'Usage and cost are visible on your OpenAI dashboard.',
    message,
  };
}

function requireReady() {
  const s = status();
  if (!s.available) {
    const err = new Error(s.message || 'The AI Assistant is not configured.');
    err.status = 400;
    err.code = 'AI_NOT_CONFIGURED';
    err.aiStatus = s;
    throw err;
  }
  const key = secrets.getKey();
  if (!key) {
    const err = new Error(
      'The stored OpenAI key could not be decrypted on this machine. Enter it again in Settings.'
    );
    err.status = 400;
    err.code = 'AI_KEY_UNREADABLE';
    throw err;
  }
  return { ...s, key };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function networkError(err) {
  const e = new Error(
    'Could not reach api.openai.com. The Assistant is the only feature that needs '
    + 'an internet connection -- check your connection and try again.'
  );
  e.status = 503;
  e.code = 'AI_OFFLINE';
  e.cause = String(err && err.message ? err.message : err);
  return e;
}

function apiError(res, body) {
  const detail = body && body.error && body.error.message ? body.error.message : null;
  const map = {
    401: 'OpenAI rejected that API key. Check it in Settings, or create a new one.',
    403: 'That OpenAI account is not permitted to use this model.',
    404: `The model "${settings.getSetting('ai_model')}" is not available to your OpenAI account. `
      + 'Pick a different model in Settings.',
    429: 'OpenAI is rate-limiting this key, or the account has no remaining quota.',
    500: 'OpenAI reported a server error. Try again in a moment.',
    503: 'OpenAI is temporarily unavailable. Try again in a moment.',
  };
  const err = new Error(map[res.status] || `OpenAI returned an error (HTTP ${res.status}).`);
  err.status = res.status === 401 || res.status === 403 ? 400 : 502;
  err.code = 'AI_API_ERROR';
  err.details = detail ? [detail] : [];
  return err;
}

async function callOpenAi(path, { key, method = 'GET', body = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OPENAI_HOST}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw networkError(err);
  }
  clearTimeout(timer);

  let payload = null;
  const text = await res.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) throw apiError(res, payload);
  return payload;
}

/** Section 14.1 Test Connection. */
async function testConnection(candidateKey = null) {
  const encryption = secrets.encryptionStatus();
  const key = candidateKey ? String(candidateKey).trim() : secrets.getKey();
  if (!key) {
    const err = new Error('No OpenAI API key is configured.');
    err.status = 400;
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  const payload = await callOpenAi('/v1/models', { key });
  const ids = Array.isArray(payload && payload.data) ? payload.data.map((m) => m.id) : [];
  const chosen = settings.getSetting('ai_model');
  return {
    ok: true,
    message: `Connected to OpenAI. ${ids.length} model(s) available to this key.`,
    modelAvailable: ids.length ? ids.includes(chosen) : null,
    chosenModel: chosen,
    // Only chat-capable ids are worth offering, and the list is long.
    models: ids.filter((id) => /^(gpt|o\d)/.test(id)).sort().slice(0, 60),
    encryptionAvailable: encryption.available,
  };
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/**
 * A compact digest of one college's timetable situation.
 * Nothing here identifies an individual student: students appear only as counts.
 */
function buildAiContext(collegeId, opts = {}) {
  const college = db.get('SELECT * FROM colleges WHERE id = ?', [collegeId]);
  const maxClasses = Math.max(20, settings.getNumber('ai_max_context_classes'));

  let timing = null;
  try {
    const { grid, timing: cfg } = loadTimingGrid(collegeId);
    timing = {
      name: cfg.name,
      workingDays: grid.workingDays.map((d) => DAY_NAMES[d]),
      periodsPerDay: grid.slots.length,
      periodMinutes: grid.slotMinutes,
      dayStart: grid.slots.length ? grid.slots[0].start : null,
      dayEnd: grid.slots.length ? grid.slots[grid.slots.length - 1].end : null,
      periods: grid.slots.map((s) => `P${s.index} ${s.start}-${s.end}`),
      breaks: grid.breaks.map((b) => `${b.name} ${toHHMM(b.start)}-${toHHMM(b.end)}`),
    };
  } catch {
    // No timing configuration yet -- the readiness block below says so plainly.
    timing = null;
  }

  const counts = {};
  for (const [label, table] of Object.entries({
    departments: 'departments', programs: 'programs', semesters: 'semesters',
    sections: 'sections', subSections: 'sub_sections', courses: 'courses',
    faculty: 'faculty', rooms: 'rooms',
  })) {
    counts[label] = db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE college_id = ?`, [collegeId]).n;
  }

  const timetableId = opts.timetableId
    ? Number(opts.timetableId)
    : (db.get(
      `SELECT id FROM timetables WHERE college_id = ? AND status <> 'ARCHIVED'
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [collegeId]
    ) || {}).id || null;

  const timetable = timetableId
    ? db.get('SELECT * FROM timetables WHERE id = ?', [timetableId])
    : null;

  let classes = [];
  let conflicts = null;
  if (timetableId) {
    classes = db.all(
      `SELECT a.day_of_week, a.slot_index, a.start_time, a.end_time, a.periods, a.component,
              a.is_locked, a.is_manual, a.status, a.score,
              c.code AS course_code, c.name AS course_name, c.ac_requirement,
              f.name AS faculty_name, r.name AS room_name, r.is_ac, r.seating_capacity,
              s.name AS section_name, s.student_count AS section_students,
              ss.name AS sub_section_name, ss.student_count AS sub_section_students
         FROM assignments a
         LEFT JOIN courses c ON c.id = a.course_id
         LEFT JOIN faculty f ON f.id = a.faculty_id
         LEFT JOIN rooms r ON r.id = a.room_id
         LEFT JOIN sections s ON s.id = a.section_id
         LEFT JOIN sub_sections ss ON ss.id = a.sub_section_id
        WHERE a.timetable_id = ?
        ORDER BY a.day_of_week, a.slot_index
        LIMIT ?`,
      [timetableId, maxClasses]
    );
    try {
      conflicts = validateTimetable(collegeId, timetableId);
    } catch {
      conflicts = null;
    }
  }

  const lastRun = timetableId
    ? db.get(
      'SELECT result_json, created_at FROM generation_runs WHERE timetable_id = ? ORDER BY id DESC LIMIT 1',
      [timetableId]
    )
    : null;
  let lastGeneration = null;
  if (lastRun) {
    try {
      const parsed = JSON.parse(lastRun.result_json);
      lastGeneration = {
        at: lastRun.created_at,
        stats: parsed.stats,
        qualityScore: parsed.qualityScore,
        unscheduled: (parsed.unscheduled || []).slice(0, 30),
        issues: (parsed.issues || []).slice(0, 20),
      };
    } catch {
      lastGeneration = null;
    }
  }

  const readiness = checkCollege(collegeId);

  return {
    college: { name: college ? college.name : null, code: college ? college.code : null },
    timing,
    counts,
    dataReadiness: {
      canGenerate: readiness.canGenerate,
      percentComplete: readiness.progress.percent,
      blocking: readiness.blocking.map((b) => b.message),
      warnings: readiness.warnings.map((w) => w.message).slice(0, 10),
    },
    timetable: timetable
      ? {
        id: timetable.id, name: timetable.name, mode: timetable.mode,
        status: timetable.status, qualityScore: timetable.quality_score,
      }
      : null,
    classes: classes.map((c) => ({
      day: DAY_NAMES[c.day_of_week],
      period: c.slot_index,
      time: `${c.start_time}-${c.end_time}`,
      periods: c.periods,
      course: `${c.course_code || ''} ${c.course_name || ''}`.trim(),
      component: c.component,
      group: c.sub_section_name ? `${c.section_name}/${c.sub_section_name}` : c.section_name,
      students: c.sub_section_name ? c.sub_section_students : c.section_students,
      teacher: c.faculty_name,
      room: c.room_name,
      roomAc: c.room_name ? (c.is_ac ? 'AC' : 'NON-AC') : null,
      roomCapacity: c.seating_capacity,
      acRequirement: c.ac_requirement,
      locked: !!c.is_locked,
      manual: !!c.is_manual,
      status: c.status,
      score: c.score,
    })),
    classesTruncated: classes.length >= maxClasses,
    conflicts: conflicts
      ? {
        hardConflicts: conflicts.hardConflicts,
        softWarnings: conflicts.softWarnings,
        averageScore: conflicts.averageScore,
        problems: conflicts.problems.slice(0, 20).map((p) => ({
          label: p.label, day: DAY_NAMES[p.day], period: p.slotIndex,
          reasons: p.violations.map((v) => v.message),
        })),
        warningSamples: conflicts.warnings.slice(0, 20).map((w) => `${w.label}: ${w.message}`),
      }
      : null,
    lastGeneration,
    facultyWorkload: facultyWorkload(collegeId, timetableId)
      .filter((f) => f.periods || f.maxWeeklyHours)
      .slice(0, 60)
      .map((f) => ({
        teacher: f.name, periods: f.periods, maxWeeklyHours: f.maxWeeklyHours,
        loadPercent: f.loadPercent, daysUsed: f.daysUsed, overloaded: f.overloaded,
      })),
    roomUtilisation: roomUtilisation(collegeId, timetableId)
      .slice(0, 60)
      .map((r) => ({
        room: r.name, type: r.roomTypeLabel, ac: r.acLabel,
        capacity: r.capacity, periodsUsed: r.periodsUsed,
        utilisationPercent: r.utilizationPercent,
      })),
    focus: opts.view || null,
  };
}

/** Optionally narrows the context to whatever the user is looking at. */
function focusView(collegeId, ref) {
  if (!ref || !ref.type || ref.id == null) return null;
  try {
    const view = buildView({ collegeId, type: ref.type, id: ref.id, timetableId: ref.timetableId });
    return {
      what: `${ref.type} view`,
      subject: view.scope.label,
      stats: view.stats,
      classes: view.cards.map((c) => ({
        day: c.dayName, period: c.slotIndex, time: c.timeLabel,
        course: `${c.courseCode || ''} ${c.courseName || ''}`.trim(),
        component: c.component, group: c.groupLabel,
        teacher: c.facultyName, room: c.roomName, roomAc: c.acLabel,
        locked: c.isLocked, warnings: (c.warnings || []).map((w) => (typeof w === 'string' ? w : w.message)),
      })),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Privacy (Section 14.3)
// ---------------------------------------------------------------------------

/**
 * Replaces real names with stable labels and returns the mapping so the reply can
 * be translated back for the reader. Student names and identifiers are not part
 * of the context at any privacy level, so there is nothing to strip there.
 */
function anonymise(context, { includeNames }) {
  if (includeNames) return { context, map: new Map() };

  const pools = { teacher: new Map(), room: new Map(), course: new Map() };
  const label = (kind, value) => {
    if (value == null || value === '') return value;
    const pool = pools[kind];
    if (!pool.has(value)) {
      const prefix = kind === 'teacher' ? 'Teacher' : (kind === 'room' ? 'Room' : 'Course');
      pool.set(value, `${prefix} ${pool.size + 1}`);
    }
    return pool.get(value);
  };

  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (k === 'teacher' || k === 'faculty_name' || k === 'facultyName') { out[k] = label('teacher', v); continue; }
          if (k === 'room' || k === 'roomName') { out[k] = label('room', v); continue; }
          if (k === 'course' || k === 'courseName') { out[k] = label('course', v); continue; }
        }
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };

  const anonymised = walk(context);

  // Free-text fields (conflict reasons, warnings) mention names too.
  const replacements = [];
  for (const pool of Object.values(pools)) {
    for (const [real, fake] of pool) replacements.push([real, fake]);
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  const scrubText = (s) => replacements.reduce(
    (acc, [real, fake]) => acc.split(real).join(fake), s
  );
  const scrubStrings = (node) => {
    if (typeof node === 'string') return scrubText(node);
    if (Array.isArray(node)) return node.map(scrubStrings);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = scrubStrings(v);
      return out;
    }
    return node;
  };

  const reverse = new Map(replacements.map(([real, fake]) => [fake, real]));
  return { context: scrubStrings(anonymised), map: reverse };
}

/** Puts the real names back into the model's answer. */
function deanonymise(text, map) {
  if (!map || !map.size) return text;
  let out = String(text);
  for (const [fake, real] of map) out = out.split(fake).join(real);
  return out;
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the timetable assistant built into a university timetable management desktop application.

You are given a JSON digest of one college's data and its current timetable. Answer questions about it: explain why something could not be scheduled, suggest where a class could move, point out overloaded teachers or under-used rooms, and explain conflicts in plain language.

Rules you must respect when reasoning:
- A teacher cannot be in two places in the same period; nor can a room; nor can a student group.
- Two sub-sections of the same section MAY share a period, but only with a different teacher AND a different room.
- Working hours, period length, and breaks come from this college's own timing configuration in the digest. Never assume a standard school day.
- Locked classes must not be suggested for moving unless the user explicitly asks about unlocking one.
- A room needs enough capacity for the group, and must satisfy the course's AC requirement (REQUIRED means air-conditioned only).

How to answer:
- Be brief and concrete. Refer to specific days, periods, teachers and rooms from the digest.
- If the digest does not contain what you need, say exactly what is missing rather than guessing.
- Never invent a class, teacher, room or constraint that is not in the digest.
- You cannot change anything yourself. Describe the action the user should take (for example "use Find Alternatives on Wednesday P3").`;

/**
 * @param {object} args
 *   collegeId  required
 *   question   the user's question
 *   view       optional {type, id, timetableId} -- what they are looking at
 *   history    optional [{role, content}] of the current conversation
 */
async function ask({ collegeId, question, view = null, history = [], timetableId = null }) {
  const ready = requireReady();
  const q = String(question || '').trim();
  if (!q) {
    const err = new Error('Type a question for the Assistant.');
    err.status = 400;
    throw err;
  }

  const privacyMode = settings.getBool('ai_privacy_mode');
  const includeNames = settings.getBool('ai_include_faculty_names');

  const raw = buildAiContext(collegeId, { timetableId, view: focusView(collegeId, view) });
  const { context, map } = anonymise(raw, { includeNames });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: `Privacy: student names and identifiers are never included in this digest.`
        + (includeNames ? '' : ' Faculty, course and room names have been replaced with labels.'),
    },
    { role: 'system', content: `TIMETABLE DIGEST:\n${JSON.stringify(context)}` },
    ...history
      .slice(-MAX_HISTORY)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    { role: 'user', content: q },
  ];

  const model = settings.getSetting('ai_model');
  const payload = await callOpenAi('/v1/chat/completions', {
    key: ready.key,
    method: 'POST',
    body: {
      model,
      messages,
      temperature: 0.2,
      max_tokens: 900,
    },
  });

  const choice = payload && payload.choices && payload.choices[0];
  const answer = choice && choice.message ? String(choice.message.content || '') : '';

  return {
    answer: deanonymise(answer, map),
    model: payload && payload.model ? payload.model : model,
    usage: payload && payload.usage ? payload.usage : null,
    privacy: {
      privacyMode,
      studentDataSent: false,
      namesSent: includeNames,
      classesSent: context.classes ? context.classes.length : 0,
      truncated: !!context.classesTruncated,
    },
    finishReason: choice ? choice.finish_reason : null,
  };
}

/** The canned questions offered in the Assistant panel (Section 14.2). */
function suggestedQuestions() {
  return [
    'Why could some classes not be scheduled?',
    'Which teachers are closest to their maximum weekly hours?',
    'Is any room badly under-used?',
    'Explain the hard conflicts in this timetable.',
    'Where could I move Wednesday\'s last class to reduce gaps?',
    'Are the sub-section labs running in parallel where they could be?',
    'Which sections have the most idle periods?',
  ];
}

/** Exactly what would be transmitted, for the "Show what will be sent" link. */
function previewContext(collegeId, opts = {}) {
  const raw = buildAiContext(collegeId, {
    timetableId: opts.timetableId,
    view: focusView(collegeId, opts.view),
  });
  const includeNames = settings.getBool('ai_include_faculty_names');
  const { context } = anonymise(raw, { includeNames });
  return {
    privacyMode: settings.getBool('ai_privacy_mode'),
    includeNames,
    destination: `${OPENAI_HOST}/v1/chat/completions`,
    approximateCharacters: JSON.stringify(context).length,
    context,
  };
}

module.exports = {
  status,
  testConnection,
  buildAiContext,
  previewContext,
  anonymise,
  deanonymise,
  ask,
  suggestedQuestions,
  OPENAI_HOST,
};
