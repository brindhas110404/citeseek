// CiteSeek frontend · core.js: Shared state, DOM references and small utilities (toast, fetch wrapper, markdown + citations).
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- State ----------------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

let sessionId = store.get("cs.session") || newId();
store.set("cs.session", sessionId);
let activePaperId = store.get("cs.scope") || null;
let papers = [];
let counts = { active: 0, archived: 0, deleted: 0 };
let chatCounts = { active: 0, archived: 0, deleted: 0 };
let shelfChats = []; // conversations shown on the Archive / Recently deleted page
let chats = []; // recent conversations, from the server
let shelfPapers = []; // papers shown on the Archive / Recently deleted page
let currentUser = null;
let armedDelete = null; // paper id waiting for a confirming second click (Delete forever)
let armTimer = 0;

// Any API call that comes back 401 means the session ended: show the sign-in screen.
const rawFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await rawFetch(input, init);
  const url = typeof input === "string" ? input : input.url;
  if (res.status === 401 && url.startsWith("/api/") && !url.startsWith("/api/auth/")) showAuth("login", "Your session ended. Please sign in again.");
  return res;
};
let selectedFile = null;
let busy = false;
const pollers = new Map();
const answers = []; // { sources, searchQuery } per rendered assistant message

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"), scrim: $("scrim"), menuBtn: $("menuBtn"),
  fileInput: $("fileInput"), dropZone: $("dropZone"), dzMain: $("dzMain"), dzSub: $("dzSub"),
  uploadRow: $("uploadRow"), paperTitle: $("paperTitle"), uploadBtn: $("uploadBtn"),
  papersList: $("papersList"), paperCount: $("paperCount"), scopeAll: $("scopeAll"), allChats: $("allChats"),
  scopeValue: $("scopeValue"), newChatBtn: $("newChatBtn"),
  thread: $("thread"), messages: $("messages"),
  composer: $("composer"), input: $("chatInput"), sendBtn: $("sendBtn"),
  drawer: $("drawer"), drawerTitle: $("drawerTitle"), drawerQuery: $("drawerQuery"),
  drawerBody: $("drawerBody"), drawerClose: $("drawerClose"), toasts: $("toasts"),
  app: document.querySelector(".app"), homeBtn: $("homeBtn"), home: $("home"),
  homeAsk: $("homeAsk"), homeAskInput: $("homeAskInput"), homeSuggest: $("homeSuggest"),
  homeDrop: $("homeDrop"), homeRecent: $("homeRecent"), homePapers: $("homePapers"), homeLibCount: $("homeLibCount"),
  shelf: $("shelf"), shelfTitle: $("shelfTitle"), shelfDesc: $("shelfDesc"), shelfList: $("shelfList"), emptyTrashBtn: $("emptyTrashBtn"),
  navArchive: $("navArchive"), navTrash: $("navTrash"), archiveCount: $("archiveCount"), trashCount: $("trashCount"),
  userAvatar: $("userAvatar"), userName: $("userName"), signOutBtn: $("signOutBtn"),
  auth: $("auth"), authForm: $("authForm"), authTitle: $("authTitle"), authSub: $("authSub"), authUser: $("authUser"),
  authPass: $("authPass"), authError: $("authError"), authSubmit: $("authSubmit"), authSwitch: $("authSwitch"),
  pwToggle: $("pwToggle"), pwHint: $("pwHint"), pwMeter: $("pwMeter"), turnstileBox: $("turnstileBox"),
  authKey: $("authKey"), keyField: $("keyField"), pwLabel: $("pwLabel"), forgotBtn: $("forgotBtn"),
  keyBtn: $("keyBtn"), keyDot: $("keyDot"), keyModal: $("keyModal"), keyTitle: $("keyTitle"), keySub: $("keySub"),
  keyConfirm: $("keyConfirm"), keyPass: $("keyPass"), keyError: $("keyError"), keyCancel: $("keyCancel"),
  keyCreate: $("keyCreate"), keyShow: $("keyShow"), keyCode: $("keyCode"), keyCopy: $("keyCopy"),
  keyDownload: $("keyDownload"), keySaved: $("keySaved"), keyDone: $("keyDone"),
  authEmail: $("authEmail"), emailField: $("emailField"), userField: $("userField"),
  forgotModal: $("forgotModal"), forgotForm: $("forgotForm"), forgotEmail: $("forgotEmail"), forgotTurnstile: $("forgotTurnstile"),
  forgotError: $("forgotError"), forgotSend: $("forgotSend"), forgotUseKey: $("forgotUseKey"), forgotSent: $("forgotSent"),
  forgotSentText: $("forgotSentText"), forgotDev: $("forgotDev"), forgotAgain: $("forgotAgain"),
  acctModal: $("acctModal"), acctEmail: $("acctEmail"), acctEmailBadge: $("acctEmailBadge"), acctEmailEdit: $("acctEmailEdit"),
  acctEmailResend: $("acctEmailResend"), acctEmailRemove: $("acctEmailRemove"), acctEmailActions: $("acctEmailActions"),
  acctEmailForm: $("acctEmailForm"), acctNewEmailField: $("acctNewEmailField"), acctNewEmail: $("acctNewEmail"), acctPass: $("acctPass"),
  acctError: $("acctError"), acctCancel: $("acctCancel"), acctSave: $("acctSave"), acctDev: $("acctDev"),
  verifyBanner: $("verifyBanner"), vbEmail: $("vbEmail"), vbResend: $("vbResend"), vbChange: $("vbChange"), vbClose: $("vbClose"),
  forgotSentKey: $("forgotSentKey"),
  deviceList: $("deviceList"), signOutOthers: $("signOutOthers"), exportBtn: $("exportBtn"),
  delAcctBtn: $("delAcctBtn"), delAcctActions: $("delAcctActions"), delAcctForm: $("delAcctForm"), delAcctName: $("delAcctName"),
  delAcctPass: $("delAcctPass"), delAcctError: $("delAcctError"), delAcctCancel: $("delAcctCancel"), delAcctGo: $("delAcctGo"),
  acctKeyText: $("acctKeyText"), acctKeyBadge: $("acctKeyBadge"), acctKeyBtn: $("acctKeyBtn"),
};
let view = "home"; // "home" | "chat" | "archive" | "trash"

const ICON_ASSISTANT = `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="#2e5a43" stroke-width="2"/><path d="M15 15l4.5 4.5" stroke="#a8683a" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const ICON_ARCHIVE = `<svg viewBox="0 0 24 24"><path d="M4 7h16v3H4zM5.5 10v8.5h13V10M10 13.5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------- Utilities ----------------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, type = "", action) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = action.label;
    b.onclick = () => { t.remove(); action.onClick(); };
    t.appendChild(b);
  }
  els.toasts.appendChild(t);
  setTimeout(() => t.remove(), action?.ms || (action ? 7000 : 4200));
}

function scrollToBottom(force = false) {
  const t = els.thread;
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 160;
  if (force || nearBottom) t.scrollTop = t.scrollHeight;
}

const paperById = (id) => papers.find((p) => p.id === id) || shelfPapers.find((p) => p.id === id && p.state === "archived");

/** Inline markdown + clickable citations. Input is already HTML-escaped. */
function inline(s, answerIdx, known) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(?:paper\s*)?(?:brief|overview|summary)\]/gi,
      `<button class="cite cite-brief" data-brief-link title="From the paper brief">brief</button>`)
    .replace(/\[(?:Source\s*)?(\d+(?:\s*[,;]\s*(?:Source\s*)?\d+)*)\]/gi, (_, nums) =>
      nums.split(/[,;]/).map((x) => {
        const n = parseInt(x.replace(/\D/g, ""), 10);
        const ok = known.has(n);
        return `<button class="cite${ok ? "" : " missing"}" data-a="${answerIdx}" data-n="${n}" ${ok ? "" : "disabled"} title="${ok ? "View source passage" : "Source unavailable"}">${n}</button>`;
      }).join("")
    );
}

/** Minimal markdown renderer: paragraphs, bullet/numbered lists, headings. */
function renderMarkdown(text, answerIdx, sources) {
  const known = new Set((sources || []).map((s) => s.n));
  const blocks = escapeHtml(text).trim().split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""), answerIdx, known)}</li>`).join("")}</ul>`;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""), answerIdx, known)}</li>`).join("")}</ol>`;
    }
    const h = block.match(/^#{1,4}\s+(.*)$/);
    if (h && lines.length === 1) return `<h4>${inline(h[1], answerIdx, known)}</h4>`;
    // Mixed blocks: render list lines as a list after any leading prose.
    const firstList = lines.findIndex((l) => /^\s*[-*•]\s+/.test(l));
    if (firstList > 0 && lines.slice(firstList).every((l) => /^\s*[-*•]\s+/.test(l))) {
      return `<p>${inline(lines.slice(0, firstList).join("<br>"), answerIdx, known)}</p><ul>${lines
        .slice(firstList).map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""), answerIdx, known)}</li>`).join("")}</ul>`;
    }
    return `<p>${inline(lines.join("<br>"), answerIdx, known)}</p>`;
  }).join("");
}

function citedNumbers(text) {
  const out = new Set();
  for (const m of text.matchAll(/\[(?:Source\s*)?(\d+(?:\s*[,;]\s*(?:Source\s*)?\d+)*)\]/gi)) {
    m[1].split(/[,;]/).forEach((x) => out.add(parseInt(x.replace(/\D/g, ""), 10)));
  }
  return out;
}
