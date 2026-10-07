// CiteSeek frontend · views.js: Home screen, switching views, and the Archive / Recently deleted pages.
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Home & views ----------------
async function loadChats() {
  try {
    const data = await (await fetch("/api/chats")).json();
    chats = data.chats || [];
  } catch { chats = []; }
  renderLibrary();
  // Asking in an archived conversation moves it back to the library, so keep the badges in step.
  if (chatCounts.archived || chatCounts.deleted) refreshCounts();
}

function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? "s" : ""} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function setView(v) {
  view = v;
  const shelf = v === "archive" || v === "trash";
  els.app.classList.toggle("view-home", v === "home");
  els.app.classList.toggle("view-shelf", shelf);
  els.home.hidden = v !== "home";
  els.shelf.hidden = !shelf;
  els.navArchive.classList.toggle("active", v === "archive");
  els.navTrash.classList.toggle("active", v === "trash");
  if (shelf) {
    els.scopeValue.textContent = v === "archive" ? "Archive" : "Recently deleted";
    els.scopeAll.classList.remove("active");
    els.papersList.querySelectorAll(".paper.active").forEach((x) => x.classList.remove("active"));
  }
  els.homeBtn.setAttribute("aria-current", v === "home" ? "page" : "false");
  if (v === "home") {
    els.scopeValue.textContent = "Home";
    els.scopeAll.classList.remove("active");
    els.papersList.querySelectorAll(".paper.active").forEach((x) => x.classList.remove("active"));
  }
}

function showHome() {
  closeDrawer();
  closeSidebar();
  setView("home");
  renderHome();
  els.home.scrollTop = 0;
}

function startChat({ paperId = null, question = null } = {}) {
  sessionId = newId();
  store.set("cs.session", sessionId);
  answers.length = 0;
  closeDrawer();
  setView("chat");
  setScope(paperId, { silent: true });
  renderIntro();
  if (question) ask(question);
  else els.input.focus();
}

async function continueChat(id, rec) {
  const r = rec || chats.find((x) => x.id === id);
  sessionId = id;
  store.set("cs.session", id);
  answers.length = 0;
  closeDrawer();
  setView("chat");
  setScope(r?.paperId && paperById(r.paperId) ? r.paperId : null, { silent: true });
  const ok = await loadHistory();
  if (!ok) {
    renderIntro();
    toast("That conversation is no longer available");
  }
}

function renderHome() {
  const ready = papers.filter((p) => p.status === "ready");

  // Suggested questions drawn from the library
  const seen = new Set();
  const qs = ready.flatMap((p) => (p.questions || []).slice(0, 2))
    .filter((q) => { const k = q.toLowerCase().trim(); return seen.has(k) ? false : seen.add(k); })
    .slice(0, 4);
  els.homeSuggest.innerHTML = qs.map((q) => `<button class="chip" data-home-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("");
  els.homeAskInput.placeholder = ready.length
    ? `Ask across ${ready.length === 1 ? "your paper" : `all ${ready.length} papers`}…`
    : "Add a paper first, then ask anything…";

  // Recent conversations
  const recents = chats;
  const ICON_CHAT = `<svg viewBox="0 0 24 24"><path d="M5 6h14v9H9l-4 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
  els.homeRecent.innerHTML = `<div class="home-card-head"><span>Continue where you left off</span></div>` + (recents.length
    ? `<div class="recent-list">${recents.slice(0, 4).map((r) => {
        const p = r.paperId && paperById(r.paperId);
        return `<button class="recent" data-recent="${r.id}">
          <span class="recent-icon">${ICON_CHAT}</span>
          <span class="recent-body"><span class="recent-q">${escapeHtml(r.title)}</span>
          <span class="recent-meta">${escapeHtml(p ? p.title : r.paperId ? "Archived or deleted paper" : "Whole library")} · ${timeAgo(r.updatedAt)}</span></span>
          <span class="recent-go">›</span></button>`;
      }).join("")}</div>`
    : `<div class="home-empty">No conversations yet. Ask a question above or open a paper from your library to start one.</div>`);

  // Library cards
  els.homeLibCount.textContent = papers.length ? String(papers.length) : "";
  els.homePapers.innerHTML = papers.length
    ? papers.map((p) => {
        const ext = (p.filename.split(".").pop() || "txt").slice(0, 3).toUpperCase();
        const foot = p.status === "ready" ? "Open brief & ask →" : p.status === "failed" ? "Indexing failed" : escapeHtml(p.stage || "Processing…");
        return `<button class="pcard ${p.status}" data-open-paper="${p.id}">
          <span class="pcard-top"><span class="pcard-ext">${escapeHtml(ext)}</span>${p.chunkCount ? `${p.chunkCount} passages` : `${(p.wordCount || 0).toLocaleString()} words`}</span>
          <span class="pcard-title">${escapeHtml(p.title)}</span>
          ${p.summary ? `<span class="pcard-sum">${escapeHtml(p.summary)}</span>` : ""}
          <span class="pcard-foot">${foot}</span>
        </button>`;
      }).join("")
    : `<div class="home-empty">Your library is empty. Shoot your first paper in and CiteSeek will chunk, embed and summarize it for you.</div>`;
}

els.homeBtn.addEventListener("click", showHome);
els.homeAsk.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = els.homeAskInput.value.trim();
  if (!q) return els.homeAskInput.focus();
  if (!papers.some((p) => p.status === "ready")) return toast("Add a paper first, then ask away", "error");
  els.homeAskInput.value = "";
  startChat({ paperId: null, question: q });
});
els.homeDrop.addEventListener("click", () => els.fileInput.click());
els.home.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-home-q]");
  if (chip) return startChat({ paperId: null, question: chip.dataset.homeQ });
  const rec = e.target.closest("[data-recent]");
  if (rec) return continueChat(rec.dataset.recent);
  const card = e.target.closest("[data-open-paper]");
  if (card) return startChat({ paperId: card.dataset.openPaper });
});

function closeSidebar() {
  els.sidebar.classList.remove("open");
  if (!els.drawer.classList.contains("open")) els.scrim.classList.remove("show");
}
els.menuBtn.addEventListener("click", () => { els.sidebar.classList.add("open"); els.scrim.classList.add("show"); });
els.scrim.addEventListener("click", () => { closeSidebar(); closeDrawer(); });

// ---------------- Archive & Recently deleted ----------------
let emptyArmed = false;
const DAY = 86_400_000;

async function showShelf(kind) {
  closeDrawer();
  closeSidebar();
  setView(kind);
  armedDelete = null;
  emptyArmed = false;
  els.shelfList.innerHTML = "";
  const state = kind === "archive" ? "archived" : "deleted";
  const [pRes, cRes] = await Promise.all([
    fetch(`/api/papers?state=${state}`).then((r) => r.json()).catch(() => ({})),
    fetch(`/api/chats?state=${state}&limit=300`).then((r) => r.json()).catch(() => ({})),
  ]);
  shelfPapers = pRes.papers || [];
  shelfChats = cRes.chats || [];
  if (pRes.counts) counts = pRes.counts;
  if (pRes.chatCounts) chatCounts = pRes.chatCounts;
  renderCounts();
  renderShelf();
}

const ICON_CHAT = `<svg viewBox="0 0 24 24"><path d="M5 5.5h14a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 013.5 15V7A1.5 1.5 0 015 5.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/** The tag on a conversation: which paper it's about. */
function chatTag(c) {
  if (!c.paperId) return `<span class="chat-tag lib">Whole library</span>`;
  if (!c.paperTitle) return `<span class="chat-tag gone">Erased paper</span>`;
  const note = c.paperState === "archived" ? " · archived" : c.paperState === "deleted" ? " · deleted" : "";
  return `<span class="chat-tag" title="${escapeHtml(c.paperTitle)}">${ICON_DOC}<span>${escapeHtml(c.paperTitle)}</span>${note ? `<em>${note}</em>` : ""}</span>`;
}
const ICON_DOC = `<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20a.5.5 0 01-.5.5h-10.5a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5zM14 3.5V8h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function trashMeta(deletedAt, purgeAt) {
  const days = Math.max(0, Math.ceil(((purgeAt ?? Date.now()) - Date.now()) / DAY));
  return `Deleted ${timeAgo(deletedAt)} · <span class="${days <= 3 ? "soon" : ""}">erased ${days <= 1 ? "within a day" : `in ${days} days`}</span>`;
}

function renderShelf() {
  const trash = view === "trash";
  const total = shelfPapers.length + shelfChats.length;
  els.shelfTitle.textContent = trash ? "Recently deleted" : "Archive";
  els.shelfDesc.textContent = trash
    ? "Deleted papers and conversations stay here for 30 days, then they're erased for good. Restore one to put it back."
    : "Archived papers and conversations are hidden from your library. Archived papers are also left out of search. Unarchive to bring one back.";
  els.emptyTrashBtn.hidden = !trash || !total;
  els.emptyTrashBtn.classList.toggle("armed", emptyArmed);
  els.emptyTrashBtn.textContent = emptyArmed ? "Click again to erase all" : "Empty Recently deleted";

  if (!total) {
    els.shelfList.innerHTML = `<div class="shelf-empty">${trash ? ICON_TRASH : ICON_ARCHIVE}
      <b>${trash ? "Nothing in Recently deleted" : "Nothing archived"}</b>
      ${trash ? "Papers and conversations you delete show up here for 30 days." : "Use the archive button on a paper or a conversation in your library to tuck it away here."}</div>`;
    return;
  }
  const paperRows = shelfPapers.map((p) => {
    const ext = (p.filename.split(".").pop() || "txt").slice(0, 3).toUpperCase();
    const meta = trash ? trashMeta(p.deletedAt, p.purgeAt) : `Archived ${timeAgo(p.archivedAt)} · ${p.chunkCount} passages`;
    const actions = trash
      ? `<button class="btn btn-primary" data-restore="${p.id}">Restore</button>
         <button class="btn btn-ghost danger ${armedDelete === p.id ? "armed" : ""}" data-forever="${p.id}">${armedDelete === p.id ? "Click again to erase" : "Delete forever"}</button>`
      : `<button class="btn btn-primary" data-unarchive="${p.id}">Unarchive</button>
         <button class="btn btn-ghost danger" data-shelf-del="${p.id}">Delete</button>`;
    return `<div class="shelf-item${trash ? "" : " openable"}" ${trash ? "" : `data-open-archived="${p.id}" title="Open this paper"`}>
      <div class="paper-icon">${escapeHtml(ext)}</div>
      <div class="shelf-body"><div class="shelf-name">${escapeHtml(p.title)}</div><div class="shelf-meta">${meta}</div></div>
      <div class="shelf-actions">${actions}</div>
    </div>`;
  }).join("");
  const chatRows = shelfChats.map((c) => {
    const key = `c:${c.id}`;
    const q = `${c.messageCount} question${c.messageCount === 1 ? "" : "s"}`;
    const meta = trash ? trashMeta(c.deletedAt, c.purgeAt) : `Archived ${timeAgo(c.archivedAt)} · ${q}`;
    const actions = trash
      ? `<button class="btn btn-primary" data-chat-restore="${c.id}">Restore</button>
         <button class="btn btn-ghost danger ${armedDelete === key ? "armed" : ""}" data-chat-forever="${c.id}">${armedDelete === key ? "Click again to erase" : "Delete forever"}</button>`
      : `<button class="btn btn-primary" data-chat-restore="${c.id}">Unarchive</button>
         <button class="btn btn-ghost danger" data-chat-shelf-del="${c.id}">Delete</button>`;
    return `<div class="shelf-item chat-item${trash ? "" : " openable"}" ${trash ? "" : `data-open-chat="${c.id}" title="Open this conversation"`}>
      <div class="chat-icon">${ICON_CHAT}</div>
      <div class="shelf-body">
        <div class="shelf-name">${escapeHtml(c.title)}</div>
        <div class="shelf-meta">${chatTag(c)}<span>${meta}</span></div>
      </div>
      <div class="shelf-actions">${actions}</div>
    </div>`;
  }).join("");
  const section = (label, n, rows) => n ? `<h3 class="shelf-section">${label} <span>${n}</span></h3>${rows}` : "";
  els.shelfList.innerHTML = section("Papers", shelfPapers.length, paperRows) + section("Conversations", shelfChats.length, chatRows);
}

els.navArchive.addEventListener("click", () => showShelf("archive"));
els.navTrash.addEventListener("click", () => showShelf("trash"));

els.shelfList.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) {
    const item = e.target.closest("[data-open-archived]");
    if (item) startChat({ paperId: item.dataset.openArchived });
    const chatItem = e.target.closest("[data-open-chat]");
    if (chatItem) {
      const rec = shelfChats.find((x) => x.id === chatItem.dataset.openChat);
      continueChat(chatItem.dataset.openChat, rec);
      toast("This conversation is archived. Ask something and it moves back to your library.");
    }
    return;
  }
  const chatId = t.dataset.chatRestore || t.dataset.chatShelfDel || t.dataset.chatForever;
  if (chatId) return shelfChatAction(t, chatId);
  const id = t.dataset.restore || t.dataset.unarchive || t.dataset.forever || t.dataset.shelfDel;
  const p = shelfPapers.find((x) => x.id === id);
  if (t.dataset.restore || t.dataset.unarchive) {
    shelfPapers = shelfPapers.filter((x) => x.id !== id);
    return restorePaper(id, `“${p?.title}” is back in your library`);
  }
  if (t.dataset.shelfDel) {
    try {
      await setPaperState(id, "deleted");
      shelfPapers = shelfPapers.filter((x) => x.id !== id);
      await loadPapers();
      renderShelf();
      toast(`Moved “${p?.title}” to Recently deleted`, "", { label: "Undo", onClick: async () => { await setPaperState(id, "archived"); showShelf("archive"); loadPapers(); } });
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  if (t.dataset.forever) {
    clearTimeout(armTimer);
    if (armedDelete !== id) {
      armedDelete = id;
      renderShelf();
      armTimer = setTimeout(() => { armedDelete = null; renderShelf(); }, 4000);
      return;
    }
    armedDelete = null;
    try {
      const res = await fetch(`/api/papers/${id}?permanent=1`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      shelfPapers = shelfPapers.filter((x) => x.id !== id);
      shelfChats = shelfChats.filter((x) => x.paperId !== id); // its conversations are erased with it
      await refreshCounts();
      await loadChats();
      renderShelf();
      toast(`Erased “${p?.title}” and its conversations for good`);
    } catch (err) { toast(err.message || "Couldn't erase paper", "error"); }
  }
});

async function shelfChatAction(t, id) {
  const c = shelfChats.find((x) => x.id === id);
  const name = c ? `“${c.title.length > 40 ? c.title.slice(0, 40) + "…" : c.title}”` : "Conversation";
  const drop = () => { shelfChats = shelfChats.filter((x) => x.id !== id); };
  try {
    if (t.dataset.chatRestore) {
      await setChatStateApi(id, "active");
      drop();
      await loadChats();
      // A conversation about a paper that's not in the library won't show in the sidebar.
      const hidden = c?.paperId && c.paperState !== "active";
      toast(hidden
        ? `Restored ${name}. Its paper is ${c.paperState === "archived" ? "archived" : c.paperTitle ? "in Recently deleted" : "erased"}; ${c.paperTitle ? "restore the paper to see it in the sidebar" : "you can still open it from Home"}.`
        : `${name} is back in your library`, "success");
    } else if (t.dataset.chatShelfDel) {
      await setChatStateApi(id, "deleted");
      drop();
      toast(`Moved ${name} to Recently deleted`, "", { label: "Undo", onClick: async () => { await setChatStateApi(id, "archived"); showShelf("archive"); } });
    } else if (t.dataset.chatForever) {
      const key = `c:${id}`;
      clearTimeout(armTimer);
      if (armedDelete !== key) {
        armedDelete = key;
        renderShelf();
        armTimer = setTimeout(() => { armedDelete = null; renderShelf(); }, 4000);
        return;
      }
      armedDelete = null;
      const res = await fetch(`/api/chat/${id}?permanent=1`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't erase it");
      drop();
      toast(`Erased ${name} for good`);
    }
    await refreshCounts();
    renderShelf();
  } catch (err) { toast(err.message || "Couldn't update that conversation", "error"); }
}

els.emptyTrashBtn.addEventListener("click", async () => {
  if (!emptyArmed) {
    emptyArmed = true;
    renderShelf();
    setTimeout(() => { emptyArmed = false; if (view === "trash") renderShelf(); }, 4000);
    return;
  }
  emptyArmed = false;
  try {
    const data = await (await fetch("/api/papers/empty-trash", { method: "POST" })).json();
    shelfPapers = [];
    shelfChats = [];
    await refreshCounts();
    await loadChats();
    renderShelf();
    const parts = [];
    if (data.erased) parts.push(`${data.erased} paper${data.erased === 1 ? "" : "s"}`);
    if (data.chatsErased) parts.push(`${data.chatsErased} conversation${data.chatsErased === 1 ? "" : "s"}`);
    toast(parts.length ? `Erased ${parts.join(" and ")} for good` : "Recently deleted is empty");
  } catch { toast("Couldn't empty Recently deleted", "error"); }
});
