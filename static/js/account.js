// CiteSeek frontend · account.js: Recovery keys, forgot-password popup, the Account panel (email, devices, export, delete).
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Recovery key ----------------
let keyResolve = null;
let shownKey = "";
function openKeyModal() {
  els.keyModal.hidden = false;
  els.keyError.hidden = true;
}
function closeKeyModal() {
  els.keyModal.hidden = true;
  els.keyPass.value = "";
  shownKey = "";
  els.keyCode.textContent = "";
  keyResolve?.();
  keyResolve = null;
}
/** Shows a recovery key until the user confirms they saved it. */
function showRecoveryKey(key, { title, sub }) {
  shownKey = key;
  els.keyTitle.textContent = title;
  els.keySub.textContent = sub;
  els.keyCode.textContent = key;
  els.keyConfirm.hidden = true;
  els.keyShow.hidden = false;
  els.keySaved.checked = false;
  els.keyDone.disabled = true;
  els.keyCopy.textContent = "Copy";
  openKeyModal();
  els.keyCopy.focus();
  return new Promise((resolve) => { keyResolve = resolve; });
}
/** From the sidebar: confirm the password, then show a new key (replacing the old one). */
function openKeySetup() {
  const has = currentUser?.hasRecoveryKey;
  els.keyTitle.textContent = has ? "New recovery key" : "Create a recovery key";
  els.keySub.textContent = has
    ? "Lost your key, or worried someone saw it? Make a new one. Your current key will stop working."
    : "Your account doesn't have a recovery key yet. Without one, a forgotten password can't be reset from the sign-in page.";
  els.keyCreate.textContent = has ? "Replace my key" : "Create recovery key";
  els.keyConfirm.hidden = false;
  els.keyShow.hidden = true;
  openKeyModal();
  setTimeout(() => els.keyPass.focus(), 30);
}
els.keyBtn.addEventListener("click", () => openAccount());
els.keyCancel.addEventListener("click", closeKeyModal);
els.keyConfirm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = (m) => { els.keyError.textContent = m; els.keyError.hidden = false; els.keyPass.classList.add("invalid"); };
  if (!els.keyPass.value) return err("Enter your password.");
  els.keyCreate.disabled = true;
  try {
    const res = await fetch("/api/account/recovery-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: els.keyPass.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(data.error || "Couldn't create a key. Try again.");
    const replaced = currentUser.hasRecoveryKey;
    currentUser.hasRecoveryKey = true;
    updateRecoveryDot();
    els.keyPass.value = "";
    els.keyPass.classList.remove("invalid");
    showRecoveryKey(data.recoveryKey, {
      title: "Your recovery key",
      sub: replaced ? "Your old key no longer works. Save this one somewhere safe; it won't be shown again." : "Save it somewhere safe, like a password manager. It won't be shown again.",
    });
  } catch {
    err("Couldn't reach CiteSeek. Is the server running?");
  } finally {
    els.keyCreate.disabled = false;
  }
});
els.keyPass.addEventListener("input", () => { els.keyPass.classList.remove("invalid"); els.keyError.hidden = true; });
els.keyCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shownKey);
    els.keyCopy.textContent = "Copied ✓";
  } catch {
    getSelection().selectAllChildren(els.keyCode); // fall back: select it so ⌘C works
    els.keyCopy.textContent = "Press ⌘C / Ctrl+C";
  }
});
els.keyDownload.addEventListener("click", () => {
  const name = currentUser?.username || "account";
  const text = `CiteSeek recovery key\n\nUsername: ${name}\nRecovery key: ${shownKey}\nCreated: ${new Date().toLocaleString()}\n\n` +
    `If you forget your password: on the sign-in page click "Forgot password?",\nenter your username, this key and a new password.\n` +
    `Each key works once; you'll get a new one after a reset.\n`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = `citeseek-recovery-key-${name}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
els.keySaved.addEventListener("change", () => { els.keyDone.disabled = !els.keySaved.checked; });
els.keyDone.addEventListener("click", closeKeyModal);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Escape only closes the password step; a key on screen needs "Done" so it isn't lost by accident.
  if (!els.keyModal.hidden) { if (!els.keyConfirm.hidden) closeKeyModal(); return; }
  if (!els.forgotModal.hidden) closeForgot();
  else if (!els.acctModal.hidden) closeAccount();
});

// ---------------- Forgot password (email link) ----------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let forgotWidget = null;
let forgotToken = "";
let forgotRendering = false;
async function renderForgotTurnstile(tries = 0) {
  if (forgotWidget) { try { window.turnstile.reset(forgotWidget); } catch {} forgotToken = ""; return; }
  if (forgotWidget === false || (forgotRendering && tries === 0)) return; // no bot check configured, or already on it
  forgotRendering = true;
  try {
    const cfg = await (await rawFetch("/api/auth/config")).json();
    if (!cfg.turnstileSiteKey) { forgotWidget = false; return; }
    // The sign-in form loads Turnstile's script; wait for it if it's still arriving.
    if (!window.turnstile) { if (tries < 30) setTimeout(() => renderForgotTurnstile(tries + 1), 300); return; }
    forgotWidget = window.turnstile.render(els.forgotTurnstile, {
      sitekey: cfg.turnstileSiteKey, theme: "light", appearance: "interaction-only",
      callback: (t) => { forgotToken = t; }, "expired-callback": () => { forgotToken = ""; }, "error-callback": () => { forgotToken = ""; },
    });
  } catch {} finally { if (forgotWidget !== null || tries >= 30) forgotRendering = false; }
}
function openForgot() {
  els.forgotForm.hidden = false;
  els.forgotSent.hidden = true;
  els.forgotError.hidden = true;
  els.forgotEmail.classList.remove("invalid");
  const typed = els.authUser.value.trim();
  if (!els.forgotEmail.value && EMAIL_RE.test(typed)) els.forgotEmail.value = typed;
  els.forgotModal.hidden = false;
  renderForgotTurnstile();
  setTimeout(() => els.forgotEmail.focus(), 30);
}
function closeForgot() { els.forgotModal.hidden = true; }
els.forgotModal.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === els.forgotModal) closeForgot(); });
els.forgotUseKey.addEventListener("click", () => {
  closeForgot();
  els.authPass.value = "";
  setAuthMode("reset");
  (els.authUser.value ? els.authKey : els.authUser).focus();
});
els.forgotAgain.addEventListener("click", openForgot);
els.forgotSentKey.addEventListener("click", () => els.forgotUseKey.click());
els.forgotEmail.addEventListener("input", () => { els.forgotEmail.classList.remove("invalid"); els.forgotError.hidden = true; });
els.forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = els.forgotEmail.value.trim();
  const err = (m) => { els.forgotError.textContent = m; els.forgotError.hidden = false; els.forgotEmail.classList.add("invalid"); };
  if (!EMAIL_RE.test(email)) return err("Enter the email address on your account.");
  if (forgotWidget && !forgotToken) return err("Please finish the human check first.");
  els.forgotSend.disabled = true;
  try {
    const res = await rawFetch("/api/auth/forgot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, turnstileToken: forgotToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { renderForgotTurnstile(); return err(data.error || "Something went wrong. Try again."); }
    // Local dev with no email service: skip the inbox and go straight to choosing a new password.
    if (data.devLink) { location.href = data.devLink; return; }
    els.forgotSentText.innerHTML = `If a CiteSeek account uses <strong>${escAttr(email)}</strong>, an email is on its way: a link to reset your password (works once, expires in ${data.minutes || 30} minutes), or, if the address was never confirmed, a link to confirm it first. Check spam if it isn't there in a minute.`;
    els.forgotDev.hidden = !data.devMode && !data.mailError;
    if (data.mailError) els.forgotDev.innerHTML = `<strong>Email failed (shown on localhost only):</strong> ${escAttr(data.mailError)}`;
    if (data.devMode && !data.mailError) {
      els.forgotDev.innerHTML = data.devLink
        ? ""
        : `<strong>Local dev:</strong> no account uses this email. Sign in and add it from the 🔑 button first. (Only shown on localhost.)`;
    }
    els.forgotForm.hidden = true;
    els.forgotSent.hidden = false;
  } catch {
    err("Couldn't reach CiteSeek. Is the server running?");
  } finally {
    els.forgotSend.disabled = false;
  }
});

/** Opened from an emailed link: /?reset=<token> */
async function openResetLink(token) {
  showAuth("login");
  const res = await rawFetch("/api/auth/reset-token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) {
    history.replaceState(null, "", "/");
    els.authError.textContent = data.error || "Couldn't check that reset link.";
    els.authError.hidden = false;
    const b = document.createElement("button");
    b.type = "button"; b.textContent = "Send a new link"; b.onclick = () => openForgot();
    els.authError.appendChild(b);
    return;
  }
  els.authUser.value = data.username; // lets password managers save it, and powers the "contains username" check
  els.authPass.value = "";
  setAuthMode("newpass");
  resetLinkToken = token;
  els.authSub.innerHTML = `For the account <strong>${escAttr(data.username)}</strong>. You'll be signed out everywhere else.`;
  setTimeout(() => els.authPass.focus(), 60);
}

/** Opened from a confirmation email: /?verify=<token>. Returns a message to show. */
async function confirmEmailLink(token) {
  history.replaceState(null, "", "/");
  try {
    const res = await rawFetch("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const data = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, text: `Email confirmed: ${data.email}. You can now reset your password by email.` }
      : { ok: false, text: data.error || "Couldn't confirm that email." };
  } catch {
    return { ok: false, text: "Couldn't reach CiteSeek to confirm your email." };
  }
}

function confirmEmailToast(email, data) {
  if (data.devLink) {
    showBannerDevLink(data.devLink);
  } else if (data.mailError) {
    toast(`Account created, but the confirmation email couldn't be sent. ${data.mailError}`, "error");
  } else {
    toast(`We sent a confirmation link to ${email}. Click it to turn on email resets.`, "success");
  }
}

// ---------------- Account: password recovery ----------------
const hasRecovery = () => !!(currentUser?.hasRecoveryKey || currentUser?.emailVerified);
function updateRecoveryDot() {
  els.keyDot.hidden = hasRecovery();
  updateVerifyBanner();
}

// Reminder shown in the app until the account's email is confirmed (hidden for this visit with ×).
let bannerDismissed = false;
/** Local dev only: no email gets sent, so put the confirmation link right in the banner (it stays put). */
let bannerDevFor = null;
const BANNER_TEXT = `Confirm your email to turn on password resets. We sent a link to <strong id="vbEmail"></strong>.`;
function showBannerDevLink(link) {
  bannerDevFor = currentUser.email;
  els.verifyBanner.querySelector(".vb-text").innerHTML =
    `<strong>Local dev:</strong> no email service is set up, so nothing was sent to ${escAttr(currentUser.email)}. ` +
    `<a href="${escAttr(link)}">Confirm my email now →</a>`;
}
function updateVerifyBanner() {
  const show = !!(currentUser?.email && !currentUser.emailVerified && !bannerDismissed);
  els.verifyBanner.hidden = !show;
  if (show && bannerDevFor !== currentUser.email) {
    bannerDevFor = null;
    els.verifyBanner.querySelector(".vb-text").innerHTML = BANNER_TEXT;
    document.getElementById("vbEmail").textContent = currentUser.email;
  }
}
els.vbClose.addEventListener("click", () => { bannerDismissed = true; updateVerifyBanner(); });
els.vbChange.addEventListener("click", () => { openAccount(); openAcctForm("save"); });
els.vbResend.addEventListener("click", async () => {
  els.vbResend.disabled = true;
  try {
    const res = await fetch("/api/account/email/resend", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || "Couldn't send the link.", "error");
    if (data.emailVerified) { currentUser.emailVerified = true; renderAccount(); return toast(`Email confirmed: ${currentUser.email}.`, "success"); }
    if (data.devLink) showBannerDevLink(data.devLink);
    else if (data.mailError) toast(`Couldn't send the email. ${data.mailError}`, "error");
    else toast(`Sent a new confirmation link to ${currentUser.email}. Check spam if it's not there.`, "success");
  } finally { els.vbResend.disabled = false; }
});
// Confirming usually happens in another tab (from the email). Catch up when this tab is looked at again.
async function refreshEmailStatus() {
  if (!currentUser?.email || currentUser.emailVerified || document.hidden) return;
  try {
    const data = await (await rawFetch("/api/auth/me")).json();
    if (data.user?.emailVerified) {
      currentUser.emailVerified = true;
      currentUser.email = data.user.email;
      renderAccount();
      toast(`Email confirmed: ${data.user.email}. Password resets by email are on.`, "success");
    }
  } catch {}
}
document.addEventListener("visibilitychange", refreshEmailStatus);
window.addEventListener("focus", refreshEmailStatus);

function renderAccount() {
  const u = currentUser || {};
  els.acctEmail.textContent = u.email || "Not added";
  els.acctEmailBadge.textContent = u.email ? (u.emailVerified ? "Confirmed" : "Not confirmed") : "Off";
  els.acctEmailBadge.className = `badge ${u.email ? (u.emailVerified ? "ok" : "warn") : ""}`;
  els.acctEmailEdit.textContent = u.email ? "Change" : "Add email";
  els.acctEmailResend.hidden = !u.email || u.emailVerified;
  els.acctEmailRemove.hidden = !u.email;
  els.acctKeyText.textContent = u.hasRecoveryKey ? "Saved when you created it. Lost it? Make a new one." : "Not set up";
  els.acctKeyBadge.textContent = u.hasRecoveryKey ? "Set up" : "Off";
  els.acctKeyBadge.className = `badge ${u.hasRecoveryKey ? "ok" : ""}`;
  els.acctKeyBtn.textContent = u.hasRecoveryKey ? "Create new key" : "Create key";
  updateRecoveryDot();
}
let acctAction = "save"; // "save" or "remove"
function openAccount() {
  renderAccount();
  closeAcctForm();
  closeDeleteForm();
  els.acctDev.hidden = true;
  els.acctModal.hidden = false;
  loadDevices();
}

// --- Signed-in devices ---
async function loadDevices() {
  els.deviceList.innerHTML = `<li class="muted">Loading…</li>`;
  try {
    const { sessions = [] } = await (await fetch("/api/account/sessions")).json();
    els.deviceList.innerHTML = sessions.map((s) => `
      <li>
        <span class="dv-main"><strong>${escapeHtml(s.device)}</strong><small>${s.current ? "Active now" : `Last active ${timeAgo(s.lastSeen)}`} · signed in ${timeAgo(s.createdAt)}</small></span>
        ${s.current ? `<span class="this">This device</span>` : `<button type="button" class="dv-out" data-revoke="${s.id}">Sign out</button>`}
      </li>`).join("") || `<li class="muted">No devices.</li>`;
    els.signOutOthers.hidden = sessions.filter((s) => !s.current).length < 1;
  } catch { els.deviceList.innerHTML = `<li class="muted">Couldn't load your devices.</li>`; }
}
els.deviceList.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-revoke]");
  if (!b) return;
  b.disabled = true;
  await fetch("/api/account/sessions/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.revoke }) }).catch(() => {});
  toast("Signed out that device.", "success");
  loadDevices();
});
els.signOutOthers.addEventListener("click", async () => {
  els.signOutOthers.disabled = true;
  try {
    const r = await (await fetch("/api/account/sessions/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ others: true }) })).json();
    toast(r.signedOut ? `Signed out ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}.` : "No other devices were signed in.", "success");
  } finally { els.signOutOthers.disabled = false; loadDevices(); }
});

// --- Download my data ---
els.exportBtn.addEventListener("click", async () => {
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = "Preparing…";
  try {
    const res = await fetch("/api/account/export");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't prepare your data.");
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "citeseek-data.json";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (err) { toast(err.message, "error"); }
  finally { els.exportBtn.disabled = false; els.exportBtn.textContent = "Download"; }
});

// --- Delete account ---
function closeDeleteForm() {
  els.delAcctForm.hidden = true;
  els.delAcctActions.hidden = false;
  els.delAcctName.value = els.delAcctPass.value = "";
  els.delAcctError.hidden = true;
}
els.delAcctBtn.addEventListener("click", () => {
  els.delAcctForm.hidden = false;
  els.delAcctActions.hidden = true;
  els.delAcctName.placeholder = currentUser?.username || "";
  setTimeout(() => els.delAcctName.focus(), 30);
});
els.delAcctCancel.addEventListener("click", closeDeleteForm);
els.delAcctForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = (m) => { els.delAcctError.textContent = m; els.delAcctError.hidden = false; };
  if (els.delAcctName.value.trim().toLowerCase() !== (currentUser?.username || "").toLowerCase()) return err("Type your username exactly to confirm.");
  if (!els.delAcctPass.value) return err("Enter your password.");
  els.delAcctGo.disabled = true;
  els.delAcctGo.textContent = "Deleting…";
  try {
    const res = await fetch("/api/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: els.delAcctName.value, password: els.delAcctPass.value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(data.error || "Couldn't delete the account.");
    ["cs.session", "cs.scope", "cs.user"].forEach((k) => store.set(k, null));
    closeAccount();
    showAuth("login", "Your account and everything in it has been deleted.");
    els.authError.classList.add("info");
  } catch { err("Couldn't reach CiteSeek. Is the server running?"); }
  finally { els.delAcctGo.disabled = false; els.delAcctGo.textContent = "Delete everything"; }
});
function closeAccount() { els.acctModal.hidden = true; closeAcctForm(); }
function openAcctForm(action) {
  acctAction = action;
  els.acctEmailForm.hidden = false;
  els.acctEmailActions.hidden = true;
  els.acctNewEmailField.hidden = action === "remove";
  els.acctNewEmail.value = action === "save" ? currentUser.email || "" : "";
  els.acctSave.textContent = action === "remove" ? "Remove email" : "Save and send link";
  els.acctSave.classList.toggle("danger-fill", action === "remove");
  els.acctError.hidden = true;
  setTimeout(() => (action === "remove" ? els.acctPass : els.acctNewEmail).focus(), 30);
}
function closeAcctForm() {
  els.acctEmailForm.hidden = true;
  els.acctEmailActions.hidden = false;
  els.acctPass.value = "";
  [els.acctPass, els.acctNewEmail].forEach((i) => i.classList.remove("invalid"));
}
els.acctModal.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === els.acctModal) closeAccount(); });
els.acctEmailEdit.addEventListener("click", () => openAcctForm("save"));
els.acctEmailRemove.addEventListener("click", () => openAcctForm("remove"));
els.acctCancel.addEventListener("click", closeAcctForm);
els.acctKeyBtn.addEventListener("click", () => { closeAccount(); openKeySetup(); });
function showAcctDev(data) {
  els.acctDev.hidden = !data.devLink;
  if (data.devLink) els.acctDev.innerHTML = `<strong>Local dev:</strong> no email service is set up, so nothing was sent. <a href="${escAttr(data.devLink)}">Open the confirmation link</a>`;
}
els.acctEmailResend.addEventListener("click", async () => {
  els.acctEmailResend.disabled = true;
  try {
    const res = await fetch("/api/account/email/resend", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || "Couldn't send the link.", "error");
    if (data.emailVerified) { currentUser.emailVerified = true; renderAccount(); return toast(`Email confirmed: ${currentUser.email}.`, "success"); }
    showAcctDev(data);
    if (data.mailError) toast(`Couldn't send the email. ${data.mailError}`, "error");
    else if (!data.devLink) toast(`Sent a new confirmation link to ${currentUser.email}.`, "success");
  } finally { els.acctEmailResend.disabled = false; }
});
els.acctEmailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = acctAction === "remove" ? "" : els.acctNewEmail.value.trim();
  const err = (m, field) => {
    els.acctError.textContent = m; els.acctError.hidden = false;
    (field === "email" ? els.acctNewEmail : els.acctPass).classList.add("invalid");
  };
  if (acctAction === "save" && !EMAIL_RE.test(email)) return err("That doesn't look like an email address.", "email");
  if (!els.acctPass.value) return err("Enter your password.", "password");
  els.acctSave.disabled = true;
  try {
    const res = await fetch("/api/account/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: els.acctPass.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(data.error || "Couldn't save. Try again.", data.field);
    currentUser.email = data.email;
    currentUser.emailVerified = data.emailVerified;
    closeAcctForm();
    renderAccount();
    showAcctDev(data);
    if (!email) toast("Email removed.", "success");
    else if (data.emailVerified) toast(`Email saved: ${email}. You can now reset your password by email.`, "success");
    else if (data.mailError) toast(`Saved, but the confirmation email couldn't be sent. ${data.mailError}`, "error");
    else if (!data.devLink) toast(`Sent a confirmation link to ${email}.`, "success");
  } catch {
    err("Couldn't reach CiteSeek. Is the server running?");
  } finally { els.acctSave.disabled = false; }
});
[els.acctPass, els.acctNewEmail].forEach((i) => i.addEventListener("input", () => { i.classList.remove("invalid"); els.acctError.hidden = true; }));
