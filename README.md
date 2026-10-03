# University Timetable Management

An offline-first Windows desktop application for university timetabling. You
provide the university's data, define your own college's timing rules, and tell
the system what to keep fixed — the scheduler works out everything else, and the
Timetable Coordinator (for their own college) or the Super Admin (for all of
them) keeps complete authority to create, edit, move, replace, lock or cancel any
assignment by hand.

Everything except the AI Assistant works with **no internet connection at all**.

---

## Run it now (development)

You need Node.js 18 or newer. From the project folder:

```bash
npm install
npm start
```

`npm start` compiles the interface and opens the desktop application. The first
run creates the database, applies the schema and loads the demo colleges, which
takes a second or two.

For live-reloading while editing the interface, use `npm run dev` instead — Vite
serves the renderer on port 5173 and Electron loads from there.

### Sign in

The first run seeds two colleges and five accounts. **The password for all of
them is `demo1234`.**

| Username | Role | What it shows |
| --- | --- | --- |
| `coordinator.a` | Timetable Coordinator | College A only — College B does not exist as far as this login is concerned |
| `coordinator.b` | Timetable Coordinator | College B only |
| `superadmin` | Super Admin | Every college, with a switcher in the sidebar |
| `prof.a` | Faculty | Professor A's own week, read-only |
| `student.b1` | Student | One section's timetable, read-only |

The login screen lists these accounts while they exist. Once you delete them, or
use **Settings → Backup & restore → Reset to empty**, it stops naming them and the
application is yours.

### A ten-minute tour

1. Sign in as **`coordinator.a`**. The dashboard opens directly into College A.
2. **Generate** → the six-step wizard. The scope is already valid, so pick
   Department *CSE* → *B.Tech CSE* → *Semester 5* → *Section B*, tick the four
   courses, and leave everything else alone: rooms, teachers and times all say
   *Auto*. Step 6 previews what will be scheduled; run it, and read the Quality
   Score and the "engine decided" list on the results panel.
3. Set **Computer Networks (Lab)** to split into sub-sections B1 / B2 in step 2,
   give B1 and B2 different teachers in step 3, and generate again — the two
   halves share one slot with different teachers *and* different rooms, and roll
   up into the section, faculty and room views.
4. Open any class card in **Views** and try Move, Change Teacher, Change Room,
   Find Alternatives, Lock and Cancel. Every one re-validates live and refuses a
   hard conflict — with an explicit override if you insist.
5. In **Timetables**, publish it. Note the automatic snapshot, then restore it.
6. Sign out and sign in as **`prof.a`**, then **`student.b1`**. Neither has a
   single edit control, and neither can reach another section's week even by
   typing the URL.

### Try the empty path too

**Settings → Backup & restore → Reset to empty** (as `superadmin`, typing
`DELETE EVERYTHING`) leaves a bare installation. **Data Management** then shows
the setup progress bar, and **Generate** refuses with a list of exactly what is
missing and a link to each screen — which is the flow a real college starts from.

---

## Build the installer

```bash
npm run dist
```

This produces a single Windows installer:

```
release/UniversityTimetableManagement-Setup-1.0.0.exe     (~85 MB)
```

It installs per-user (no administrator rights needed), lets the user choose the
install folder, and creates Desktop and Start Menu shortcuts. Uninstalling leaves
the data folder alone, so reinstalling does not lose a college's timetables.

The build does three things first: prepares electron-builder's Windows tool cache
(`npm run prepare:win` — see below), draws the application icon
(`npm run icon` → `build/icon.ico`), and compiles the interface.

`npm run pack:dir` builds the unpacked folder only — faster, and enough to check
the packaged application without waiting for NSIS.

### Check the packaged build

```bash
npm run test:packaged
```

Runs the backend **out of the built `app.asar`, using the packaged Electron
binary**, and drives it through sign-in, a real generation run, an Excel export
and the role checks. This is what catches the packaging-only failures: a file
that was never listed in `electron-builder.yml`, a path that resolved relative to
the working directory, a module that needed to stay unpacked.

### If the build stops on "Cannot create symbolic link"

electron-builder needs `rcedit.exe` from a package called winCodeSign to stamp
the icon and version onto the `.exe`. That archive also contains the macOS tools,
which are symlinks, and Windows refuses to create symlinks without Developer Mode
or an elevated shell — so the extraction fails and the build dies before it
starts.

`npm run prepare:win` runs automatically as the first step of `npm run dist` and
avoids this by unpacking that archive itself without the macOS folder. If it is
ever unable to (no network, a newer tool version), enable **Windows Developer
Mode** or run the build from an elevated terminal.

### Where the installed application keeps its data

```
%APPDATA%\University Timetable Management\
  timetable.db          the database
  backups\              every backup written from Settings
  installation.json     local / LAN mode, read before the database opens
  application.log       startup and backend messages
```

Deleting that folder gives you a first run again, demo data and all.

### If it ever says "database is locked"

It should not any more, and if it does the application clears the obstruction
itself and opens. The full story is in
[DECISIONS.md](DECISIONS.md#the-database-records-who-holds-it-because-the-drivers-lock-does-not);
the short version is that the SQLite driver locks by creating a folder called
`timetable.db.lock`, and a copy of the application that was killed rather than
closed used to leave it behind for ever.

Two things worth knowing if you see that message anyway:

- **"already in use by another copy"** is a different message and means what it
  says — another window, or another machine using this one as its host, has the
  database open. It names the process. Close it.
- If the application still refuses to open, delete the `timetable.db.lock`
  **folder** from the data folder above. Nothing is lost by doing so: it is empty,
  and it is not part of the database. `application.log` in the same folder records
  what happened.

---

## Where things are

```
src/main/          Electron: window, menu, backend lifecycle, file dialogs
src/server/        Express + SQLite: the whole backend
  routes/          HTTP surface, one file per area
  services/        scheduling engine, entity registry, imports, exports, AI
  db/              schema, migrations, seed data
src/renderer/      React interface (Vite)
  pages/           one file per screen
  components/      shared UI vocabulary, timetable grid, card actions
test/              run-tests.js (backend), smoke-app.js (whole stack),
                   verify-packaged.js (the built .asar)
tools/             icon generator, Windows build-cache preparation
```

The renderer never touches SQLite; it talks HTTP to the local backend. That is
what makes §12's role scoping enforceable in one place and what makes the LAN
mode a change of address rather than a change of architecture. See
[DECISIONS.md](DECISIONS.md) for this and the other implementation decisions.

### Tests

```bash
npm test              # 97 assertions, backend only, no Electron and no display
npm run test:app      # 46 assertions, the built interface + backend over HTTP
npm run test:packaged # 23 assertions, the same backend running out of app.asar
```

`npm test` runs against a temporary database in a plain Node process and covers
first run and sign-in, per-college timing, the readiness gate, generation, the
constraint checklist, parallel sub-sections, card actions and versions, exports,
all four roles, the Assistant when unconfigured, import templates, and backup /
reset. It also proves the database recovers from a lock left behind by a process
that is gone and refuses one that is genuinely held, and it reads the interface's
source to check that every endpoint it calls exists on the server — see
[DECISIONS.md](DECISIONS.md#testing) for why that last one is a separate check.
reset. It also reads the interface's source and checks that every endpoint it
calls exists on the server — see [DECISIONS.md](DECISIONS.md#testing) for why
that is a separate check.

`npm run test:app` builds the renderer, serves it from the real backend, and
walks the Section 17 acceptance scenario end to end — including a live generation
run — then checks that Faculty and Student get read-only views and that College
B's coordinator cannot reach College A's timetable.

`npm run test:packaged` needs `npm run dist` (or `npm run pack:dir`) to have run.

---

## Sharing over a LAN (optional)

The default is a single machine: the database lives in that machine's application
data folder and nothing listens on the network.

To share it, on the machine that will hold the data, sign in as the Super Admin
and open **Settings → Sharing & network → Share this machine's database over the
LAN**. Restart it. That screen then lists the addresses to hand out, e.g.
`http://192.168.1.24:4713`.

On each other machine, install the same application and choose **Use another
machine as the host**, entering that address. Test it, save, restart.

Two things to know. The host must stay switched on while others are using it, and
backups are only meaningful *on the host* — a client machine stores nothing of its
own.

---

## The AI Assistant (optional)

The Assistant is the one feature that needs the internet, and it needs your own
OpenAI API key. Add it in **Settings → AI Assistant**.

The key is encrypted by Windows' own credential protection and never leaves the
machine except to `api.openai.com` over HTTPS. It is never written to a
configuration file — if the operating system cannot encrypt it, the application
**refuses to store it** rather than falling back to plain text. Nothing on this
screen ever shows the key again; the most you see is `sk-...1234`.

Privacy mode is on by default: student names and IDs are stripped from any
timetable context before a question is sent, and the context is trimmed to a
fixed number of classes so a large college does not send its whole week to a
third party.

Every other feature works with the Assistant switched off.

---

## Backups

**Settings → Backup & restore → Back up now** writes one self-contained file. Copy
it somewhere other than this machine — a backup that only exists on the machine
that failed is not a backup.

Restoring saves a copy of the database it replaces first, refuses a file that is
not one of ours, and warns before touching anything if the backup came from a
different schema version.
