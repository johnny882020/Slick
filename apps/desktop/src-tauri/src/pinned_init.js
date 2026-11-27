// Initialization script for pinned app windows (labels "app-<id>").
// Runs before the page's own scripts. It defines exactly one global: window.oneseat,
// a frozen object with one method, run(skill, input), which calls the single command a
// pinned window may use, bridge_run. The shell derives the app id from the window label;
// the page never passes it. Capabilities (capabilities/pinned-apps.json) make every other
// command, plugin and core API unreachable from this window.
(function () {
  "use strict";
  if (Object.prototype.hasOwnProperty.call(window, "oneseat")) return;
  var internals = window.__TAURI_INTERNALS__;
  var captured = internals && typeof internals.invoke === "function" ? internals.invoke.bind(internals) : null;
  var MAX_INPUT_CHARS = 1000000;

  function fail(message) {
    return Promise.reject(new TypeError("oneseat.run: " + message));
  }

  function run(skill, input) {
    if (typeof skill !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill)) return fail("skill must be a skill name");
    var isObject = typeof input === "object" && input !== null && !Array.isArray(input);
    if (typeof input !== "string" && !isObject) return fail("input must be a string or a plain object");
    var size;
    try {
      size = typeof input === "string" ? input.length : JSON.stringify(input).length;
    } catch (e) {
      return fail("input must be JSON-serialisable");
    }
    if (size > MAX_INPUT_CHARS) return fail("input is too large");
    var invoke = captured || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
    if (typeof invoke !== "function") return fail("the OneSeat bridge is not available");
    return Promise.resolve(invoke("bridge_run", { skill: skill, input: input }));
  }

  var bridge = Object.freeze({
    run: function (skill, input) {
      return run(skill, input);
    },
  });
  Object.defineProperty(window, "oneseat", { value: bridge, writable: false, configurable: false, enumerable: true });
})();
