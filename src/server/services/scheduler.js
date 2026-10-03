'use strict';

/**
 * The scheduling engine (Sections 5, 6, 13).
 *
 * Strategy: strongest-constraint-first greedy placement, then a bounded repair
 * pass that displaces already-placed classes to make room for anything that
 * failed, then a small number of restarts under different orderings, keeping the
 * best result. Locked assignments and assignments belonging to other timetables
 * are loaded into the calendar up front and are never moved.
 *
 * This shape was chosen over a full CSP search deliberately: it is deterministic
 * (no randomness, so the same input always yields the same timetable), it always
 * returns *something* with per-class reasons for whatever it could not place, and
 * it stays interactive on the data volumes a single college produces.
 *
 * Parallel sub-sections (Section 3) are placed as a single unit so that B1 and B2
 * land in the same slot with different teachers and different rooms; if the unit
 * cannot be placed as a whole it is broken up and its members are placed
 * independently rather than being dropped.
 */

const { checkPlacement, checkParallelGroup } = require('./constraints');
const { scoreCandidate, timetableQuality } = require('./scoring');
const { buildOccurrences } = require('./occurrences');

const DEFAULT_TIME_BUDGET_MS = 9000;
const TOP_FACULTY_PER_SLOT = 3;
const TOP_ROOMS_PER_SLOT = 3;
const MAX_OPTIONS_PER_UNIT = 60;

// ---------------------------------------------------------------------------
// Candidate helpers
// ---------------------------------------------------------------------------
function materialiseSlot(ctx, slotCandidate, periodCount) {
  const slots = ctx.grid.slots;
  const startIdx = slotCandidate.startIdx;
  if (startIdx == null || startIdx < 0 || startIdx + periodCount > slots.length) return null;
  const periods = [];
  for (let i = startIdx; i < startIdx + periodCount; i += 1) periods.push(slots[i].index);
  return {
    day: Number(slotCandidate.day),
    startIdx,
    periods,
    startMin: slots[startIdx].startMin,
    endMin: slots[startIdx + periodCount - 1].endMin,
    startTime: slots[startIdx].start,
    endTime: slots[startIdx + periodCount - 1].end,
  };
}

function placementFor(occ, option, ctx) {
  const room = option.roomId ? ctx.roomById.get(option.roomId) : null;
  return {
    id: `p_${occ.id}`,
    occId: occ.id,
    day: option.day,
    periods: option.periods,
    facultyId: option.facultyId || null,
    roomId: option.roomId || null,
    buildingId: room ? room.building_id || null : null,
    sectionId: occ.sectionId,
    subSectionId: occ.subSectionId,
    courseId: occ.courseId,
    component: occ.component,
    isLocked: false,
    external: false,
  };
}

/**
 * Faculty feasible for one occurrence in one slot, cheapest-loaded first.
 * Returns `{ids, reasons}` so callers can explain an empty result.
 */
function feasibleFaculty(occ, base, cal, ctx, ignore) {
  const ids = [];
  const reasons = [];
  for (const fid of occ.facultyCandidates) {
    const res = checkPlacement({ ...base, facultyId: fid, roomId: null }, occ, cal, ctx, ignore);
    if (res.ok) ids.push(fid);
    else reasons.push(...res.violations);
  }
  ids.sort((a, b) => {
    const pa = occ.preferredFacultyIds && occ.preferredFacultyIds.includes(a) ? 0 : 1;
    const pb = occ.preferredFacultyIds && occ.preferredFacultyIds.includes(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return cal.facultyPeriodsInWeek(a) - cal.facultyPeriodsInWeek(b);
  });
  return { ids, reasons };
}

/** Rooms feasible in one slot, tightest acceptable fit first. */
function feasibleRooms(occ, base, cal, ctx, ignore) {
  const ids = [];
  const reasons = [];
  for (const rid of occ.roomCandidates) {
    const res = checkPlacement({ ...base, facultyId: null, roomId: rid }, occ, cal, ctx, ignore);
    if (res.ok) ids.push(rid);
    else reasons.push(...res.violations);
  }
  ids.sort((a, b) => {
    const pa = occ.preferredRoomIds && occ.preferredRoomIds.includes(a) ? 0 : 1;
    const pb = occ.preferredRoomIds && occ.preferredRoomIds.includes(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ra = ctx.roomById.get(a);
    const rb = ctx.roomById.get(b);
    const wasteA = (Number(ra.seating_capacity) || 0) - occ.strength;
    const wasteB = (Number(rb.seating_capacity) || 0) - occ.strength;
    return Math.abs(wasteA) - Math.abs(wasteB);
  });
  return { ids, reasons };
}

/**
 * All reasonable placements for a single occurrence, best first.
 */
function enumerateSingleOptions(occ, cal, ctx, opts = {}) {
  const limit = opts.limit || MAX_OPTIONS_PER_UNIT;
  const ignore = opts.ignore || null;
  const options = [];
  const reasons = [];

  for (const sc of occ.slotCandidates) {
    const base = materialiseSlot(ctx, sc, occ.periods);
    if (!base) {
      reasons.push({
        code: 'BLOCK_DOES_NOT_FIT',
        message: `${occ.label}: a ${occ.periods}-period block does not fit at the requested position.`,
      });
      continue;
    }

    // Student-group / day / break level checks first -- these reject a whole slot
    // cheaply before we look at teachers and rooms.
    const groupCheck = checkPlacement({ ...base, facultyId: null, roomId: null }, occ, cal, ctx, ignore);
    if (!groupCheck.ok) {
      reasons.push(...groupCheck.violations);
      continue;
    }

    const fac = feasibleFaculty(occ, base, cal, ctx, ignore);
    if (!fac.ids.length) {
      reasons.push(...fac.reasons);
      continue;
    }
    const rooms = feasibleRooms(occ, base, cal, ctx, ignore);
    if (!rooms.ids.length) {
      reasons.push(...rooms.reasons);
      continue;
    }

    const facTop = fac.ids.slice(0, opts.wide ? fac.ids.length : TOP_FACULTY_PER_SLOT);
    const roomTop = rooms.ids.slice(0, opts.wide ? rooms.ids.length : TOP_ROOMS_PER_SLOT);

    for (const fid of facTop) {
      for (const rid of roomTop) {
        const cand = { ...base, facultyId: fid, roomId: rid, parallelWithSiblings: false };
        const full = checkPlacement(cand, occ, cal, ctx, ignore);
        if (!full.ok) {
          reasons.push(...full.violations);
          continue;
        }
        const scored = scoreCandidate(cand, occ, cal, ctx, full.warnings);
        options.push({
          occId: occ.id,
          ...base,
          facultyId: fid,
          roomId: rid,
          score: scored.score,
          breakdown: scored.breakdown,
          warnings: full.warnings,
        });
      }
    }
  }

  options.sort((a, b) => b.score - a.score);
  return { options: options.slice(0, limit), reasons: dedupeReasons(reasons) };
}

/**
 * Placements for a whole parallel sub-section group: one shared slot, distinct
 * teacher and distinct room per member (Section 3 / rule 14).
 */
function enumerateGroupOptions(unit, cal, ctx, opts = {}) {
  const limit = opts.limit || 24;
  const ignore = opts.ignore || null;
  const members = unit.occurrences;
  const periodCount = members[0].periods;
  const options = [];
  const reasons = [];

  // Slots every member allows.
  const keyOf = (sc) => `${sc.day}:${sc.startIdx}`;
  const shared = members
    .map((m) => new Set(m.slotCandidates.map(keyOf)))
    .reduce((acc, set) => new Set([...acc].filter((k) => set.has(k))),
      new Set(members[0].slotCandidates.map(keyOf)));

  for (const key of shared) {
    const [dayStr, idxStr] = key.split(':');
    const base = materialiseSlot(ctx, { day: Number(dayStr), startIdx: Number(idxStr) }, periodCount);
    if (!base) continue;

    // Per-member feasible teachers and rooms at this slot.
    const perMember = [];
    let blocked = false;
    for (const occ of members) {
      const groupCheck = checkPlacement({ ...base, facultyId: null, roomId: null }, occ, cal, ctx, ignore);
      if (!groupCheck.ok) {
        reasons.push(...groupCheck.violations);
        blocked = true;
        break;
      }
      const fac = feasibleFaculty(occ, base, cal, ctx, ignore);
      const rooms = feasibleRooms(occ, base, cal, ctx, ignore);
      if (!fac.ids.length || !rooms.ids.length) {
        reasons.push(...fac.reasons, ...rooms.reasons);
        blocked = true;
        break;
      }
      perMember.push({
        occ,
        faculty: fac.ids.slice(0, Math.max(members.length + 2, TOP_FACULTY_PER_SLOT)),
        rooms: rooms.ids.slice(0, Math.max(members.length + 2, TOP_ROOMS_PER_SLOT)),
      });
    }
    if (blocked) continue;

    // Depth-first assignment with distinctness enforced across the group.
    const best = [];
    const usedFaculty = new Set();
    const usedRooms = new Set();
    const chosen = [];

    const walk = (i) => {
      if (best.length >= 4) return;
      if (i === perMember.length) {
        const verdict = checkParallelGroup(chosen.map((c) => ({
          label: c.occ.label, facultyId: c.facultyId, roomId: c.roomId,
        })));
        if (!verdict.ok) {
          reasons.push(...verdict.violations);
          return;
        }
        best.push({
          members: chosen.map((c) => ({
            occId: c.occ.id,
            facultyId: c.facultyId,
            roomId: c.roomId,
            score: c.score,
            breakdown: c.breakdown,
            warnings: c.warnings,
          })),
          totalScore: chosen.reduce((s, c) => s + c.score, 0) / chosen.length,
        });
        return;
      }
      const { occ, faculty, rooms } = perMember[i];
      for (const fid of faculty) {
        if (usedFaculty.has(fid)) continue;
        for (const rid of rooms) {
          if (usedRooms.has(rid)) continue;
          const cand = { ...base, facultyId: fid, roomId: rid, parallelWithSiblings: true };
          const full = checkPlacement(cand, occ, cal, ctx, ignore);
          if (!full.ok) {
            reasons.push(...full.violations);
            continue;
          }
          const scored = scoreCandidate(cand, occ, cal, ctx, full.warnings);
          usedFaculty.add(fid);
          usedRooms.add(rid);
          chosen.push({ occ, facultyId: fid, roomId: rid, score: scored.score, breakdown: scored.breakdown, warnings: full.warnings });
          walk(i + 1);
          chosen.pop();
          usedFaculty.delete(fid);
          usedRooms.delete(rid);
          if (best.length >= 4) return;
        }
      }
    };
    walk(0);

    for (const b of best) {
      options.push({ kind: 'GROUP', ...base, members: b.members, score: Math.round(b.totalScore) });
    }
  }

  options.sort((a, b) => b.score - a.score);
  return { options: options.slice(0, limit), reasons: dedupeReasons(reasons) };
}

function dedupeReasons(reasons) {
  const seen = new Set();
  const out = [];
  for (const r of reasons) {
    if (!r || !r.message) continue;
    if (seen.has(r.message)) continue;
    seen.add(r.message);
    out.push(r);
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
function buildUnits(occurrences, groups, ctx) {
  const units = [];
  const byId = new Map(occurrences.map((o) => [o.id, o]));
  const claimed = new Set();

  if (ctx.rules.preferParallelSubsections) {
    for (const group of groups.values()) {
      const members = group.memberIds.map((id) => byId.get(id)).filter(Boolean);
      if (members.length < 2) continue;
      // Only group members that agree on block length -- otherwise they cannot
      // share one slot anyway.
      if (!members.every((m) => m.periods === members[0].periods)) continue;
      members.forEach((m) => claimed.add(m.id));
      units.push({
        id: `u_${group.key}`,
        kind: 'GROUP',
        groupKey: group.key,
        occurrences: members,
        label: `${ctx.courseName(group.courseId)} ${members[0].componentLabel} `
          + `(${ctx.sectionName(group.sectionId)} / ${members.map((m) => m.subSection.name).join(' + ')})`,
      });
    }
  }

  for (const occ of occurrences) {
    if (claimed.has(occ.id)) continue;
    units.push({ id: `u_${occ.id}`, kind: 'SINGLE', occurrences: [occ], label: occ.label });
  }
  return units;
}

/** How constrained a unit is -- used to order placement (most constrained first). */
function tightness(unit) {
  return unit.occurrences.reduce((acc, o) => {
    const slots = Math.max(1, o.slotCandidates.length);
    const fac = Math.max(1, o.facultyCandidates.length);
    const rooms = Math.max(1, o.roomCandidates.length);
    return acc + slots * fac * rooms;
  }, 0) / unit.occurrences.length;
}

function enumerateUnit(unit, cal, ctx, opts) {
  return unit.kind === 'GROUP'
    ? enumerateGroupOptions(unit, cal, ctx, opts)
    : enumerateSingleOptions(unit.occurrences[0], cal, ctx, opts);
}

function applyOption(unit, option, cal, ctx, store) {
  if (unit.kind === 'GROUP') {
    for (const m of option.members) {
      const occ = unit.occurrences.find((o) => o.id === m.occId);
      const p = placementFor(occ, { ...option, facultyId: m.facultyId, roomId: m.roomId }, ctx);
      cal.add(p);
      store.set(p.id, {
        placement: p, occ, unit, option, member: m, score: m.score, warnings: m.warnings, breakdown: m.breakdown,
      });
    }
  } else {
    const occ = unit.occurrences[0];
    const p = placementFor(occ, option, ctx);
    cal.add(p);
    store.set(p.id, {
      placement: p, occ, unit, option, score: option.score, warnings: option.warnings, breakdown: option.breakdown,
    });
  }
}

function revertUnit(unit, cal, store) {
  for (const occ of unit.occurrences) {
    const id = `p_${occ.id}`;
    if (store.has(id)) {
      cal.remove(id);
      store.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Repair: displace movable classes to make room for a failed unit
// ---------------------------------------------------------------------------
function collectBlockers(occ, base, facultyId, roomId, cal, ctx) {
  const blockers = new Map();
  const note = (p) => {
    if (p && !p.external && !p.isLocked) blockers.set(p.id, p);
    else if (p) blockers.set(`IMMOVABLE_${p.id}`, p);
  };
  for (const period of base.periods) {
    if (facultyId) note(cal.facultyAt(base.day, period, facultyId));
    if (roomId) note(cal.roomAt(base.day, period, roomId));
    if (occ.subSectionId) {
      note(cal.subSectionAt(base.day, period, occ.subSectionId));
      note(cal.sectionWholeAt(base.day, period, occ.sectionId));
    } else if (occ.sectionId) {
      note(cal.sectionWholeAt(base.day, period, occ.sectionId));
      const subs = ctx.subSectionIdsBySection.get(occ.sectionId) || [];
      cal.siblingsAt(base.day, period, occ.sectionId, subs).forEach(note);
    }
  }
  const immovable = [...blockers.keys()].some((k) => String(k).startsWith('IMMOVABLE_'));
  return { movable: [...blockers.values()].filter((p) => !p.external && !p.isLocked), immovable };
}

function attemptRepair(unit, cal, ctx, store, deadline) {
  if (unit.kind === 'GROUP') return false;   // groups fall back to singles instead
  const occ = unit.occurrences[0];
  let tries = 0;

  for (const sc of occ.slotCandidates) {
    if (Date.now() > deadline || tries > 400) return false;
    const base = materialiseSlot(ctx, sc, occ.periods);
    if (!base) continue;

    for (const fid of occ.facultyCandidates) {
      for (const rid of occ.roomCandidates) {
        tries += 1;
        if (tries > 400 || Date.now() > deadline) return false;

        const { movable, immovable } = collectBlockers(occ, base, fid, rid, cal, ctx);
        if (immovable || movable.length === 0 || movable.length > 2) continue;

        // Temporarily lift the blockers.
        const lifted = movable.map((p) => store.get(p.id)).filter(Boolean);
        if (lifted.length !== movable.length) continue;
        lifted.forEach((entry) => { cal.remove(entry.placement.id); store.delete(entry.placement.id); });

        const cand = { ...base, facultyId: fid, roomId: rid };
        const check = checkPlacement(cand, occ, cal, ctx);
        if (check.ok) {
          const scored = scoreCandidate(cand, occ, cal, ctx, check.warnings);
          const option = {
            occId: occ.id, ...base, facultyId: fid, roomId: rid,
            score: scored.score, breakdown: scored.breakdown, warnings: check.warnings,
          };
          applyOption(unit, option, cal, ctx, store);

          // Re-home every displaced class; give up if any cannot be re-placed.
          const rehomed = [];
          let ok = true;
          for (const entry of lifted) {
            const res = enumerateUnit(entry.unit, cal, ctx, { limit: 1 });
            if (!res.options.length) { ok = false; break; }
            applyOption(entry.unit, res.options[0], cal, ctx, store);
            rehomed.push(entry.unit);
          }
          if (ok) return true;

          rehomed.forEach((u) => revertUnit(u, cal, store));
          revertUnit(unit, cal, store);
        }

        // Restore the original state and keep looking.
        lifted.forEach((entry) => {
          cal.add(entry.placement);
          store.set(entry.placement.id, entry);
        });
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------
function runPass(units, ctx, order, deadline) {
  const cal = ctx.calendar.clone();
  const store = new Map();
  const unscheduled = [];
  const queue = order.slice();

  for (const unit of queue) {
    if (Date.now() > deadline) {
      unscheduled.push({ unit, reasons: [{ code: 'TIME_BUDGET', message: 'Generation time budget was reached before this class could be placed.' }] });
      continue;
    }
    const res = enumerateUnit(unit, cal, ctx, {});
    if (res.options.length) {
      applyOption(unit, res.options[0], cal, ctx, store);
      continue;
    }

    // A parallel group that cannot run together is split rather than dropped.
    if (unit.kind === 'GROUP') {
      const singles = unit.occurrences.map((o) => ({
        id: `u_${o.id}`, kind: 'SINGLE', occurrences: [o], label: o.label, fromGroup: unit.groupKey,
      }));
      let anyPlaced = false;
      for (const s of singles) {
        const r = enumerateUnit(s, cal, ctx, { wide: true });
        if (r.options.length) {
          applyOption(s, r.options[0], cal, ctx, store);
          anyPlaced = true;
        } else if (!attemptRepair(s, cal, ctx, store, deadline)) {
          unscheduled.push({ unit: s, reasons: r.reasons.length ? r.reasons : res.reasons });
        } else {
          anyPlaced = true;
        }
      }
      if (anyPlaced) {
        // Record it as a soft warning rather than a failure.
        unit.splitFallback = true;
      }
      continue;
    }

    const wide = enumerateUnit(unit, cal, ctx, { wide: true });
    if (wide.options.length) {
      applyOption(unit, wide.options[0], cal, ctx, store);
      continue;
    }
    if (!attemptRepair(unit, cal, ctx, store, deadline)) {
      unscheduled.push({ unit, reasons: wide.reasons.length ? wide.reasons : res.reasons });
    }
  }

  return { cal, store, unscheduled };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
function generate(ctx, request, opts = {}) {
  const budget = Number(opts.timeBudgetMs) || DEFAULT_TIME_BUDGET_MS;
  const deadline = Date.now() + budget;

  const { occurrences, issues, warnings, groups } = buildOccurrences(ctx, request);

  if (!occurrences.length) {
    return {
      ok: false,
      assignments: [],
      unscheduled: [],
      issues: issues.length ? issues : [{ code: 'NOTHING_TO_SCHEDULE', message: 'No classes were derived from the selected courses.' }],
      warnings,
      stats: emptyStats(),
      qualityScore: 0,
    };
  }

  const units = buildUnits(occurrences, groups, ctx);

  // Deterministic orderings, most-constrained-first plus two variations. No
  // randomness so a given input always produces the same timetable.
  const byTightness = units.slice().sort((a, b) => tightness(a) - tightness(b));
  const byPeriodsThenTightness = units.slice().sort((a, b) => {
    const pa = b.occurrences[0].periods - a.occurrences[0].periods;
    if (pa !== 0) return pa;
    return tightness(a) - tightness(b);
  });
  const byGroupsFirst = units.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'GROUP' ? -1 : 1;
    return tightness(a) - tightness(b);
  });

  const orderings = [byPeriodsThenTightness, byTightness, byGroupsFirst];
  let best = null;

  for (const order of orderings) {
    const pass = runPass(units, ctx, order, deadline);
    const placed = pass.store.size;
    const quality = timetableQuality({
      assignments: [...pass.store.values()].map((e) => ({ score: e.score })),
      unscheduledCount: pass.unscheduled.reduce((n, u) => n + u.unit.occurrences.length, 0),
      warningCount: [...pass.store.values()].reduce((n, e) => n + (e.warnings ? e.warnings.length : 0), 0),
    });
    if (!best || placed > best.placed || (placed === best.placed && quality > best.quality)) {
      best = { ...pass, placed, quality };
    }
    if (best.unscheduled.length === 0 && best.quality >= 95) break;
    if (Date.now() > deadline) break;
  }

  const entries = [...best.store.values()];
  const assignments = entries.map((e) => ({
    occId: e.occ.id,
    courseId: e.occ.courseId,
    sectionId: e.occ.sectionId,
    subSectionId: e.occ.subSectionId,
    facultyId: e.placement.facultyId,
    roomId: e.placement.roomId,
    day: e.placement.day,
    slotIndex: e.placement.periods[0],
    periods: e.placement.periods.length,
    startTime: e.option.startTime,
    endTime: e.option.endTime,
    component: e.occ.component,
    groupKey: e.occ.groupKey,
    strength: e.occ.strength,
    score: e.score,
    breakdown: e.breakdown,
    warnings: e.warnings || [],
    label: e.occ.label,
  }));

  const splitFallbacks = units.filter((u) => u.splitFallback).map((u) => u.label);
  splitFallbacks.forEach((label) => warnings.push(
    `${label}: the sub-sections could not share one slot, so they were scheduled separately.`
  ));

  const unscheduled = best.unscheduled.map((u) => ({
    label: u.unit.label,
    occurrences: u.unit.occurrences.map((o) => ({
      courseId: o.courseId,
      sectionId: o.sectionId,
      subSectionId: o.subSectionId,
      component: o.component,
      periods: o.periods,
      label: o.label,
    })),
    reasons: u.reasons,
  }));

  const warningCount = assignments.reduce((n, a) => n + a.warnings.length, 0);
  const unscheduledCount = unscheduled.reduce((n, u) => n + u.occurrences.length, 0);

  return {
    ok: unscheduledCount === 0,
    assignments,
    unscheduled,
    issues,
    warnings,
    stats: {
      coursesConsidered: new Set(occurrences.map((o) => o.courseId)).size,
      classesRequired: occurrences.length,
      classesScheduled: assignments.length,
      classesUnscheduled: unscheduledCount,
      hardConflicts: unscheduled.length,
      softWarnings: warningCount + warnings.length,
      parallelGroups: [...groups.keys()].length,
    },
    qualityScore: timetableQuality({ assignments, unscheduledCount, warningCount }),
  };
}

function emptyStats() {
  return {
    coursesConsidered: 0,
    classesRequired: 0,
    classesScheduled: 0,
    classesUnscheduled: 0,
    hardConflicts: 0,
    softWarnings: 0,
    parallelGroups: 0,
  };
}

module.exports = {
  generate,
  buildUnits,
  enumerateSingleOptions,
  enumerateGroupOptions,
  materialiseSlot,
  placementFor,
  dedupeReasons,
};
