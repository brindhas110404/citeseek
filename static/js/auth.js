// CiteSeek frontend · auth.js: Sign in, sign up, password reset with a recovery key or an emailed link, Turnstile.
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Sign in / create account ----------------
let authMode = "login";

// Four modes share one form: "login", "signup", "reset" (with a recovery key) and
// "newpass" (opened from an emailed reset link).
let resetLinkToken = null;
const AUTH_COPY = {
  login: {
    title: "Welcome back", sub: "Sign in to your library.", submit: "Sign in",
    user: "Your username", pass: "Your password", passLabel: "Password",
    switch: `New here? <button type="button" data-auth-tab="signup">Create an account</button>`,
  },
  signup: {
    title: "Create your library", sub: "Pick a username and password. Your papers and chats stay private to you.", submit: "Create account",
    user: "3–32 letters, numbers, dots, dashes or _", pass: "At least 10 characters", passLabel: "Password",
    switch: `Already have an account? <button type="button" data-auth-tab="login">Sign in</button>`,
  },
  newpass: {
    title: "Choose a new password", sub: "", submit: "Save new password",
    user: "", pass: "At least 10 characters", passLabel: "New password",
    switch: `<button type="button" data-auth-tab="login">Back to sign in</button>`,
  },
  reset: {
    title: "Reset your password", sub: "Enter your username and the recovery key you saved when you made your account.", submit: "Reset password",
    user: "Your username", pass: "At least 10 characters", passLabel: "New password",
    switch: `Remembered it? <button type="button" data-auth-tab="login">Sign in</button>`,
  },
};
function setAuthMode(mode) {
  authMode = mode;
  const copy = AUTH_COPY[mode];
  const newPw = mode !== "login";
  els.auth.querySelectorAll(".auth-tabs [data-auth-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.authTab === mode)));
  els.authTitle.textContent = copy.title;
  els.authSub.textContent = copy.sub;
  els.authSubmit.textContent = copy.submit;
  els.authUser.placeholder = copy.user;
  els.authPass.placeholder = copy.pass;
  els.pwLabel.textContent = copy.passLabel;
  els.authPass.autocomplete = newPw ? "new-password" : "current-password";
  els.keyField.hidden = mode !== "reset";
  els.emailField.hidden = mode !== "signup";
  els.auth.querySelector(".auth-tabs").hidden = mode === "newpass";
  els.userField.hidden = mode === "newpass";
  els.forgotBtn.hidden = mode !== "login";
  if (mode !== "newpass") resetLinkToken = null;
  els.pwHint.hidden = !newPw;
  els.pwMeter.hidden = !newPw;
  updatePwHint();
  [els.authUser, els.authPass, els.authKey, els.authEmail].forEach((i) => i.classList.remove("invalid"));
  els.authSwitch.innerHTML = copy.switch;
  els.authError.hidden = true;
}

// --- Password feedback (mirrors the server's rules in guard.ts) ---
const MIN_PW = 10;
function pwScore(p) {
  let s = 0;
  if (p.length >= MIN_PW) s++;
  if (p.length >= 14) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p) && /[^a-zA-Z0-9]/.test(p)) s++;
  return s;
}
function updatePwHint() {
  if (authMode === "login") return;
  const p = els.authPass.value, u = els.authUser.value.trim().toLowerCase();
  let msg = "Avoid common passwords and your username.", cls = "";
  if (p) {
    if (p.length < MIN_PW) { msg = `${MIN_PW - p.length} more character${MIN_PW - p.length === 1 ? "" : "s"} needed.`; cls = "bad"; }
    else if (u && p.toLowerCase().includes(u)) { msg = "Your password can't contain your username."; cls = "bad"; }
    else { msg = ["", "Okay", "Good", "Strong", "Very strong"][Math.max(1, pwScore(p))] + " password."; cls = "ok"; }
  }
  els.pwHint.textContent = msg;
  els.pwHint.className = `field-hint ${cls}`;
  els.pwMeter.dataset.score = p ? String(Math.max(1, pwScore(p))) : "0";
}
els.authPass.addEventListener("input", () => { updatePwHint(); els.authPass.classList.remove("invalid"); });
els.authUser.addEventListener("input", () => { updatePwHint(); els.authUser.classList.remove("invalid"); });
els.authKey.addEventListener("input", () => els.authKey.classList.remove("invalid"));
els.authEmail.addEventListener("input", () => els.authEmail.classList.remove("invalid"));
els.forgotBtn.addEventListener("click", () => openForgot());

// --- Cloudflare Turnstile (only when the server has keys configured) ---
let turnstileWidget = null;
let turnstileToken = "";
async function setupTurnstile() {
  if (turnstileWidget !== null) return;
  turnstileWidget = false;
  try {
    const cfg = await (await rawFetch("/api/auth/config")).json();
    if (!cfg.turnstileSiteKey) return;
    await new Promise((resolve, reject) => {
      if (window.turnstile) return resolve();
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    turnstileWidget = window.turnstile.render(els.turnstileBox, {
      sitekey: cfg.turnstileSiteKey,
      theme: "light",
      appearance: "interaction-only",
      callback: (t) => { turnstileToken = t; },
      "expired-callback": () => { turnstileToken = ""; },
      "error-callback": () => { turnstileToken = ""; },
    });
  } catch (err) {
    console.warn("Turnstile unavailable:", err);
  }
}
function resetTurnstile() {
  turnstileToken = "";
  if (turnstileWidget) try { window.turnstile.reset(turnstileWidget); } catch {}
}

// The sign-in page shows the paper globe so visitors can explore before signing up.
let landingAtlas = null;
let pendingAdd = null; // a globe paper a visitor wanted to add; added right after they sign in
async function mountLandingAtlas() {
  if (landingAtlas || !window.Atlas) return;
  landingAtlas = "mounting";
  atlas?.pause?.();
  landingAtlas = await window.Atlas.mount(document.getElementById("authGlobe"), {
    toast,
    onAdd: async (rec) => {
      pendingAdd = rec;
      els.authError.textContent = `Sign in or create an account and “${rec.t}” will be added to your library.`;
      els.authError.classList.add("info");
      els.authError.hidden = false;
      (els.authUser.value ? els.authPass : els.authUser).focus();
      throw new Error(""); // reset the card's button; nothing went wrong
    },
  }, { landing: true });
}
function unmountLandingAtlas() {
  if (landingAtlas && landingAtlas !== "mounting") landingAtlas.destroy();
  landingAtlas = null;
  atlas?.resume?.();
}

function showAuth(mode = "login", message) {
  if (!els.auth.hidden && !message) return;
  window.Court?.close();
  els.auth.hidden = false;
  els.authError.classList.remove("info");
  mountLandingAtlas();
  setupTurnstile();
  setAuthMode(mode);
  if (message) { els.authError.textContent = message; els.authError.hidden = false; }
  // On phones, don't jump past the globe to the form; on larger screens, put the cursor in the form.
  if (window.innerWidth > 860) setTimeout(() => (els.authUser.value ? els.authPass : els.authUser).focus({ preventScroll: true }), 50);
}

els.auth.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-auth-tab]");
  if (tab) { setAuthMode(tab.dataset.authTab); (els.authUser.value ? els.authPass : els.authUser).focus(); }
});
els.pwToggle.addEventListener("click", () => {
  const show = els.authPass.type === "password";
  els.authPass.type = show ? "text" : "password";
  els.pwToggle.textContent = show ? "Hide" : "Show";
  els.pwToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
});

els.authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = els.authUser.value.trim();
  const password = els.authPass.value;
  const recoveryKey = els.authKey.value.trim();
  const fail = (msg, field) => {
    els.authError.classList.remove("info");
    els.authError.textContent = msg;
    els.authError.hidden = false;
    [els.authUser, els.authPass, els.authKey, els.authEmail].forEach((i) => i.classList.remove("invalid"));
    if (field === "email") els.authEmail.classList.add("invalid");
    if (field === "username") els.authUser.classList.add("invalid");
    if (field === "password") els.authPass.classList.add("invalid");
    if (field === "recoveryKey") els.authKey.classList.add("invalid");
    els.auth.classList.remove("shake");
    void els.auth.offsetWidth;
    els.auth.classList.add("shake");
  };
  const email = els.authEmail.value.trim();
  if (authMode !== "newpass" && !username) return fail("Enter your username.", "username");
  if (authMode === "signup" && email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("That doesn't look like an email address.", "email");
  if (authMode === "reset" && recoveryKey.replace(/[^a-z0-9]/gi, "").length !== 20) {
    return fail("Recovery keys are 20 letters and numbers, like ABCDE-FGHJK-MNPQR-STVWX.", "recoveryKey");
  }
  if (!password) return fail(authMode === "reset" ? "Choose a new password." : "Enter your password.", "password");
  if (authMode !== "login" && password.length < MIN_PW) return fail(`Use at least ${MIN_PW} characters.`, "password");
  if (authMode !== "newpass" && turnstileWidget && !turnstileToken) return fail("Please finish the human check first. It should only take a second.");
  els.authSubmit.disabled = true;
  try {
    const body = authMode === "newpass"
      ? { token: resetLinkToken, password }
      : { username, password, turnstileToken, ...(authMode === "reset" ? { recoveryKey } : {}), ...(authMode === "signup" && email ? { email } : {}) };
    const res = await rawFetch(`/api/auth/${authMode === "newpass" ? "reset-link" : authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      resetTurnstile(); // tokens are single-use
      fail(data.error || "Something went wrong. Try again.", data.field);
      if (data.code === "no_user") {
        // Offer to create the account with the name they typed.
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Create it?";
        b.onclick = () => { els.authPass.value = ""; setAuthMode("signup"); els.authPass.focus(); };
        els.authError.appendChild(b);
      }
      if (data.code === "bad_password" || data.code === "bad_link") {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = data.code === "bad_link" ? "Send a new link" : "Reset it?";
        b.onclick = () => openForgot();
        els.authError.appendChild(b);
      }
      return;
    }
    const mode = authMode;
    els.authPass.value = "";
    els.authKey.value = "";
    els.authEmail.value = "";
    if (mode === "newpass") { resetLinkToken = null; history.replaceState(null, "", "/"); }
    els.auth.hidden = true;
    unmountLandingAtlas();
    await startApp(data.user, { quiet: !!data.recoveryKey || mode === "newpass" });
    if (mode === "newpass") toast("Password changed. You're signed in, and your other devices were signed out.", "success");
    if (data.recoveryKey) {
      await showRecoveryKey(data.recoveryKey, mode === "reset"
        ? { title: "Password changed", sub: "You're signed in, and every other device was signed out. Here's a fresh recovery key; the one you just used no longer works. Save it like before." }
        : { title: "Save your recovery key", sub: "If you ever forget your password, this key is the only way to reset it. CiteSeek can't show it again, so keep it in a password manager or a safe note." });
    }
    if (data.user.email && mode === "signup" && !data.user.emailVerified) confirmEmailToast(data.user.email, data);
    if (data.imported) toast(`Welcome! Your ${data.imported} existing paper${data.imported === 1 ? " is" : "s are"} now in your library.`, "success");
    if (pendingAdd) {
      const rec = pendingAdd;
      pendingAdd = null;
      addFromAtlas(rec).catch((err) => err.message && toast(err.message, "error"));
    }
  } catch {
    fail("Couldn't reach CiteSeek. Is the server running?");
  } finally {
    els.authSubmit.disabled = false;
  }
});

els.signOutBtn.addEventListener("click", async () => {
  await rawFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  ["cs.session", "cs.scope"].forEach((k) => store.set(k, null));
  location.reload();
});
