// CiteSeek frontend · boot.js: Startup: handle emailed links, restore the session, show the app or the sign-in page.
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Boot ----------------
(async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get("reset")) return openResetLink(params.get("reset"));
  const confirmed = params.get("verify") ? await confirmEmailLink(params.get("verify")) : null;
  try {
    const res = await rawFetch("/api/auth/me");
    const data = await res.json();
    if (res.ok && data.user) {
      await startApp(data.user, { quiet: !!confirmed });
      if (confirmed) toast(confirmed.text, confirmed.ok ? "success" : "error");
      return;
    }
  } catch {}
  showAuth("login");
  if (confirmed) {
    els.authError.textContent = confirmed.ok ? `${confirmed.text} Sign in to continue.` : confirmed.text;
    els.authError.classList.toggle("info", confirmed.ok);
    els.authError.hidden = false;
  }
})();
