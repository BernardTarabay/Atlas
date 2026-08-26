# 11. Remote Access and Installability

How Atlas is reached from a device that is not the machine it runs on, and how
it comes to look like an application rather than a browser tab pointed at a
port number.

## 11.1 The problem this solves

Atlas runs on one machine — the one the documents are on. The API serves the
built UI from port 5000 (`docs/04 §4.2`, `backend/src/app.js`), and
`scripts/install-autostart.ps1` starts it at logon and drops a desktop
shortcut, so on that machine the experience is already a double-click.

Every other device was told to open `http://192.168.1.101:5000`. That address is
wrong in three independent ways:

1. **It moves.** It is a DHCP lease. The router reboots and the bookmark dies.
2. **It is LAN-only.** Off the network there is no Atlas at all.
3. **It is not a secure context** — and this is the one with consequences
   beyond aesthetics. Browsers refuse to register a service worker over plain
   HTTP on any non-loopback origin, and without a registered worker there is no
   install prompt. `manifest.webmanifest` and `sw.js` can be perfectly correct
   and still never run.

So the LAN IP is not merely unprofessional. It is the reason Atlas cannot be
installed on a phone.

## 11.2 Why this is not solved by becoming a desktop application

The recurring instinct is that a desktop app would remove the addressing
problem. It removes the *feature*: a desktop app is per-machine, so the phone
stops having degraded access and starts having none. Cross-device access is
already modelled deliberately here — `docs/04 §4.6` exists so a phone can
retrieve a file that physically lives elsewhere, and migration 030 separates
organization (cross-device) from content (not).

The addressing problem is a *networking* problem wearing an architecture
problem's clothes. It is fixed with networking.

## 11.3 The mechanism: `tailscale serve`

`tailscale serve` publishes `http://127.0.0.1:5000` at
`https://<machine>.<tailnet>.ts.net` with a genuine Let's Encrypt certificate,
reachable by any device signed into the same tailnet, on or off the LAN.

All three failures above go away at once: the name is stable, it is not
LAN-bound, and it is a secure context.

Alternatives, and why not:

| Option | Why not |
|---|---|
| Port forwarding + DDNS | Publishes a document repository to the open internet, and still needs a certificate |
| Self-signed certificate | A trust-store install on every device; iOS makes this genuinely painful |
| `tailscale funnel` | Same as port forwarding — funnel is public. **Never use it here** |
| Reverse proxy + real domain | Correct, and much more to own: DNS, renewals, a public endpoint to harden |

`scripts/install-tailscale-serve.ps1` only ever calls `serve`. Funnel is not
exposed as a flag, because exposing a private document index to the internet
should require deliberately typing a different command.

## 11.4 Installability

With HTTPS in place, `frontend/public/manifest.webmanifest` and
`frontend/public/sw.js` make Atlas installable: Chromium offers *Install app*,
iOS Safari offers *Add to Home Screen*, and both then run it in its own window
with no URL bar.

The service worker's rules and their rationale live in the header of `sw.js`.
The one worth repeating here: **`/api` is never intercepted.** Atlas's data is
live and authenticated, and a cache in front of it could only ever produce a
stale view of someone's library that no in-app observation would distinguish
from a server bug. `frontend/tests/sw.test.mjs` asserts it.

Note that the HTTPS name is a **different origin** from the LAN address, and
tokens live in `localStorage` (`frontend/src/services/apiClient.js`), which is
per-origin. Signing in again at the new address is expected, not a fault.

## 11.5 What the application itself had to change

One thing: `upgrade-insecure-requests`.

helmet emits that CSP directive by default. It rewrites every `http://`
subresource request to `https://`, and browsers exempt loopback but not a LAN
address — so on `http://192.168.1.101:5000` every asset request was upgraded
against a server that speaks no TLS, and the page rendered blank with the
correct title and nothing in any log (`backend/src/app.js`).

That was originally fixed with a `SERVE_OVER_HTTPS` boolean. Running behind
`tailscale serve` breaks that flag, because the app is now reachable *three*
ways simultaneously:

```
https://atlas.<tailnet>.ts.net    TLS          needs the directive
http://192.168.1.101:5000         plain        blank page if it gets it
http://localhost:5000             plain        exempt either way
```

One global flag forces a choice about which of those is allowed to break, and
setting it for the tunnel silently re-breaks the LAN fallback — the path you
reach for precisely when the tunnel is down.

So the decision is made **per request**, from `X-Forwarded-Proto` (which
`tailscale serve` sets) with `req.secure` and `SERVE_OVER_HTTPS=true` as
fallbacks. Every address is then correct at the same time and there is no
setting to get wrong.

The header is read directly rather than by enabling Express's `trust proxy`,
deliberately: `trust proxy` would also make `express-rate-limit` key on
`X-Forwarded-For`, letting any caller reset their own rate limit with an
invented header. Spoofing `X-Forwarded-Proto` only causes the spoofer's own
browser to upgrade its own subresource requests.

## 11.6 Setup

Steps 1–3 require a Tailscale account and cannot be scripted.

1. Install Tailscale on the Atlas machine (<https://tailscale.com/download/windows>)
   and sign in.
2. Sign the client's phone and laptop into the **same tailnet**.
3. Enable **MagicDNS** and **HTTPS Certificates**:
   <https://login.tailscale.com/admin/dns>
4. Then:

```powershell
.\scripts\install-tailscale-serve.ps1            # configures serve, prints the URL
.\scripts\install-tailscale-serve.ps1 -Status    # show current config
.\scripts\install-tailscale-serve.ps1 -Remove    # tear it down
```

5. Confirm the install metadata is correct over TLS:

```bash
cd frontend && npm run verify:pwa -- https://<machine>.<tailnet>.ts.net
```

6. On the phone, open that URL and install it (address-bar icon on
   Chrome/Edge; Share → Add to Home Screen on iOS).

The desktop shortcut on the Atlas machine should keep pointing at
`http://localhost:5000` — it is faster and works even if Tailscale is down.

## 11.7 What this does not solve

- **The phone layout is adaptive, not a separate design.** The nav collapses to
  a drawer and the tables now drop columns by priority instead of scrolling
  sideways (see §11.8), but the pages are still laid out for a reader who will
  mostly be at a desk. Nothing is unreachable; some things take an extra tap.
- **Every device needs Tailscale.** That is the price of not having a public
  endpoint, and it is the right trade for a private document index.
- **Postgres still has to be installed on the host machine.** (Only Postgres --
  migration 040 moved the job queue into `processing_jobs`, so there is no Redis
  and no broker to install.) The install story is a scheduled task, not an
  installer.

## 11.8 Tables on a phone

`.table-shell` keeps a wide table from pushing the page sideways, but on a
375px screen it only converts a broken layout into "scroll right to find the
buttons". Seven columns do not belong there.

The usual fix is to reflow rows into cards — set every table element to
`display: block` and print the column name from a `data-label`. It is **not**
used here: changing the display of a table element destroys its semantics for
assistive technology. The table stops being a table, and the association
between a cell and its header is lost — so the reflow that makes the table
readable by eye makes it unreadable by ear. Restoring that needs an explicit
`role` on every table, row and cell, in nine files.

So columns are dropped by priority instead (`.col-secondary`, `.col-tertiary`
in `frontend/src/index.css`). The markup stays a real table at every width,
`display: none` removes a dropped column from the accessibility tree rather
than leaving a phantom, and nothing becomes unreachable — the row opens a
detail view carrying every field. Where a dropped value is genuinely needed on
a phone (a date, a size, a user's email), `.cell-subline` carries it under the
primary cell and disappears again at the width where its own column returns.

One non-obvious part was necessary to make it work at all. `truncate` sets
`white-space: nowrap`, which means a filename cell's **min-content** width is
the entire untruncated filename. An auto-layout table honours that and grows
past its container, so dropping columns alone still left the table scrolling at
375px. The primary cell therefore carries `w-full max-w-0`: `max-w-0` removes
the min-content floor, and `w-full` hands that cell the slack, so the text
truncates instead of the table growing.

Verified by measuring the rendered table at 375 / 640 / 768 / 1024 px: header
and body column counts stay equal, and neither the table nor the page overflows
at any of them.
