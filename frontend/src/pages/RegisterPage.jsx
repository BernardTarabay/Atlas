import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, AlertCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { AuthShell } from "./LoginPage";

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: "", email: "", password: "" });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  function update(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register(form.email, form.password, form.fullName);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message || "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="mb-2">
          <h1 className="text-xl font-semibold text-base-50">Create your account</h1>
          <p className="mt-1 text-sm text-base-400">New accounts get standard access; an admin can grant more.</p>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="register-fullname">Full name</label>
          <input
            id="register-fullname"
            name="fullName"
            className="input"
            autoComplete="name"
            required
            value={form.fullName}
            onChange={update("fullName")}
            placeholder="Ada Lovelace"
          />
        </div>
        <div>
          <label className="label" htmlFor="register-email">Email</label>
          <input
            id="register-email"
            name="email"
            className="input"
            type="email"
            autoComplete="username"
            required
            value={form.email}
            onChange={update("email")}
            placeholder="you@company.com"
          />
        </div>
        <div>
          <label className="label" htmlFor="register-password">Password</label>
          <input
            id="register-password"
            name="password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={form.password}
            onChange={update("password")}
            placeholder="At least 8 characters"
          />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? "Creating account…" : <>Create account <ArrowRight size={15} /></>}
        </button>

        <p className="text-center text-sm text-base-400">
          Already have an account? <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
