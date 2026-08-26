/**
 * Service worker registration.
 *
 * The worker exists to make Atlas installable -- once it is registered and the
 * manifest is served, Chromium offers "Install app" and iOS offers "Add to
 * Home Screen", and both then run Atlas in its own window with no URL bar.
 * That is the whole point: the client opens an app, not a browser tab pointed
 * at a port number.
 *
 * The caching it does on the side is described in public/sw.js. It never
 * touches /api.
 *
 * WHY THIS IS PRODUCTION-ONLY, AND WHY DEV ACTIVELY UNREGISTERS
 *
 * In development the UI is served by Vite on :5173 with hot reload, and a
 * worker caching an app shell in front of HMR produces exactly the failure
 * this repo has already been bitten by twice (see the header of
 * backend/src/app.js and scripts/preflight-dev.js): edits that appear to do
 * nothing, because the thing answering the browser is not the thing being
 * edited. So dev does not merely skip registration -- it removes any worker it
 * finds. Registering once from a production build on :5173 would otherwise
 * leave a worker that outlives the build that installed it.
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  if (!import.meta.env.PROD) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
    return;
  }

  // After load: registration competes with the app's own first paint and its
  // opening API calls, and it is not urgent -- the install prompt appearing a
  // second late costs nothing.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // A failed registration must never be fatal. The app works fine without
      // a worker; it just is not installable. Swallowing this silently would
      // make "why is there no install button" unanswerable, so it is logged.
      console.warn("Service worker registration failed:", err);
    });
  });
}
