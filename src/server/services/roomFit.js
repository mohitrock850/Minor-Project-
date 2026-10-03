'use strict';

/**
 * Room fitting + capacity arithmetic (Section 2).
 *
 * Every number the UI shows on a room comparison card -- Student Strength /
 * Room Capacity / Capacity Difference / Overflow % / Tolerance / Final Status --
 * is produced here, so the engine and the UI can never disagree about whether a
 * room fits.
 */

const AC_REQUIREMENT = {
  REQUIRED: 'REQUIRED',
  PREFERRED: 'PREFERRED',
  NOT_REQUIRED: 'NOT_REQUIRED',
};

function parseFacilityList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
  const raw = String(value).trim();
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    } catch {
      /* fall through to CSV parsing */
    }
  }
  return raw.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
}

/** The facility keys a room actually provides. */
function roomFacilities(room) {
  const set = new Set(parseFacilityList(room.other_facilities));
  if (room.has_projector) set.add('PROJECTOR');
  if (room.has_smart_board) set.add('SMART_BOARD');
  if (room.has_computers) set.add('COMPUTERS');
  if (room.is_ac) set.add('AC');
  if (room.lab_equipment && String(room.lab_equipment).trim()) set.add('LAB_EQUIPMENT');
  return set;
}

/**
 * @returns {{ok:boolean, status:string, ...}} capacity verdict for one room.
 */
function evaluateCapacity(room, strength, opts = {}) {
  const tolerancePercent = Number.isFinite(opts.tolerancePercent) ? Number(opts.tolerancePercent) : 10;
  const allowOverflow = opts.allowOverflow !== false;

  const seating = Number(room.seating_capacity) || 0;
  const maxPermitted = Number(room.max_capacity) || 0;
  const students = Number(strength) || 0;

  const difference = seating - students;
  const overflow = Math.max(0, students - seating);
  const overflowPercent = seating > 0 ? (overflow / seating) * 100 : (overflow > 0 ? Infinity : 0);
  const utilizationPercent = seating > 0 ? Math.min(999, (students / seating) * 100) : 0;

  let status;
  let ok;
  if (seating <= 0) {
    status = 'NO_CAPACITY_DATA';
    ok = false;
  } else if (students <= seating) {
    status = 'FITS';
    ok = true;
  } else if (
    allowOverflow
    && overflowPercent <= tolerancePercent
    && (maxPermitted <= 0 || students <= maxPermitted)
  ) {
    status = 'OVERFLOW_WITHIN_TOLERANCE';
    ok = true;
  } else {
    status = 'EXCEEDS_CAPACITY';
    ok = false;
  }

  return {
    ok,
    status,
    students,
    capacity: seating,
    maxPermitted: maxPermitted || null,
    difference,
    overflow,
    overflowPercent: Number.isFinite(overflowPercent) ? Math.round(overflowPercent * 10) / 10 : null,
    tolerancePercent,
    utilizationPercent: Math.round(utilizationPercent),
  };
}

/** AC verdict: hard fail only when AC is REQUIRED and the room is Non-AC. */
function evaluateAc(room, requirement) {
  const req = requirement || AC_REQUIREMENT.NOT_REQUIRED;
  const isAc = !!room.is_ac;
  if (req === AC_REQUIREMENT.REQUIRED) {
    return {
      ok: isAc,
      requirement: req,
      isAc,
      warning: null,
      reason: isAc ? null
        : `${room.name} is NON-AC but this class requires an AC room.`,
    };
  }
  if (req === AC_REQUIREMENT.PREFERRED) {
    return {
      ok: true,
      requirement: req,
      isAc,
      warning: isAc ? null : `AC preferred but ${room.name} is NON-AC.`,
      reason: null,
    };
  }
  return { ok: true, requirement: req, isAc, warning: null, reason: null };
}

/** Required-facility verdict (Section 13.8). Missing facilities are a hard fail. */
function evaluateFacilities(room, requiredFacilities) {
  const required = parseFacilityList(requiredFacilities);
  if (!required.length) return { ok: true, missing: [], reason: null };
  const have = roomFacilities(room);
  const missing = required.filter((r) => !have.has(r));
  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length
      ? `${room.name} is missing required ${missing.map(humanFacility).join(', ')}.`
      : null,
  };
}

function evaluateRoomType(room, requiredType) {
  if (!requiredType) return { ok: true, exact: true, reason: null };
  const ok = String(room.room_type || '').toUpperCase() === String(requiredType).toUpperCase();
  return {
    ok,
    exact: ok,
    reason: ok ? null
      : `${room.name} is a ${humanEnum(room.room_type)} but a ${humanEnum(requiredType)} is required.`,
  };
}

/**
 * Full room verdict used by the engine, "Change Room" and "Find Alternatives".
 */
function evaluateRoom(room, need, opts = {}) {
  const capacity = evaluateCapacity(room, need.strength, opts);
  const ac = evaluateAc(room, need.acRequirement);
  const facilities = evaluateFacilities(room, need.requiredFacilities);
  const type = evaluateRoomType(room, need.requiredRoomType);

  const reasons = [capacity.ok ? null : capacityReason(room, capacity), ac.reason, facilities.reason, type.reason]
    .filter(Boolean);
  const warnings = [ac.warning].filter(Boolean);
  if (capacity.status === 'OVERFLOW_WITHIN_TOLERANCE') {
    warnings.push(
      `${room.name} is over capacity by ${capacity.overflow} student(s) `
      + `(${capacity.overflowPercent}% -- within the ${capacity.tolerancePercent}% tolerance).`
    );
  }

  return {
    roomId: room.id,
    ok: capacity.ok && ac.ok && facilities.ok && type.ok,
    capacity,
    ac,
    facilities,
    type,
    reasons,
    warnings,
  };
}

function capacityReason(room, capacity) {
  if (capacity.status === 'NO_CAPACITY_DATA') return `${room.name} has no seating capacity recorded.`;
  return `${room.name} seats ${capacity.capacity} but ${capacity.students} students are enrolled.`;
}

function humanEnum(v) {
  if (!v) return '';
  return String(v).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function humanFacility(v) {
  return humanEnum(v);
}

/**
 * Builds the comparison card payload shown whenever a user picks a room.
 * `utilization` is the share of the college's weekly periods the room is booked for.
 */
function roomCard(room, extra = {}) {
  return {
    id: room.id,
    name: room.name,
    roomNumber: room.room_number || null,
    code: room.code || null,
    roomType: room.room_type,
    roomTypeLabel: humanEnum(room.room_type),
    capacity: Number(room.seating_capacity) || 0,
    maxPermitted: Number(room.max_capacity) || null,
    isAc: !!room.is_ac,
    acLabel: room.is_ac ? 'AC' : 'NON-AC',
    hasProjector: !!room.has_projector,
    hasSmartBoard: !!room.has_smart_board,
    hasComputers: !!room.has_computers,
    computerCount: room.computer_count || null,
    labEquipment: room.lab_equipment || null,
    building: extra.buildingName || null,
    floor: extra.floorName || null,
    facilities: [...roomFacilities(room)],
    ...extra,
  };
}

module.exports = {
  AC_REQUIREMENT,
  parseFacilityList,
  roomFacilities,
  evaluateCapacity,
  evaluateAc,
  evaluateFacilities,
  evaluateRoomType,
  evaluateRoom,
  roomCard,
  humanEnum,
};
