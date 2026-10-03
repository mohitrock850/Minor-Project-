'use strict';

/**
 * Time + slot helpers.
 *
 * Every concrete timing value in the application comes from the College Timing
 * Configuration (Section 1.15) for the college in scope. This module owns the
 * only translation from that configuration into the discrete period grid used by
 * the wizard, the manual builder and the constraint engine (Section 4).
 *
 * There are deliberately NO fallback constants for working hours, slot length or
 * lunch: if a college has no timing row, callers get an error and the
 * pre-generation gate (Section 9) reports it.
 */

const MIN_PER_DAY = 24 * 60;

function toMinutes(hhmm) {
  if (hhmm == null) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function toHHMM(minutes) {
  const m = ((Math.round(minutes) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function parseDays(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => a - b);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Builds the period grid for one timing configuration.
 *
 * @param {object} timing  row from college_timings
 * @param {Array}  breaks  rows from college_breaks belonging to that timing
 * @returns {{workingDays:number[], slots:Array, breaks:Array, warnings:string[], slotMinutes:number}}
 */
function buildGrid(timing, breaks = []) {
  if (!timing) {
    const err = new Error('This college has no Timing Configuration set up.');
    err.status = 400;
    err.code = 'NO_TIMING_CONFIG';
    throw err;
  }

  const dayStart = toMinutes(timing.start_time);
  const dayEnd = toMinutes(timing.end_time);
  const slotMinutes = Number(timing.slot_minutes);
  const periods = Number(timing.periods_per_day);
  const warnings = [];

  if (dayStart == null || dayEnd == null) {
    const err = new Error('Timing Configuration has an invalid start or end time.');
    err.status = 400;
    throw err;
  }
  if (!(slotMinutes > 0)) {
    const err = new Error('Timing Configuration must have a positive period duration.');
    err.status = 400;
    throw err;
  }
  if (!(periods > 0)) {
    const err = new Error('Timing Configuration must define at least one period per day.');
    err.status = 400;
    throw err;
  }
  if (dayEnd <= dayStart) {
    const err = new Error('College end time must be after the start time.');
    err.status = 400;
    throw err;
  }

  const windows = breaks
    .map((b) => ({
      id: b.id,
      kind: b.kind || 'LUNCH',
      name: b.name || (b.kind === 'SHORT' ? 'Short Break' : 'Lunch Break'),
      start: toMinutes(b.start_time),
      end: toMinutes(b.end_time),
    }))
    .filter((b) => b.start != null && b.end != null && b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const slots = [];
  let cursor = dayStart;
  let guard = 0;

  while (slots.length < periods && guard < 500) {
    guard += 1;

    // Push the cursor past any break window it lands inside or would straddle.
    const clash = windows.find((w) => overlaps(cursor, cursor + slotMinutes, w.start, w.end));
    if (clash) {
      cursor = clash.end;
      continue;
    }

    const end = cursor + slotMinutes;
    if (end > dayEnd) {
      warnings.push(
        `Only ${slots.length} of the ${periods} configured periods fit between ` +
        `${timing.start_time} and ${timing.end_time} once breaks are excluded.`
      );
      break;
    }

    slots.push({
      index: slots.length + 1,
      start: toHHMM(cursor),
      end: toHHMM(end),
      startMin: cursor,
      endMin: end,
    });
    cursor = end;
  }

  if (!slots.length) {
    const err = new Error(
      'The Timing Configuration produces no usable periods -- check the start/end time, ' +
      'period duration and break windows.'
    );
    err.status = 400;
    throw err;
  }

  const days = parseDays(timing.working_days);
  if (!days.length) {
    const err = new Error('Timing Configuration has no working days selected.');
    err.status = 400;
    throw err;
  }

  return { workingDays: days, slots, breaks: windows, warnings, slotMinutes, timingId: timing.id };
}

/**
 * True when periods [startIdx .. startIdx+count-1] are genuinely back-to-back,
 * i.e. no break window sits between them. Multi-period labs must not straddle
 * lunch, so this is what the engine uses to place a block.
 */
function isContiguousBlock(slots, startIdx, count) {
  if (startIdx < 0 || startIdx + count > slots.length) return false;
  for (let i = startIdx; i < startIdx + count - 1; i += 1) {
    if (slots[i].endMin !== slots[i + 1].startMin) return false;
  }
  return true;
}

/** Every valid starting position for a block of `count` contiguous periods. */
function blockStarts(slots, count) {
  const out = [];
  for (let i = 0; i + count <= slots.length; i += 1) {
    if (isContiguousBlock(slots, i, count)) out.push(i);
  }
  return out;
}

/** The period indices (1-based slot.index) a block covers. */
function blockPeriodIndices(slots, startIdx, count) {
  const out = [];
  for (let i = startIdx; i < startIdx + count; i += 1) out.push(slots[i].index);
  return out;
}

/** Renders the grid plus break rows in display order -- used by all timetable views. */
function displayRows(grid) {
  const rows = [];
  grid.slots.forEach((s, i) => {
    rows.push({ kind: 'PERIOD', index: s.index, start: s.start, end: s.end });
    const next = grid.slots[i + 1];
    if (next && next.startMin > s.endMin) {
      const gap = grid.breaks.find((b) => b.start >= s.endMin && b.end <= next.startMin)
        || { name: 'Break', kind: 'SHORT', start: s.endMin, end: next.startMin };
      rows.push({
        kind: 'BREAK',
        name: gap.name,
        breakKind: gap.kind,
        start: toHHMM(gap.start),
        end: toHHMM(gap.end),
      });
    }
  });
  return rows;
}

module.exports = {
  toMinutes,
  toHHMM,
  parseDays,
  overlaps,
  buildGrid,
  isContiguousBlock,
  blockStarts,
  blockPeriodIndices,
  displayRows,
};
