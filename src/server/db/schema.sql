-- =============================================================================
-- University Timetable Management -- SQLite schema
--
-- Conventions
--   * Times are stored as zero padded 'HH:MM' strings so they sort and compare
--     lexicographically. Nothing about timing is hardcoded anywhere in code --
--     every working hour / period length / break comes from college_timings.
--   * day_of_week: 1 = Monday ... 7 = Sunday.
--   * college_id is denormalised onto every college-owned table so that the
--     role scoping in Section 12 is a single indexed WHERE clause at the API
--     layer, never a multi-join that could be forgotten.
--   * Booleans are INTEGER 0/1.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Meta
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Section 1.1 University / 1.2 College
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS universities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL UNIQUE,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT,
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS colleges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL UNIQUE,
  address       TEXT,
  campus        TEXT,
  principal     TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_colleges_university ON colleges(university_id);

-- ---------------------------------------------------------------------------
-- Section 12 -- Users / roles
-- role: SUPER_ADMIN | COLLEGE_ADMIN | FACULTY | STUDENT
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  full_name     TEXT,
  email         TEXT,
  -- COLLEGE_ADMIN is bound to exactly one college. FACULTY/STUDENT inherit
  -- their college from the linked faculty/student record but it is copied here
  -- too so that scoping never needs a join.
  college_id    INTEGER REFERENCES colleges(id) ON DELETE SET NULL,
  faculty_id    INTEGER,
  student_id    INTEGER,
  can_edit_own_availability INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_college ON users(college_id);

-- ---------------------------------------------------------------------------
-- Section 1.3 - 1.5 Academic structure
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL,
  hod        TEXT,
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (college_id, code)
);
CREATE INDEX IF NOT EXISTS idx_departments_college ON departments(college_id);

CREATE TABLE IF NOT EXISTS programs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id     INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  department_id  INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  code           TEXT NOT NULL,
  duration_years REAL,
  semester_count INTEGER,
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (college_id, code)
);
CREATE INDEX IF NOT EXISTS idx_programs_college ON programs(college_id);
CREATE INDEX IF NOT EXISTS idx_programs_department ON programs(department_id);

CREATE TABLE IF NOT EXISTS semesters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id       INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  program_id       INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  semester_number  INTEGER NOT NULL,
  academic_session TEXT NOT NULL,
  start_date       TEXT,
  end_date         TEXT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, semester_number, academic_session)
);
CREATE INDEX IF NOT EXISTS idx_semesters_college ON semesters(college_id);
CREATE INDEX IF NOT EXISTS idx_semesters_program ON semesters(program_id);

-- ---------------------------------------------------------------------------
-- Section 1.7 Batch / 1.8 Section + Sub-Section
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id       INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  program_id       INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  semester_id      INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  academic_session TEXT,
  student_count    INTEGER,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batches_college ON student_batches(college_id);

CREATE TABLE IF NOT EXISTS sections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id    INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  program_id    INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  semester_id   INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  batch_id      INTEGER REFERENCES student_batches(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  code          TEXT,
  student_count INTEGER,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (semester_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sections_college ON sections(college_id);
CREATE INDEX IF NOT EXISTS idx_sections_semester ON sections(semester_id);

CREATE TABLE IF NOT EXISTS sub_sections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id    INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  section_id    INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  code          TEXT,
  student_count INTEGER,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (section_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sub_sections_college ON sub_sections(college_id);
CREATE INDEX IF NOT EXISTS idx_sub_sections_section ON sub_sections(section_id);

-- ---------------------------------------------------------------------------
-- Section 1.6 Student
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id        INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  university_id     INTEGER REFERENCES universities(id) ON DELETE SET NULL,
  department_id     INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  program_id        INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  semester_id       INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  batch_id          INTEGER REFERENCES student_batches(id) ON DELETE SET NULL,
  section_id        INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  sub_section_id    INTEGER REFERENCES sub_sections(id) ON DELETE SET NULL,
  student_code      TEXT,
  enrollment_number TEXT,
  name              TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  academic_session  TEXT,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_students_college ON students(college_id);
CREATE INDEX IF NOT EXISTS idx_students_section ON students(section_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_enrollment
  ON students(college_id, enrollment_number) WHERE enrollment_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Section 1.10 Faculty
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faculty (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id        INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  department_id     INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  employee_id       TEXT,
  email             TEXT,
  phone             TEXT,
  designation       TEXT,
  qualification     TEXT,
  specialization    TEXT,
  max_weekly_hours  INTEGER,
  preferred_hours   INTEGER,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_faculty_college ON faculty(college_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_faculty_employee
  ON faculty(college_id, employee_id) WHERE employee_id IS NOT NULL;

-- kind: AVAILABLE | PREFERRED | UNAVAILABLE
CREATE TABLE IF NOT EXISTS faculty_availability (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id  INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  faculty_id  INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'AVAILABLE',
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_fac_avail_faculty ON faculty_availability(faculty_id);

-- ---------------------------------------------------------------------------
-- Section 1.9 Course
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id         INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  department_id      INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  program_id         INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  semester_id        INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  code               TEXT NOT NULL,
  credits            REAL,
  lecture_hours      INTEGER NOT NULL DEFAULT 0,
  tutorial_hours     INTEGER NOT NULL DEFAULT 0,
  lab_hours          INTEGER NOT NULL DEFAULT 0,
  course_type        TEXT NOT NULL DEFAULT 'LECTURE',
  required_room_type TEXT,
  required_facilities TEXT,            -- JSON array of facility keys
  ac_requirement     TEXT NOT NULL DEFAULT 'NOT_REQUIRED', -- REQUIRED|PREFERRED|NOT_REQUIRED
  -- A course targets one section. Leave NULL to mean "every section of the
  -- semester" -- the generation wizard resolves that against its chosen scope.
  section_id         INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  student_strength   INTEGER,
  split_mode         TEXT NOT NULL DEFAULT 'WHOLE_SECTION',  -- WHOLE_SECTION|SPLIT_SUB_SECTIONS
  split_components   TEXT NOT NULL DEFAULT 'LAB,PRACTICAL',  -- which components split
  lab_block_periods  INTEGER NOT NULL DEFAULT 2,
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (college_id, code, semester_id, section_id)
);
CREATE INDEX IF NOT EXISTS idx_courses_college ON courses(college_id);
CREATE INDEX IF NOT EXISTS idx_courses_semester ON courses(semester_id);

-- Section 1.11 Faculty-Course assignment (eligibility pool + fixed flag)
CREATE TABLE IF NOT EXISTS faculty_courses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  is_fixed   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (faculty_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_fc_course ON faculty_courses(course_id);
CREATE INDEX IF NOT EXISTS idx_fc_faculty ON faculty_courses(faculty_id);

-- ---------------------------------------------------------------------------
-- Section 1.12 - 1.14 Physical resources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS buildings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id   INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  code         TEXT,
  campus       TEXT,
  floors_count INTEGER,
  facilities   TEXT,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_buildings_college ON buildings(college_id);

CREATE TABLE IF NOT EXISTS floors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id  INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  level_index INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (building_id, name)
);
CREATE INDEX IF NOT EXISTS idx_floors_college ON floors(college_id);

CREATE TABLE IF NOT EXISTS rooms (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id       INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  building_id      INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
  floor_id         INTEGER REFERENCES floors(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  room_number      TEXT,
  code             TEXT,
  room_type        TEXT NOT NULL DEFAULT 'CLASSROOM',
  seating_capacity INTEGER,
  max_capacity     INTEGER,
  is_ac            INTEGER NOT NULL DEFAULT 0,   -- first class field, always shown
  has_projector    INTEGER NOT NULL DEFAULT 0,
  has_smart_board  INTEGER NOT NULL DEFAULT 0,
  has_computers    INTEGER NOT NULL DEFAULT 0,
  computer_count   INTEGER,
  lab_equipment    TEXT,
  other_facilities TEXT,
  availability_note TEXT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_college ON rooms(college_id);
CREATE INDEX IF NOT EXISTS idx_rooms_building ON rooms(building_id);

-- Blocks a room out (maintenance, reserved, etc.)
CREATE TABLE IF NOT EXISTS room_availability (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id  INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_avail_room ON room_availability(room_id);

-- ---------------------------------------------------------------------------
-- Section 1.15 College Timing Configuration -- nothing here has a code default
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS college_timings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id      INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'Default Timing',
  working_days    TEXT NOT NULL,          -- CSV of day_of_week, e.g. '1,2,3,4,5,6'
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  slot_minutes    INTEGER NOT NULL,
  periods_per_day INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timings_college ON college_timings(college_id);

CREATE TABLE IF NOT EXISTS college_breaks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  timing_id  INTEGER NOT NULL REFERENCES college_timings(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'LUNCH',   -- LUNCH | SHORT
  name       TEXT,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_breaks_timing ON college_breaks(timing_id);

-- ---------------------------------------------------------------------------
-- Section 1.16 Scheduling Rules -- key/value so new rules need no migration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduling_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  rule_key   TEXT NOT NULL,
  rule_value TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (college_id, rule_key)
);

-- ---------------------------------------------------------------------------
-- Timetables, assignments, versions, audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timetables (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id       INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  program_id       INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  semester_id      INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  academic_session TEXT,
  name             TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'HYBRID',    -- AUTOMATIC|MANUAL|HYBRID
  status           TEXT NOT NULL DEFAULT 'DRAFT',     -- DRAFT|PUBLISHED|ARCHIVED
  quality_score    REAL,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timetables_college ON timetables(college_id);

CREATE TABLE IF NOT EXISTS assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timetable_id   INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  college_id     INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  course_id      INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  section_id     INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  sub_section_id INTEGER REFERENCES sub_sections(id) ON DELETE CASCADE,
  faculty_id     INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
  room_id        INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  day_of_week    INTEGER NOT NULL,
  start_time     TEXT NOT NULL,
  end_time       TEXT NOT NULL,
  slot_index     INTEGER NOT NULL DEFAULT 0,
  periods        INTEGER NOT NULL DEFAULT 1,
  component      TEXT NOT NULL DEFAULT 'LECTURE',  -- LECTURE|TUTORIAL|LAB|...
  -- Sub-sections of one parent that are meant to run in parallel share group_key
  group_key      TEXT,
  is_locked      INTEGER NOT NULL DEFAULT 0,
  -- Hybrid mode (Section 0): distinguishes what the coordinator fixed by hand
  -- from what the engine decided, both on screen and during re-generation.
  is_manual      INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED|CANCELLED
  score          REAL,
  warnings       TEXT,                              -- JSON array of soft warnings
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assign_timetable ON assignments(timetable_id);
CREATE INDEX IF NOT EXISTS idx_assign_college ON assignments(college_id);
CREATE INDEX IF NOT EXISTS idx_assign_faculty ON assignments(faculty_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_assign_room ON assignments(room_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_assign_section ON assignments(section_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_assign_subsection ON assignments(sub_section_id, day_of_week);

CREATE TABLE IF NOT EXISTS timetable_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  college_id   INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  version_no   INTEGER NOT NULL,
  label        TEXT,
  reason       TEXT,
  snapshot     TEXT NOT NULL,             -- JSON array of assignment rows
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (timetable_id, version_no)
);

CREATE TABLE IF NOT EXISTS assignment_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timetable_id   INTEGER,
  assignment_id  INTEGER,
  college_id     INTEGER,
  action         TEXT NOT NULL,
  actor_user_id  INTEGER,
  before_json    TEXT,
  after_json     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_timetable ON assignment_audit(timetable_id);

CREATE TABLE IF NOT EXISTS generation_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timetable_id INTEGER REFERENCES timetables(id) ON DELETE CASCADE,
  college_id   INTEGER NOT NULL,
  request_json TEXT,
  result_json  TEXT,
  created_by   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  college_id  INTEGER,
  entity      TEXT NOT NULL,
  filename    TEXT,
  total_rows  INTEGER,
  valid_rows  INTEGER,
  error_rows  INTEGER,
  status      TEXT NOT NULL DEFAULT 'PREVIEW',
  report_json TEXT,
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
