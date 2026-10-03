'use strict';

/**
 * College Timing Configuration (Section 1.15 / Section 4) and Scheduling Rules
 * (Section 13).
 *
 * The timing configuration is edited as one object -- the working days, the day
 * window, the period length and every break together -- because they only make
 * sense as a set: changing the lunch window changes how many periods fit. The
 * endpoint returns the derived period grid with every save so the editor can show
 * the real timetable rows the college will get, including the warning when fewer
 * periods fit than were asked for.
 */

const express = require('express');
const db = require('../db/connection');
const { httpError, requireCollege, requireCoordinator } = require('../auth/middleware');
const { buildGrid, displayRows, toMinutes, parseDays } = require('../services/timing');
const { RULE_CATALOGUE, DAY_NAMES } = require('../services/entityRegistry');
const { loadRules } = require('../services/context');

const router = express.Router();

// ---------------------------------------------------------------------------
// Timing configuration
// ---------------------------------------------------------------------------
function readTiming(collegeId) {
  const timing = db.get(
    `SELECT * FROM college_timings WHERE college_id = ? AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [collegeId]
  );
  if (!timing) {
    return {
      configured: false,
      timing: null,
      breaks: [],
      grid: null,
      rows: [],
      warnings: [],
      message: 'This college has no timing configuration yet. Nothing about the timetable is '
        + 'assumed until you define the working days, the day window, the period length and the breaks.',
    };
  }
  const breaks = db.all(
    'SELECT * FROM college_breaks WHERE timing_id = ? ORDER BY start_time', [timing.id]
  );
  let grid = null;
  let warnings = [];
  let error = null;
  try {
    grid = buildGrid(timing, breaks);
    warnings = grid.warnings;
  } catch (err) {
    error = err.message;
  }
  return {
    configured: true,
    timing,
    breaks,
    grid: grid && {
      workingDays: grid.workingDays,
      dayNames: grid.workingDays.map((d) => DAY_NAMES[d]),
      slots: grid.slots,
      slotMinutes: grid.slotMinutes,
      breaks: grid.breaks,
    },
    rows: grid ? displayRows(grid) : [],
    warnings,
    error,
  };
}

router.get('/timing', (req, res, next) => {
  try {
    res.json(readTiming(requireCollege(req)));
  } catch (err) {
    next(err);
  }
});

function validateTimingBody(body) {
  const errors = [];
  const days = parseDays(body.workingDays != null
    ? (Array.isArray(body.workingDays) ? body.workingDays.join(',') : body.workingDays)
    : body.working_days);
  if (!days.length) errors.push('Select at least one working day.');

  const start = toMinutes(body.startTime || body.start_time);
  const end = toMinutes(body.endTime || body.end_time);
  if (start == null) errors.push('College Start Time must be a time in HH:MM form.');
  if (end == null) errors.push('College End Time must be a time in HH:MM form.');
  if (start != null && end != null && end <= start) errors.push('College End Time must be after the start time.');

  const slotMinutes = Number(body.slotMinutes ?? body.slot_minutes);
  if (!Number.isFinite(slotMinutes) || slotMinutes <= 0) errors.push('Period Duration must be a positive number of minutes.');

  const periods = Number(body.periodsPerDay ?? body.periods_per_day);
  if (!Number.isInteger(periods) || periods <= 0) errors.push('Periods Per Day must be a whole number of at least 1.');

  const breaks = Array.isArray(body.breaks) ? body.breaks : [];
  breaks.forEach((b, i) => {
    const bs = toMinutes(b.startTime || b.start_time);
    const be = toMinutes(b.endTime || b.end_time);
    const label = b.name || `Break ${i + 1}`;
    if (bs == null || be == null) errors.push(`${label}: start and end must be times in HH:MM form.`);
    else if (be <= bs) errors.push(`${label}: the end time must be after the start time.`);
    else if (start != null && end != null && (bs < start || be > end)) {
      errors.push(`${label} (${b.startTime || b.start_time}-${b.endTime || b.end_time}) falls outside the college day.`);
    }
  });

  // Overlapping breaks would silently swallow periods, so they are refused.
  const sorted = breaks
    .map((b, i) => ({ i, s: toMinutes(b.startTime || b.start_time), e: toMinutes(b.endTime || b.end_time), b }))
    .filter((x) => x.s != null && x.e != null)
    .sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].s < sorted[i - 1].e) {
      errors.push(`"${sorted[i - 1].b.name || 'a break'}" and "${sorted[i].b.name || 'a break'}" overlap.`);
    }
  }

  if (errors.length) {
    const err = httpError(400, errors[0], 'VALIDATION');
    err.details = errors;
    throw err;
  }
  return { days, start, end, slotMinutes, periods, breaks };
}

/** Try a configuration without saving it -- powers the live preview. */
router.post('/timing/preview', requireCoordinator, (req, res, next) => {
  try {
    const body = req.body || {};
    const parsed = validateTimingBody(body);
    const timing = {
      id: 0,
      name: body.name || 'Preview',
      working_days: parsed.days.join(','),
      start_time: body.startTime || body.start_time,
      end_time: body.endTime || body.end_time,
      slot_minutes: parsed.slotMinutes,
      periods_per_day: parsed.periods,
    };
    const breaks = parsed.breaks.map((b, i) => ({
      id: i + 1,
      kind: (b.kind || 'LUNCH').toUpperCase(),
      name: b.name || null,
      start_time: b.startTime || b.start_time,
      end_time: b.endTime || b.end_time,
    }));
    const grid = buildGrid(timing, breaks);
    res.json({
      grid: {
        workingDays: grid.workingDays,
        dayNames: grid.workingDays.map((d) => DAY_NAMES[d]),
        slots: grid.slots,
        slotMinutes: grid.slotMinutes,
        breaks: grid.breaks,
      },
      rows: displayRows(grid),
      warnings: grid.warnings,
      weeklyCapacity: grid.workingDays.length * grid.slots.length,
    });
  } catch (err) {
    next(err);
  }
});

/** Save the whole configuration, breaks included, in one transaction. */
router.put('/timing', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const body = req.body || {};
    const parsed = validateTimingBody(body);

    const result = db.transaction(() => {
      const existing = db.get(
        `SELECT * FROM college_timings WHERE college_id = ? AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
        [collegeId]
      );
      const values = [
        body.name || (existing ? existing.name : 'Default Timing'),
        parsed.days.join(','),
        body.startTime || body.start_time,
        body.endTime || body.end_time,
        parsed.slotMinutes,
        parsed.periods,
      ];

      let timingId;
      if (existing) {
        db.run(
          `UPDATE college_timings SET name = ?, working_days = ?, start_time = ?, end_time = ?,
                  slot_minutes = ?, periods_per_day = ? WHERE id = ?`,
          [...values, existing.id]
        );
        timingId = existing.id;
      } else {
        const info = db.run(
          `INSERT INTO college_timings
             (college_id, name, working_days, start_time, end_time, slot_minutes, periods_per_day)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [collegeId, ...values]
        );
        timingId = info.lastInsertRowid;
      }

      // Breaks are replaced wholesale: the editor always submits the full list.
      db.run('DELETE FROM college_breaks WHERE timing_id = ?', [timingId]);
      for (const b of parsed.breaks) {
        db.run(
          `INSERT INTO college_breaks (college_id, timing_id, kind, name, start_time, end_time)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            collegeId, timingId,
            (b.kind || 'LUNCH').toUpperCase(),
            b.name || null,
            b.startTime || b.start_time,
            b.endTime || b.end_time,
          ]
        );
      }
      return timingId;
    });

    const saved = readTiming(collegeId);
    // Existing assignments keep their stored start/end times, but if the grid
    // shrank some may now sit outside it -- say so instead of failing silently.
    const stale = saved.grid
      ? db.get(
        `SELECT COUNT(*) AS n FROM assignments
          WHERE college_id = ? AND (slot_index > ? OR day_of_week NOT IN (${saved.grid.workingDays.map(() => '?').join(',') || '0'}))`,
        [collegeId, saved.grid.slots.length, ...saved.grid.workingDays]
      ).n
      : 0;

    res.json({
      ...saved,
      timingId: result,
      staleAssignments: stale,
      staleWarning: stale
        ? `${stale} scheduled class(es) now fall outside the new grid. Open the timetable and `
          + 'use Validate to see them.'
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Scheduling rules
// ---------------------------------------------------------------------------
router.get('/rules', (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const stored = db.all(
      'SELECT rule_key, rule_value, enabled FROM scheduling_rules WHERE college_id = ?', [collegeId]
    );
    const byKey = new Map(stored.map((r) => [r.rule_key, r]));
    res.json({
      rules: RULE_CATALOGUE.map((rule) => {
        const row = byKey.get(rule.key);
        return {
          ...rule,
          value: row && row.rule_value != null && row.rule_value !== '' ? row.rule_value : rule.default,
          enabled: row ? !!row.enabled : true,
          isDefault: !row,
        };
      }),
      effective: loadRules(collegeId),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/rules', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    const patch = (req.body && req.body.rules) || req.body || {};
    const errors = [];
    const applied = {};

    db.transaction(() => {
      for (const [key, raw] of Object.entries(patch)) {
        const rule = RULE_CATALOGUE.find((r) => r.key === key);
        if (!rule) {
          errors.push(`"${key}" is not a scheduling rule.`);
          continue;
        }
        const incoming = raw != null && typeof raw === 'object' && 'value' in raw ? raw : { value: raw };
        let value = incoming.value;

        if (rule.type === 'boolean') {
          value = (value === true || value === 1 || value === '1' || value === 'true') ? '1' : '0';
        } else if (rule.type === 'number') {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) {
            errors.push(`${rule.label} must be zero or a positive number.`);
            continue;
          }
          value = String(n);
        } else if (key === 'disallowed_slots') {
          const parts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
          const bad = parts.filter((p) => !/^\d+:\d+$/.test(p));
          if (bad.length) {
            errors.push(`Disallowed Slots: "${bad.join(', ')}" should be day:period pairs such as 6:5.`);
            continue;
          }
          value = parts.join(',');
        } else {
          value = value == null ? '' : String(value);
        }

        const enabled = incoming.enabled === undefined ? 1 : (incoming.enabled ? 1 : 0);
        db.run(
          `INSERT INTO scheduling_rules (college_id, rule_key, rule_value, enabled)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(college_id, rule_key)
             DO UPDATE SET rule_value = excluded.rule_value, enabled = excluded.enabled`,
          [collegeId, key, value, enabled]
        );
        applied[key] = { value, enabled: !!enabled };
      }
    });

    if (errors.length) {
      const err = httpError(400, errors[0], 'VALIDATION');
      err.details = errors;
      throw err;
    }
    res.json({ applied, effective: loadRules(collegeId) });
  } catch (err) {
    next(err);
  }
});

/** Put every rule back to the shipped default. */
router.delete('/rules', requireCoordinator, (req, res, next) => {
  try {
    const collegeId = requireCollege(req);
    db.run('DELETE FROM scheduling_rules WHERE college_id = ?', [collegeId]);
    res.json({ reset: true, effective: loadRules(collegeId) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
