// HTTP client for the agent protocol (backend/src/routes/agentRoutes.js).
// Raw fetch, no SDK -- same style as the backend's own outbound clients.
class BackendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class BackendClient {
  constructor({ serverUrl, agentId, apiKey }) {
    this.serverUrl = String(serverUrl || "").replace(/\/+$/, "");
    this.agentId = agentId;
    this.apiKey = apiKey;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async _request(method, urlPath, { body, auth = true, timeoutMs = 30000 } = {}) {
    if (auth) await this.ensureSession();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${this.serverUrl}${urlPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw new BackendError(`Request to ${urlPath} timed out.`, 0);
      // Network-level failure: the server is down, or this laptop is offline.
      throw new BackendError(`Cannot reach ${this.serverUrl}: ${err.message}`, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { error: text.slice(0, 300) };
    }

    if (!response.ok) {
      // A 401 means the session is stale or the agent was revoked. Dropping
      // the token forces re-authentication on the next call, which will
      // surface a permanent revocation as a clear error rather than an
      // endless quiet retry.
      if (response.status === 401) this.token = null;
      throw new BackendError(payload?.error || `HTTP ${response.status}`, response.status);
    }
    return payload;
  }

  async ensureSession() {
    // Refresh a minute early so a long poll can't start on a token that
    // expires mid-flight.
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;

    const os = require("os");
    const { version } = require("../package.json");
    const result = await this._request("POST", "/api/agents/session", {
      auth: false,
      body: {
        agentId: this.agentId,
        apiKey: this.apiKey,
        agentVersion: version,
        platform: `${os.platform()} ${os.release()}`,
        hostname: os.hostname(),
      },
    });

    this.token = result.token;
    this.tokenExpiresAt = Date.now() + 60 * 60 * 1000;
    this.agentInfo = result.agent;
    return this.token;
  }

  heartbeat(registeredDirectories) {
    return this._request("POST", "/api/agents/heartbeat", { body: { registeredDirectories } });
  }

  pollOperations(limit = 10) {
    return this._request("GET", `/api/agents/operations?limit=${limit}`);
  }

  reportResult(operationId, { success, result, errorMessage }) {
    return this._request("POST", `/api/agents/operations/${operationId}/result`, {
      body: { success, result, errorMessage },
      // A read_file result carries the file's bytes base64-encoded, so this
      // timeout is really "how long may a whole file take to upload".
      //
      // 120s was generous against the ~750KB the backend actually accepted and
      // is far too tight now the ceiling is 200MB. Over Tailscale -- which is
      // the normal case, not the exceptional one -- a link doing a real-world
      // 2 MB/s needs about 100s for a 200MB file BEFORE base64's 4/3 inflation,
      // so the old value would have aborted a perfectly healthy transfer
      // partway and reported it as a timeout rather than as a slow network.
      //
      // 15 minutes covers 200MB down to roughly 300 KB/s. It is deliberately
      // not unbounded: a genuinely dead connection still has to be noticed, and
      // the operation re-issued, rather than hanging this agent forever.
      timeoutMs: parseInt(process.env.AGENT_RESULT_TIMEOUT_MS || "900000", 10),
    });
  }
}

module.exports = { BackendClient, BackendError };
