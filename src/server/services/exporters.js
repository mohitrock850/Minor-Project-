'use strict';

/**
 * Timetable export (Section 8.5): PDF, Excel and iCal.
 *
 * All three render the same view object that the screen shows, so an export can
 * never disagree with what the coordinator just looked at. PDF is produced by
 * handing this module's self-contained HTML to Electron's printToPDF -- no
 * headless browser, no external service, and it works offline.
 */

const { DAY_NAMES } = require('./entityRegistry');

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

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** One line per card, used by every format. */
function cardLines(card, opts = {}) {
  const lines = [`${card.courseCode || ''} ${card.courseName || ''}`.trim()];
  if (card.component && card.component !== 'LECTURE') lines.push(labelOf(card.component));
  if (card.groupLabel) lines.push(card.groupLabel);
  if (card.facultyName) lines.push(card.facultyName);
  if (card.roomName) {
    lines.push(`${card.roomName}${card.acLabel ? ` [${card.acLabel}]` : ''}`);
  }
  if (opts.includeStatus && card.status === 'CANCELLED') lines.push('CANCELLED');
  return lines.filter(Boolean);
}

function labelOf(component) {
  const map = {
    LECTURE: 'Lecture', TUTORIAL: 'Tutorial', LAB: 'Lab', PRACTICAL: 'Practical',
    SEMINAR: 'Seminar', WORKSHOP: 'Workshop', PROJECT: 'Project', OTHER: 'Class',
  };
  return map[component] || 'Class';
}

/**
 * Groups the cards of one grid position, dropping continuation tiles so a
 * multi-period lab prints once with a "(2 periods)" note.
 */
function cellCards(view, day, slotIndex) {
  return (view.cells[`${day}:${slotIndex}`] || []).filter((c) => !c.continuation);
}

// ---------------------------------------------------------------------------
// HTML (also the PDF source)
// ---------------------------------------------------------------------------
function toHtml(view, meta = {}) {
  const rows = view.grid.rows || [];
  const days = view.grid.workingDays;

  const header = `
    <div class="head">
      <div>
        <h1>${esc(meta.collegeName || 'Timetable')}</h1>
        <h2>${esc(view.scope.label || '')}</h2>
      </div>
      <div class="meta">
        ${meta.timetableName ? `<div><b>${esc(meta.timetableName)}</b></div>` : ''}
        ${meta.academicSession ? `<div>${esc(meta.academicSession)}</div>` : ''}
        <div>${view.stats.classes} classes &middot; ${view.stats.periods} periods</div>
        ${meta.generatedAt ? `<div class="muted">Generated ${esc(meta.generatedAt)}</div>` : ''}
      </div>
    </div>`;

  const thead = `<tr><th class="time">Time</th>${days
    .map((d) => `<th>${esc(DAY_NAMES[d] || `Day ${d}`)}</th>`).join('')}</tr>`;

  const body = rows.map((row) => {
    if (row.kind === 'BREAK') {
      return `<tr class="brk"><td class="time">${esc(row.start)} - ${esc(row.end)}</td>`
        + `<td colspan="${days.length}">${esc(row.name || 'Break')}</td></tr>`;
    }
    const cells = days.map((day) => {
      const cards = cellCards(view, day, row.index);
      if (!cards.length) return '<td class="free"></td>';
      const inner = cards.map((card) => {
        const lines = cardLines(card, { includeStatus: true });
        const cls = ['card'];
        if (card.isLocked) cls.push('locked');
        if (card.status === 'CANCELLED') cls.push('cancelled');
        if (card.subSectionId) cls.push('split');
        return `<div class="${cls.join(' ')}">`
          + lines.map((l, i) => `<div class="${i === 0 ? 'l1' : 'ln'}">${esc(l)}</div>`).join('')
          + (card.periods > 1 ? `<div class="ln muted">${card.periods} periods</div>` : '')
          + (card.isLocked ? '<div class="ln muted">Locked</div>' : '')
          + '</div>';
      }).join('');
      return `<td${cards.length > 1 ? ' class="multi"' : ''}>${inner}</td>`;
    }).join('');
    return `<tr><td class="time"><b>P${row.index}</b><br>${esc(row.start)}<br>${esc(row.end)}</td>${cells}</tr>`;
  }).join('');

  const legend = `
    <div class="legend">
      <span><i class="sw split"></i>Sub-section (parallel group)</span>
      <span><i class="sw locked"></i>Locked</span>
      <span>[AC] / [NON-AC] shows the room's air-conditioning</span>
    </div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(view.scope.label || 'Timetable')}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #0f172a; font-size: 10px; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #1d4ed8; padding-bottom: 6px; margin-bottom: 10px; }
  h1 { font-size: 16px; margin: 0; }
  h2 { font-size: 12px; margin: 2px 0 0; font-weight: 500; color: #475569; }
  .meta { text-align: right; font-size: 10px; line-height: 1.5; }
  .muted { color: #64748b; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #cbd5e1; padding: 3px 4px; vertical-align: top; }
  th { background: #f1f5f9; font-size: 10px; text-align: left; }
  td.time, th.time { width: 62px; background: #f8fafc; font-size: 9px; text-align: center;
                     color: #475569; white-space: nowrap; }
  tr.brk td { background: #fff7ed; text-align: center; font-weight: 600; color: #9a3412; }
  td.free { background: #fff; }
  .card { border-left: 3px solid #1d4ed8; padding: 2px 4px; margin-bottom: 3px; background: #f8fafc; }
  .card:last-child { margin-bottom: 0; }
  .card.split { border-left-color: #7c3aed; }
  .card.locked { border-left-color: #b45309; }
  .card.cancelled { opacity: .55; text-decoration: line-through; }
  .l1 { font-weight: 700; }
  .ln { font-size: 9px; color: #334155; }
  .legend { margin-top: 8px; font-size: 9px; color: #475569; display: flex; gap: 16px; }
  .sw { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; }
  .sw.split { background: #7c3aed; } .sw.locked { background: #b45309; }
</style></head>
<body>${header}<table><thead>${thead}</thead><tbody>${body}</tbody></table>${legend}</body></html>`;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------
async function toExcel(view, meta = {}) {
  const excel = getExcel();
  if (!excel) {
    const err = new Error('Excel export is unavailable in this build. Use PDF or CSV instead.');
    err.status = 400;
    throw err;
  }
  const wb = new excel.Workbook();
  wb.creator = 'University Timetable Management';

  const days = view.grid.workingDays;
  const rows = view.grid.rows || [];

  // --- Sheet 1: the grid, laid out as it appears on screen -----------------
  const ws = wb.addWorksheet('Timetable');
  ws.columns = [
    { width: 16 },
    ...days.map(() => ({ width: 34 })),
  ];
  ws.addRow([meta.collegeName || 'Timetable']).font = { bold: true, size: 14 };
  ws.addRow([view.scope.label || '']).font = { bold: true, size: 11 };
  if (meta.timetableName) ws.addRow([meta.timetableName]);
  ws.addRow([]);

  const headerRow = ws.addRow(['Time', ...days.map((d) => DAY_NAMES[d] || `Day ${d}`)]);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  for (const row of rows) {
    if (row.kind === 'BREAK') {
      const r = ws.addRow([`${row.start} - ${row.end}`, row.name || 'Break']);
      r.font = { bold: true, color: { argb: 'FF9A3412' } };
      ws.mergeCells(r.number, 2, r.number, days.length + 1);
      r.getCell(2).alignment = { horizontal: 'center' };
      r.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7ED' } };
      });
      continue;
    }
    const values = [`P${row.index}\n${row.start} - ${row.end}`];
    for (const day of days) {
      const cards = cellCards(view, day, row.index);
      values.push(cards.map((c) => cardLines(c, { includeStatus: true }).join('\n')).join('\n---\n'));
    }
    const r = ws.addRow(values);
    r.alignment = { wrapText: true, vertical: 'top' };
    r.height = 58;
    r.getCell(1).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    r.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      };
    });
  }

  // --- Sheet 2: one row per class, for filtering and pivoting --------------
  const list = wb.addWorksheet('Class List');
  list.columns = [
    { header: 'Day', key: 'day', width: 12 },
    { header: 'Period', key: 'period', width: 8 },
    { header: 'Time', key: 'time', width: 16 },
    { header: 'Periods', key: 'periods', width: 9 },
    { header: 'Course Code', key: 'code', width: 14 },
    { header: 'Course', key: 'course', width: 30 },
    { header: 'Type', key: 'component', width: 12 },
    { header: 'Section', key: 'section', width: 16 },
    { header: 'Sub-Section', key: 'sub', width: 14 },
    { header: 'Students', key: 'students', width: 10 },
    { header: 'Teacher', key: 'faculty', width: 24 },
    { header: 'Room', key: 'room', width: 18 },
    { header: 'AC', key: 'ac', width: 9 },
    { header: 'Building', key: 'building', width: 18 },
    { header: 'Locked', key: 'locked', width: 9 },
    { header: 'Manual', key: 'manual', width: 9 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Score', key: 'score', width: 8 },
    { header: 'Warnings', key: 'warnings', width: 40 },
  ];
  list.getRow(1).font = { bold: true };
  list.views = [{ state: 'frozen', ySplit: 1 }];
  for (const card of view.cards) {
    list.addRow({
      day: card.dayName,
      period: card.slotIndex,
      time: card.timeLabel,
      periods: card.periods,
      code: card.courseCode,
      course: card.courseName,
      component: labelOf(card.component),
      section: card.sectionName,
      sub: card.subSectionName || '',
      students: card.studentCount,
      faculty: card.facultyName || '',
      room: card.roomName || '',
      ac: card.acLabel || '',
      building: card.buildingName || '',
      locked: card.isLocked ? 'Yes' : 'No',
      manual: card.isManual ? 'Yes' : 'No',
      status: card.status,
      score: card.score,
      warnings: (card.warnings || []).map((w) => (typeof w === 'string' ? w : w.message)).join('; '),
    });
  }
  list.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 19 } };

  const buffer = await wb.xlsx.writeBuffer();
  return {
    filename: `${slug(view.scope.label || 'timetable')}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(buffer),
  };
}

// ---------------------------------------------------------------------------
// iCal
// ---------------------------------------------------------------------------
const ICS_DAYS = { 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA', 7: 'SU' };

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Folds a line at 75 octets as RFC 5545 requires. */
function fold(line) {
  if (line.length <= 73) return line;
  const parts = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest) parts.push(` ${rest}`);
  return parts.join('\r\n');
}

/** The next occurrence of `day` (1=Mon) on or after `from`. */
function firstDateFor(from, day) {
  const d = new Date(from.getTime());
  const current = d.getDay() === 0 ? 7 : d.getDay();
  const delta = (day - current + 7) % 7;
  d.setDate(d.getDate() + delta);
  return d;
}

function localStamp(date, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `T${pad(h || 0)}${pad(m || 0)}00`;
}

/**
 * A weekly-repeating event per class.
 *
 * Times are written as floating local times (no timezone) deliberately: a
 * college timetable means "09:30 wherever the college is", and floating times
 * survive being opened on a laptop set to another zone without shifting.
 */
function toIcal(view, meta = {}) {
  const start = meta.termStart ? new Date(`${meta.termStart}T00:00:00`) : new Date();
  const weeks = Math.max(1, Number(meta.weeks) || 16);
  const stamp = meta.now || localStamp(new Date(), '00:00');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//University Timetable Management//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`${view.scope.label || 'Timetable'}`)}`,
  ];

  for (const card of view.cards) {
    if (card.status === 'CANCELLED') continue;
    const day = Number(card.day);
    if (!ICS_DAYS[day]) continue;
    const first = firstDateFor(start, day);
    const summary = [card.courseCode, card.courseName, labelOf(card.component)]
      .filter(Boolean).join(' - ');
    const description = [
      card.groupLabel ? `Group: ${card.groupLabel}` : null,
      card.facultyName ? `Teacher: ${card.facultyName}` : null,
      card.studentCount ? `Students: ${card.studentCount}` : null,
      card.roomName ? `Room: ${card.roomName} (${card.acLabel})` : null,
      card.isLocked ? 'Locked assignment' : null,
    ].filter(Boolean).join('\n');
    const location = [card.roomName, card.buildingName].filter(Boolean).join(', ');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:assignment-${card.id}@university-timetable`);
    lines.push(`DTSTAMP:${stamp}Z`);
    lines.push(`DTSTART:${localStamp(first, card.startTime)}`);
    lines.push(`DTEND:${localStamp(first, card.endTime)}`);
    lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${ICS_DAYS[day]};COUNT=${weeks}`);
    lines.push(fold(`SUMMARY:${icsEscape(summary)}`));
    if (description) lines.push(fold(`DESCRIPTION:${icsEscape(description)}`));
    if (location) lines.push(fold(`LOCATION:${icsEscape(location)}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return {
    filename: `${slug(view.scope.label || 'timetable')}.ics`,
    mimeType: 'text/calendar',
    buffer: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// CSV (always available, no dependency)
// ---------------------------------------------------------------------------
function toCsv(view) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'Day', 'Period', 'Time', 'Periods', 'Course Code', 'Course', 'Type', 'Section',
    'Sub-Section', 'Students', 'Teacher', 'Room', 'AC', 'Building', 'Locked', 'Status',
  ];
  const rows = view.cards.map((c) => [
    c.dayName, c.slotIndex, c.timeLabel, c.periods, c.courseCode, c.courseName,
    labelOf(c.component), c.sectionName, c.subSectionName || '', c.studentCount,
    c.facultyName || '', c.roomName || '', c.acLabel || '', c.buildingName || '',
    c.isLocked ? 'Yes' : 'No', c.status,
  ]);
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
  return {
    filename: `${slug(view.scope.label || 'timetable')}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(`${text}\n`, 'utf8'),
  };
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'timetable';
}

module.exports = { toHtml, toExcel, toIcal, toCsv, cardLines, slug };
