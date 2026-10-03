/**
 * Small display helpers. Nothing here makes a decision -- they only turn values
 * the server already computed into text a person reads.
 */

export const DAY_NAMES = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday',
  5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};

export const DAY_SHORT = {
  1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun',
};

export const dayName = (day) => DAY_NAMES[Number(day)] || `Day ${day}`;
export const dayShort = (day) => DAY_SHORT[Number(day)] || `D${day}`;

/** "14:30" -> "2:30 PM". Times are stored as 24-hour strings throughout. */
export function formatTime(value) {
  const text = String(value || '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return text;
  const hour = Number(m[1]);
  const minute = m[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${minute} ${suffix}`;
}

export function formatTimeRange(start, end) {
  if (!start && !end) return '';
  return `${formatTime(start)} – ${formatTime(end)}`;
}

/** Minutes as a person would say them: 90 -> "1 h 30 min". */
export function formatMinutes(total) {
  const minutes = Number(total) || 0;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * SQLite's datetime('now') writes UTC as "2026-08-27 09:15:00" -- no timezone
 * marker at all -- and JavaScript reads that shape as *local* time. On any
 * machine east of Greenwich that makes every stored timestamp look like the
 * future, so "created 5 minutes ago" reads as "just now" forever. Anything in
 * that exact shape is therefore pinned to UTC before it is parsed; a real ISO
 * string (with a T, a Z or an offset) is left alone.
 */
export function parseStamp(value) {
  if (value instanceof Date) return value;
  const text = String(value || '').trim();
  if (!text) return null;
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text);
  const date = new Date(sqlite ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** ISO timestamp -> "22 Aug 2026, 3:04 PM". Empty string for nothing. */
export function formatDateTime(value) {
  if (!value) return '';
  const date = parseStamp(value);
  if (!date) return String(value);
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function formatDate(value) {
  if (!value) return '';
  const date = parseStamp(value);
  if (!date) return String(value);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Never", or how long ago something happened. Used for the last backup. */
export function timeAgo(value) {
  if (!value) return 'never';
  const date = parseStamp(value);
  if (!date) return String(value);
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  const days = Math.round(seconds / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(value);
}

/** ENUM_VALUE -> "Enum value", for anything the registry did not label. */
export function humanise(value) {
  if (value == null || value === '') return '';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

export const ROLE_LABELS = {
  SUPER_ADMIN: 'Super Admin',
  // Stored as COLLEGE_ADMIN; Section 12 calls this role the Timetable Coordinator.
  COLLEGE_ADMIN: 'Timetable Coordinator',
  FACULTY: 'Faculty',
  STUDENT: 'Student',
};

export const roleLabel = (role) => ROLE_LABELS[role] || humanise(role);

export const AC_LABELS = {
  REQUIRED: 'AC required',
  PREFERRED: 'AC preferred',
  NOT_REQUIRED: 'AC not required',
};

export const acRequirementLabel = (value) => AC_LABELS[value] || 'AC not required';

/** 0-100 -> a band the stylesheet colours. Used for quality and load. */
export function scoreBand(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 85) return 'good';
  if (n >= 70) return 'fair';
  if (n >= 50) return 'poor';
  return 'bad';
}

export function pluralise(count, singular, plural) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : (plural || `${singular}s`)}`;
}

/** Keeps long free text from breaking a card's layout. */
export function truncate(value, length = 90) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** A safe file name for exports: "B.Tech CSE / Sem 5" -> "B.Tech-CSE-Sem-5". */
export function slugForFile(value) {
  return String(value || 'timetable')
    .replace(/[^\w\s.-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'timetable';
}
