import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Boxes, ArrowRight, AlertCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      navigate(location.state?.from || "/", { replace: true });
    } catch (err) {
      setError(err.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="mb-2">
          <h1 className="text-xl font-semibold text-base-50">Welcome back</h1>
          <p className="mt-1 text-sm text-base-400">Sign in to your document repository.</p>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
          </div>
        )}

        {/* htmlFor/id pairs: a <label> with no `for` is decoration. Without it
            a screen reader announces "edit text, blank" and clicking the word
            "Email" does not focus the field. autoComplete lets a password
            manager fill this, which is the difference between the account
            having a strong password and a memorable one. */}
        <div>
          <label className="label" htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        <div>
          <label className="label" htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? "Signing in…" : <>Sign in <ArrowRight size={15} /></>}
        </button>

        <p className="text-center text-sm text-base-400">
          Don&rsquo;t have an account? <Link to="/register" className="font-medium text-brand-600 hover:text-brand-700">Create one</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function AuthShell({ children }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-brand-600/20 blur-[120px]" />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-glow">
            <Boxes size={22} className="text-white" />
          </div>
          <p className="text-lg font-semibold text-base-50">Atlas</p>
        </div>
        <div className="glass-card animate-fade-in-up p-7">{children}</div>
      </div>
    </div>
  );
}
