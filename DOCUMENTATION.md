# Complete Project Documentation: University Timetable Management

## 1. Project Overview (What is the project?)

**University Timetable Management** is an offline-first Windows desktop application designed to solve the complex problem of university timetabling. It acts as a comprehensive data management, constraint solving, and AI-assisted scheduling system.

### Key Features:
- **Hybrid AI-Assisted Scheduling**: The system auto-generates timetables while strictly adhering to university rules (faculty availability, room capacities, period structures). It leaves ultimate authority to the user to lock, swap, or override assignments manually.
- **Offline-First**: All core scheduling, database management, and UI operations work entirely offline. The only feature requiring internet is the optional AI Assistant.
- **Multi-Tenant Architecture**: Supports multiple colleges under one university, isolating data so a Timetable Coordinator for College A cannot interfere with College B.
- **Export & Import Capabilities**: Full support for importing data via templates and exporting timetables to Excel, CSV, PDF, and iCal formats.

---

## 2. Architecture & How it Works

The application follows a modern desktop architecture separating the frontend, backend, and database within a single distributable bundle.

### Tech Stack
- **Frontend**: React.js built with Vite, utilizing hash routing (`HashRouter`) to ensure smooth internal navigation within the desktop app environment.
- **Backend**: An Express.js server bundled inside the application. The React frontend never touches the database directly; it makes HTTP calls to the local Express server.
- **Database**: SQLite using `node-sqlite3-wasm`. This is a pure WebAssembly driver that ensures cross-platform reliability without requiring a native C++ build step.
- **Desktop Container**: Electron.js, which manages the application window, file dialogs, background lifecycle, and Windows installer generation (via `electron-builder`).

### Data Flow
1. **Electron Main Process** launches and starts the local **Express Backend** on a loopback port.
2. The **React UI** loads and communicates with the backend via RESTful APIs.
3. The **Entity Registry** serves as the single source of truth for all 19 entity types (rooms, faculty, sections, etc.), automatically handling validation, CRUD routes, and Excel templates.
4. Data is persisted to a local `timetable.db` SQLite database stored in `%APPDATA%\University Timetable Management\`.

---

## 3. Getting Started & Sample Details

### Running the Application
Ensure you have **Node.js 18 or newer** installed.
```bash
# Install dependencies
npm install

# Start the application in development mode
npm start
```
For live-reloading during UI development, run `npm run dev` instead.

### Sample Details & Pre-Seeded Accounts
On its first run, the system automatically creates a schema and loads demo data (College A and College B). You can use these pre-seeded accounts to explore the system. **The password for all accounts is `demo1234`.**

| Username | Role | Scope & Permissions |
| --- | --- | --- |
| `superadmin` | **Super Admin** | Complete access to every college. Can switch colleges via sidebar and manage LAN sharing. |
| `coordinator.a` | **Timetable Coordinator** | Full authority over College A. College B is entirely invisible. |
| `coordinator.b` | **Timetable Coordinator** | Full authority over College B. |
| `prof.a` | **Faculty** | Read-only view of Professor A's specific weekly timetable. |
| `student.b1` | **Student** | Read-only view of Section B1's specific weekly timetable. |

*To clear this sample data and start fresh, log in as `superadmin` and navigate to **Settings → Backup & restore → Reset to empty**.*

---

## 4. Complete Testing Guide

The project includes an extensive, multi-layered testing strategy to guarantee reliability.

### 1. Backend API & Logic Tests (Fastest)
Tests the backend engine without launching Electron or the display. It covers constraints, parallel sections, entity validations, and database locking.
```bash
npm test
```

### 2. Full-Stack Integration Tests
Builds the React frontend and runs an end-to-end acceptance scenario testing the UI interacting with the real backend.
```bash
npm run test:app
```

### 3. Packaged Build Tests
Tests the fully compiled `.asar` artifact to ensure nothing broke during the packaging process (e.g., missing static files or symlink issues). **Note: You must build the app first.**
```bash
# Build the application
npm run dist  # (or npm run pack:dir)

# Run packaged tests
npm run test:packaged
```

---

## 5. Detailed Workflows (How to Use)

### Generating a Timetable
1. Log in as `coordinator.a`.
2. Navigate to **Generate**. This opens a 6-step wizard.
3. Select your Target (e.g., *Department CSE* → *B.Tech CSE* → *Semester 5* → *Section B*).
4. Let the system auto-assign Rooms, Teachers, and Times.
5. In Step 6, review the **Quality Score** and run the generator.

### Manual Refinement (The Hybrid Approach)
The AI handles the heavy lifting, but the user remains the authority.
- Go to **Views** and open any class card.
- You can manually use **Move, Change Teacher, Change Room, Find Alternatives, Lock,** or **Cancel**.
- **Conflict Resolution**: If you attempt to double-book a teacher, the system will warn you of a hard conflict but provide an **Override** option if you wish to force the placement.

### Publishing & Backups
- **Publishing**: When satisfied, publish the timetable. The system automatically creates a snapshot so you can safely revert if necessary.
- **Backups**: Navigate to **Settings → Backup & restore** to download a `.db` file containing the entire state. Restoring from a backup will automatically create a safety copy of the overwritten data first.

---

## 6. Advanced Configuration

### Sharing over a LAN
By default, the database is localized to a single machine. To allow multiple users on the same network to collaborate:
1. On the main computer, log in as `superadmin`.
2. Go to **Settings → Sharing & network → Share this machine's database over the LAN**.
3. Restart the application. It will provide a local IP address (e.g., `http://192.168.1.24:4713`).
4. On client computers, select **Use another machine as the host** and enter this URL.

### AI Assistant
The natural language AI Assistant requires an OpenAI API Key.
1. Navigate to **Settings → AI Assistant**.
2. Enter your OpenAI key. It is securely encrypted using Windows DPAPI and never saved in plain text.
3. **Privacy Mode** ensures student IDs and names are scrubbed before sending contextual scheduling data to the AI.
