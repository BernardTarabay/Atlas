// Thin fetch wrapper for the backend API (docs/08-api-contracts.md).
// Handles: base URL, JSON encode/decode, Authorization header injection,
// and a single silent refresh-and-retry on a 401 so a merely-expired access
// token doesn't kick the user back to the login screen mid-session.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

let accessToken = localStorage.getItem("atlas.accessToken") || null;
let refreshToken = localStorage.getItem("atlas.refreshToken") || null;
let onUnauthorized = () => {};

function setTokens(tokens) {
  accessToken = tokens?.accessToken || null;
  refreshToken = tokens?.refreshToken || null;
  if (accessToken) localStorage.setItem("atlas.accessToken", accessToken);
  else localStorage.removeItem("atlas.accessToken");
  if (refreshToken) localStorage.setItem("atlas.refreshToken", refreshToken);
  else localStorage.removeItem("atlas.refreshToken");
}

function getAccessToken() {
  return accessToken;
}

function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function rawRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 204) return null;

  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!res.ok) {
    throw new ApiError(body?.error || `Request failed (${res.status})`, res.status, body);
  }
  return body;
}

let refreshInFlight = null;

/**
 * Pick up tokens another tab has already rotated into localStorage.
 *
 * `refreshInFlight` below serialises refreshes within ONE tab, but each tab
 * has its own module instance, so two open tabs can present the same refresh
 * token at the same moment. The server now treats a second use of an
 * already-spent token as a leak and revokes every session for the account
 * (see authService.refresh) -- correct against theft, and it would sign the
 * user out of both tabs for doing nothing wrong.
 *
 * localStorage is shared across tabs and is written the instant a rotation
 * succeeds, so it is the coordination point that already exists. Before
 * asking the server for a rotation, and again if one fails, check whether
 * somebody else has already done it: if the stored token is no longer the one
 * we set out with, adopt what they got instead of replaying ours.
 */
function adoptTokensRotatedElsewhere(attemptedWith) {
  const stored = localStorage.getItem("atlas.refreshToken");
  if (!stored || stored === attemptedWith) return false;
  accessToken = localStorage.getItem("atlas.accessToken");
  refreshToken = stored;
  return true;
}

async function tryRefresh() {
  if (!refreshToken) return false;
  if (!refreshInFlight) {
    const attemptedWith = refreshToken;
    refreshInFlight = (async () => {
      try {
        if (adoptTokensRotatedElsewhere(attemptedWith)) return true;
        const data = await rawRequest("/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken: attemptedWith }),
        });
        setTokens(data);
        return true;
      } catch {
        // Lost a race with another tab? Then this failure is not ours.
        if (adoptTokensRotatedElsewhere(attemptedWith)) return true;
        setTokens(null);
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

async function request(path, options = {}) {
  try {
    return await rawRequest(path, options);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;

    if (refreshToken) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        // The retry used to be `return rawRequest(...)` straight out of this
        // catch block, so if the retry ALSO 401'd -- a revoked session, a
        // suspended account, a token the server no longer accepts -- that
        // second 401 escaped without ever reaching onUnauthorized(). The user
        // was left sitting in the app holding credentials the server rejects,
        // with every request failing and nothing sending them to the login
        // screen.
        try {
          return await rawRequest(path, options);
        } catch (retryErr) {
          if (retryErr instanceof ApiError && retryErr.status === 401) onUnauthorized();
          throw retryErr;
        }
      }
    }

    onUnauthorized();
    throw err;
  }
}

function qs(params = {}) {
  const usable = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (usable.length === 0) return "";
  return "?" + new URLSearchParams(usable).toString();
}

/**
 * Fetches a binary/attachment response with the Authorization header
 * attached and triggers a client-side save. Plain `<a href={API_BASE+path}>`
 * links (the previous pattern) can't carry the JWT -- the token lives in
 * localStorage, not a cookie, so a bare anchor navigation to a protected
 * download route 401s. This goes through fetch like every other request,
 * then turns the response into a blob download.
 */
async function downloadFile(path, fallbackFilename = "download") {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res = await fetch(`${API_BASE}${path}`, { headers });
  if (res.status === 401 && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
  }
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error || message;
    } catch {
      // response wasn't JSON (likely a stream/binary error) -- keep default message
    }
    throw new ApiError(message, res.status);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match ? match[1] : fallbackFilename;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Fetches a preview-whitelisted file inline and returns a blob object URL
 * (for <img>/<iframe> src) plus its Content-Type, instead of triggering a
 * save like downloadFile() does. Callers own the returned URL and must
 * revoke it (URL.revokeObjectURL) once the preview is no longer shown, or
 * it leaks for the life of the tab. Throws ApiError (status 415) if the
 * backend rejected the mime type as not safely inline-previewable -- the
 * caller should fall back to the text excerpt from the file detail in
 * that case.
 */
async function fetchPreviewBlobUrl(path) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res = await fetch(`${API_BASE}${path}`, { headers });
  if (res.status === 401 && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
  }
  if (!res.ok) {
    let message = `Preview failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error || message;
    } catch {
      // response wasn't JSON -- keep default message
    }
    throw new ApiError(message, res.status);
  }

  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), contentType: res.headers.get("Content-Type") || blob.type };
}

/**
 * The file's bytes as a Blob, for code that needs to HAND THE FILE SOMEWHERE
 * rather than show it or save it.
 *
 * Neither existing helper fits: downloadFile() triggers a save and returns
 * nothing, and previewBlobUrl() hands back an object URL, which is the right
 * shape for an <img src> and the wrong one for the Web Share API -- that wants
 * a real File object so the receiving app gets a name and a mime type.
 *
 * Same auth-and-refresh path as the other two, deliberately: a share that
 * 401s halfway through a session is exactly the kind of thing that only shows
 * up in someone else's hands.
 */
async function fetchBlob(path) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res = await fetch(`${API_BASE}${path}`, { headers });
  if (res.status === 401 && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
  }
  if (!res.ok) {
    let message = `Could not read the file (${res.status})`;
    try { message = (await res.json())?.error || message; } catch { /* not JSON */ }
    throw new ApiError(message, res.status);
  }

  const blob = await res.blob();
  return { blob, contentType: res.headers.get("Content-Type") || blob.type };
}

// `uploadForm` and `downloadUrl` used to live here and are gone.
//
// uploadForm was the client half of the byte-upload routes, which were
// deliberately removed from the backend (see routes/storageLocationRoutes.js
// for the "40 files became 80" reasoning) -- it had no caller and no endpoint
// to call. downloadUrl handed out a bare `/api/...` string for use as an
// <a href>, which cannot carry the Authorization header and therefore always
// 401'd; its own neighbouring comment says so. Both were exported API surface
// that could only ever mislead the next person to reach for them.

export const api = {
  get: (path, params) => request(`${path}${qs(params)}`),
  post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body || {}) }),
  patch: (path, body) => request(path, { method: "PATCH", body: JSON.stringify(body || {}) }),
  del: (path) => request(path, { method: "DELETE" }),
  download: downloadFile,
  previewBlobUrl: fetchPreviewBlobUrl,
  fetchBlob,
};

export { setTokens, getAccessToken, setUnauthorizedHandler, ApiError, API_BASE };
