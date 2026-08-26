// Wraps an async route/controller so rejected promises reach Express's error
// handler instead of becoming unhandled rejections. Every controller in this
// project uses this rather than repeating try/catch.
function asyncHandler(fn, label) {
  // FAIL AT BOOT, NOT AT THE FIRST CLICK.
  //
  // `asyncHandler(controller.doThing)` where the controller defines doThing but
  // forgets to export it hands this `undefined`. Without this check the route
  // registers happily, the server starts clean, and the mistake surfaces only
  // when a user finally hits that endpoint -- as a 500 reading
  // "TypeError: fn is not a function", which names neither the route nor the
  // missing export.
  //
  // That is exactly how POST /files/:id/open shipped dead: openLocally was
  // written, wired into the route, and left out of module.exports. Double-click
  // reached the API and got an internal server error, and nothing had complained
  // until then.
  //
  // Routes are built at startup, so checking here turns a runtime 500 into a
  // refusal to start -- the failure arrives while you are looking at it.
  if (typeof fn !== "function") {
    throw new TypeError(
      `asyncHandler was given ${fn === undefined ? "undefined" : typeof fn}` +
      `${label ? ` for "${label}"` : ""} instead of a handler. ` +
      "This is almost always a controller function that is defined but missing from module.exports."
    );
  }
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
