import { Hono } from "hono";
import type { ChatMessage, Env, Paper, PaperState } from "./types";
import { contentKey } from "./types";
import { cleanText, generateId } from "./utils";
import { MODELS, buildMessages, buildSystemPrompt, cleanTitle, embed, looseAi, readAiStream, retrieve, rewriteQuery, indexPaperProfile } from "./rag";
import { checkDocument } from "./doccheck";
import { downloadPdf, lookupPaper, pdfFromPage } from "./resolve";
import { clientIp, rateLimited } from "./guard";
import { ensureSchema } from "./db";
import { chatStub, eraseChats } from "./chats";
import { runMaintenance } from "./maintenance";
import { checkResetToken, forgotPassword, resendVerification, resetWithLink, updateEmail, verifyEmail } from "./email";
import { type AppEnv, authConfig, checkPassword, login, logout, me, regenerateRecoveryKey, requireUser, resetPassword, signup } from "./auth";
import { deleteCookie } from "hono/cookie";
import {
  countPapers,
  countChats,
  chatIdsToErase,
  setChatState,
  type ChatState,
  deleteChat,
  getPaper,
  insertPaper,
  listChats,
  listPapers,
  purgeExpired,
  purgePaper,
  touchChat,
  updatePaper,
} from "./db";

// Durable Object and Workflow classes must be exported from the entry module.
export { ChatSession } from "./chat-session";
export { PaperIngestionWorkflow } from "./workflow";

const MAX_CHARS = 1_500_000; // ~250k words; keeps KV values and workflow runs reasonable
const STATES: PaperState[] = ["active", "archived", "deleted"];

const app = new Hono<AppEnv>();

// ---------------- Auth ----------------
app.post("/api/auth/signup", signup);
app.post("/api/auth/login", login);
app.post("/api/auth/reset", resetPassword);
app.post("/api/auth/forgot", forgotPassword);
app.post("/api/auth/reset-token", checkResetToken);
app.post("/api/auth/reset-link", resetWithLink);
app.post("/api/auth/verify-email", verifyEmail);
app.post("/api/auth/logout", logout);
app.get("/api/auth/me", me);
app.get("/api/auth/config", authConfig);

// Atlas build helper: embeds topic names for scripts/build-atlas.mjs.
// Only answers on localhost (i.e. `npm run dev`), so it can't be used once deployed.
app.post("/api/atlas/embed", async (c) => {
  const host = new URL(c.req.url).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.json({ error: "Not available" }, 404);
  const { texts } = await c.req.json<{ texts?: string[] }>();
  if (!Array.isArray(texts) || !texts.length || texts.length > 100) return c.json({ error: "Send 1–100 texts" }, 400);
  return c.json({ vectors: await embed(c.env, texts.map((t) => String(t).slice(0, 500))) });
});

// Atlas build helper: short names for regions of the globe, from sample titles. Localhost only.
app.post("/api/atlas/name", async (c) => {
  const host = new URL(c.req.url).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.json({ error: "Not available" }, 404);
  const { items } = await c.req.json<{ items?: Array<{ keywords?: string; others?: string[]; titles?: string[] }> }>();
  if (!Array.isArray(items) || items.length > 40) return c.json({ error: "Send up to 40 items" }, 400);
  const names: string[] = [];
  for (const it of items) {
    try {
      const res: any = await looseAi(c.env).run(MODELS.fast, {
        messages: [
          {
            role: "system",
            content:
              "You label regions on a map of research papers about AI and the fields it touches (vision, language, robotics, speech, " +
              "health, biology, security, systems, statistics, HCI...). Never answer with broad labels like " +
              "'Natural Language Processing', 'Deep Learning', 'Machine Learning', 'Language Models', 'Computer Science' or 'Artificial Intelligence'. " +
              "Name what makes THIS region different from the others, e.g. 'Machine Translation', 'Robot Manipulation', 'Medical Image Analysis', " +
              "'Speech & Audio', 'Graph Learning', 'Diffusion & Image Generation', 'Privacy & Security'. Reply with ONLY a 2-4 word name in Title Case.",
          },
          {
            role: "user",
            content:
              `This region's distinctive keywords: ${it.keywords || ""}\n` +
              `Other regions (name this one differently): ${(it.others || []).slice(0, 14).join("; ")}\n` +
              `Example paper titles from this region:\n- ${(it.titles || []).slice(0, 14).map((t) => String(t).slice(0, 140)).join("\n- ")}\n\nName:`,
          },
        ],
        max_tokens: 16,
        temperature: 0.2,
      });
      names.push(String(res?.response || "").split("\n")[0].replace(/^["'*\s]+|["'*.\s]+$/g, "").slice(0, 40));
    } catch {
      names.push("");
    }
  }
  return c.json({ names });
});

// Errors from the browser (window.onerror / unhandled promise rejections), for Workers Logs.
app.post("/api/log", async (c) => {
  await ensureSchema(c.env);
  if (await rateLimited(c.env, `log:${clientIp(c)}`, 30, 60 * 60_000)) return c.body(null, 204);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  console.warn(JSON.stringify({ event: "client_error", message: clip(b.message, 300), source: clip(b.source, 200), stack: clip(b.stack, 1200), page: clip(b.page, 200), ua: clip(c.req.header("User-Agent"), 160) }));
  return c.body(null, 204);
});

// Everything else under /api needs a signed-in user.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/log" || c.req.path.startsWith("/api/auth/") || c.req.path === "/api/atlas/embed" || c.req.path === "/api/atlas/name" || c.req.path === "/api/atlas/lookup") return next();
  return requireUser(c, next);
});


// ---------------- Papers ----------------

// POST /api/papers — upload (multipart: text|file, title, titleHint, filename)
app.post("/api/account/recovery-key", regenerateRecoveryKey);
app.post("/api/account/email", updateEmail);
app.post("/api/account/email/resend", resendVerification);

// ---------------- Account: devices, export, delete ----------------

// GET /api/account/sessions — where you're signed in
app.get("/api/account/sessions", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT token_hash, device, created_at, last_seen FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_seen, created_at) DESC`
  ).bind(user.id, Date.now()).all<{ token_hash: string; device: string | null; created_at: number; last_seen: number | null }>();
  return c.json({
    sessions: results.map((s) => ({
      id: s.token_hash.slice(0, 16), // a handle for "sign out", not the secret
      device: s.device || "Unknown device",
      createdAt: s.created_at,
      lastSeen: s.last_seen || s.created_at,
      current: s.token_hash === c.get("sessionHash"),
    })),
  });
});

// POST /api/account/sessions/revoke — { id } signs out one device; { others: true } signs out all others
app.post("/api/account/sessions/revoke", async (c) => {
  const user = c.get("user");
  const current = c.get("sessionHash");
  const { id, others } = await c.req.json<{ id?: string; others?: boolean }>().catch(() => ({} as { id?: string; others?: boolean }));
  if (others) {
    const r = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`).bind(user.id, current).run();
    return c.json({ signedOut: r.meta.changes });
  }
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return c.json({ error: "Unknown device" }, 400);
  if (current.startsWith(id)) return c.json({ error: "That's this device. Use Sign out instead." }, 400);
  const r = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?`).bind(user.id, id).run();
  return c.json({ signedOut: r.meta.changes });
});

// GET /api/account/export — everything CiteSeek holds about you, as one JSON file
app.get("/api/account/export", async (c) => {
  const user = c.get("user");
  const wait = await rateLimited(c.env, `ex:${user.id}`, 5, 60 * 60_000);
  if (wait) return c.json({ error: `You can download your data again in ${wait} minutes.` }, 429);
  const env = c.env;
  const profile = await env.DB.prepare(`SELECT created_at FROM users WHERE id = ?`).bind(user.id).first<{ created_at: number }>();
  const email = await env.DB.prepare(`SELECT email, verified_at FROM user_emails WHERE user_id = ?`).bind(user.id).first<{ email: string; verified_at: number | null }>();
  const papers = (await Promise.all((["active", "archived", "deleted"] as PaperState[]).map((s) => listPapers(env, user.id, s)))).flat();
  const paperOut = [];
  for (const p of papers) {
    const { paperVec, ...meta } = p;
    paperOut.push({ ...meta, text: await env.PAPERS_KV.get(contentKey(p.id)) });
  }
  const chats = (await Promise.all((["active", "archived", "deleted"] as const).map((s) => listChats(env, user.id, 1000, s)))).flat();
  const chatOut = [];
  for (const ch of chats) {
    const messages = (await chatStub(env, user.id, ch.id).getHistory(1000).catch(() => [])) as ChatMessage[];
    chatOut.push({ ...ch, messages });
  }
  const body = JSON.stringify({
    exportedAt: new Date().toISOString(),
    account: { username: user.username, createdAt: profile ? new Date(profile.created_at).toISOString() : null, email: email?.email ?? null, emailConfirmed: !!email?.verified_at },
    papers: paperOut,
    conversations: chatOut,
  }, null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="citeseek-${user.username}-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});

// POST /api/account/delete — { password, confirm: <username> } erases the account and everything in it
app.post("/api/account/delete", async (c) => {
  const user = c.get("user");
  const env = c.env;
  const { password, confirm } = await c.req.json<{ password?: string; confirm?: string }>().catch(() => ({} as { password?: string; confirm?: string }));
  if (String(confirm || "").trim().toLowerCase() !== user.username.toLowerCase()) {
    return c.json({ error: "Type your username exactly to confirm.", field: "confirm" }, 400);
  }
  if (!(await checkPassword(c, user, password))) return c.json({ error: "Wrong password.", field: "password" }, 403);

  for (const s of ["active", "archived", "deleted"] as PaperState[]) {
    for (const p of await listPapers(env, user.id, s)) await purgePaper(env, p);
  }
  const chatIds = (await Promise.all((["active", "archived", "deleted"] as const).map((s) => listChats(env, user.id, 10_000, s)))).flat().map((ch) => ch.id);
  await eraseChats(env, user.id, chatIds);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chats WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM user_emails WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM recovery_keys WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM auth_attempts WHERE key = ?`).bind(`u:${user.username.toLowerCase()}`),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id),
  ]);
  deleteCookie(c, "cs_session", { path: "/" });
  console.log(JSON.stringify({ event: "account_deleted", user: user.id, papers: "all", chats: chatIds.length }));
  return c.json({ success: true });
});

app.post("/api/papers", async (c) => {
  try {
    const user = c.get("user");
    const form = await c.req.formData();
    const file = form.get("file") as File | null;
    const pasted = form.get("text") as string | null;
    const filename = ((form.get("filename") as string) || file?.name || "paste.txt").slice(0, 200);
    const typedTitle = ((form.get("title") as string) || "").trim().slice(0, 250);
    const titleHint = ((form.get("titleHint") as string) || "").trim().slice(0, 250) || undefined;
    // No title typed: show a placeholder now and let ingestion detect the real one.
    const autoTitle = !typedTitle;
    const title = typedTitle || cleanTitle(titleHint) || filename.replace(/\.\w+$/, "").replace(/[_-]+/g, " ");

    const raw = pasted ?? (file ? await file.text() : null);
    if (!raw) return c.json({ error: "No file or text provided" }, 400);

    const content = cleanText(raw).slice(0, MAX_CHARS);
    if (content.length < 200) {
      return c.json({ error: "That's too little text to index. Is the PDF a scan?" }, 400);
    }
    // Not a research paper? Ask before indexing (the user can still choose "Add anyway").
    if (form.get("force") !== "1") {
      const check = await checkDocument(c.env, content, MODELS.fast);
      if (!check.paper) {
        return c.json({ error: `This looks like ${/^[aeiou]/i.test(check.kind) ? "an" : "a"} ${check.kind}, not a research paper.`, reason: check.reason, kind: check.kind, code: "not_paper" }, 422);
      }
    }

    const paperId = generateId();
    const meta: Paper = {
      id: paperId,
      title,
      filename,
      uploadedAt: new Date().toISOString(),
      status: "processing",
      stage: "Queued",
      chunkCount: 0,
      wordCount: content.split(/\s+/).length,
      autoTitle,
      state: "active",
    };

    await c.env.PAPERS_KV.put(contentKey(paperId), content);
    await insertPaper(c.env, user.id, meta);
    await c.env.INGESTION_WORKFLOW.create({
      id: paperId,
      params: { paperId, userId: user.id, title, filename, autoTitle, titleHint },
    });

    return c.json({ success: true, paper: meta });
  } catch (err: any) {
    return c.json({ error: err.message || "Upload failed" }, 500);
  }
});

// GET /api/papers?state=active|archived|deleted — list, plus counts for each section
app.get("/api/papers", async (c) => {
  try {
    const user = c.get("user");
    const state = (STATES.includes(c.req.query("state") as PaperState) ? c.req.query("state") : "active") as PaperState;
    // Erase anything that has been in Recently deleted for 30+ days.
    c.executionCtx.waitUntil((async () => {
      const erasedPapers = await purgeExpired(c.env, user.id);
      await eraseChats(c.env, user.id, [
        ...(await chatIdsToErase(c.env, user.id, { expired: true })),
        ...(await chatIdsToErase(c.env, user.id, { paperIds: erasedPapers })),
      ]);
    })().catch((e) => console.warn("purge failed", e)));
    const [papers, counts, chatCounts] = await Promise.all([
      listPapers(c.env, user.id, state), countPapers(c.env, user.id), countChats(c.env, user.id),
    ]);
    // Papers added before the paper index existed get their summary vector in the background.
    const missing = state === "active" ? papers.filter((p) => p.status === "ready" && !p.paperVec).slice(0, 5) : [];
    if (missing.length) {
      c.executionCtx.waitUntil((async () => {
        for (const p of missing) {
          await indexPaperProfile(c.env, user.id, p);
          await updatePaper(c.env, p.id, { paperVec: true });
        }
      })().catch((e) => console.warn("paper index backfill failed", e)));
    }
    return c.json({ papers, counts, chatCounts });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to list papers" }, 500);
  }
});

// POST /api/papers/empty-trash — erase everything in Recently deleted now
app.post("/api/papers/empty-trash", async (c) => {
  const user = c.get("user");
  const trash = await listPapers(c.env, user.id, "deleted");
  for (const p of trash) await purgePaper(c.env, p);
  const chatsErased = await eraseChats(c.env, user.id, [
    ...new Set([
      ...(await chatIdsToErase(c.env, user.id, { allDeleted: true })),
      ...(await chatIdsToErase(c.env, user.id, { paperIds: trash.map((p) => p.id) })),
    ]),
  ]);
  return c.json({ success: true, erased: trash.length, chatsErased });
});

// GET /api/papers/:id — metadata, status, summary, suggested questions
app.get("/api/papers/:id", async (c) => {
  const paper = await getPaper(c.env, c.req.param("id"), c.get("user").id);
  return paper ? c.json(paper) : c.json({ error: "Paper not found" }, 404);
});

// PATCH /api/papers/:id — { title } to rename, { state } to archive / unarchive / restore
app.patch("/api/papers/:id", async (c) => {
  const id = c.req.param("id");
  const paper = await getPaper(c.env, id, c.get("user").id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  const body = await c.req.json<{ title?: string; state?: PaperState }>();
  const patch: Partial<Paper> = {};

  if (body.title !== undefined) {
    const clean = body.title.replace(/\s+/g, " ").trim().slice(0, 250);
    if (!clean) return c.json({ error: "Title can't be empty" }, 400);
    Object.assign(patch, { title: clean, autoTitle: false });
    // Keep the paper index in step with the new title (best effort).
    if (paper.status === "ready") c.executionCtx.waitUntil(indexPaperProfile(c.env, c.get("user").id, { ...paper, title: clean }).catch(() => {}));
  }
  if (body.state !== undefined) {
    if (!STATES.includes(body.state)) return c.json({ error: "Unknown state" }, 400);
    patch.state = body.state;
    patch.archivedAt = body.state === "archived" ? Date.now() : undefined;
    patch.deletedAt = body.state === "deleted" ? Date.now() : undefined;
  }
  await updatePaper(c.env, id, patch);
  return c.json(await getPaper(c.env, id));
});

// DELETE /api/papers/:id — move to Recently deleted; ?permanent=1 erases it now
app.delete("/api/papers/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const paper = await getPaper(c.env, id, c.get("user").id);
    if (!paper) return c.json({ error: "Paper not found" }, 404);
    if (c.req.query("permanent") === "1") {
      await purgePaper(c.env, paper);
      await eraseChats(c.env, c.get("user").id, await chatIdsToErase(c.env, c.get("user").id, { paperIds: [id] }));
      return c.json({ success: true, erased: true });
    }
    await updatePaper(c.env, id, { state: "deleted", deletedAt: Date.now(), archivedAt: undefined });
    return c.json({ success: true, paper: await getPaper(c.env, id) });
  } catch (err: any) {
    return c.json({ error: err.message || "Delete failed" }, 500);
  }
});

// Paper hosts we fetch a globe paper's own link from. (Copies found through the scholarly
// indexes in resolve.ts can live anywhere, e.g. a university repository, so they only need https.)
const PDF_HOSTS = [
  "arxiv.org", "export.arxiv.org", "openreview.net", "proceedings.neurips.cc", "papers.nips.cc",
  "proceedings.mlr.press", "aclanthology.org", "www.aclweb.org", "aclweb.org", "openaccess.thecvf.com",
  "www.jmlr.org", "jmlr.org", "ojs.aaai.org", "www.ijcai.org", "ijcai.org",
];
const pdfHostOk = (u: URL) => u.protocol === "https:" && PDF_HOSTS.includes(u.hostname);
const anyHttps = (u: URL) => u.protocol === "https:";

// GET /api/atlas/lookup?title=… — abstract + whether a free PDF exists (works before sign-in).
app.get("/api/atlas/lookup", async (c) => {
  const title = (c.req.query("title") || "").trim().slice(0, 400);
  if (title.length < 6) return c.json({ error: "Title too short" }, 400);
  await ensureSchema(c.env); // this route skips sign-in, which normally prepares the tables
  const wait = await rateLimited(c.env, `lk:${clientIp(c)}`, 120, 60 * 60_000);
  if (wait) return c.json({ error: "Too many lookups. Try again in a little while." }, 429);
  const r = await lookupPaper(c.env, title);
  return c.json({ abstract: r.abstract ?? null, abstractSource: r.abstractSource ?? null, pdfSources: [...new Set(r.pdfs.map((p) => p.source))] });
});

// GET /api/atlas/pdf?url=…&title=… — downloads a free PDF for a globe paper so the browser can add
// it to the library. Tries the paper's own link first, then copies found by title (arXiv first).
app.get("/api/atlas/pdf", async (c) => {
  const own = c.req.query("url") || "";
  const title = (c.req.query("title") || "").trim().slice(0, 400);
  const tried: { source: string; reason: string }[] = [];

  if (own) {
    const r = await downloadPdf(pdfFromPage(own), pdfHostOk);
    if (r.res) return pdfResponse(r.res, "the paper's site");
    tried.push({ source: "the paper's site", reason: r.reason! });
  }
  if (title.length >= 6) {
    const found = await lookupPaper(c.env, title);
    for (const cand of found.pdfs.slice(0, 5)) {
      if (own && cand.url === pdfFromPage(own)) continue;
      const r = await downloadPdf(cand.url, anyHttps);
      if (r.res) return pdfResponse(r.res, cand.source);
      tried.push({ source: cand.source, reason: r.reason! });
    }
  }
  const why = tried.length
    ? `Tried ${tried.map((t) => `${t.source} (${t.reason})`).join(", ")}.`
    : "No free copy is listed anywhere we can check.";
  return c.json({ error: `Couldn't find a free PDF to download. ${why}`, code: "no_pdf", tried }, 502);
});
function pdfResponse(res: Response, source: string) {
  return new Response(res.body, {
    headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=3600", "X-Paper-Source": source },
  });
}

// GET /api/debug/search?q=...&paperId=... — retrieval diagnostics (your own papers only)
app.get("/api/debug/search", async (c) => {
  try {
    const user = c.get("user");
    const q = c.req.query("q") || "attention";
    const papers = await listPapers(c.env, user.id, "active");
    const paperId = c.req.query("paperId") || papers[0]?.id;
    const [vector] = await embed(c.env, [q]);
    const scoped = paperId
      ? await c.env.VECTORIZE.query(vector, { topK: 5, namespace: paperId, returnMetadata: "all" })
      : null;
    return c.json({
      query: q,
      embeddingDims: vector?.length,
      index: await Promise.resolve().then(() => c.env.VECTORIZE.describe()).catch((e) => ({ error: String(e) })),
      papers: papers.map((p) => ({ id: p.id, title: p.title, status: p.status, chunkCount: p.chunkCount })),
      paperId,
      matches: scoped?.matches.map((m) => ({ id: m.id, score: Number(m.score.toFixed(3)) })),
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ---------------- Chat ----------------

/**
 * POST /api/chat — streams the answer as Server-Sent Events:
 *   event: meta   { sessionId, searchQuery, sources[] }   (sent before any text)
 *   event: token  { t }                                    (repeated)
 *   event: done   {}
 *   event: error  { error }
 */
app.post("/api/chat", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ message?: string; sessionId?: string; paperId?: string | null }>();
  const message = body.message?.trim();
  if (!message) return c.json({ error: "Message cannot be empty" }, 400);

  const sessionId = body.sessionId || generateId();
  const env = c.env;

  // Scope: one paper (must be the user's, not deleted) or all of the user's active, ready papers.
  let scopePapers: Paper[];
  if (body.paperId) {
    const p = await getPaper(env, body.paperId, user.id);
    if (!p || p.state === "deleted") return c.json({ error: "Paper not found" }, 404);
    scopePapers = [p];
  } else {
    scopePapers = (await listPapers(env, user.id, "active")).filter((p) => p.status === "ready");
  }
  const paperId = body.paperId || undefined;
  const session = chatStub(env, user.id, sessionId);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event: string, data: unknown) =>
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const run = async () => {
    try {
      // History is read before saving the new question so it isn't sent twice.
      const history = await session.getContextMessages(6);
      await session.addMessage({ role: "user", content: message, timestamp: new Date().toISOString() });
      await touchChat(env, user.id, sessionId, message, paperId);

      const searchQuery = await rewriteQuery(env, history, message);
      const { sources, shortlist } = await retrieve(env, searchQuery, scopePapers, user.id);

      // Vectors store the title from upload time; show each paper's current title instead.
      const titles = new Map(scopePapers.map((p) => [p.id, p.title]));
      for (const s of sources) s.title = titles.get(s.paperId) ?? s.title;

      await send("meta", { sessionId, searchQuery, sources });

      // Paper overviews let broad questions ("what is this paper about?") work.
      // (for whole-library questions, the overviews of the most relevant papers)
      const byId = new Map(scopePapers.map((p) => [p.id, p]));
      const cited = new Set(sources.map((s) => s.paperId));
      const overviews = [...new Set([...cited, ...shortlist])].map((id) => byId.get(id)).filter((p): p is Paper => !!p?.summary).slice(0, 5);
      const stream = (await looseAi(env).run(MODELS.chat, {
        messages: buildMessages(buildSystemPrompt(sources, overviews), history, message),
        max_tokens: 1024,
        temperature: 0.3,
        stream: true,
      })) as ReadableStream<Uint8Array>;

      let full = "";
      for await (const t of readAiStream(stream)) {
        full += t;
        await send("token", { t });
      }

      await session.addMessage({
        role: "assistant",
        content: full,
        timestamp: new Date().toISOString(),
        sources,
        searchQuery: searchQuery !== message ? searchQuery : undefined,
      });
      await send("done", {});
    } catch (err: any) {
      console.error("Chat error:", err);
      await send("error", { error: err?.message || "Chat failed" }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  };

  c.executionCtx.waitUntil(run());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Session-Id": sessionId,
    },
  });
});

// GET /api/chats — the user's recent conversations
const CHAT_STATES: ChatState[] = ["active", "archived", "deleted"];
app.get("/api/chats", async (c) => {
  const limit = Math.min(300, Math.max(1, Number(c.req.query("limit")) || 100));
  const state = (CHAT_STATES.includes(c.req.query("state") as ChatState) ? c.req.query("state") : "active") as ChatState;
  return c.json({ chats: await listChats(c.env, c.get("user").id, limit, state) });
});

// PATCH /api/chat/:sessionId — { state: "archived" | "active" | "deleted" }
app.patch("/api/chat/:sessionId", async (c) => {
  const { state } = await c.req.json<{ state?: ChatState }>().catch(() => ({} as { state?: ChatState }));
  if (!state || !CHAT_STATES.includes(state)) return c.json({ error: "Unknown state" }, 400);
  const ok = await setChatState(c.env, c.get("user").id, c.req.param("sessionId"), state);
  return ok ? c.json({ success: true, state }) : c.json({ error: "Conversation not found" }, 404);
});

// GET /api/chat/:sessionId — history (with cited passages)
app.get("/api/chat/:sessionId", async (c) => {
  try {
    const id = c.req.param("sessionId");
    const messages = (await chatStub(c.env, c.get("user").id, id).getHistory(50)) as ChatMessage[];
    return c.json({ sessionId: id, messages });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// DELETE /api/chat/:sessionId — move to Recently deleted (30 days); ?permanent=1 erases it now
app.delete("/api/chat/:sessionId", async (c) => {
  try {
    const user = c.get("user");
    const id = c.req.param("sessionId");
    if (c.req.query("permanent") === "1") {
      await eraseChats(c.env, user.id, [id]);
      return c.json({ success: true, erased: true });
    }
    // Not in the list yet (no messages sent): nothing to keep, just clear it.
    if (!(await setChatState(c.env, user.id, id, "deleted"))) await eraseChats(c.env, user.id, [id]);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Any unexpected error: log it (with the route) for Workers Logs, and answer with a plain message.
app.onError((err, c) => {
  console.error(JSON.stringify({ event: "server_error", method: c.req.method, path: c.req.path, message: String(err?.message || err).slice(0, 500), stack: String(err?.stack || "").slice(0, 1500) }));
  return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
});

export default {
  fetch: app.fetch,
  // Daily cleanup (see [triggers] in wrangler.toml and src/maintenance.ts).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runMaintenance(env));
  },
};
export { app };
