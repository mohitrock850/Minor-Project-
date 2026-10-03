import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './lib/auth.jsx';
import AppShell from './components/AppShell.jsx';
import { Loading, EmptyState } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import DataHub from './pages/DataHub.jsx';
import EntityList from './pages/EntityList.jsx';
import TimingConfig from './pages/TimingConfig.jsx';
import Rules from './pages/Rules.jsx';
import ImportExport from './pages/ImportExport.jsx';
import GenerateWizard from './pages/GenerateWizard.jsx';
import ManualBuilder from './pages/ManualBuilder.jsx';
import Views from './pages/Views.jsx';
import Timetables from './pages/Timetables.jsx';
import Availability from './pages/Availability.jsx';
import Settings from './pages/Settings.jsx';
import Assistant from './pages/Assistant.jsx';
import Help from './pages/Help.jsx';

/**
 * Routes.
 *
 * Each guard below decides what to *draw*. The server independently refuses
 * anything the signed-in user may not do, so a guessed URL cannot reveal another
 * college's data even if a guard here were wrong.
 */

function Guard({ allowed, children, why }) {
  if (allowed) return children;
  return (
    <main className="page">
      <EmptyState icon="⛔" title="That page is not part of your account">
        {why || 'If you think you should have access to it, ask your Super Admin.'}
      </EmptyState>
    </main>
  );
}

export default function App() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'checking') return <Loading label="Signing you in…" />;

  if (auth.status !== 'signedIn') {
    // Everything funnels to sign-in; the intended page is remembered so a
    // deep link survives the detour.
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  const { permissions } = auth;

  return (
    <AppShell>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/" element={<Dashboard />} />

        <Route path="/views" element={<Views />} />
        <Route path="/views/:type/:id" element={<Views />} />

        <Route
          path="/generate"
          element={(
            <Guard allowed={permissions.canGenerate} why="Only a Timetable Coordinator or the Super Admin can generate timetables.">
              <GenerateWizard />
            </Guard>
          )}
        />
        <Route
          path="/manual"
          element={(
            <Guard allowed={permissions.canEditTimetable} why="Only a Timetable Coordinator or the Super Admin can change a timetable.">
              <ManualBuilder />
            </Guard>
          )}
        />
        <Route
          path="/timetables"
          element={<Guard allowed={permissions.canEditTimetable}><Timetables /></Guard>}
        />

        <Route path="/data" element={<Guard allowed={permissions.canManageData}><DataHub /></Guard>} />
        <Route path="/data/:entity" element={<Guard allowed={permissions.canManageData}><EntityList /></Guard>} />
        <Route path="/timing" element={<Guard allowed={permissions.canManageData}><TimingConfig /></Guard>} />
        <Route path="/rules" element={<Guard allowed={permissions.canManageData}><Rules /></Guard>} />
        <Route path="/import" element={<Guard allowed={permissions.canManageData}><ImportExport /></Guard>} />

        <Route
          path="/availability"
          element={<Guard allowed={permissions.canEditOwnAvailability}><Availability /></Guard>}
        />

        <Route path="/assistant" element={<Assistant />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/help" element={<Help />} />

        <Route
          path="*"
          element={(
            <main className="page">
              <EmptyState icon="○" title="There is nothing at that address">
                Use the menu on the left to find your way back.
              </EmptyState>
            </main>
          )}
        />
      </Routes>
    </AppShell>
  );
}
