# Decisions

Section 0 of the specification asks for clarification only on genuinely blocking
ambiguities and otherwise for reasonable implementation decisions, noted. This is
that note. Each entry says what was decided, and — more usefully — *why*, so a
future change can be made with the original reasoning in view.

Two questions were put to the user because they change the shape of the product:

| Question | Answer |
| --- | --- |
| Single-machine or LAN-shared database (§15)? | **Both** — local by default, LAN as an opt-in toggle. |
| Ship a demo dataset? | **Yes** — College A + College B, with a "Reset to empty" action. |

Everything below was decided here.

---

## Architecture

### An Express server inside Electron, not direct database calls from the window

The renderer never touches SQLite. It talks HTTP to a local Express app, which
the Electron main process starts on a loopback port.

This costs one hop and buys three things. First, §12's role scoping — *"all
queries and mutations must be scoped server-side by `college_id` … UI hiding of
controls is not sufficient on its own"* — has exactly one place to live, and no
code path can skip it. Second, the LAN toggle becomes a change of address rather
than a change of architecture: a client machine points `apiBase` at the host and
every screen works unmodified. Third, the whole backend is testable without
Electron, which is why `npm test` runs 87 assertions in a plain Node process.

### `node-sqlite3-wasm` is the SQLite driver

`better-sqlite3` is faster and is used automatically if it happens to be
installed, but it is a native module: it needs a C++ toolchain to install and has
to be rebuilt against every Electron version. For a single-`.exe` deliverable
that is a recurring failure that surfaces on the user's machine, not ours.
`node-sqlite3-wasm` is pure WebAssembly — no toolchain, no rebuild, no ABI to
mismatch.

It loads its `.wasm` binary with `fs.readFileSync`, which cannot read inside an
asar archive, so `electron-builder.yml` unpacks that one package:

```yaml
asarUnpack:
  - '**/node_modules/node-sqlite3-wasm/**'
```

### `HashRouter`, not `BrowserRouter`

The packaged application loads `index.html` over `file://`, where a path-based
router's URLs resolve to files that do not exist. Hash routing works identically
from `file://` and from a LAN client's `http://`, so there is one build.

### An entity registry as the single source of truth

`src/server/services/entityRegistry.js` describes all 19 entity types — fields,
types, labels, enums, relationships, required-ness. From it come the CRUD routes,
the generic UI forms, the Excel templates and their header validation, global
search, and the readiness dashboard's checks.

The alternative — 19 hand-written route files and 19 hand-written forms — makes
§1's "nothing is hardcoded" promise a maintenance claim rather than a structural
fact. Adding a field to an entity should not require editing seven files, and
here it does not.

### Enums live in the registry, not a shared constants module

There is no `src/shared/enums.js`. Enum values are declared beside the field that
uses them, so the value list, the label and the validation cannot drift apart.

---

## Timing and the period grid

### Everything is derived from College Timing Configuration

§4 requires that no timing is hardcoded, so there is no constant anywhere for
period length, start time, number of periods, or working days. The grid is
computed from `college_timings` + `college_breaks` into one canonical shape:

```js
{ workingDays, slots: [{ index, start, end }], breaks, warnings, slotMinutes, timingId }
```

`workingDays` is the canonical day list; every view, export and validator reads
it rather than assuming Monday–Saturday.

### A multi-period block never crosses a break

A two-period lab either fits entirely before a break or entirely after it. This
was chosen because the alternative — a block that spans a break — is not a class
anyone actually teaches, and it also means the grid's `colSpan` arithmetic needs
no break-column correction.

### "Hours per week" means periods per week

Course plans are expressed in periods, because a period's length is a per-college
setting. A course needing "4 hours" of theory in a college with 50-minute periods
would otherwise silently mean something different from the same course in a
college with 60-minute ones.

### A section's daily load counts distinct occupied periods

When sub-sections B1 and B2 run parallel labs in period 3, the section has used
*one* period, not two. Counting assignments instead of occupied periods would
make every split lab look like an overload and would fight §3's whole purpose.

### Blank `courses.student_strength` means "use the section's count"

An empty field is not invalid data (§5's `AUTO` principle applied to a place
outside the wizard); it means the course is taken by the whole section, so
capacity checks should follow the section as its enrolment changes.

---

## Scheduling semantics

### Availability: `UNAVAILABLE` blocks, `AVAILABLE` whitelists, `PREFERRED` nudges

Given a mixture of records for one teacher, `UNAVAILABLE` is a hard block.
`AVAILABLE` is treated as a **whitelist**: if a teacher has recorded any
`AVAILABLE` window at all, they are considered unavailable everywhere else. If
they have recorded none, they are available by default.

The whitelist reading is the one that matches how people actually fill the form —
a visiting lecturer who writes down "Tuesdays and Thursdays" means *only* those,
not "those, plus everything I did not mention". `PREFERRED` never blocks
anything; it only adds score, so a preference can never make a timetable
infeasible.

### Hard conflicts are refused, then overridable

A coordinator is the authority (§8), but authority is not the same as being
unaware. A hard conflict returns `409` with `canOverride: true` and an
`overrideHint`, and the UI turns that into an explicit "Override and place"
button. So the answer is never a silent yes and never a flat no.

### Locked assignments are never moved by re-generation

`keepLocked` defaults to `true` on every generation run. §8 says locked means
locked; a default of `false` would make the flagship Hybrid mode quietly
destructive.

### Publishing takes a snapshot; so does clearing

Both are automatic (`Published <name>`, `Before clearing`). The moment worth
being able to return to is the moment just before something irreversible, and
asking the user to remember to snapshot first means they will remember once.

---

## Data import and export (§10)

### Templates identify references by human code or name, not database id

A blank Rooms template asks for a building *name* and a room *type*, not
`building_id: 7`. Nobody filling in a spreadsheet knows the id, and ids differ
between two installations, so an id-based template cannot be prepared on one
machine and imported on another.

### Templates are versioned, and headers are validated before anything is written

An import runs entirely as a validation pass first and reports per-row problems,
duplicates and unresolvable references. Only then is a commit offered. A partial
import — 400 good rows in, 12 bad rows rejected, no record of which — is worse
than no import, because the user cannot tell what to fix.

### CSV is the fallback when `exceljs` is unavailable

`exceljs` is a dependency, but if it fails to load the export still produces
usable CSV rather than an error. A coordinator who needs the data out today
should not be blocked by a packaging problem.

### Excel sheet names are sanitised

Entity labels can contain `/` (as in "AC / Non-AC"), which Excel forbids in a
sheet name.

### Uploads travel as base64 inside JSON

One request shape for every upload, no multipart parser, and it works identically
through the Electron bridge and through a browser on the LAN. The body limit is
32 MB with a 12 MB cap on an import file — comfortably more than a spreadsheet of
a university's rooms, and small enough that a mistaken upload fails fast.

### PDF export returns print-ready HTML

The server produces HTML; Electron's `printToPDF` renders it. Adding a PDF
library would mean re-implementing table layout that Chromium already does
better, and in a browser tab the same HTML goes to the print dialog.

### iCal uses floating local times

No timezone is attached, so an exported calendar imports as the wall-clock times
the college actually teaches at, wherever the person opening it happens to be.

---

## Security and privacy (§14.1, §12)

### The OpenAI key is stored only if the operating system can encrypt it

The key goes through Electron's `safeStorage` (Windows DPAPI). If encryption is
unavailable, storage is **refused** — there is deliberately no plain-text
fallback, because a fallback that works is the one that ships. No route ever
returns the key; the most any screen sees is `sk-...1234`.

### Privacy mode is on by default

Student names and IDs are stripped from timetable context before a question
leaves the machine, and the context is trimmed to a configurable number of
classes. Requests go only to `api.openai.com` over HTTPS — OpenAI is the sole
provider, per §14.

### CORS is `*`, and that is safe here

Every mutating route requires a bearer token, and outside `HOST` mode the server
binds to loopback only, so there is no browser origin that could reach it
without one. In `HOST` mode a permissive origin is what allows a colleague's
browser on the LAN to be a client at all.

### Sessions are HMAC-SHA256 bearer tokens with a 12-hour TTL

No session table to keep in sync, and no cookie, which matters because the same
token is used from `file://`, from `http://localhost` and from a LAN address.
Passwords are bcrypt.

### `/health` lists the demo accounts only while their rows exist

It is how a new user finds the seeded logins. After "Reset to empty" those rows
are gone and the endpoint stops naming them, so a real installation does not
advertise credentials.

---

## Roles

### Stored as `COLLEGE_ADMIN`, displayed as "Timetable Coordinator"

§12's four roles are `SUPER_ADMIN`, `COLLEGE_ADMIN`, `FACULTY`, `STUDENT`. The
label is a display concern (`ROLE_LABELS` in `src/renderer/lib/format.js`); the
stored value is the conventional one, so an administrator reading the database
directly is not surprised.

---

## Installation and networking (§15)

### Local by default, LAN opt-in, restart to apply

Three modes: `LOCAL` (own database, nothing listens on the network), `HOST`
(shares this machine's database) and `CLIENT` (uses another machine's). Only the
Super Admin can change it, because it changes the installation for everyone.

### `installation.json` exists outside the database

Network mode is stored *in* the database — but a `CLIENT` machine never opens a
database of its own, so it cannot read its own mode from one. A small file beside
the application data holds enough to know where to connect before anything else
starts.

### Backup is a file copy, and restore takes a safety copy first

A checkpoint, then `copyFileSync`. Nothing about SQLite makes this need to be
cleverer, and a single self-contained file is what a person can actually put on
a USB stick. Restore copies the database it is about to replace, so an
accidental restore is recoverable. Restore also refuses a file that is not a
SQLite database of ours, and warns — before touching anything — when the schema
version differs.

### "Reset to empty" keeps the acting user

It requires the Super Admin, a typed `DELETE EVERYTHING`, and an automatic backup.
The account performing it survives, because a machine that has locked out its own
administrator needs a reinstall.

### Licensing and activation are left open

§15 mentions them without specifying a scheme. Nothing here phones home, and
there is no activation gate, so adding one later is additive rather than a
change to how the application starts.

### The database records who holds it, because the driver's lock does not

`node-sqlite3-wasm` cannot use the operating system's file locks from inside
WebAssembly, so it locks by creating a *directory* beside the database:

```js
lock:   fs.mkdirSync(`${file}.lock`)    // EEXIST means "someone else has it"
unlock: fs.rmdirSync(`${file}.lock`)
```

The existence of that directory is the entire lock, and it records nothing about
who made it. So a process that dies without unlocking — a crash, End Task, a
power cut, or the installer stopping a running copy in order to replace it —
leaves it behind, and **every later start fails with "database is locked", for
ever**, with no way out but deleting a folder the user has no reason to know
about. A busy timeout cannot help: nothing is ever going to release it.

So the missing half of the lock is written here. While the database is open there
is a `timetable.db.owner` file naming the process and machine that opened it,
removed on close. On meeting a lock, the two situations can then be told apart:

| What is found | What happens |
| --- | --- |
| No owner file | Debris. Cleared, and the reason is logged. |
| Owner names a process that is not running | Debris. Cleared, naming the pid. |
| Owner names a process that *is* running | Left alone. Reported as `DATABASE_IN_USE`, naming the other copy. |
| Owner names a different machine (shared folder) | Left alone. Not ours to clear. |

The lock directory is also required to be empty before it is removed, because the
driver only ever creates it empty — anything inside was put there by something
else, and deleting other people's files is not this code's job.

### Quitting is held back until the backend is actually down

Electron does not wait for an `async` `before-quit` listener; it exits while the
listener is still running. The old handler was `async () => { await
serverControl.stop(); }`, so the process died before `closeDatabase()` ran and a
**normal quit leaked the lock** — which is how the failure above was first hit,
rather than by any crash. `before-quit` now calls `event.preventDefault()`, waits
for one shared shutdown promise, and quits again when it resolves.

Three related leaks were found by following that through:

- `server.close()` waits for every keep-alive socket the window is holding, which
  can take many seconds. An application that appears to hang on quit gets killed
  — and being killed is precisely what leaks the lock. Connections are now
  dropped explicitly and there is a two-second deadline regardless.
- Settings → restart used `app.exit()`, which skips `before-quit` altogether, so
  restarting to apply a network-mode change leaked the lock every single time. It
  goes through `app.quit()` now.
- `SIGINT` / `SIGTERM` / `SIGHUP` route into the same quit, and
  `process.on('exit')` closes the database synchronously as a last resort, which
  an async handler cannot be relied on to do.

None of that can help a process that is killed outright, which is why the
recovery above exists as well. Belt and braces: the leak is fixed *and* survivable.

---

## Packaging the installer

### The Windows tool cache is prepared before electron-builder runs

`npm run dist` starts with `tools/prepare-win-build.js`. electron-builder needs
`rcedit-x64.exe` to stamp the icon and version strings onto the `.exe`, and
`rcedit` ships inside a package called winCodeSign — which is fetched *whether or
not anything is code-signed*, because `app-builder rcedit` is what reaches for
it. That archive also carries the macOS toolchain, whose files are symlinks, and
creating a symlink on Windows needs Developer Mode or an elevated shell. On an
ordinary account the extraction fails with `Cannot create symbolic link : A
required privilege is not held by the client`, and the build dies before it has
built anything.

So the prepare step fetches the same archive and unpacks it without the `darwin`
folder, into the exact directory electron-builder looks in
(`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`).
electron-builder then finds a populated cache and extracts nothing. It is a
no-op on a second run, a no-op on non-Windows, and on failure it warns and
removes what it half-wrote rather than failing the build — a machine with
Developer Mode enabled succeeds the ordinary way regardless.

### The application icon is generated, not committed as a binary

`tools/make-icon.js` draws `build/icon.ico` with no image library and no
toolchain: PNG encoding is `zlib.deflateSync` plus a CRC, and an `.ico` file is a
short table of PNGs (Windows has read PNG entries since Vista). The whole design
is the twenty lines of `paint()`.

The reason is reviewability. A committed `.ico` is opaque in a diff and can only
be changed by whoever has the original artwork; a generated one can be read,
reasoned about and edited by anyone with the repository. It also keeps §16's
"very simple, clean, minimal" honest — the icon is a rounded indigo square, a
grid, and exactly one amber cell, because at 16×16 nothing else survives.

### The packaged build is verified through Electron's Node mode

`npm run test:packaged` runs the backend **out of `resources/app.asar`, using the
packaged Electron binary** (`ELECTRON_RUN_AS_NODE=1 <exe> -e "<script>"`), whose
`require` sees through the archive. It signs in, generates a real timetable,
exports an Excel file and checks all four roles, with the working directory set
to the system temp folder so nothing may quietly depend on being run from the
project.

This exists because passing tests on the source tree prove nothing about the
artifact. A file left out of `electron-builder.yml`, a static path resolved
relative to `cwd`, a module that needed `asarUnpack` — each is invisible until
something reads the archive. Driving a GUI would be better still, but a desktop
window cannot be opened from a headless shell; the backend, the archive and the
served interface are everything below the window, and this covers them.

---

## Testing

### The interface's endpoints are checked against the router, statically

`test/api-contract.js` reads every literal path the renderer passes to `api.get`,
`api.post` and friends, and asks the real Express router whether that method and
path would match a route. It sends no requests, so it creates and changes
nothing.

It exists because of a bug that all three suites missed. The renderer asked for
`/api/dashboard`; the server serves it at `/api/meta/dashboard`. Six calls were
written without the `/meta` prefix — the dashboard, global search, the entity
registry, the setup progress counts, the readiness gate and every dropdown's
options — and the first person to find out was a user looking at *"No API
endpoint matches GET /api/dashboard"*.

Nothing caught it because of a gap that is easy to miss: the acceptance tests
call the API with paths they write themselves, so they prove the server is right,
never that the interface agrees with it. The renderer's own JavaScript is never
executed by any suite. A static contract check is the cheap half of that gap —
it cannot verify a response *shape*, but it does make a wrong address impossible
to commit.

Two details it has to get right. It looks only inside the `/api` router, because
the application also serves the interface and that ends in a catch-all which
answers any GET with `index.html` — consult the whole app and every wrong path
looks fine. And a segment written as `${…}` could be anything at run time, so it
is tried as an id first and then as each path name the server itself declares:
`/timetable/assignments/${id}/${action}` is a real endpoint when `action` is
`move`, and nothing at all when it is `mvoe`.


- `db.get()` returns `null` when there is no row (not `undefined`), so callers
  can use `??` without ambiguity between "no row" and "column was null".
- `PUT` is treated as a partial update throughout. A generic form that sends only
  the fields it rendered must not blank the ones it did not.
- An empty field in the Generation Wizard means `AUTO`, never invalid — §5's rule,
  implemented as one predicate (`isAuto`) used by every field.
- Large source files are written with the editor's Write tool rather than shell
  heredocs: on Windows the whole command string, heredoc body included, goes
  through the process command line, which has a hard length limit.
