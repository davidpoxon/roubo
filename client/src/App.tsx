import { Routes, Route, Navigate, useMatch, useLocation } from "react-router-dom";
import ProjectSidebar from "./components/ProjectSidebar";
import ErrorBoundary from "./components/ErrorBoundary";
import TitleBar from "./components/TitleBar";
import { useProjects } from "./hooks/useProjects";
import BenchDashboard from "./components/BenchDashboard";
import BenchesTab from "./components/BenchesTab";
import ProjectSettingsTab from "./components/ProjectSettingsTab";
import ProjectSettings from "./components/ProjectSettings";
import UpdatesPage from "./components/UpdatesPage";
import BenchDetail from "./components/BenchDetail";
import JigEditor from "./components/jig-editor/JigEditor";
import { useThemeSync } from "./hooks/useSettings";
import { useNotificationStream } from "./hooks/useNotificationStream";
import { useAppBadge } from "./hooks/useAppBadge";
import { useMenuNav } from "./hooks/useMenuNav";
import { useDeepLink } from "./hooks/useDeepLink";
import { RegisterProjectModalProvider } from "./components/RegisterProjectModalProvider";
import MigrationBanner from "./components/MigrationBanner";
import OnlyToDoNoticeBanner from "./components/OnlyToDoNoticeBanner";

export default function App() {
  useThemeSync();
  useNotificationStream();
  useAppBadge();
  useDeepLink();
  useMenuNav();
  const projectMatch = useMatch({ path: "/projects/:projectId", end: false });
  const projectId = projectMatch?.params.projectId;
  const location = useLocation();
  const { data: projects } = useProjects();
  const currentProject = projectId ? projects?.find((p) => p.id === projectId) : undefined;
  const projectName = currentProject?.config?.project?.displayName ?? projectId;
  return (
    <RegisterProjectModalProvider>
      <div className="flex flex-col h-screen">
        <TitleBar projectName={projectName} />
        <MigrationBanner />
        <OnlyToDoNoticeBanner />
        <div className="flex flex-1 min-h-0">
          <ProjectSidebar />
          <main className="flex-1 overflow-auto flex flex-col">
            {/* A render error in any route shows a recoverable panel instead of
                blanking the whole window. Keyed on pathname so navigating away
                clears a failed route. */}
            <ErrorBoundary resetKey={location.pathname}>
              <Routes>
                <Route path="/" element={<BenchDashboard />} />
                <Route path="/projects/:projectId" element={<BenchDashboard />}>
                  <Route index element={<BenchesTab />} />
                  <Route path="settings/*" element={<ProjectSettingsTab />} />
                  <Route path="*" element={<Navigate to=".." relative="path" replace />} />
                </Route>
                <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
                <Route path="/settings" element={<ProjectSettings />} />
                <Route path="/updates" element={<UpdatesPage />} />
                <Route path="/jigs/new" element={<JigEditor mode="create" scope="global" />} />
                <Route
                  path="/jigs/edit/:jigId"
                  element={<JigEditor mode="edit" scope="global" />}
                />
                <Route
                  path="/projects/:projectId/jigs/new"
                  element={<JigEditor mode="create" scope="project" />}
                />
                <Route
                  path="/projects/:projectId/jigs/edit/:jigId"
                  element={<JigEditor mode="edit" scope="project" />}
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </RegisterProjectModalProvider>
  );
}
