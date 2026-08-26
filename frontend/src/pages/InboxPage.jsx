import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Inbox as InboxIcon, Mail, RefreshCw, Unlink, ExternalLink, Trash2, Plus, Paperclip,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { useToast } from "../context/ToastContext";
import { relativeTime, formatDate } from "../utils/format";

const LIMIT = 25;

// Gmail only. The Outlook provider was removed from the backend, so offering
// it here would produce a button that 400s. Accounts connected before the
// removal still render -- the label falls back to the raw provider value --
// so a leftover row is visible and disconnectable rather than invisible.
const PROVIDER_LABEL = { gmail: "Gmail" };

export function InboxPage() {
  const { push } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: accounts, loading: accountsLoading, error: accountsError, reload: reloadAccounts } =
    useApiData(() => api.get("/email-accounts"), []);

  const [view, setView] = useState("kept"); // "kept" | "deleted"
  const [offset, setOffset] = useState(0);
  const {
    data: messages, loading: messagesLoading, error: messagesError, reload: reloadMessages,
  } = useApiData(() => api.get("/inbox", { status: view, limit: LIMIT, offset }), [view, offset]);

  const [connecting, setConnecting] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  // The deferred post-sync refresh below is scheduled with setTimeout and was
  // never cleared, so navigating away within its 1.5s window called reload()
  // on an unmounted page.
  const syncRefreshTimer = useRef(null);
  useEffect(() => () => clearTimeout(syncRefreshTimer.current), []);
  const [disconnectTarget, setDisconnectTarget] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Google's redirect lands back here with ?connected=<email> or
  // ?error=<message> after the OAuth round trip. Surface it once as a
  // toast, then strip the params so a refresh doesn't re-show it and so
  // the URL looks like a normal page again.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    if (!connected && !error) return;

    if (connected) push(`Connected ${connected}.`, "success");
    if (error) push(error, "error");

    setSearchParams({}, { replace: true });
    reloadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function connect(provider) {
    setConnecting(provider);
    try {
      const { authUrl } = await api.get(`/email-accounts/connect/${provider}`);
      window.location.href = authUrl;
    } catch (err) {
      push(err.message, "error");
      setConnecting(null);
    }
  }

  async function triggerSync(id) {
    setSyncingId(id);
    try {
      await api.post(`/email-accounts/${id}/sync`);
      push("Sync started — new messages will appear here shortly.", "success");
      // The sync runs as a background job, not synchronously, so an
      // immediate reload won't show new mail yet -- just give the account
      // card's "last synced" status a chance to refresh.
      clearTimeout(syncRefreshTimer.current);
      syncRefreshTimer.current = setTimeout(reloadAccounts, 1500);
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSyncingId(null);
    }
  }

  async function confirmDisconnect() {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    try {
      await api.del(`/email-accounts/${disconnectTarget.id}`);
      push(`Disconnected ${disconnectTarget.email_address}.`, "success");
      setDisconnectTarget(null);
      reloadAccounts();
      reloadMessages();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setDisconnecting(false);
    }
  }

  function switchView(next) {
    if (next === view) return;
    setView(next);
    setOffset(0);
  }

  const hasAccounts = Boolean(accounts?.length);

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Connect Gmail to auto-triage your inbox — junk and promo mail is removed automatically, everything relevant shows up here."
        actions={
          <button className="btn-secondary btn-sm" disabled={connecting === "gmail"} onClick={() => connect("gmail")}>
            <Plus size={14} /> {connecting === "gmail" ? "Redirecting…" : "Connect Gmail"}
          </button>
        }
      />

      {accountsLoading ? (
        <PageSpinner />
      ) : accountsError ? (
        <ErrorState error={accountsError} onRetry={reloadAccounts} title="Couldn't load connected accounts" />
      ) : !hasAccounts ? (
        <EmptyState
          icon={InboxIcon}
          title="No inbox connected yet"
          description="Connect a Gmail account above. Once connected, we automatically remove ads, spam, and other clutter, and surface everything else right here."
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((acc) => (
              <div key={acc.id} className="glass-card animate-fade-in-up p-5">
                <div className="mb-3 flex items-start justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-line-strong bg-base-900">
                    <Mail size={16} className="text-brand-700" />
                  </div>
                  <StatusBadge value={acc.status} />
                </div>
                <p className="truncate text-sm font-medium text-base-100">{acc.email_address}</p>
                <p className="mt-1 text-xs text-base-400">{PROVIDER_LABEL[acc.provider] || acc.provider}</p>
                {acc.status === "error" && acc.last_error && (
                  <p className="mt-1 text-xs text-rose-700">{acc.last_error}</p>
                )}
                <p className="mt-1 text-xs text-base-500">
                  {acc.last_synced_at ? `Last synced ${relativeTime(acc.last_synced_at)}` : "Not yet synced"}
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    className="btn-secondary btn-sm flex-1"
                    disabled={syncingId === acc.id || acc.status !== "connected"}
                    onClick={() => triggerSync(acc.id)}
                  >
                    <RefreshCw size={13} className={syncingId === acc.id ? "animate-spin" : ""} />
                    {syncingId === acc.id ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    title="Disconnect"
                    onClick={() => setDisconnectTarget(acc)}
                  >
                    <Unlink size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mb-4 flex items-center gap-1.5 border-b border-line">
            <button
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                view === "kept" ? "border-b-2 border-brand-400 text-base-50" : "text-base-400 hover:text-base-200"
              }`}
              onClick={() => switchView("kept")}
            >
              Inbox
            </button>
            <button
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                view === "deleted" ? "border-b-2 border-brand-400 text-base-50" : "text-base-400 hover:text-base-200"
              }`}
              onClick={() => switchView("deleted")}
            >
              Auto-removed
            </button>
          </div>

          {messagesLoading ? (
            <PageSpinner />
          ) : messagesError ? (
            <ErrorState error={messagesError} onRetry={reloadMessages} title="Couldn't load messages" compact />
          ) : !messages?.length ? (
            <EmptyState
              icon={view === "kept" ? InboxIcon : Trash2}
              title={view === "kept" ? "No messages yet" : "Nothing auto-removed yet"}
              description={
                view === "kept"
                  ? "Run a sync above, or wait for the next automatic sync — relevant mail will show up here."
                  : "Junk and promotional mail that gets auto-deleted will be listed here for transparency."
              }
            />
          ) : (
            <div className="glass-card overflow-hidden p-0">
              <div className="divide-y divide-line">
                {messages.map((msg) => (
                  <div key={msg.id} className="flex items-start gap-3 p-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-base-900">
                      {view === "deleted" ? (
                        <Trash2 size={16} className="text-rose-700" />
                      ) : (
                        <Mail size={16} className="text-brand-700" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-base-100">
                          {msg.from_name || msg.from_address || "Unknown sender"}
                        </p>
                        <span className="shrink-0 text-xs text-base-500">{formatDate(msg.received_at)}</span>
                      </div>
                      <p className="truncate text-sm text-base-200">{msg.subject || "(no subject)"}</p>
                      {msg.snippet && <p className="truncate text-xs text-base-500">{msg.snippet}</p>}
                      <div className="mt-1.5 flex items-center gap-2">
                        {view === "deleted" && <StatusBadge value={msg.classification} />}
                        {msg.has_attachments && <Paperclip size={12} className="text-base-500" />}
                      </div>
                    </div>
                    {msg.provider_web_link && (
                      <button
                        className="btn-secondary btn-sm shrink-0"
                        onClick={() => window.open(msg.provider_web_link, "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink size={13} /> Open
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <Pagination offset={offset} limit={LIMIT} pageCount={messages?.length} onChange={setOffset} />
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(disconnectTarget)}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={confirmDisconnect}
        loading={disconnecting}
        danger
        title="Disconnect account"
        confirmLabel="Disconnect"
        description={
          disconnectTarget
            ? `Disconnect "${disconnectTarget.email_address}"? Auto-triage will stop, and the stored access token is revoked. Messages already shown here stay in this list.`
            : ""
        }
      />
    </div>
  );
}
