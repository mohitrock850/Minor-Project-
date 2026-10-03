'use strict';

/**
 * First-run demo data.
 *
 * This is the acceptance scenario from Section 17 turned into rows: two colleges
 * under one university, each with its own timing configuration, and a College A
 * Semester 5 Section B whose Computer Networks lab is split into sub-sections
 * B1 / B2. Nothing is pre-scheduled -- the whole point of the scenario is that a
 * coordinator opens the Generation Wizard and produces the timetable themselves,
 * so the seed stops at the data the wizard needs.
 *
 * College B exists mainly to prove two things that cannot be demonstrated with a
 * single college: that a Timetable Coordinator cannot see another college's data,
 * and that no timing rule is hardcoded -- College B runs six days a week on
 * 45-minute periods with two breaks, College A five days a week on 60-minute
 * periods with one.
 *
 * Everything here is ordinary data created through the same tables the UI writes
 * to, so "Reset to empty" (Section 15) removes it completely and the user can
 * start from their own university instead.
 */

const db = require('./connection');
const settings = require('../services/settings');
const { hashPassword } = require('../auth/tokens');

/** Documented on the login screen -- this is demo data, not a deployment. */
const DEMO_PASSWORD = 'demo1234';

/**
 * The logins the seed creates, in the order the sign-in screen offers them.
 *
 * Kept out of seedUsers() so /health can list them on a machine that still holds
 * demo data -- and stop listing them the moment it does not. There is nothing to
 * leak here: these accounts only exist while the shipped demo dataset does, and
 * demoAccounts() checks the users table rather than trusting the seeded flag
 * alone, so deleting one removes it from the screen.
 */
const DEMO_ACCOUNTS = [
  {
    username: 'superadmin',
    role: 'SUPER_ADMIN',
    describes: 'Every college, with a college switcher.',
  },
  {
    username: 'coordinator.a',
    role: 'COLLEGE_ADMIN',
    describes: 'College A only -- College B is invisible to this login.',
  },
  {
    username: 'coordinator.b',
    role: 'COLLEGE_ADMIN',
    describes: 'College B only.',
  },
  {
    username: 'prof.a',
    role: 'FACULTY',
    describes: "Professor A's own week, with no edit controls.",
  },
  {
    username: 'student.b1',
    role: 'STUDENT',
    describes: "One section's timetable, read only.",
  },
];

/**
 * The demo logins that still exist on this machine, or an empty list once the
 * user has reset to empty or deleted them.
 *
 * @returns {Array<{username:string, role:string, describes:string}>}
 */
function demoAccounts() {
  if (!settings.getBool('seeded')) return [];
  const placeholders = DEMO_ACCOUNTS.map(() => '?').join(', ');
  const rows = db.all(
    `SELECT username FROM users WHERE status = 'ACTIVE' AND username IN (${placeholders})`,
    DEMO_ACCOUNTS.map((a) => a.username)
  );
  const present = new Set(rows.map((r) => r.username));
  return DEMO_ACCOUNTS.filter((a) => present.has(a.username));
}

const ACADEMIC_SESSION = '2026-27';

// ---------------------------------------------------------------------------
// Small insert helper -- keeps the data below readable
// ---------------------------------------------------------------------------

/**
 * Inserts one row from a plain object and returns its new id.
 * Positional parameters only, which is what both SQLite drivers agree on.
 */
function insert(table, row) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) `
    + `VALUES (${keys.map(() => '?').join(', ')})`;
  const values = keys.map((k) => {
    const v = row[k];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v === undefined ? null : v;
  });
  return db.run(sql, values).lastInsertRowid;
}

/** Names that read like a class list without pretending to be real people. */
const FIRST_NAMES = [
  'Aarav', 'Aditi', 'Ananya', 'Arjun', 'Bhavya', 'Chirag', 'Devika', 'Dhruv',
  'Esha', 'Farhan', 'Gaurav', 'Harshita', 'Ishaan', 'Jaya', 'Kabir', 'Kavya',
  'Lakshay', 'Manvi', 'Neel', 'Nisha', 'Omkar', 'Priya', 'Rahul', 'Riya',
  'Sahil', 'Sanya', 'Tanvi', 'Uday', 'Vihaan', 'Zoya',
];
const LAST_NAMES = [
  'Agarwal', 'Bhatia', 'Chauhan', 'Desai', 'Gupta', 'Iyer', 'Joshi', 'Kapoor',
  'Malhotra', 'Nair', 'Patel', 'Rao', 'Reddy', 'Sharma', 'Singh', 'Verma',
];

function studentName(index) {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${first} ${last}`;
}

/**
 * Creates a class list. Enrollment numbers are unique per college, which is what
 * the schema's partial index requires.
 * @returns {number[]} the new student ids, in order
 */
function addStudents(base, opts) {
  const ids = [];
  for (let i = 0; i < opts.count; i += 1) {
    const serial = String(opts.startSerial + i).padStart(3, '0');
    const enrollment = `${opts.prefix}${serial}`;
    const name = studentName(opts.nameOffset + i);
    ids.push(insert('students', {
      college_id: base.collegeId,
      university_id: base.universityId,
      department_id: opts.departmentId,
      program_id: opts.programId,
      semester_id: opts.semesterId,
      batch_id: opts.batchId,
      section_id: opts.sectionId,
      sub_section_id: opts.subSectionId || null,
      student_code: enrollment,
      enrollment_number: enrollment,
      name,
      email: `${enrollment.toLowerCase()}@${opts.emailDomain}`,
      academic_session: ACADEMIC_SESSION,
      status: 'ACTIVE',
    }));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// College A -- the Section 17 scenario
// ---------------------------------------------------------------------------

/**
 * Five working days, 09:00-16:00, 60-minute periods, lunch 13:00-14:00.
 * Six periods fit exactly, so the timing screen shows no shortfall warning:
 * 09-10, 10-11, 11-12, 12-13, [lunch], 14-15, 15-16.
 */
function seedCollegeA(universityId) {
  const collegeId = insert('colleges', {
    university_id: universityId,
    name: 'College A',
    code: 'CA',
    campus: 'North Campus',
    principal: 'Dr. R. Menon',
    contact_email: 'office@college-a.demo',
    contact_phone: '+91 80 4000 1000',
  });

  const timingId = insert('college_timings', {
    college_id: collegeId,
    name: 'Regular Weekday Timing',
    working_days: '1,2,3,4,5',
    start_time: '09:00',
    end_time: '16:00',
    slot_minutes: 60,
    periods_per_day: 6,
  });
  insert('college_breaks', {
    college_id: collegeId,
    timing_id: timingId,
    kind: 'LUNCH',
    name: 'Lunch',
    start_time: '13:00',
    end_time: '14:00',
  });

  const departmentId = insert('departments', {
    college_id: collegeId,
    name: 'Computer Science and Engineering',
    code: 'CSE',
    hod: 'Dr. S. Kulkarni',
  });

  const programId = insert('programs', {
    college_id: collegeId,
    department_id: departmentId,
    name: 'B.Tech Computer Science and Engineering',
    code: 'BTECH-CSE',
    duration_years: 4,
    semester_count: 8,
  });

  const semesterId = insert('semesters', {
    college_id: collegeId,
    program_id: programId,
    semester_number: 5,
    academic_session: ACADEMIC_SESSION,
    start_date: '2026-07-20',
    end_date: '2026-11-20',
  });

  const batchId = insert('student_batches', {
    college_id: collegeId,
    department_id: departmentId,
    program_id: programId,
    semester_id: semesterId,
    name: 'CSE 2022-26',
    academic_session: ACADEMIC_SESSION,
    student_count: 118,
  });

  // --- Sections and the sub-sections the scenario splits the lab into -------
  const sectionA = insert('sections', {
    college_id: collegeId,
    department_id: departmentId,
    program_id: programId,
    semester_id: semesterId,
    batch_id: batchId,
    name: 'Section A',
    code: 'CSE5A',
    student_count: 58,
  });
  const sectionB = insert('sections', {
    college_id: collegeId,
    department_id: departmentId,
    program_id: programId,
    semester_id: semesterId,
    batch_id: batchId,
    name: 'Section B',
    code: 'CSE5B',
    student_count: 60,
  });
  const subB1 = insert('sub_sections', {
    college_id: collegeId, section_id: sectionB, name: 'B1', code: 'CSE5B1', student_count: 30,
  });
  const subB2 = insert('sub_sections', {
    college_id: collegeId, section_id: sectionB, name: 'B2', code: 'CSE5B2', student_count: 30,
  });

  // --- Rooms: a deliberate mix of AC and Non-AC ------------------------------
  const academicBlock = insert('buildings', {
    college_id: collegeId, name: 'Academic Block A', code: 'AB-A', campus: 'North Campus', floors_count: 2,
  });
  const labBlock = insert('buildings', {
    college_id: collegeId, name: 'Laboratory Block', code: 'LB-A', campus: 'North Campus', floors_count: 1,
  });
  const abGround = insert('floors', {
    college_id: collegeId, building_id: academicBlock, name: 'Ground Floor', level_index: 0,
  });
  const abFirst = insert('floors', {
    college_id: collegeId, building_id: academicBlock, name: 'First Floor', level_index: 1,
  });
  const lbGround = insert('floors', {
    college_id: collegeId, building_id: labBlock, name: 'Ground Floor', level_index: 0,
  });

  const rooms = {};
  const room = (key, row) => { rooms[key] = insert('rooms', { college_id: collegeId, ...row }); };

  room('a101', {
    building_id: academicBlock, floor_id: abGround, name: 'Room A-101', room_number: 'A-101',
    code: 'A101', room_type: 'CLASSROOM', seating_capacity: 70, max_capacity: 78,
    is_ac: 1, has_projector: 1, has_smart_board: 0,
  });
  room('a102', {
    building_id: academicBlock, floor_id: abGround, name: 'Room A-102', room_number: 'A-102',
    code: 'A102', room_type: 'CLASSROOM', seating_capacity: 66, max_capacity: 72,
    is_ac: 0, has_projector: 1,
  });
  // Too small for a 60-student section on purpose: the room comparison card in
  // Section 2 has to have something to reject.
  room('a103', {
    building_id: academicBlock, floor_id: abGround, name: 'Room A-103', room_number: 'A-103',
    code: 'A103', room_type: 'CLASSROOM', seating_capacity: 40, max_capacity: 44,
    is_ac: 1, has_projector: 1, has_smart_board: 1,
  });
  room('a201', {
    building_id: academicBlock, floor_id: abFirst, name: 'Lecture Theatre A-201', room_number: 'A-201',
    code: 'A201', room_type: 'LECTURE_THEATRE', seating_capacity: 120, max_capacity: 140,
    is_ac: 1, has_projector: 1, other_facilities: 'AUDIO_SYSTEM',
  });
  room('a202', {
    building_id: academicBlock, floor_id: abFirst, name: 'Room A-202', room_number: 'A-202',
    code: 'A202', room_type: 'CLASSROOM', seating_capacity: 62, max_capacity: 68,
    is_ac: 1, has_projector: 1,
  });
  room('a203', {
    building_id: academicBlock, floor_id: abFirst, name: 'Tutorial Room A-203', room_number: 'A-203',
    code: 'A203', room_type: 'TUTORIAL_ROOM', seating_capacity: 35, max_capacity: 38,
    is_ac: 0, has_projector: 0,
  });
  // Two AC computer labs, so B1 and B2 can genuinely run at the same time.
  room('cl1', {
    building_id: labBlock, floor_id: lbGround, name: 'Computer Lab 1', room_number: 'CL-1',
    code: 'CL1', room_type: 'COMPUTER_LAB', seating_capacity: 36, max_capacity: 36,
    is_ac: 1, has_projector: 1, has_computers: 1, computer_count: 36,
    lab_equipment: 'Networking rack, patch panel',
  });
  room('cl2', {
    building_id: labBlock, floor_id: lbGround, name: 'Computer Lab 2', room_number: 'CL-2',
    code: 'CL2', room_type: 'COMPUTER_LAB', seating_capacity: 32, max_capacity: 34,
    is_ac: 1, has_projector: 1, has_computers: 1, computer_count: 32,
    lab_equipment: 'Managed switches, cable tester',
  });
  // Non-AC: excluded automatically whenever a course says AC is Required.
  room('cl3', {
    building_id: labBlock, floor_id: lbGround, name: 'Computer Lab 3', room_number: 'CL-3',
    code: 'CL3', room_type: 'COMPUTER_LAB', seating_capacity: 30, max_capacity: 30,
    is_ac: 0, has_projector: 0, has_computers: 1, computer_count: 30,
  });
  room('seminar', {
    building_id: academicBlock, floor_id: abGround, name: 'Seminar Hall A', room_number: 'SH-A',
    code: 'SHA', room_type: 'SEMINAR_HALL', seating_capacity: 80, max_capacity: 90,
    is_ac: 0, has_projector: 1, other_facilities: 'AUDIO_SYSTEM',
  });

  // A real-world blockout, so the constraint has something to catch.
  insert('room_availability', {
    college_id: collegeId, room_id: rooms.cl1, day_of_week: 5,
    start_time: '14:00', end_time: '16:00', kind: 'UNAVAILABLE',
    note: 'Weekly hardware maintenance',
  });

  // --- Faculty: Professor A .. E, exactly as the scenario names them --------
  const faculty = {};
  const prof = (key, row) => {
    faculty[key] = insert('faculty', {
      college_id: collegeId, department_id: departmentId,
      max_weekly_hours: 18, preferred_hours: 14, ...row,
    });
  };

  prof('a', {
    name: 'Professor A', employee_id: 'CA-F001', email: 'prof.a@college-a.demo',
    designation: 'Professor', qualification: 'Ph.D.', specialization: 'Data Structures, Algorithms',
  });
  prof('b', {
    name: 'Professor B', employee_id: 'CA-F002', email: 'prof.b@college-a.demo',
    designation: 'Associate Professor', qualification: 'Ph.D.', specialization: 'Operating Systems',
  });
  prof('c', {
    name: 'Professor C', employee_id: 'CA-F003', email: 'prof.c@college-a.demo',
    designation: 'Associate Professor', qualification: 'Ph.D.', specialization: 'Database Systems',
  });
  prof('d', {
    name: 'Professor D', employee_id: 'CA-F004', email: 'prof.d@college-a.demo',
    designation: 'Assistant Professor', qualification: 'M.Tech', specialization: 'Computer Networks',
    max_weekly_hours: 16, preferred_hours: 12,
  });
  prof('e', {
    name: 'Professor E', employee_id: 'CA-F005', email: 'prof.e@college-a.demo',
    designation: 'Assistant Professor', qualification: 'M.Tech', specialization: 'Computer Networks, Security',
    max_weekly_hours: 16, preferred_hours: 12,
  });

  // Only UNAVAILABLE and PREFERRED are seeded. An AVAILABLE row would turn into
  // a whitelist (see services/constraints.js) and quietly confine the teacher to
  // that window, which is not what a demo dataset should imply.
  insert('faculty_availability', {
    college_id: collegeId, faculty_id: faculty.c, day_of_week: 1,
    start_time: '09:00', end_time: '11:00', kind: 'UNAVAILABLE',
    note: 'Departmental committee',
  });
  insert('faculty_availability', {
    college_id: collegeId, faculty_id: faculty.a, day_of_week: 2,
    start_time: '09:00', end_time: '13:00', kind: 'PREFERRED',
    note: 'Prefers morning classes',
  });
  insert('faculty_availability', {
    college_id: collegeId, faculty_id: faculty.a, day_of_week: 4,
    start_time: '09:00', end_time: '13:00', kind: 'PREFERRED',
  });

  // --- Courses -------------------------------------------------------------
  // section_id is left NULL: these are the semester's courses and apply to both
  // Section A and Section B. The wizard's chosen scope decides which one is
  // being generated, which is exactly what the scenario does with Section B.
  const courses = {};
  const course = (key, row) => {
    courses[key] = insert('courses', {
      college_id: collegeId, department_id: departmentId, program_id: programId,
      semester_id: semesterId, section_id: null, ...row,
    });
  };

  course('ds', {
    name: 'Data Structures', code: 'CS501', credits: 4,
    lecture_hours: 3, tutorial_hours: 1, lab_hours: 0,
    course_type: 'LECTURE', required_room_type: 'CLASSROOM',
    required_facilities: JSON.stringify(['PROJECTOR']),
    ac_requirement: 'REQUIRED',
  });
  course('os', {
    name: 'Operating Systems', code: 'CS502', credits: 3,
    lecture_hours: 3, tutorial_hours: 0, lab_hours: 0,
    course_type: 'LECTURE', required_room_type: 'CLASSROOM',
    required_facilities: JSON.stringify(['PROJECTOR']),
    ac_requirement: 'REQUIRED',
  });
  course('dbms', {
    name: 'Database Management', code: 'CS503', credits: 3,
    lecture_hours: 3, tutorial_hours: 0, lab_hours: 0,
    course_type: 'LECTURE', required_room_type: 'CLASSROOM',
    required_facilities: JSON.stringify([]),
    ac_requirement: 'PREFERRED',
  });
  // The heart of the scenario: two two-period lab blocks a week, each split into
  // B1 and B2, each half needing an AC computer lab with machines.
  //
  // Section 17 lists this course as "Computer Networks (Lab)", so it is lab-only:
  // lecture_hours stays 0. Giving it lecture periods as well would ask the engine
  // to seat all 60 students of Section B in a room of type COMPUTER_LAB, and no
  // such room exists -- correctly, since a lab's room requirements are not the
  // right requirements for a lecture.
  course('cn', {
    name: 'Computer Networks', code: 'CS504', credits: 4,
    lecture_hours: 0, tutorial_hours: 0, lab_hours: 4,
    course_type: 'LABORATORY', required_room_type: 'COMPUTER_LAB',
    required_facilities: JSON.stringify(['COMPUTERS']),
    ac_requirement: 'REQUIRED',
    split_mode: 'SPLIT_SUB_SECTIONS',
    split_components: 'LAB,PRACTICAL',
    lab_block_periods: 2,
  });

  // --- Who may teach what --------------------------------------------------
  const eligible = (facultyId, courseId, isFixed) => insert('faculty_courses', {
    college_id: collegeId, faculty_id: facultyId, course_id: courseId, is_fixed: isFixed ? 1 : 0,
  });

  eligible(faculty.a, courses.ds, true);      // fixed: A always takes Data Structures
  eligible(faculty.b, courses.os, true);
  eligible(faculty.c, courses.dbms, true);
  eligible(faculty.d, courses.cn);            // D and E share the lab, one half each
  eligible(faculty.e, courses.cn);
  // A second eligible name per lecture course, so "Change Teacher" and
  // "Find Alternatives" have something to offer.
  eligible(faculty.b, courses.ds);
  eligible(faculty.c, courses.os);
  eligible(faculty.a, courses.dbms);
  eligible(faculty.d, courses.os);

  // --- Class lists ---------------------------------------------------------
  const base = { collegeId, universityId };
  const shared = {
    departmentId, programId, semesterId, batchId, emailDomain: 'college-a.demo', prefix: '2022CSEA',
  };
  addStudents(base, {
    ...shared, sectionId: sectionA, count: 58, startSerial: 1, nameOffset: 0,
  });
  const b1Students = addStudents(base, {
    ...shared, prefix: '2022CSEB', sectionId: sectionB, subSectionId: subB1,
    count: 30, startSerial: 1, nameOffset: 58,
  });
  addStudents(base, {
    ...shared, prefix: '2022CSEB', sectionId: sectionB, subSectionId: subB2,
    count: 30, startSerial: 31, nameOffset: 88,
  });

  return {
    collegeId, departmentId, programId, semesterId, sectionB, subB1, subB2,
    faculty, courses, rooms,
    facultyForLogin: faculty.a,
    studentForLogin: b1Students[0],
  };
}

// ---------------------------------------------------------------------------
// College B -- deliberately unlike College A
// ---------------------------------------------------------------------------

/**
 * Six working days, 08:30-14:30, 45-minute periods, a short break and a shorter
 * lunch. Seven periods fit exactly:
 * 08:30, 09:15, 10:00, [short 10:45-11:00], 11:00, 11:45, [lunch 12:30-13:00],
 * 13:00, 13:45.
 */
function seedCollegeB(universityId) {
  const collegeId = insert('colleges', {
    university_id: universityId,
    name: 'College B',
    code: 'CB',
    campus: 'City Campus',
    principal: 'Dr. A. Fernandes',
    contact_email: 'office@college-b.demo',
    contact_phone: '+91 80 4000 2000',
  });

  const timingId = insert('college_timings', {
    college_id: collegeId,
    name: 'Six-Day Timing',
    working_days: '1,2,3,4,5,6',
    start_time: '08:30',
    end_time: '14:30',
    slot_minutes: 45,
    periods_per_day: 7,
  });
  insert('college_breaks', {
    college_id: collegeId, timing_id: timingId, kind: 'SHORT', name: 'Tea Break',
    start_time: '10:45', end_time: '11:00',
  });
  insert('college_breaks', {
    college_id: collegeId, timing_id: timingId, kind: 'LUNCH', name: 'Lunch',
    start_time: '12:30', end_time: '13:00',
  });

  // Its own rules too -- Section 13 is configured per college, not per install.
  insert('scheduling_rules', {
    college_id: collegeId, rule_key: 'max_section_periods_per_day', rule_value: '5', enabled: 1,
  });
  insert('scheduling_rules', {
    college_id: collegeId, rule_key: 'avoid_last_period', rule_value: '1', enabled: 1,
  });
  insert('scheduling_rules', {
    college_id: collegeId, rule_key: 'disallowed_slots', rule_value: '6:5,6:6,6:7', enabled: 1,
  });

  const departmentId = insert('departments', {
    college_id: collegeId, name: 'Mechanical Engineering', code: 'MECH', hod: 'Dr. P. Deshpande',
  });
  const programId = insert('programs', {
    college_id: collegeId, department_id: departmentId,
    name: 'B.Tech Mechanical Engineering', code: 'BTECH-MECH',
    duration_years: 4, semester_count: 8,
  });
  const semesterId = insert('semesters', {
    college_id: collegeId, program_id: programId, semester_number: 3,
    academic_session: ACADEMIC_SESSION, start_date: '2026-07-20', end_date: '2026-11-20',
  });
  const batchId = insert('student_batches', {
    college_id: collegeId, department_id: departmentId, program_id: programId,
    semester_id: semesterId, name: 'MECH 2024-28', academic_session: ACADEMIC_SESSION,
    student_count: 45,
  });
  const sectionId = insert('sections', {
    college_id: collegeId, department_id: departmentId, program_id: programId,
    semester_id: semesterId, batch_id: batchId, name: 'Section A', code: 'ME3A',
    student_count: 45,
  });

  const building = insert('buildings', {
    college_id: collegeId, name: 'Main Building', code: 'MB', campus: 'City Campus', floors_count: 2,
  });
  const ground = insert('floors', {
    college_id: collegeId, building_id: building, name: 'Ground Floor', level_index: 0,
  });
  const first = insert('floors', {
    college_id: collegeId, building_id: building, name: 'First Floor', level_index: 1,
  });

  insert('rooms', {
    college_id: collegeId, building_id: building, floor_id: ground,
    name: 'Room B-101', room_number: 'B-101', code: 'B101', room_type: 'CLASSROOM',
    seating_capacity: 50, max_capacity: 55, is_ac: 0, has_projector: 1,
  });
  insert('rooms', {
    college_id: collegeId, building_id: building, floor_id: first,
    name: 'Room B-102', room_number: 'B-102', code: 'B102', room_type: 'CLASSROOM',
    seating_capacity: 50, max_capacity: 54, is_ac: 1, has_projector: 1, has_smart_board: 1,
  });
  insert('rooms', {
    college_id: collegeId, building_id: building, floor_id: ground,
    name: 'Fluid Mechanics Laboratory', room_number: 'B-105', code: 'B105',
    room_type: 'LABORATORY', seating_capacity: 48, max_capacity: 50, is_ac: 0,
    lab_equipment: 'Flow benches, venturi meters, pumps',
  });
  insert('rooms', {
    college_id: collegeId, building_id: building, floor_id: ground,
    name: 'Machine Workshop', room_number: 'B-110', code: 'B110',
    room_type: 'WORKSHOP', seating_capacity: 45, max_capacity: 45, is_ac: 0,
    lab_equipment: 'Lathes, milling machines, welding bays',
  });

  const facP = insert('faculty', {
    college_id: collegeId, department_id: departmentId, name: 'Professor P',
    employee_id: 'CB-F001', email: 'prof.p@college-b.demo', designation: 'Professor',
    specialization: 'Thermodynamics', max_weekly_hours: 18, preferred_hours: 14,
  });
  const facQ = insert('faculty', {
    college_id: collegeId, department_id: departmentId, name: 'Professor Q',
    employee_id: 'CB-F002', email: 'prof.q@college-b.demo', designation: 'Associate Professor',
    specialization: 'Fluid Mechanics', max_weekly_hours: 18, preferred_hours: 14,
  });
  const facR = insert('faculty', {
    college_id: collegeId, department_id: departmentId, name: 'Professor R',
    employee_id: 'CB-F003', email: 'prof.r@college-b.demo', designation: 'Assistant Professor',
    specialization: 'Manufacturing', max_weekly_hours: 16, preferred_hours: 12,
  });

  const thermo = insert('courses', {
    college_id: collegeId, department_id: departmentId, program_id: programId,
    semester_id: semesterId, name: 'Thermodynamics', code: 'ME301', credits: 4,
    lecture_hours: 3, tutorial_hours: 1, lab_hours: 0, course_type: 'LECTURE',
    required_room_type: 'CLASSROOM', ac_requirement: 'PREFERRED',
  });
  const fluids = insert('courses', {
    college_id: collegeId, department_id: departmentId, program_id: programId,
    semester_id: semesterId, name: 'Fluid Mechanics', code: 'ME302', credits: 4,
    lecture_hours: 3, tutorial_hours: 0, lab_hours: 2, course_type: 'LECTURE',
    required_room_type: 'CLASSROOM',
    required_facilities: JSON.stringify(['LAB_EQUIPMENT']),
    ac_requirement: 'NOT_REQUIRED', lab_block_periods: 2,
  });
  const manufacturing = insert('courses', {
    college_id: collegeId, department_id: departmentId, program_id: programId,
    semester_id: semesterId, name: 'Manufacturing Processes', code: 'ME303', credits: 3,
    lecture_hours: 2, tutorial_hours: 0, lab_hours: 2, course_type: 'WORKSHOP',
    required_room_type: 'WORKSHOP',
    required_facilities: JSON.stringify(['LAB_EQUIPMENT']),
    ac_requirement: 'NOT_REQUIRED', lab_block_periods: 2,
  });

  insert('faculty_courses', { college_id: collegeId, faculty_id: facP, course_id: thermo, is_fixed: 1 });
  insert('faculty_courses', { college_id: collegeId, faculty_id: facQ, course_id: fluids, is_fixed: 1 });
  insert('faculty_courses', { college_id: collegeId, faculty_id: facR, course_id: manufacturing, is_fixed: 0 });
  insert('faculty_courses', { college_id: collegeId, faculty_id: facQ, course_id: manufacturing, is_fixed: 0 });

  addStudents({ collegeId, universityId }, {
    departmentId, programId, semesterId, batchId, sectionId,
    prefix: '2024MECHA', emailDomain: 'college-b.demo',
    count: 45, startSerial: 1, nameOffset: 7,
  });

  return { collegeId, departmentId, programId, semesterId, sectionId };
}

// ---------------------------------------------------------------------------
// Logins -- one per role, so Section 12 can be checked by signing in
// ---------------------------------------------------------------------------
function seedUsers(a, b) {
  // One hash, reused: bcrypt is intentionally slow and every demo account shares
  // the same password anyway.
  const hash = hashPassword(DEMO_PASSWORD);
  const accounts = [];

  // The role and the one-line description come from DEMO_ACCOUNTS, so the list
  // the sign-in screen shows cannot drift from the rows actually created.
  const account = (row) => {
    const meta = DEMO_ACCOUNTS.find((x) => x.username === row.username);
    if (!meta) throw new Error(`Demo account ${row.username} is missing from DEMO_ACCOUNTS.`);
    insert('users', {
      password_hash: hash, status: 'ACTIVE', role: meta.role, ...row,
    });
    accounts.push({ ...meta });
  };

  account({
    username: 'superadmin', full_name: 'System Administrator',
    email: 'superadmin@demo.local', college_id: null,
  });

  account({
    username: 'coordinator.a', full_name: 'Timetable Coordinator (College A)',
    email: 'coordinator@college-a.demo', college_id: a.collegeId,
  });

  account({
    username: 'coordinator.b', full_name: 'Timetable Coordinator (College B)',
    email: 'coordinator@college-b.demo', college_id: b.collegeId,
  });

  account({
    username: 'prof.a', full_name: 'Professor A',
    email: 'prof.a@college-a.demo', college_id: a.collegeId, faculty_id: a.facultyForLogin,
    can_edit_own_availability: 1,
  });

  account({
    username: 'student.b1', full_name: 'Student (College A, Section B / B1)',
    email: 'student.b1@college-a.demo', college_id: a.collegeId, student_id: a.studentForLogin,
    can_edit_own_availability: 0,
  });

  return accounts;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Loads the demo dataset. Called once, on a database that has never been seeded.
 * Everything happens in a single transaction: a half-seeded database would be
 * worse than an empty one.
 *
 * @returns {{seeded:true, message:string, accounts:Array, counts:object}}
 */
function seedDemoData() {
  if (settings.getBool('seeded')) {
    return {
      seeded: false,
      message: 'The demo data has already been loaded, so nothing was added.',
      accounts: [],
      counts: {},
    };
  }

  const result = db.transaction(() => {
    const universityId = insert('universities', {
      name: 'Demo Technical University',
      code: 'DTU-DEMO',
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India',
      contact_name: 'Registrar',
      contact_email: 'registrar@demo.local',
    });

    const a = seedCollegeA(universityId);
    const b = seedCollegeB(universityId);
    const accounts = seedUsers(a, b);

    settings.setSetting('institution_name', 'Demo Technical University');
    settings.setSetting('academic_session', ACADEMIC_SESSION);
    settings.setSetting('term_start_date', '2026-07-20');
    settings.setSetting('term_weeks', '16');
    settings.setSetting('seeded', '1');

    return { accounts };
  });

  const counts = {};
  for (const table of ['colleges', 'departments', 'programs', 'semesters', 'sections',
    'sub_sections', 'students', 'faculty', 'courses', 'rooms', 'users']) {
    counts[table] = db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
  }

  return {
    seeded: true,
    accounts: result.accounts,
    counts,
    password: DEMO_PASSWORD,
    message: `Demo data loaded: ${counts.colleges} colleges, ${counts.courses} courses, `
      + `${counts.rooms} rooms, ${counts.students} students. `
      + `Sign in as any of ${result.accounts.map((x) => x.username).join(', ')} `
      + `with the password "${DEMO_PASSWORD}". `
      + 'No timetable has been generated -- that is the first thing to try.',
  };
}

module.exports = {
  seedDemoData, demoAccounts, DEMO_PASSWORD, DEMO_ACCOUNTS, ACADEMIC_SESSION,
};
