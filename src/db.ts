import type { Env, Paper, PaperState } from "./types";
import { contentKey, paperVectorId, vectorId } from "./types";

/**
 * D1 schema. Applied lazily on the first request of each isolate
 * (CREATE ... IF NOT EXISTS), so there is no separate migration step to run.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     pass_hash TEXT NOT NULL,
     salt TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS papers (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     title TEXT NOT NULL,
     filename TEXT NOT NULL,
     uploaded_at TEXT NOT NULL,
     status TEXT NOT NULL,
     stage TEXT,
     chunk_count INTEGER NOT NULL DEFAULT 0,
     word_count INTEGER NOT NULL DEFAULT 0,
     summary TEXT,
     key_points TEXT,
     questions TEXT,
     error TEXT,
     auto_title INTEGER NOT NULL DEFAULT 0,
     state TEXT NOT NULL DEFAULT 'active',
     archived_at INTEGER,
     deleted_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS papers_user_state ON papers(user_id, state, uploaded_at)`,
  `CREATE TABLE IF NOT EXISTS chats (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     title TEXT NOT NULL,
     paper_id TEXT,
     message_count INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS chats_user ON chats(user_id, updated_at)`,
  // Sign-in / sign-up attempts, for rate limiting (see guard.ts).
  `CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS auth_attempts_key ON auth_attempts(key, at)`,
  // One recovery key per user (hashed), for resetting a forgotten password. See auth.ts.
  // Optional email per account, for reset links. Only verified addresses receive reset links.
  // Not UNIQUE: an unverified claim must not block the real owner, so uniqueness among
  // *verified* addresses is enforced in email.ts.
  `CREATE TABLE IF NOT EXISTS user_emails (
     user_id TEXT PRIMARY KEY,
     email TEXT NOT NULL COLLATE NOCASE,
     verified_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS user_emails_email ON user_emails(email)`,
  // Single-use links sent by email: "verify" (confirm an address) and "reset" (new password).
  `CREATE TABLE IF NOT EXISTS email_tokens (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     purpose TEXT NOT NULL,
     email TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS recovery_keys (
     user_id TEXT PRIMARY KEY,
     key_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

/** Columns added after a table was first created (CREATE IF NOT EXISTS won't add them). */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["chats", "state", "TEXT NOT NULL DEFAULT 'active'"],
  ["chats", "archived_at", "INTEGER"],
  ["chats", "deleted_at", "INTEGER"],
  ["papers", "paper_vec", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "device", "TEXT"],
  ["sessions", "last_seen", "INTEGER"],
];
async function migrate(env: Env): Promise<void> {
  for (const table of new Set(ADDED_COLUMNS.map((c) => c[0]))) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const have = new Set(results.map((r) => r.name));
    for (const [t, col, type] of ADDED_COLUMNS) {
      if (t === table && !have.has(col)) await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`).run();
    }
  }
}

let schemaReady: Promise<void> | null = null;
export function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)))
      .then(() => migrate(env))
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

export const TRASH_DAYS = 30;
const DAY = 86_400_000;

// ---------------- Papers ----------------

type PaperRow = {
  id: string; user_id: string; title: string; filename: string; uploaded_at: string;
  status: Paper["status"]; stage: string | null; chunk_count: number; word_count: number;
  summary: string | null; key_points: string | null; questions: string | null; error: string | null;
  auto_title: number; state: PaperState; archived_at: number | null; deleted_at: number | null;
  paper_vec?: number;
};

const parseList = (v: string | null) => {
  if (!v) return undefined;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : undefined; } catch { return undefined; }
};

function toPaper(r: PaperRow): Paper {
  return {
    id: r.id,
    title: r.title,
    filename: r.filename,
    uploadedAt: r.uploaded_at,
    status: r.status,
    stage: r.stage ?? undefined,
    chunkCount: r.chunk_count,
    wordCount: r.word_count,
    summary: r.summary ?? undefined,
    keyPoints: parseList(r.key_points),
    questions: parseList(r.questions),
    error: r.error ?? undefined,
    autoTitle: !!r.auto_title,
    paperVec: !!r.paper_vec,
    state: r.state,
    archivedAt: r.archived_at ?? undefined,
    deletedAt: r.deleted_at ?? undefined,
    purgeAt: r.deleted_at ? r.deleted_at + TRASH_DAYS * DAY : undefined,
  };
}

export async function insertPaper(env: Env, userId: string, p: Paper): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO papers (id, user_id, title, filename, uploaded_at, status, stage, chunk_count, word_count,
       summary, key_points, questions, error, auto_title, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  )
    .bind(
      p.id, userId, p.title, p.filename, p.uploadedAt, p.status, p.stage ?? null, p.chunkCount, p.wordCount,
      p.summary ?? null, p.keyPoints ? JSON.stringify(p.keyPoints) : null,
      p.questions ? JSON.stringify(p.questions) : null, p.error ?? null, p.autoTitle ? 1 : 0
    )
    .run();
}

/** Fetches a paper. When userId is given, only that user's paper is returned. */
export async function getPaper(env: Env, id: string, userId?: string): Promise<Paper | null> {
  const row = userId
    ? await env.DB.prepare(`SELECT * FROM papers WHERE id = ? AND user_id = ?`).bind(id, userId).first<PaperRow>()
    : await env.DB.prepare(`SELECT * FROM papers WHERE id = ?`).bind(id).first<PaperRow>();
  return row ? toPaper(row) : null;
}

export async function listPapers(env: Env, userId: string, state: PaperState = "active"): Promise<Paper[]> {
  const order = state === "deleted" ? "deleted_at DESC" : state === "archived" ? "archived_at DESC" : "uploaded_at DESC";
  const { results } = await env.DB.prepare(`SELECT * FROM papers WHERE user_id = ? AND state = ? ORDER BY ${order}`)
    .bind(userId, state)
    .all<PaperRow>();
  return results.map(toPaper);
}

export async function countPapers(env: Env, userId: string): Promise<Record<PaperState, number>> {
  const { results } = await env.DB.prepare(`SELECT state, COUNT(*) AS n FROM papers WHERE user_id = ? GROUP BY state`)
    .bind(userId)
    .all<{ state: PaperState; n: number }>();
  const out = { active: 0, archived: 0, deleted: 0 };
  for (const r of results) out[r.state] = r.n;
  return out;
}

const COLS: Record<string, string> = {
  title: "title", status: "status", stage: "stage", chunkCount: "chunk_count", wordCount: "word_count",
  summary: "summary", keyPoints: "key_points", questions: "questions", error: "error", autoTitle: "auto_title",
  state: "state", archivedAt: "archived_at", deletedAt: "deleted_at", paperVec: "paper_vec",
};

/** Partial update. `undefined` values clear the column (e.g. stage once processing ends). */
export async function updatePaper(env: Env, id: string, patch: Partial<Paper>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    if (v === undefined) vals.push(null);
    else if (Array.isArray(v)) vals.push(JSON.stringify(v));
    else if (typeof v === "boolean") vals.push(v ? 1 : 0);
    else vals.push(v);
  }
  if (!sets.length) return;
  await env.DB.prepare(`UPDATE papers SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
}

/**
 * Deletes a paper's passages from Vectorize. Vectorize sometimes rejects a delete
 * (VECTOR_DELETE_ERROR 400); we retry in smaller pieces, and if it still refuses we carry on,
 * because leftover passages are never searched (searches only look inside a user's own
 * current papers, by namespace). It never blocks erasing the paper itself.
 */
export const ORPHAN_PREFIX = "orphans:";
export async function deleteVectors(env: Env, ids: string[], paperId: string): Promise<string[]> {
  const tryDelete = async (batch: string[]) => {
    try { await env.VECTORIZE.deleteByIds(batch); return true; } catch { return false; }
  };
  const failed: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    if (await tryDelete(batch)) continue;
    for (let j = 0; j < batch.length; j += 10) {
      const small = batch.slice(j, j + 10);
      if (!(await tryDelete(small))) failed.push(...small);
    }
  }
  // Remember what Vectorize refused; the daily cleanup job (maintenance.ts) tries again.
  if (failed.length) {
    console.warn(JSON.stringify({ event: "vector_delete_deferred", paperId, count: failed.length, of: ids.length }));
    await env.PAPERS_KV.put(`${ORPHAN_PREFIX}${paperId}`, JSON.stringify(failed), { expirationTtl: 60 * 86400 }).catch(() => {});
  }
  return failed;
}

/** Permanently removes a paper: vectors, stored text and its row. */
export async function purgePaper(env: Env, p: Pick<Paper, "id" | "chunkCount">): Promise<void> {
  const ids = [...Array.from({ length: p.chunkCount }, (_, i) => vectorId(p.id, i)), paperVectorId(p.id)];
  await deleteVectors(env, ids, p.id);
  await env.PAPERS_KV.delete(contentKey(p.id));
  await env.DB.prepare(`DELETE FROM papers WHERE id = ?`).bind(p.id).run();
}

/** Erases a user's papers that have been in Recently deleted for more than 30 days. */
export async function purgeExpired(env: Env, userId: string): Promise<string[]> {
  const cutoff = Date.now() - TRASH_DAYS * DAY;
  const { results } = await env.DB.prepare(
    `SELECT id, chunk_count FROM papers WHERE user_id = ? AND state = 'deleted' AND deleted_at < ?`
  ).bind(userId, cutoff).all<{ id: string; chunk_count: number }>();
  for (const r of results) await purgePaper(env, { id: r.id, chunkCount: r.chunk_count });
  return results.map((r) => r.id);
}

// ---------------- Chats (conversation list) ----------------

export type ChatState = "active" | "archived" | "deleted";
export interface ChatSummary {
  id: string; title: string; paperId?: string; messageCount: number; updatedAt: number;
  state: ChatState; archivedAt?: number; deletedAt?: number; purgeAt?: number;
  /** For tags on the Archive / Recently deleted pages. Missing when the paper was erased. */
  paperTitle?: string; paperState?: PaperState;
}
type ChatRow = {
  id: string; title: string; paper_id: string | null; message_count: number; updated_at: number;
  state: ChatState; archived_at: number | null; deleted_at: number | null; paper_title: string | null; paper_state: PaperState | null;
};
const toChat = (r: ChatRow): ChatSummary => ({
  id: r.id, title: r.title, paperId: r.paper_id ?? undefined, messageCount: r.message_count, updatedAt: r.updated_at,
  state: r.state || "active", archivedAt: r.archived_at ?? undefined, deletedAt: r.deleted_at ?? undefined,
  purgeAt: r.deleted_at ? r.deleted_at + TRASH_DAYS * DAY : undefined,
  paperTitle: r.paper_title ?? undefined, paperState: r.paper_state ?? undefined,
});

/** Records a new message. Writing in an archived conversation brings it back to the library. */
export async function touchChat(env: Env, userId: string, id: string, firstQuestion: string, paperId?: string) {
  await env.DB.prepare(
    `INSERT INTO chats (id, user_id, title, paper_id, message_count, updated_at, state) VALUES (?, ?, ?, ?, 1, ?, 'active')
     ON CONFLICT(id) DO UPDATE SET message_count = message_count + 1, updated_at = excluded.updated_at,
       paper_id = excluded.paper_id, state = 'active', archived_at = NULL, deleted_at = NULL
     WHERE chats.user_id = excluded.user_id`
  ).bind(id, userId, firstQuestion.slice(0, 200), paperId ?? null, Date.now()).run();
}

export async function listChats(env: Env, userId: string, limit = 100, state: ChatState = "active"): Promise<ChatSummary[]> {
  const order = state === "deleted" ? "c.deleted_at DESC" : state === "archived" ? "c.archived_at DESC" : "c.updated_at DESC";
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.title, c.paper_id, c.message_count, c.updated_at, c.state, c.archived_at, c.deleted_at,
            p.title AS paper_title, p.state AS paper_state
     FROM chats c LEFT JOIN papers p ON p.id = c.paper_id
     WHERE c.user_id = ? AND c.state = ? ORDER BY ${order} LIMIT ?`
  ).bind(userId, state, limit).all<ChatRow>();
  return results.map(toChat);
}

export async function countChats(env: Env, userId: string): Promise<Record<ChatState, number>> {
  const { results } = await env.DB.prepare(`SELECT state, COUNT(*) AS n FROM chats WHERE user_id = ? GROUP BY state`)
    .bind(userId).all<{ state: ChatState; n: number }>();
  const out = { active: 0, archived: 0, deleted: 0 };
  for (const r of results) out[r.state || "active"] += r.n;
  return out;
}

/** Archives, deletes (to Recently deleted) or restores a conversation. Returns false if it isn't theirs. */
export async function setChatState(env: Env, userId: string, id: string, state: ChatState): Promise<boolean> {
  const now = Date.now();
  const r = await env.DB.prepare(`UPDATE chats SET state = ?, archived_at = ?, deleted_at = ? WHERE id = ? AND user_id = ?`)
    .bind(state, state === "archived" ? now : null, state === "deleted" ? now : null, id, userId).run();
  return !!r.meta.changes;
}

/** Conversations to erase: expired ones in Recently deleted, or (with paperIds) every chat about those papers. */
export async function chatIdsToErase(env: Env, userId: string, opts: { expired?: boolean; allDeleted?: boolean; paperIds?: string[] }) {
  if (opts.paperIds) {
    if (!opts.paperIds.length) return [];
    const { results } = await env.DB.prepare(
      `SELECT id FROM chats WHERE user_id = ? AND paper_id IN (${opts.paperIds.map(() => "?").join(",")})`
    ).bind(userId, ...opts.paperIds).all<{ id: string }>();
    return results.map((r) => r.id);
  }
  const cutoff = opts.allDeleted ? Date.now() + DAY : Date.now() - TRASH_DAYS * DAY;
  const { results } = await env.DB.prepare(`SELECT id FROM chats WHERE user_id = ? AND state = 'deleted' AND deleted_at < ?`)
    .bind(userId, cutoff).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function deleteChat(env: Env, userId: string, id: string) {
  await env.DB.prepare(`DELETE FROM chats WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

// ---------------- Legacy import ----------------

/**
 * Papers uploaded before accounts existed live only in KV ("meta:<id>").
 * The first account created adopts them so nothing is lost.
 */
export async function adoptLegacyPapers(env: Env, userId: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await env.PAPERS_KV.list({ prefix: "meta:", cursor });
    for (const k of page.keys) {
      const raw = await env.PAPERS_KV.get(k.name);
      if (!raw) continue;
      const p = JSON.parse(raw) as Paper;
      const exists = await env.DB.prepare(`SELECT 1 FROM papers WHERE id = ?`).bind(p.id).first();
      if (!exists) {
        await insertPaper(env, userId, { ...p, status: p.status === "processing" ? "failed" : p.status });
        n++;
      }
      await env.PAPERS_KV.delete(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}
