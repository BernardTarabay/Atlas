import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./context/ToastContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";

import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FilesPage } from "./pages/FilesPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ProcessingJobsPage } from "./pages/ProcessingJobsPage";
import { FailedPage } from "./pages/FailedPage";
import { PhotosPage } from "./pages/PhotosPage";
import { DevicesPage } from "./pages/DevicesPage";
import { StorageLocationsPage } from "./pages/StorageLocationsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { UsersPage } from "./pages/UsersPage";
import { InboxPage } from "./pages/InboxPage";

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              {/*
                THE LIBRARY IS THE FRONT DOOR, not the dashboard.

                This is a document management system: the thing a person opens
                it to do is look at their documents, organized. A dashboard of
                pipeline counters is genuinely useful — it is how you find out
                that 900 files are stuck — but it answers a question you ask
                occasionally, not the one you come here with. It keeps its own
                route and stays in the navigation; it just is not what greets
                you any more.
              */}
              <Route path="/" element={<LibraryPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/files" element={<FilesPage />} />
              {/* The old address, kept working. Anyone who bookmarked
                  /subjects or has it in their history lands where that page
                  went rather than on the not-found redirect. */}
              <Route path="/subjects" element={<Navigate to="/" replace />} />
              {/* /document-types was the Types browse page. The page is gone;
                  the document-type CLASSIFICATION AXIS it browsed is not, and
                  still filters the Files page and is set by hand in the file
                  editor. The redirect is here rather than left to the
                  catch-all so a stale bookmark lands deliberately. */}
              <Route path="/document-types" element={<Navigate to="/files" replace />} />
              <Route path="/failed" element={<FailedPage />} />
              {/* "Triage" was this screen's old name. Kept working for anyone
                  who bookmarked it or linked to it from a note. */}
              <Route path="/triage" element={<Navigate to="/failed" replace />} />
              <Route path="/photos" element={<PhotosPage />} />
              <Route path="/devices" element={<DevicesPage />} />
              <Route path="/jobs" element={<ProcessingJobsPage />} />
              <Route path="/storage-locations" element={<StorageLocationsPage />} />
              <Route path="/audit-log" element={<AuditLogPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/inbox" element={<InboxPage />} />

              {/*
                Unmatched paths land here, INSIDE the auth guard and the app
                shell. This used to be `<Route path="*" element={<DashboardPage/>}/>`
                sitting outside both: a typo'd or stale URL rendered a bare
                dashboard with no sidebar, no topbar, no way to navigate out --
                and, because it was outside ProtectedRoute, it did that for
                signed-out visitors too, showing them a broken page instead of
                sending them to the login screen.

                Redirecting rather than rendering the dashboard in place also
                means the address bar stops lying about where you are.
              */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}

export default App;
