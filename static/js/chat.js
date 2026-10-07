// CiteSeek frontend · chat.js: The conversation: paper brief, messages and streaming answers, the evidence drawer, composer.
// Plain scripts (no build step) loaded in order by index.html; they share top-level names.
"use strict";

// ---------------- Intro + paper brief ----------------
const hasMessages = () => !!els.messages.querySelector(".msg");

function suggestionChips(questions) {
  if (!questions?.length) return "";
  return `<div class="suggest-label">Try asking</div><div class="suggestions">${questions
    .map((q) => `<button class="chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("")}</div>`;
}

function briefHtml(p) {
  const stats = `${p.wordCount?.toLocaleString() ?? "?"} words${p.chunkCount ? ` · ${p.chunkCount} passages` : ""}`;
  if (p.status === "processing") {
    return `<div class="brief-top"><div class="brief-kicker">Indexing</div><div class="brief-title">${escapeHtml(p.title)}</div><div class="brief-stats">${stats}</div></div>
      <div class="brief-processing"><span class="dots"><i></i><i></i><i></i></span>${escapeHtml(p.stage || "Processing")}: chunking, embedding and summarizing…</div>`;
  }
  if (p.status === "failed") {
    return `<div class="brief-top"><div class="brief-kicker" style="color:var(--danger)">Indexing failed</div><div class="brief-title">${escapeHtml(p.title)}</div></div>
      <div class="brief-body"><p class="brief-summary">${escapeHtml(p.error || "Something went wrong.")} Try removing it and uploading again.</p></div>`;
  }
  const archivedNote = p.state === "archived"
    ? `<div class="brief-archived">${ICON_ARCHIVE}<span>This paper is archived, so it's left out of whole-library searches. You can still ask about it here.</span><button class="btn btn-ghost" data-unarchive-brief="${p.id}">Unarchive</button></div>`
    : "";
  const titleEl = `<div class="brief-title editable" contenteditable="plaintext-only" spellcheck="false" data-rename="${p.id}" title="Click to rename">${escapeHtml(p.title)}</div>`;
  const points = p.keyPoints?.length ? `<ul class="brief-points">${p.keyPoints.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul>` : "";
  return `<div class="brief-top"><div class="brief-kicker">${p.state === "archived" ? "Archived paper" : "Paper brief"}</div>${titleEl}<div class="brief-stats">${stats}</div></div>
    ${archivedNote}
    <div class="brief-body">
      ${p.summary ? `<p class="brief-summary">${escapeHtml(p.summary)}</p>` : `<p class="brief-summary">Indexed and ready. Ask anything about it.</p>`}
      ${points}
      ${suggestionChips(p.questions)}
    </div>`;
}

function appendBrief(p) {
  const div = document.createElement("div");
  div.className = "brief";
  div.dataset.brief = p.id;
  div.innerHTML = briefHtml(p);
  els.messages.appendChild(div);
  scrollToBottom(true);
}

function updateBrief(p) {
  els.messages.querySelectorAll(`[data-brief="${p.id}"]`).forEach((el) => { el.innerHTML = briefHtml(p); });
}

function renderIntro() {
  els.messages.innerHTML = "";
  const p = activePaperId && paperById(activePaperId);
  if (p) return appendBrief(p);

  const ready = papers.filter((x) => x.status === "ready");
  if (ready.length) {
    const qs = ready.slice(0, 4).map((x) => x.questions?.[0]).filter(Boolean);
    els.messages.innerHTML = `
      <div class="welcome">
        <h1>Ask across <em>${ready.length} paper${ready.length > 1 ? "s" : ""}</em>, or pick one from the library.</h1>
        <p>Answers come only from your papers. Every claim carries a numbered citation you can open to read the exact passage behind it.</p>
        ${suggestionChips(qs)}
      </div>`;
    return;
  }
  els.messages.innerHTML = `
    <div class="welcome">
      <h1>Read less. <em>Understand more.</em> Trust every answer.</h1>
      <p>CiteSeek turns research papers into a conversation. Ask in plain English and get answers grounded in the text, with citations you can check.</p>
      <div class="steps">
        <div class="step"><div class="step-n">01</div><div class="step-t">Add a paper</div><div class="step-d">Drop a PDF in the library. It's chunked, embedded and summarized for you.</div></div>
        <div class="step"><div class="step-n">02</div><div class="step-t">Ask anything</div><div class="step-d">Search one paper or your whole library. Follow-ups understand context.</div></div>
        <div class="step"><div class="step-n">03</div><div class="step-t">Check the receipts</div><div class="step-d">Click any citation to see the passage and how closely it matched.</div></div>
      </div>
    </div>`;
}

els.messages.addEventListener("click", async (e) => {
  const un = e.target.closest("[data-unarchive-brief]");
  if (un) {
    const id = un.dataset.unarchiveBrief;
    await restorePaper(id, "Back in your library");
    const p = papers.find((x) => x.id === id);
    if (p) updateBrief(p);
    return;
  }
  const chip = e.target.closest(".chip[data-q]");
  if (chip) return ask(chip.dataset.q);
  if (e.target.closest("[data-brief-link]")) return showBrief();
  const cite = e.target.closest(".cite:not(.missing)");
  if (cite) return openEvidence(+cite.dataset.a, +cite.dataset.n, cite);
  const trail = e.target.closest(".trail-item");
  if (trail) return openEvidence(+trail.dataset.a, +trail.dataset.n);
});

function showBrief() {
  const briefs = els.messages.querySelectorAll(".brief");
  const target = briefs[briefs.length - 1];
  if (!target) return toast("This came from the paper's summary");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
}

// Rename by editing the title in the brief.
async function renamePaper(el) {
  const id = el.dataset.rename;
  const p = paperById(id);
  const title = el.textContent.replace(/\s+/g, " ").trim();
  if (!p || !title || title === p.title) { el.textContent = p?.title ?? ""; return; }
  try {
    const res = await fetch(`/api/papers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    Object.assign(p, data);
    renderLibrary();
    if (activePaperId === id) els.scopeValue.textContent = data.title;
    els.messages.querySelectorAll(`[data-rename="${id}"]`).forEach((x) => { if (x !== el) x.textContent = data.title; });
    toast("Renamed", "success");
  } catch (err) {
    el.textContent = p.title;
    toast(err.message || "Couldn't rename", "error");
  }
}
els.messages.addEventListener("keydown", (e) => {
  const el = e.target.closest?.("[data-rename]");
  if (!el) return;
  if (e.key === "Enter") { e.preventDefault(); el.blur(); }
  if (e.key === "Escape") { el.textContent = paperById(el.dataset.rename)?.title ?? ""; el.blur(); }
});
els.messages.addEventListener("focusout", (e) => {
  const el = e.target.closest?.("[data-rename]");
  if (el) renamePaper(el);
});

// ---------------- Messages ----------------
function appendUser(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  els.messages.appendChild(div);
}

function appendAssistant() {
  const idx = answers.length;
  answers.push({ sources: [], searchQuery: "" });
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<div class="avatar">${ICON_ASSISTANT}</div>
    <div class="body"><div class="answer"><div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span class="thinking-label">Searching your papers…</span></div></div><div class="extras"></div></div>`;
  els.messages.appendChild(div);
  return { idx, el: div, answer: div.querySelector(".answer"), extras: div.querySelector(".extras") };
}

function renderExtras(view, text, question) {
  answers[view.idx].text = text;
  const { sources, searchQuery } = answers[view.idx];
  const cited = citedNumbers(text);
  const used = sources.filter((s) => cited.has(s.n));
  let html = "";
  if (used.length) {
    html += `<div class="trail"><span class="trail-label">Sources</span>${used.map((s) =>
      `<button class="trail-item" data-a="${view.idx}" data-n="${s.n}"><span class="n">${s.n}</span><span class="t">${escapeHtml(s.title)}</span><span class="pg">¶${s.chunkIndex + 1}</span></button>`).join("")}</div>`;
  } else if (sources.length) {
    html += `<div class="trail"><button class="trail-item" data-a="${view.idx}" data-n="${sources[0].n}"><span class="t">View ${sources.length} retrieved passages</span></button></div>`;
  } else {
    html += `<div class="trail"><span class="trail-label">No matching passages were found, so this answer could only use the paper brief. Try rephrasing with terms the paper itself uses.</span></div>`;
  }
  if (searchQuery && question && searchQuery.toLowerCase() !== question.toLowerCase()) {
    html += `<div class="rewrite">Searched for <em>“${escapeHtml(searchQuery)}”</em></div>`;
  }
  view.extras.innerHTML = html;
}

async function ask(question) {
  question = question.trim();
  if (!question || busy) return;
  busy = true;
  els.sendBtn.disabled = true;

  if (!hasMessages()) {
    // Keep the brief visible above the conversation; drop the generic welcome.
    els.messages.querySelector(".welcome")?.remove();
  }
  appendUser(question);
  const view = appendAssistant();
  scrollToBottom(true);
  els.input.value = "";
  autoResize();

  let text = "";
  let raf = 0;
  const paint = (final = false) => {
    view.answer.innerHTML = renderMarkdown(text, view.idx, answers[view.idx].sources) + (final ? "" : `<span class="caret"></span>`);
    scrollToBottom();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, sessionId, paperId: activePaperId }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const evt of events) {
        const type = evt.match(/^event: (.+)$/m)?.[1];
        const dataLine = evt.match(/^data: (.*)$/m)?.[1];
        if (!type || dataLine == null) continue;
        const data = JSON.parse(dataLine);
        if (type === "meta") {
          answers[view.idx].sources = data.sources || [];
          answers[view.idx].searchQuery = data.searchQuery || "";
          const label = view.answer.querySelector(".thinking-label");
          if (label) label.textContent = data.sources?.length ? `Found ${data.sources.length} relevant passages. Writing…` : "Writing…";
        } else if (type === "token") {
          text += data.t;
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });
        } else if (type === "error") {
          throw new Error(data.error);
        } else if (type === "done") {
          finished = true;
        }
      }
    }
    cancelAnimationFrame(raf);
    if (!text) throw new Error("No answer was returned.");
    paint(true);
    renderExtras(view, text, question);
  } catch (err) {
    cancelAnimationFrame(raf);
    view.answer.innerHTML = (text ? renderMarkdown(text, view.idx, answers[view.idx].sources) : "") +
      `<p class="error-text">Something went wrong: ${escapeHtml(err.message)}</p>`;
  } finally {
    busy = false;
    loadChats();
    els.sendBtn.disabled = false;
    els.input.focus();
    scrollToBottom();
  }
}

async function loadHistory() {
  try {
    const res = await fetch(`/api/chat/${sessionId}`);
    const data = await res.json();
    const msgs = data.messages || [];
    if (!msgs.length) return false;
    els.messages.innerHTML = "";
    const p = activePaperId && paperById(activePaperId);
    if (p) appendBrief(p);
    let lastQuestion = "";
    for (const m of msgs) {
      if (m.role === "user") { appendUser(m.content); lastQuestion = m.content; continue; }
      const view = appendAssistant();
      answers[view.idx] = { sources: m.sources || [], searchQuery: m.searchQuery || "" };
      view.answer.innerHTML = renderMarkdown(m.content, view.idx, m.sources);
      renderExtras(view, m.content, lastQuestion);
    }
    scrollToBottom(true);
    return true;
  } catch {
    return false;
  }
}

// ---------------- Evidence drawer ----------------
const STOP = new Set("the and for with that this what from are was were how why which does into its their there about have has can not but you your our more than when where who also only such these those them then over very".split(" "));

function highlight(text, query) {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9-]{3,}/g) || []).filter((w) => !STOP.has(w)))];
  let html = escapeHtml(text);
  if (!terms.length) return html;
  const re = new RegExp(`\\b(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\w*`, "gi");
  return html.replace(re, "<mark>$&</mark>");
}

function openEvidence(answerIdx, n, citeEl) {
  const a = answers[answerIdx];
  if (!a?.sources?.length) return;
  const cited = citedNumbers(a.text || "");
  const focus = a.sources.find((s) => s.n === n) || a.sources[0];

  document.querySelectorAll(".cite.active").forEach((c) => c.classList.remove("active"));
  if (citeEl) citeEl.classList.add("active");

  const titles = [...new Set(a.sources.map((s) => s.title))];
  els.drawerTitle.textContent = titles.length === 1 ? titles[0] : `${a.sources.length} passages from ${titles.length} papers`;
  els.drawerQuery.innerHTML = `<b>Search</b>${escapeHtml(a.searchQuery || "")}`;
  els.drawerQuery.hidden = !a.searchQuery;

  els.drawerBody.innerHTML = a.sources.map((s) => {
    const pct = Math.round(Math.max(0, Math.min(1, s.score)) * 100);
    const isCited = cited.has(s.n);
    return `
      <article class="evidence ${s.n === focus.n ? "focus" : ""} ${isCited ? "" : "uncited"}" id="ev-${s.n}">
        <div class="ev-head">
          <span class="ev-n">${s.n}</span>
          <span class="ev-paper">${escapeHtml(s.title)}</span>
          <span class="match" title="Cosine similarity to the search">${pct}%<span class="match-bar"><span style="width:${pct}%"></span></span></span>
        </div>
        <div class="ev-text">${highlight(s.text, a.searchQuery || "")}</div>
        <div class="ev-foot">passage ${s.chunkIndex + 1}${isCited ? "" : " · retrieved, not cited"}</div>
      </article>`;
  }).join("");

  els.drawer.classList.add("open");
  els.drawer.setAttribute("aria-hidden", "false");
  els.scrim.classList.add("show");
  requestAnimationFrame(() => document.getElementById(`ev-${focus.n}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
}

function closeDrawer() {
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
  document.querySelectorAll(".cite.active").forEach((c) => c.classList.remove("active"));
  if (!els.sidebar.classList.contains("open")) els.scrim.classList.remove("show");
}
els.drawerClose.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeSidebar(); } });

// ---------------- Composer, new chat, mobile ----------------
function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}
els.input.addEventListener("input", autoResize);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(els.input.value); }
});
els.composer.addEventListener("submit", (e) => { e.preventDefault(); ask(els.input.value); });

els.newChatBtn.addEventListener("click", () => {
  if (!hasMessages()) {
    toast("You're already in a new chat. Ask away!");
    els.input.focus();
    els.composer.classList.remove("pulse");
    void els.composer.offsetWidth;
    els.composer.classList.add("pulse");
    return;
  }
  startChat({ paperId: activePaperId });
  toast("Started a new chat. Your last one is on the home screen.", "success");
});
