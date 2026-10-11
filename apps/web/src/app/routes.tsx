import { Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './Shell';
import { EditorPage } from '../screens/EditorPage';
import { ProjectsPage } from '../screens/ProjectsPage';
import { QueuePage } from '../screens/QueuePage';
import { SettingsPage } from '../screens/SettingsPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<EditorPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}
