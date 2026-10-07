// CiteSeek frontend · atlas.js: Mounting the paper atlas globe and adding globe papers to the library.
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Paper atlas (globe on the home screen) ----------------
let atlas = null;
let atlasMounting = false;
async function mountAtlas() {
  if (atlas || atlasMounting || !window.Atlas) return;
  atlasMounting = true;
  try {
    atlas = await window.Atlas.mount(document.getElementById("atlas"), {
      toast,
      onAdd: addFromAtlas,
      onUploadOwn: uploadOwnCopy,
    });
  } finally { atlasMounting = false; }
}

/** "Upload the PDF yourself" for a globe paper: opens the file picker and keeps the paper's title. */
let ownCopy = null;
function uploadOwnCopy(rec) {
  ownCopy = { title: rec.t, at: Date.now() };
  els.fileInput.click();
}

/** Downloads an open-access PDF for a globe paper and runs it through the normal upload. */
async function addFromAtlas(rec) {
  if (papers.some((p) => p.title.toLowerCase() === rec.t.toLowerCase())) {
    throw new Error("That paper is already in your library.");
  }
  // The server tries the paper's own link, then free copies found by title (arXiv first).
  const res = await fetch(`/api/atlas/pdf?url=${encodeURIComponent(rec.pdf || "")}&title=${encodeURIComponent(rec.t)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || "Couldn't download that PDF."), { code: err.code });
  }
  const source = res.headers.get("X-Paper-Source");
  const blob = await res.blob();
  const name = `${rec.t.replace(/[^\w\s-]/g, "").slice(0, 80).trim() || "paper"}.pdf`;
  const file = new File([blob], name, { type: "application/pdf" });
  selectedFile = file;
  els.paperTitle.value = rec.t; // we already know the real title
  extracting = readPaper(file);
  skipPaperCheck = true; // it's from the paper atlas
  toast(source && source !== "the paper's site"
    ? `Adding “${rec.t}” (free copy from ${source})…`
    : `Adding “${rec.t}” to your library…`);
  if (!(await startUpload())) throw new Error(""); // startUpload already showed why
}

async function startApp(user, { quiet = false } = {}) {
  currentUser = user;
  updateRecoveryDot();
  // No way to recover the account yet: nudge (at most once a day) to set one up.
  if (!quiet && !hasRecovery() && store.get("cs.keyNag") !== new Date().toDateString()) {
    store.set("cs.keyNag", new Date().toDateString());
    setTimeout(() => toast("Add an email or a recovery key so you can reset your password if you forget it.", "", { label: "Set up", onClick: openAccount }), 1200);
  }
  els.userName.textContent = user.username;
  els.userAvatar.textContent = user.username.slice(0, 1);
  // A different person signed in on this browser: don't carry over the last person's chat or scope.
  if (store.get("cs.user") !== user.id) {
    ["cs.session", "cs.scope"].forEach((k) => store.set(k, null));
    sessionId = newId();
    store.set("cs.session", sessionId);
    activePaperId = null;
    store.set("cs.user", user.id);
  }
  await Promise.all([loadPapers(), loadChats()]);
  setScope(activePaperId && paperById(activePaperId) ? activePaperId : null, { silent: true });
  showHome();
  mountAtlas();
}
