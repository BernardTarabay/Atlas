import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PageSpinner } from "./Spinner";

export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <PageSpinner />
      </div>
    );
  }
  // Remember where they were headed. LoginPage already reads
  // `location.state?.from` to send people back after signing in, but nothing
  // ever SET it -- so that redirect was dead code and a deep link (an emailed
  // link to a subject, a bookmarked filter) always dropped you on the
  // dashboard instead of where you asked to go.
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
