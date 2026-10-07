// CiteSeek frontend · library.js: The sidebar library: papers, their conversations, archive/delete actions.
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Library ----------------
async function loadPapers() {
  try {
    const res = await fetch("/api/papers");
    const data = await res.json();
    papers = data.papers || [];
    if (data.counts) counts = data.counts;
    if (data.chatCounts) chatCounts = data.chatCounts;
  } catch {
    papers = [];
  }
  if (activePaperId && !paperById(activePaperId)) setScope(null, { silent: true });
  renderLibrary();
  papers.filter((p) => p.status === "processing").forEach((p) => pollPaper(p.id));
}

function renderCounts() {
  els.archiveCount.textContent = counts.archived + chatCounts.archived || "";
  els.trashCount.textContent = counts.deleted + chatCounts.deleted || "";
}

// ---- Conversations grouped under their paper in the sidebar ----
const expanded = new Set();   // groups opened with the chevron ("all" or a paper id)
const collapsed = new Set();  // groups closed with the chevron (overrides auto-open of the current paper)
const showAllChats = new Set(); // groups showing more than the first few chats
const CHATS_SHOWN = 5;
const ICON_CHEVRON = `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const groupKey = (paperId) => paperId || "all";
const chatsFor = (paperId) => chats.filter((c) => (c.paperId || null) === (paperId || null));
function isOpen(key) {
  const activeKey = groupKey(activePaperId);
  if (collapsed.has(key)) return false;
  return expanded.has(key) || (view === "chat" && key === activeKey);
}
function shortAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d` : `${Math.round(d / 7)}w`;
}
function chatListHtml(paperId) {
  const key = groupKey(paperId);
  const list = chatsFor(paperId);
  const shown = showAllChats.has(key) ? list : list.slice(0, CHATS_SHOWN);
  const rows = shown.map((c) => `
      <div class="chat-link ${view === "chat" && c.id === sessionId ? "active" : ""}" data-chat="${c.id}" role="button" tabindex="0" title="${escapeHtml(c.title)}">
        <span class="chat-t">${escapeHtml(c.title)}</span>
        <span class="chat-time">${shortAgo(c.updatedAt)}</span>
        <button class="chat-act" data-chat-arc="${c.id}" title="Archive conversation" aria-label="Archive conversation">${ICON_ARCHIVE}</button>
        <button class="chat-act chat-del" data-chat-del="${c.id}" title="Move to Recently deleted" aria-label="Delete conversation">${ICON_TRASH}</button>
      </div>`).join("");
  const more = list.length > CHATS_SHOWN
    ? `<button class="chat-more" data-more="${key}">${showAllChats.has(key) ? "Show fewer" : `Show ${list.length - CHATS_SHOWN} more`}</button>`
    : "";
  return `<div class="chat-list">
      <button class="chat-new" data-newchat="${paperId || ""}">+ New chat</button>
      ${rows}${more}
    </div>`;
}

function renderLibrary() {
  if (view === "home") renderHome();
  renderCounts();
  els.paperCount.textContent = papers.length ? String(papers.length) : "";
  els.scopeAll.classList.toggle("active", !activePaperId && view === "chat");
  const allCount = chatsFor(null).length;
  els.scopeAll.innerHTML = `<span class="scope-dot"></span><span class="scope-all-label">Whole library<small class="scope-note">Searches every paper at once</small></span>${allCount ? `<span class="chat-count">${allCount}</span>` : ""}<span class="chev ${isOpen("all") ? "open" : ""}" data-toggle="all" role="button" aria-label="Show conversations">${ICON_CHEVRON}</span>`;
  els.allChats.innerHTML = isOpen("all") ? chatListHtml(null) : "";
  if (!papers.length) {
    els.papersList.innerHTML = `<div class="empty-lib">No papers yet. Add one above to start.</div>`;
    return;
  }
  els.papersList.innerHTML = papers.map((p) => {
    const ext = (p.filename.split(".").pop() || "txt").slice(0, 3).toUpperCase();
    const meta = p.status === "ready"
      ? `<span class="status">${p.chunkCount} passages</span>`
      : p.status === "failed"
        ? `<span class="status failed">Failed</span>`
        : `<span class="status processing">${escapeHtml(p.stage || "Processing")}</span>`;
    const n = chatsFor(p.id).length;
    const open = isOpen(p.id);
    return `
      <div class="paper ${p.id === activePaperId && view === "chat" ? "active" : ""}" data-id="${p.id}" role="button" tabindex="0">
        <div class="paper-icon">${escapeHtml(ext)}</div>
        <div class="paper-body">
          <div class="paper-title">${escapeHtml(p.title)}</div>
          <div class="paper-meta">${meta}${n ? `<span class="chat-count-inline">· ${n} chat${n === 1 ? "" : "s"}</span>` : ""}</div>
        </div>
        <span class="paper-actions">
          <button data-archive="${p.id}" title="Archive" aria-label="Archive paper">${ICON_ARCHIVE}</button>
          <button class="del" data-del="${p.id}" title="Move to Recently deleted" aria-label="Delete paper">${ICON_TRASH}</button>
        </span>
        <span class="chev ${open ? "open" : ""}" data-toggle="${p.id}" role="button" aria-label="Show conversations">${ICON_CHEVRON}</span>
      </div>
      ${open ? chatListHtml(p.id) : ""}`;
  }).join("");
}

function setScope(id, { silent = false } = {}) {
  activePaperId = id;
  store.set("cs.scope", id);
  const p = id && paperById(id);
  els.scopeValue.textContent = p ? p.title : "Whole library";
  renderLibrary();
  closeSidebar();
  if (silent) return;
  if (hasMessages()) {
    if (p) appendBrief(p);
  } else {
    renderIntro();
  }
}

/** Opens a paper (or the whole library): a fresh chat in that scope, unless we're already in an empty one there. */
function openScope(paperId) {
  if (view === "chat" && (activePaperId || null) === (paperId || null) && !hasMessages()) {
    collapsed.delete(groupKey(paperId));
    expanded.add(groupKey(paperId));
    return renderLibrary();
  }
  startChat({ paperId });
}

/** Sets a conversation's state: "active" (restore / unarchive), "archived" or "deleted". */
async function setChatStateApi(id, state) {
  const res = state === "deleted"
    ? await fetch(`/api/chat/${id}`, { method: "DELETE" })
    : await fetch(`/api/chat/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || "Something went wrong");
}
async function refreshCounts() {
  try {
    const data = await (await fetch("/api/papers")).json();
    if (data.counts) counts = data.counts;
    if (data.chatCounts) chatCounts = data.chatCounts;
    renderCounts();
  } catch {}
}
/** Takes a conversation out of the sidebar (archive or delete), with Undo. */
async function moveChat(id, state) {
  const c = chats.find((x) => x.id === id);
  try {
    await setChatStateApi(id, state);
    const wasCurrent = id === sessionId;
    chats = chats.filter((x) => x.id !== id);
    if (wasCurrent && view === "chat") startChat({ paperId: activePaperId });
    else renderLibrary();
    refreshCounts();
    const name = c ? `“${c.title.length > 40 ? c.title.slice(0, 40) + "…" : c.title}”` : "Conversation";
    toast(state === "archived" ? `Archived ${name}` : `Moved ${name} to Recently deleted`, "", {
      label: "Undo",
      onClick: async () => { await setChatStateApi(id, "active"); await loadChats(); refreshCounts(); },
    });
  } catch (err) { toast(err.message || "Couldn't update that conversation", "error"); }
}
const deleteChatById = (id) => moveChat(id, "deleted");

/** Shared handler for the sidebar's paper rows, chat lists and chevrons. */
function onSidebarClick(e) {
  const t = e.target;
  const chatDel = t.closest("[data-chat-del]");
  if (chatDel) { e.stopPropagation(); return deleteChatById(chatDel.dataset.chatDel); }
  const chatArc = t.closest("[data-chat-arc]");
  if (chatArc) { e.stopPropagation(); return moveChat(chatArc.dataset.chatArc, "archived"); }
  const toggle = t.closest("[data-toggle]");
  if (toggle) {
    e.stopPropagation();
    const key = toggle.dataset.toggle;
    if (isOpen(key)) { expanded.delete(key); collapsed.add(key); }
    else { collapsed.delete(key); expanded.add(key); }
    return renderLibrary();
  }
  const more = t.closest("[data-more]");
  if (more) { e.stopPropagation(); const k = more.dataset.more; showAllChats.has(k) ? showAllChats.delete(k) : showAllChats.add(k); return renderLibrary(); }
  const nc = t.closest("[data-newchat]");
  if (nc) { e.stopPropagation(); const pid = nc.dataset.newchat || null; return view === "chat" && (activePaperId || null) === pid && !hasMessages() ? els.input.focus() : startChat({ paperId: pid }); }
  const chat = t.closest("[data-chat]");
  if (chat) { e.stopPropagation(); return chat.dataset.chat === sessionId && view === "chat" ? closeSidebar() : continueChat(chat.dataset.chat); }
  const del = t.closest("[data-del]");
  if (del) { e.stopPropagation(); return deletePaper(del.dataset.del); }
  const arc = t.closest("[data-archive]");
  if (arc) { e.stopPropagation(); return archivePaper(arc.dataset.archive); }
  const card = t.closest(".paper");
  if (card) return openScope(card.dataset.id);
}
els.papersList.addEventListener("click", onSidebarClick);
els.allChats.addEventListener("click", onSidebarClick);
els.papersList.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.target.classList.contains("paper") || e.target.matches("[data-chat]"))) e.target.click();
});
els.scopeAll.addEventListener("click", (e) => {
  if (e.target.closest("[data-toggle]")) return onSidebarClick(e);
  openScope(null);
});
els.allChats.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-chat]")) e.target.click(); });

/** Changes a paper's state (active / archived / deleted). */
async function setPaperState(id, state) {
  const res = state === "deleted"
    ? await fetch(`/api/papers/${id}`, { method: "DELETE" })
    : await fetch(`/api/papers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "Something went wrong");
  return data;
}

function leavePaper(id) {
  papers = papers.filter((p) => p.id !== id);
  if (activePaperId === id) {
    setScope(null, { silent: true });
    if (view === "chat") renderIntro();
  }
}

/** Moves a paper to Recently deleted (kept 30 days) with an Undo. */
async function deletePaper(id) {
  const p = paperById(id);
  try {
    await setPaperState(id, "deleted");
    leavePaper(id);
    await loadPapers();
    if (view === "archive" || view === "trash") renderShelf();
    toast(`Moved “${p?.title ?? "paper"}” to Recently deleted`, "", { label: "Undo", onClick: () => restorePaper(id) });
  } catch (err) {
    toast(err.message || "Couldn't delete paper", "error");
  }
}

async function archivePaper(id) {
  const p = paperById(id);
  try {
    await setPaperState(id, "archived");
    leavePaper(id);
    await loadPapers();
    toast(`Archived “${p?.title ?? "paper"}”`, "", { label: "Undo", onClick: () => restorePaper(id) });
  } catch (err) {
    toast(err.message || "Couldn't archive paper", "error");
  }
}

async function restorePaper(id, msg) {
  try {
    await setPaperState(id, "active");
    await loadPapers();
    if (view === "archive" || view === "trash") renderShelf();
    if (msg) toast(msg, "success");
  } catch (err) {
    toast(err.message || "Couldn't restore paper", "error");
  }
}

function pollPaper(id) {
  if (pollers.has(id)) return;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`/api/papers/${id}`);
      if (res.status === 404) { clearInterval(timer); pollers.delete(id); return; }
      const p = await res.json();
      const i = papers.findIndex((x) => x.id === id);
      if (p.state && p.state !== "active") {
        // Archived or deleted while indexing: keep polling quietly, but not in the library.
        if (i >= 0) papers.splice(i, 1);
      } else if (i >= 0) papers[i] = p; else papers.unshift(p);
      renderLibrary();
      if (activePaperId === id) els.scopeValue.textContent = p.title;
      if (!document.activeElement?.matches?.(`[data-rename="${id}"]`)) updateBrief(p);
      if (p.status !== "processing") {
        clearInterval(timer);
        pollers.delete(id);
        if (p.status === "ready") toast(`“${p.title}” is ready to query`, "success");
        else toast(`Indexing failed: ${p.error || "unknown error"}`, "error");
        if (!hasMessages()) renderIntro();
      }
    } catch { /* keep polling */ }
  }, 2500);
  pollers.set(id, timer);
}
