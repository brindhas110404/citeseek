/**
 * Sends unexpected browser errors to /api/log (they show up in Workers Logs), so problems
 * users hit are visible without them having to report them. At most 5 per page load,
 * no duplicates, and nothing from the user's own content is included.
 */
(function () {
  let sent = 0;
  const seen = new Set();
  function report(message, source, stack) {
    const key = `${message}|${source}`;
    if (sent >= 5 || seen.has(key) || !message) return;
    seen.add(key);
    sent++;
    const body = JSON.stringify({ message: String(message).slice(0, 300), source: String(source || "").slice(0, 200), stack: String(stack || "").slice(0, 1200), page: location.pathname });
    try {
      if (!navigator.sendBeacon?.("/api/log", new Blob([body], { type: "application/json" }))) {
        fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
      }
    } catch {}
  }
  window.addEventListener("error", (e) => {
    if (!e.message || /ResizeObserver loop/.test(e.message)) return; // harmless browser noise
    report(e.message, `${e.filename || ""}:${e.lineno || 0}`, e.error?.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report(r?.message || String(r), "promise", r?.stack);
  });
})();
