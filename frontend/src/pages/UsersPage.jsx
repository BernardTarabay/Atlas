import { useState } from "react";
import { Users, ShieldCheck, UserX, UserCheck, LogOut, KeyRound, Copy, Check } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";

export function UsersPage() {
  const { data: users, loading, error, reload } = useApiData(() => api.get("/users"), []);
  const { data: roles } = useApiData(() => api.get("/roles"), []);
  const [managing, setManaging] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [resetResult, setResetResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();
  const { user: currentUser } = useAuth();

  async function runAction(fn, successMessage) {
    setBusy(true);
    try {
      const result = await fn();
      if (successMessage) push(successMessage, "success");
      reload();
      return result;
    } catch (err) {
      push(err.message, "error");
      return null;
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  function confirmSuspend(user) {
    const suspending = user.status === "active";
    setConfirming({
      title: suspending ? `Suspend ${user.full_name}?` : `Reactivate ${user.full_name}?`,
      description: suspending
        ? "They will be signed out immediately and cannot sign in again until reactivated. Nothing they created is deleted."
        : "They will be able to sign in again. They will need to sign in fresh — their old sessions were revoked.",
      confirmLabel: suspending ? "Suspend" : "Reactivate",
      danger: suspending,
      run: () =>
        runAction(
          () => api.patch(`/users/${user.id}/status`, { status: suspending ? "suspended" : "active" }),
          suspending ? "User suspended." : "User reactivated."
        ),
    });
  }

  function confirmRevoke(user) {
    setConfirming({
      title: `Sign ${user.full_name} out everywhere?`,
      description:
        "Revokes their saved sessions on every device. Note: an access token already issued stays valid " +
        "for up to 15 more minutes — suspend the account instead if you need it to stop immediately.",
      confirmLabel: "Sign out everywhere",
      danger: false,
      run: () => runAction(() => api.post(`/users/${user.id}/revoke-sessions`), "Sessions revoked."),
    });
  }

  function confirmReset(user) {
    setConfirming({
      title: `Reset the password for ${user.full_name}?`,
      description:
        "Generates a new temporary password and signs them out everywhere. Their current password stops " +
        "working straight away. You will see the new password once — existing passwords cannot be shown, " +
        "as they are only stored hashed.",
      confirmLabel: "Reset password",
      danger: true,
      run: async () => {
        const result = await runAction(() => api.post(`/users/${user.id}/reset-password`), null);
        if (result?.temporaryPassword) {
          setResetResult({ user, password: result.temporaryPassword });
        }
      },
    });
  }

  return (
    <div>
      <PageHeader
        title="Users"
        description="Accounts with access to this repository, the roles granting them permission, and the admin actions available for each."
      />

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load users" />
      ) : !users?.length ? (
        <EmptyState icon={Users} title="No users found" />
      ) : (
        <div className="table-shell glass-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wider text-base-400">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="col-secondary px-4 py-3 font-medium">Email</th>
                <th className="col-secondary px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="col-tertiary px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === currentUser?.id;
                const roleNames = (u.roles || []).map((r) => r.name);
                return (
                  <tr key={u.id} className="table-row-hover border-b border-line last:border-0">
                    <td className="px-4 py-3 font-medium text-base-100">
                      {u.full_name}
                      {isSelf && <span className="ml-2 text-xs text-base-400">(you)</span>}
                      {/* Identity is the email, not the display name -- two
                          people called "Bernard" are told apart by it, so it is
                          the one dropped column that has to survive. */}
                      <div className="cell-subline font-normal">
                        <span className="truncate">{u.email}</span>
                        {roleNames.length > 0 && <span>{roleNames.join(", ")}</span>}
                      </div>
                    </td>
                    <td className="col-secondary px-4 py-3 text-base-400">{u.email}</td>
                    <td className="col-secondary px-4 py-3">
                      {roleNames.length ? (
                        <span className="text-base-200">{roleNames.join(", ")}</span>
                      ) : (
                        <span className="text-base-500">none</span>
                      )}
                    </td>
                    <td className="px-4 py-3"><StatusBadge value={u.status} /></td>
                    <td className="col-tertiary px-4 py-3 text-base-400">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button className="btn-ghost btn-sm" onClick={() => setManaging(u)} title="Change role">
                          <ShieldCheck size={13} /> Role
                        </button>
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => confirmRevoke(u)}
                          title="Revoke all saved sessions"
                        >
                          <LogOut size={13} />
                        </button>
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => confirmReset(u)}
                          title="Reset password"
                        >
                          <KeyRound size={13} />
                        </button>
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => confirmSuspend(u)}
                          disabled={isSelf && u.status === "active"}
                          title={
                            isSelf && u.status === "active"
                              ? "You cannot suspend your own account"
                              : u.status === "active"
                                ? "Suspend"
                                : "Reactivate"
                          }
                        >
                          {u.status === "active" ? <UserX size={13} /> : <UserCheck size={13} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ChangeRoleModal
        user={managing}
        roles={roles}
        onClose={() => setManaging(null)}
        onChanged={() => {
          setManaging(null);
          reload();
          push("Role updated.", "success");
        }}
      />

      <ConfirmDialog
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming?.run()}
        title={confirming?.title}
        description={confirming?.description}
        confirmLabel={confirming?.confirmLabel}
        danger={confirming?.danger}
        loading={busy}
      />

      <TemporaryPasswordModal result={resetResult} onClose={() => setResetResult(null)} />
    </div>
  );
}

/**
 * Replaces the user's role rather than adding to it. The previous version
 * only ever granted, so "demoting" someone left their old role in place and
 * they silently kept every permission it carried.
 */
function ChangeRoleModal({ user, roles, onClose, onChanged }) {
  const [saving, setSaving] = useState(false);
  const { data: detail } = useApiData(
    () => (user ? api.get(`/users/${user.id}`) : Promise.resolve(null)),
    [user]
  );
  const { push } = useToast();

  const currentRoleIds = new Set((detail?.roles || []).map((r) => r.id));

  async function change(roleId) {
    setSaving(true);
    try {
      await api.patch(`/users/${user.id}/role`, { roleId });
      onChanged();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={`Role for ${user?.full_name || ""}`}
      width="max-w-sm"
    >
      <p className="mb-3 text-xs text-base-400">
        Selecting a role replaces any role this user currently has.
      </p>
      <div className="space-y-2">
        {(roles || []).map((role) => {
          const isCurrent = currentRoleIds.has(role.id);
          return (
            <div
              key={role.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-base-900 px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm text-base-100">{role.name}</p>
                <p className="text-xs text-base-400">{role.description}</p>
              </div>
              {isCurrent ? (
                <span className="badge-emerald shrink-0">current</span>
              ) : (
                <button
                  className="btn-secondary btn-sm shrink-0"
                  disabled={saving}
                  onClick={() => change(role.id)}
                >
                  Set
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function TemporaryPasswordModal({ result, onClose }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the password is visible either way.
    }
  }

  return (
    <Modal
      open={Boolean(result)}
      onClose={onClose}
      title="Temporary password"
      width="max-w-md"
      footer={<button className="btn-primary btn-sm" onClick={onClose}>Done</button>}
    >
      <p className="text-sm text-base-300">
        New password for <span className="text-base-100">{result?.user?.full_name}</span>. This is shown
        once and cannot be retrieved again — give it to them and have them change it after signing in.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-base-900 px-3.5 py-2.5">
        <code className="flex-1 break-all font-mono text-sm text-base-100">{result?.password}</code>
        <button className="btn-ghost btn-sm shrink-0" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-3 text-xs text-base-400">
        Their previous password stopped working immediately, and they were signed out everywhere.
      </p>
    </Modal>
  );
}
