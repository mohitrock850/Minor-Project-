'use strict';

/**
 * Central entity registry (Section 1).
 *
 * Every entity is declared once here and that declaration drives:
 *   - the generic CRUD REST routes                (routes/entities.js)
 *   - the generic list/form UI in the renderer    (served via /api/meta/entities)
 *   - the Excel export-template / import flow     (services/templates.js, Section 10)
 *   - global search                               (routes/search.js, Section 11)
 *   - the Data Setup Progress dashboard           (routes/readiness.js, Section 9)
 *
 * Adding a field in one place therefore updates the database contract, the UI,
 * and the bulk-import template together -- which is what keeps the exported
 * templates' headers "exactly matching that entity's fields" (Section 10.1).
 */

const STATUS = ['ACTIVE', 'INACTIVE'];

const ENUMS = {
  STATUS,
  COURSE_TYPE: [
    'LECTURE', 'TUTORIAL', 'LABORATORY', 'PRACTICAL',
    'SEMINAR', 'WORKSHOP', 'PROJECT', 'OTHER',
  ],
  COMPONENT: ['LECTURE', 'TUTORIAL', 'LAB', 'PRACTICAL', 'SEMINAR', 'WORKSHOP', 'PROJECT', 'OTHER'],
  AC_REQUIREMENT: ['REQUIRED', 'PREFERRED', 'NOT_REQUIRED'],
  SPLIT_MODE: ['WHOLE_SECTION', 'SPLIT_SUB_SECTIONS'],
  ROOM_TYPE: [
    'CLASSROOM', 'LECTURE_THEATRE', 'LABORATORY', 'COMPUTER_LAB',
    'SEMINAR_HALL', 'WORKSHOP', 'TUTORIAL_ROOM', 'AUDITORIUM', 'OTHER',
  ],
  AVAILABILITY_KIND: ['AVAILABLE', 'PREFERRED', 'UNAVAILABLE'],
  BREAK_KIND: ['LUNCH', 'SHORT'],
  FACILITY: [
    'PROJECTOR', 'SMART_BOARD', 'COMPUTERS', 'LAB_EQUIPMENT',
    'AC', 'INTERNET', 'WHITEBOARD', 'AUDIO_SYSTEM',
  ],
  SELECTION_MODE: ['FIXED', 'PREFERRED', 'AUTOMATIC'],
  ROLE: ['SUPER_ADMIN', 'COLLEGE_ADMIN', 'FACULTY', 'STUDENT'],
  DAY: [1, 2, 3, 4, 5, 6, 7],
};

const DAY_NAMES = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday',
  5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};

// ---------------------------------------------------------------------------
// Field helpers -- keep declarations short and consistent.
// ---------------------------------------------------------------------------
const f = {
  text: (key, label, opts = {}) => ({ key, label, type: 'text', ...opts }),
  area: (key, label, opts = {}) => ({ key, label, type: 'textarea', ...opts }),
  num: (key, label, opts = {}) => ({ key, label, type: 'number', ...opts }),
  bool: (key, label, opts = {}) => ({ key, label, type: 'boolean', ...opts }),
  enumf: (key, label, values, opts = {}) => ({ key, label, type: 'enum', values, ...opts }),
  ref: (key, label, entity, opts = {}) => ({ key, label, type: 'ref', ref: entity, ...opts }),
  time: (key, label, opts = {}) => ({ key, label, type: 'time', ...opts }),
  date: (key, label, opts = {}) => ({ key, label, type: 'date', ...opts }),
  csv: (key, label, opts = {}) => ({ key, label, type: 'csv', ...opts }),
  day: (key, label, opts = {}) => ({ key, label, type: 'day', ...opts }),
  status: () => ({ key: 'status', label: 'Status', type: 'enum', values: STATUS, default: 'ACTIVE' }),
};

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
const ENTITIES = {
  universities: {
    key: 'universities',
    table: 'universities',
    label: 'Universities',
    singular: 'University',
    group: 'Institution',
    collegeScoped: false,
    superAdminOnly: true,
    bulk: false,
    titleField: 'name',
    subtitleFields: ['code', 'city'],
    searchable: ['name', 'code', 'city', 'state'],
    fields: [
      f.text('name', 'University Name', { required: true, listed: true }),
      f.text('code', 'University Code', { required: true, listed: true, unique: true }),
      f.area('address', 'Address'),
      f.text('city', 'City', { listed: true }),
      f.text('state', 'State'),
      f.text('country', 'Country'),
      f.text('contact_name', 'Contact Person'),
      f.text('contact_email', 'Contact Email'),
      f.text('contact_phone', 'Contact Phone'),
      f.status(),
    ],
  },

  colleges: {
    key: 'colleges',
    table: 'colleges',
    label: 'Colleges',
    singular: 'College',
    group: 'Institution',
    collegeScoped: false,
    // A Timetable Coordinator may read (and edit) only their own college row.
    selfCollegeRow: true,
    superAdminCreateOnly: true,
    bulk: false,
    titleField: 'name',
    subtitleFields: ['code', 'campus'],
    searchable: ['name', 'code', 'campus', 'principal'],
    fields: [
      f.text('name', 'College Name', { required: true, listed: true }),
      f.text('code', 'College Code', { required: true, listed: true, unique: true }),
      f.ref('university_id', 'University', 'universities', { required: true, listed: true }),
      f.area('address', 'Address'),
      f.text('campus', 'Campus', { listed: true }),
      f.text('principal', 'Principal / Dean', { listed: true }),
      f.text('contact_email', 'Contact Email'),
      f.text('contact_phone', 'Contact Phone'),
      f.status(),
    ],
  },

  departments: {
    key: 'departments',
    table: 'departments',
    label: 'Departments',
    singular: 'Department',
    group: 'Academic Structure',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['code', 'hod'],
    searchable: ['name', 'code', 'hod'],
    // Mirrors the UNIQUE constraint in schema.sql, so the import preview reports
    // exactly the duplicates the database would refuse (Section 10.3).
    duplicateKey: ['code'],
    readiness: { required: true, minCount: 1, hint: 'Create at least one department' },
    fields: [
      f.text('name', 'Department Name', { required: true, listed: true }),
      f.text('code', 'Department Code', { required: true, listed: true }),
      f.text('hod', 'HOD', { listed: true }),
      f.status(),
    ],
  },

  programs: {
    key: 'programs',
    table: 'programs',
    label: 'Programs',
    singular: 'Program',
    group: 'Academic Structure',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['code'],
    searchable: ['name', 'code'],
    duplicateKey: ['code'],
    readiness: { required: true, minCount: 1, hint: 'Create at least one program' },
    fields: [
      f.text('name', 'Program Name', { required: true, listed: true }),
      f.text('code', 'Program Code', { required: true, listed: true }),
      f.ref('department_id', 'Department', 'departments', { required: true, listed: true }),
      f.num('duration_years', 'Duration (Years)', { step: 0.5 }),
      f.num('semester_count', 'Semester Count'),
      f.status(),
    ],
  },

  semesters: {
    key: 'semesters',
    table: 'semesters',
    label: 'Semesters',
    singular: 'Semester',
    group: 'Academic Structure',
    collegeScoped: true,
    bulk: true,
    titleField: 'semester_number',
    titlePrefix: 'Semester ',
    subtitleFields: ['academic_session'],
    searchable: ['academic_session'],
    duplicateKey: ['program_id', 'semester_number', 'academic_session'],
    readiness: { required: true, minCount: 1, hint: 'Create at least one semester' },
    fields: [
      f.ref('program_id', 'Program', 'programs', { required: true, listed: true }),
      f.num('semester_number', 'Semester Number', { required: true, listed: true }),
      f.text('academic_session', 'Academic Session', { required: true, listed: true, placeholder: '2025-26' }),
      f.date('start_date', 'Start Date'),
      f.date('end_date', 'End Date'),
      f.status(),
    ],
  },

  student_batches: {
    key: 'student_batches',
    table: 'student_batches',
    label: 'Student Batches',
    singular: 'Student Batch',
    group: 'Students',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['academic_session', 'student_count'],
    searchable: ['name', 'academic_session'],
    fields: [
      f.text('name', 'Batch Name', { required: true, listed: true }),
      f.ref('department_id', 'Department', 'departments', { listed: true }),
      f.ref('program_id', 'Program', 'programs', { listed: true }),
      f.ref('semester_id', 'Semester', 'semesters', { listed: true }),
      f.text('academic_session', 'Academic Session'),
      f.num('student_count', 'Student Count', { listed: true }),
      f.status(),
    ],
  },

  sections: {
    key: 'sections',
    table: 'sections',
    label: 'Sections',
    singular: 'Section',
    group: 'Students',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['code', 'student_count'],
    searchable: ['name', 'code'],
    duplicateKey: ['semester_id', 'name'],
    readiness: {
      required: true,
      minCount: 1,
      hint: 'Create sections and give each one a student count',
      completeness: [{ column: 'student_count', message: 'sections have no student count' }],
    },
    fields: [
      f.text('name', 'Section Name', { required: true, listed: true }),
      f.text('code', 'Section Code', { listed: true }),
      f.ref('program_id', 'Program', 'programs', { required: true, listed: true }),
      f.ref('semester_id', 'Semester', 'semesters', { required: true, listed: true }),
      f.ref('department_id', 'Department', 'departments'),
      f.ref('batch_id', 'Student Batch', 'student_batches'),
      f.num('student_count', 'Student Count', { required: true, listed: true }),
      f.status(),
    ],
  },

  sub_sections: {
    key: 'sub_sections',
    table: 'sub_sections',
    label: 'Sub-Sections',
    singular: 'Sub-Section',
    group: 'Students',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['code', 'student_count'],
    searchable: ['name', 'code'],
    duplicateKey: ['section_id', 'name'],
    help: 'Split a large section into parallel groups (e.g. Section B -> B1, B2) for labs, tutorials and practicals.',
    fields: [
      f.text('name', 'Sub-Section Name', { required: true, listed: true }),
      f.text('code', 'Sub-Section Code', { listed: true }),
      f.ref('section_id', 'Parent Section', 'sections', { required: true, listed: true }),
      f.num('student_count', 'Student Count', { required: true, listed: true }),
      f.status(),
    ],
  },

  students: {
    key: 'students',
    table: 'students',
    label: 'Students',
    singular: 'Student',
    group: 'Students',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['enrollment_number', 'email'],
    searchable: ['name', 'enrollment_number', 'student_code', 'email'],
    duplicateKey: ['enrollment_number'],
    fields: [
      f.text('name', 'Name', { required: true, listed: true }),
      f.text('student_code', 'Student ID', { listed: true }),
      f.text('enrollment_number', 'Enrollment Number', { required: true, listed: true }),
      f.text('email', 'Email', { listed: true }),
      f.text('phone', 'Phone'),
      f.ref('department_id', 'Department', 'departments'),
      f.ref('program_id', 'Program', 'programs', { listed: true }),
      f.ref('semester_id', 'Semester', 'semesters', { listed: true }),
      f.text('academic_session', 'Academic Session'),
      f.ref('batch_id', 'Batch', 'student_batches'),
      f.ref('section_id', 'Section', 'sections', { listed: true }),
      f.ref('sub_section_id', 'Sub-Section', 'sub_sections'),
      f.status(),
    ],
  },

  faculty: {
    key: 'faculty',
    table: 'faculty',
    label: 'Faculty / Teachers',
    singular: 'Faculty',
    group: 'People',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['employee_id', 'designation'],
    searchable: ['name', 'employee_id', 'email', 'specialization', 'designation'],
    duplicateKey: ['employee_id'],
    readiness: {
      required: true,
      minCount: 1,
      hint: 'Add faculty and configure their availability',
      completeness: [{ column: 'max_weekly_hours', message: 'faculty members have no maximum weekly hours' }],
    },
    fields: [
      f.text('name', 'Faculty Name', { required: true, listed: true }),
      f.text('employee_id', 'Employee ID', { required: true, listed: true }),
      f.text('email', 'Email', { listed: true }),
      f.text('phone', 'Phone'),
      f.ref('department_id', 'Department', 'departments', { listed: true }),
      f.text('designation', 'Designation', { listed: true }),
      f.text('qualification', 'Qualification'),
      f.text('specialization', 'Specialization'),
      f.num('max_weekly_hours', 'Maximum Weekly Hours', { required: true, listed: true }),
      f.num('preferred_hours', 'Preferred Hours'),
      f.status(),
    ],
  },

  faculty_availability: {
    key: 'faculty_availability',
    table: 'faculty_availability',
    label: 'Faculty Availability',
    singular: 'Availability Entry',
    group: 'People',
    collegeScoped: true,
    bulk: true,
    titleField: 'faculty_id',
    searchable: [],
    facultySelfEditable: true,
    help: 'UNAVAILABLE windows are hard blocks. PREFERRED windows are rewarded by the quality score.',
    fields: [
      f.ref('faculty_id', 'Faculty', 'faculty', { required: true, listed: true }),
      f.day('day_of_week', 'Day', { required: true, listed: true }),
      f.time('start_time', 'Start Time', { required: true, listed: true }),
      f.time('end_time', 'End Time', { required: true, listed: true }),
      f.enumf('kind', 'Kind', ENUMS.AVAILABILITY_KIND, { default: 'AVAILABLE', listed: true }),
      f.text('note', 'Note'),
    ],
  },

  courses: {
    key: 'courses',
    table: 'courses',
    label: 'Courses',
    singular: 'Course',
    group: 'Academic Structure',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['code', 'course_type'],
    searchable: ['name', 'code', 'course_type'],
    duplicateKey: ['code', 'semester_id', 'section_id'],
    readiness: {
      required: true,
      minCount: 1,
      hint: 'Add courses, set weekly hours and assign faculty',
      // Deliberately no completeness rule on student_strength: leaving it blank is
      // the normal case and means "however many students the section has", which
      // is what the scheduler resolves it to. Warning about it would contradict
      // Section 5's rule that an empty field is an instruction, not a mistake.
    },
    fields: [
      f.text('name', 'Course Name', { required: true, listed: true }),
      f.text('code', 'Course Code', { required: true, listed: true }),
      f.ref('department_id', 'Department', 'departments', { listed: true }),
      f.ref('program_id', 'Program', 'programs', { listed: true }),
      f.ref('semester_id', 'Semester', 'semesters', { required: true, listed: true }),
      f.num('credits', 'Credits', { step: 0.5 }),
      f.num('lecture_hours', 'Lecture Hours/Week', { default: 0, listed: true }),
      f.num('tutorial_hours', 'Tutorial Hours/Week', { default: 0, listed: true }),
      f.num('lab_hours', 'Lab Hours/Week', { default: 0, listed: true }),
      f.enumf('course_type', 'Course Type', ENUMS.COURSE_TYPE, { required: true, default: 'LECTURE', listed: true }),
      f.enumf('required_room_type', 'Required Room Type', ENUMS.ROOM_TYPE, { nullable: true }),
      f.csv('required_facilities', 'Required Facilities', { values: ENUMS.FACILITY }),
      f.enumf('ac_requirement', 'AC Requirement', ENUMS.AC_REQUIREMENT, { default: 'NOT_REQUIRED', listed: true }),
      f.ref('section_id', 'Student Section', 'sections', {
        listed: true,
        help: 'Leave blank to mean "all sections of this semester" -- the wizard resolves it against the chosen scope.',
      }),
      f.num('student_strength', 'Student Strength', {
        listed: true,
        help: 'Leave blank to use the section\'s own student count. Fill it in only when this course '
          + 'is taken by a different number of students -- an elective, for example.',
      }),
      f.enumf('split_mode', 'Split Mode', ENUMS.SPLIT_MODE, { default: 'WHOLE_SECTION', listed: true }),
      f.csv('split_components', 'Split Components', { values: ENUMS.COMPONENT, default: 'LAB,PRACTICAL' }),
      f.num('lab_block_periods', 'Lab Block Length (periods)', { default: 2 }),
      f.status(),
    ],
  },

  faculty_courses: {
    key: 'faculty_courses',
    table: 'faculty_courses',
    label: 'Faculty-Course Assignments',
    singular: 'Faculty-Course Assignment',
    group: 'People',
    collegeScoped: true,
    bulk: true,
    titleField: 'course_id',
    searchable: [],
    duplicateKey: ['faculty_id', 'course_id'],
    help: 'The eligible-faculty pool per course. Mark Fixed Faculty when the scheduler must never substitute another teacher.',
    readiness: {
      required: true,
      minCount: 1,
      hint: 'Every course needs at least one eligible faculty member',
    },
    fields: [
      f.ref('course_id', 'Course', 'courses', { required: true, listed: true }),
      f.ref('faculty_id', 'Faculty', 'faculty', { required: true, listed: true }),
      f.bool('is_fixed', 'Fixed Faculty', { default: 0, listed: true }),
    ],
  },

  buildings: {
    key: 'buildings',
    table: 'buildings',
    label: 'Buildings',
    singular: 'Building',
    group: 'Infrastructure',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['code', 'campus'],
    searchable: ['name', 'code', 'campus'],
    fields: [
      f.text('name', 'Building Name', { required: true, listed: true }),
      f.text('code', 'Building Code', { listed: true }),
      f.text('campus', 'Campus', { listed: true }),
      f.num('floors_count', 'Number of Floors', { listed: true }),
      f.csv('facilities', 'Facilities', { values: ENUMS.FACILITY }),
      f.status(),
    ],
  },

  floors: {
    key: 'floors',
    table: 'floors',
    label: 'Floors',
    singular: 'Floor',
    group: 'Infrastructure',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    searchable: ['name'],
    duplicateKey: ['building_id', 'name'],
    fields: [
      f.ref('building_id', 'Building', 'buildings', { required: true, listed: true }),
      f.text('name', 'Floor Name', { required: true, listed: true, placeholder: 'Ground / First / Second' }),
      f.num('level_index', 'Level Index', { required: true, default: 0, listed: true }),
      f.status(),
    ],
  },

  rooms: {
    key: 'rooms',
    table: 'rooms',
    label: 'Rooms / LTs / Labs',
    singular: 'Room',
    group: 'Infrastructure',
    collegeScoped: true,
    bulk: true,
    titleField: 'name',
    subtitleFields: ['room_type', 'seating_capacity'],
    searchable: ['name', 'code', 'room_number', 'room_type'],
    readiness: {
      required: true,
      minCount: 1,
      hint: 'Add rooms with capacity and AC status',
      completeness: [{ column: 'seating_capacity', message: 'rooms have no capacity' }],
    },
    fields: [
      f.text('name', 'Room Name', { required: true, listed: true }),
      f.text('room_number', 'Room Number', { listed: true }),
      f.text('code', 'Room Code', { listed: true }),
      f.ref('building_id', 'Building', 'buildings', { listed: true }),
      f.ref('floor_id', 'Floor', 'floors'),
      f.enumf('room_type', 'Room Type', ENUMS.ROOM_TYPE, { required: true, default: 'CLASSROOM', listed: true }),
      f.num('seating_capacity', 'Seating Capacity', { required: true, listed: true }),
      f.num('max_capacity', 'Maximum Permitted Capacity', { listed: true }),
      f.bool('is_ac', 'AC', { default: 0, listed: true, prominent: true }),
      f.bool('has_projector', 'Projector', { default: 0, listed: true }),
      f.bool('has_smart_board', 'Smart Board', { default: 0 }),
      f.bool('has_computers', 'Computer Availability', { default: 0 }),
      f.num('computer_count', 'Computer Count'),
      f.text('lab_equipment', 'Lab Equipment'),
      f.csv('other_facilities', 'Other Facilities', { values: ENUMS.FACILITY }),
      f.text('availability_note', 'Availability'),
      f.status(),
    ],
  },

  room_availability: {
    key: 'room_availability',
    table: 'room_availability',
    label: 'Room Availability',
    singular: 'Room Availability Entry',
    group: 'Infrastructure',
    collegeScoped: true,
    bulk: true,
    titleField: 'room_id',
    searchable: [],
    help: 'Block a room out for maintenance or reserved use. UNAVAILABLE windows are hard blocks.',
    fields: [
      f.ref('room_id', 'Room', 'rooms', { required: true, listed: true }),
      f.day('day_of_week', 'Day', { required: true, listed: true }),
      f.time('start_time', 'Start Time', { required: true, listed: true }),
      f.time('end_time', 'End Time', { required: true, listed: true }),
      f.enumf('kind', 'Kind', ENUMS.AVAILABILITY_KIND, { default: 'UNAVAILABLE', listed: true }),
      f.text('note', 'Note'),
    ],
  },

  // College timing has a purpose-built editor (breaks are a child table), but it
  // is still registered so CRUD, search and readiness work uniformly.
  college_timings: {
    key: 'college_timings',
    table: 'college_timings',
    label: 'College Timing Configuration',
    singular: 'Timing Configuration',
    group: 'Configuration',
    collegeScoped: true,
    bulk: false,
    customEditor: 'timing',
    titleField: 'name',
    searchable: ['name'],
    readiness: {
      required: true,
      minCount: 1,
      hint: 'This college has no Timing Configuration set up',
      action: 'Set Up Timing',
    },
    fields: [
      f.text('name', 'Configuration Name', { required: true, default: 'Default Timing', listed: true }),
      f.csv('working_days', 'Working Days', { required: true, values: ENUMS.DAY, listed: true }),
      f.time('start_time', 'College Start Time', { required: true, listed: true }),
      f.time('end_time', 'College End Time', { required: true, listed: true }),
      f.num('slot_minutes', 'Period / Time-Slot Duration (minutes)', { required: true, listed: true }),
      f.num('periods_per_day', 'Number of Periods per Day', { required: true, listed: true }),
      f.status(),
    ],
  },

  college_breaks: {
    key: 'college_breaks',
    table: 'college_breaks',
    label: 'Lunch & Short Breaks',
    singular: 'Break',
    group: 'Configuration',
    collegeScoped: true,
    bulk: false,
    titleField: 'name',
    searchable: ['name'],
    fields: [
      f.ref('timing_id', 'Timing Configuration', 'college_timings', { required: true, listed: true }),
      f.enumf('kind', 'Break Kind', ENUMS.BREAK_KIND, { required: true, default: 'LUNCH', listed: true }),
      f.text('name', 'Break Name', { listed: true }),
      f.time('start_time', 'Start Time', { required: true, listed: true }),
      f.time('end_time', 'End Time', { required: true, listed: true }),
    ],
  },
};

// ---------------------------------------------------------------------------
// Scheduling rule catalogue (Section 1.16) -- editable through the UI.
// ---------------------------------------------------------------------------
const RULE_CATALOGUE = [
  {
    key: 'capacity_tolerance_percent', label: 'Room Capacity Overflow Tolerance (%)',
    type: 'number', default: '10',
    help: 'How far student strength may exceed seating capacity before the room is rejected. Overflow up to this figure is a soft warning.',
  },
  {
    key: 'max_consecutive_teacher_periods', label: 'Max Consecutive Periods per Teacher',
    type: 'number', default: '3',
    help: 'A teacher is never scheduled for more back-to-back periods than this.',
  },
  {
    key: 'max_teacher_periods_per_day', label: 'Max Periods per Teacher per Day',
    type: 'number', default: '6',
  },
  {
    key: 'max_section_periods_per_day', label: 'Max Periods per Section per Day',
    type: 'number', default: '7',
  },
  {
    key: 'min_gap_section_minutes', label: 'Minimum Gap Between a Section\'s Classes (minutes)',
    type: 'number', default: '0',
    help: 'Set above 0 to force a breather between consecutive classes for the same section.',
  },
  {
    key: 'prefer_parallel_subsections', label: 'Prefer Running Sub-Sections in Parallel',
    type: 'boolean', default: '1',
    help: 'Sub-sections of one section are placed in the same slot where possible (different teacher and room each). Never a hard requirement.',
  },
  {
    key: 'allow_capacity_overflow', label: 'Allow Capacity Overflow Within Tolerance',
    type: 'boolean', default: '1',
  },
  {
    key: 'avoid_last_period', label: 'Avoid the Last Period of the Day',
    type: 'boolean', default: '0',
    help: 'Soft preference only.',
  },
  {
    key: 'spread_course_across_days', label: 'Spread a Course\'s Classes Across Different Days',
    type: 'boolean', default: '1',
    help: 'Soft preference: penalises putting two classes of the same course on the same day.',
  },
  {
    key: 'disallowed_slots', label: 'Disallowed Slots',
    type: 'text', default: '',
    help: 'Comma-separated day:period pairs that are never used, e.g. "6:5,6:6" to keep Saturday afternoons free.',
  },
  {
    key: 'respect_faculty_max_hours', label: 'Enforce Faculty Maximum Weekly Hours',
    type: 'boolean', default: '1',
  },
];

// ---------------------------------------------------------------------------
// Lookups / helpers
// ---------------------------------------------------------------------------
function getEntity(key) {
  const e = ENTITIES[key];
  if (!e) {
    const err = new Error(`Unknown entity "${key}"`);
    err.status = 404;
    throw err;
  }
  return e;
}

function listEntities() {
  return Object.values(ENTITIES);
}

function bulkEntities() {
  return listEntities().filter((e) => e.bulk);
}

/** Columns actually written to the table (registry fields + college_id). */
function writableColumns(entity) {
  const cols = entity.fields.map((x) => x.key);
  if (entity.collegeScoped) cols.push('college_id');
  return cols;
}

/** Client-safe copy of the registry for the renderer's generic CRUD UI. */
function publicRegistry() {
  return {
    enums: ENUMS,
    dayNames: DAY_NAMES,
    rules: RULE_CATALOGUE,
    entities: listEntities().map((e) => ({
      key: e.key,
      label: e.label,
      singular: e.singular,
      group: e.group,
      help: e.help || null,
      collegeScoped: !!e.collegeScoped,
      superAdminOnly: !!e.superAdminOnly,
      superAdminCreateOnly: !!e.superAdminCreateOnly,
      selfCollegeRow: !!e.selfCollegeRow,
      bulk: !!e.bulk,
      duplicateKey: e.duplicateKey || null,
      customEditor: e.customEditor || null,
      titleField: e.titleField,
      titlePrefix: e.titlePrefix || '',
      subtitleFields: e.subtitleFields || [],
      fields: e.fields,
    })),
  };
}

module.exports = {
  ENUMS,
  DAY_NAMES,
  ENTITIES,
  RULE_CATALOGUE,
  STATUS,
  getEntity,
  listEntities,
  bulkEntities,
  writableColumns,
  publicRegistry,
};
