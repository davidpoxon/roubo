import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useMatch } from "react-router-dom";
import ProjectSidebar from "./components/ProjectSidebar";
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
import { RegisterProjectModalProvider } from "./components/RegisterProjectModalProvider";
import MigrationBanner from "./components/MigrationBanner";

const MENU_NAV_ALLOWLIST = new Set(["/settings", "/updates"]);

export function useMenuNav(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!window.roubo) return;
    return window.roubo.onNavigate((path) => {
      if (MENU_NAV_ALLOWLIST.has(path)) {
        navigate(path);
      }
    });
  }, [navigate]);
}

function useDeepLink(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!window.roubo) return;
    return window.roubo.onDeepLink((url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "roubo:" || parsed.hostname !== "project") return;
        const parts = parsed.pathname.split("/").filter(Boolean);
        const ID_RE = /^[\w-]+$/;
        if (
          parts.length === 3 &&
          parts[1] === "bench" &&
          ID_RE.test(parts[0]) &&
          ID_RE.test(parts[2])
        ) {
          navigate(`/projects/${parts[0]}/benches/${parts[2]}`);
        }
      } catch {
        // ignore malformed URLs
      }
    });
  }, [navigate]);
}

export default function App() {
  useThemeSync();
  useNotificationStream();
  useAppBadge();
  useDeepLink();
  useMenuNav();
  const projectMatch = useMatch({ path: "/projects/:projectId", end: false });
  const projectId = projectMatch?.params.projectId;
  const { data: projects } = useProjects();
  const currentProject = projectId ? projects?.find((p) => p.id === projectId) : undefined;
  const projectName = currentProject?.config?.project?.displayName ?? projectId;
  return (
    <RegisterProjectModalProvider>
      <div className="flex flex-col h-screen">
        <MigrationBanner />
        <TitleBar projectName={projectName} />
        <div className="flex flex-1 min-h-0">
          <ProjectSidebar />
          <main className="flex-1 overflow-auto flex flex-col">
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
              <Route path="/jigs/edit/:jigId" element={<JigEditor mode="edit" scope="global" />} />
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
          </main>
        </div>
      </div>
    </RegisterProjectModalProvider>
  );
}
