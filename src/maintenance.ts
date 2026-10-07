import type { Env } from "./types";
import { ORPHAN_PREFIX, TRASH_DAYS, chatIdsToErase, ensureSchema, purgePaper } from "./db";
import { eraseChats } from "./chats";

const DAY = 86_400_000;

/**
 * Daily cleanup, run by the cron trigger in wrangler.toml (and on demand in tests).
 * Recently deleted is also emptied when its owner visits; this catches everyone who doesn't.
 *  - papers and conversations in Recently deleted for 30+ days (and chats about erased papers)
 *  - expired sign-in sessions, used/expired email links, old rate-limit records
 *  - passages Vectorize refused to delete earlier (retried, then forgotten after 60 days)
 */
export async function runMaintenance(env: Env) {
  const started = Date.now();
  await ensureSchema(env);
  const now = Date.now();
  const report = { papers: 0, chats: 0, sessions: 0, tokens: 0, attempts: 0, orphansRetried: 0, orphansLeft: 0 };

  const { results: oldPapers } = await env.DB.prepare(
    `SELECT id, user_id, chunk_count FROM papers WHERE state = 'deleted' AND deleted_at < ? LIMIT 200`
  ).bind(now - TRASH_DAYS * DAY).all<{ id: string; user_id: string; chunk_count: number }>();
  const byUser = new Map<string, string[]>();
  for (const p of oldPapers) {
    await purgePaper(env, { id: p.id, chunkCount: p.chunk_count });
    byUser.set(p.user_id, [...(byUser.get(p.user_id) || []), p.id]);
    report.papers++;
  }
  const { results: chatOwners } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM chats WHERE state = 'deleted' AND deleted_at < ? LIMIT 500`
  ).bind(now - TRASH_DAYS * DAY).all<{ user_id: string }>();
  const users = new Set([...byUser.keys(), ...chatOwners.map((r) => r.user_id)]);
  for (const userId of users) {
    const ids = new Set([
      ...(await chatIdsToErase(env, userId, { expired: true })),
      ...(await chatIdsToErase(env, userId, { paperIds: byUser.get(userId) || [] })),
    ]);
    report.chats += await eraseChats(env, userId, [...ids]);
  }

  const run = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).run()).meta.changes || 0;
  report.sessions = await run(`DELETE FROM sessions WHERE expires_at < ?`, now);
  report.tokens = await run(`DELETE FROM email_tokens WHERE expires_at < ?`, now - 7 * DAY);
  report.attempts = await run(`DELETE FROM auth_attempts WHERE at < ?`, now - DAY);

  let cursor: string | undefined;
  do {
    const page = await env.PAPERS_KV.list({ prefix: ORPHAN_PREFIX, cursor });
    for (const k of page.keys) {
      const ids = (await env.PAPERS_KV.get<string[]>(k.name, "json")) || [];
      const left: string[] = [];
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        try { await env.VECTORIZE.deleteByIds(batch); } catch { left.push(...batch); }
      }
      report.orphansRetried += ids.length;
      report.orphansLeft += left.length;
      if (left.length) await env.PAPERS_KV.put(k.name, JSON.stringify(left), { expirationTtl: 60 * 86400 });
      else await env.PAPERS_KV.delete(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(JSON.stringify({ event: "maintenance", ms: Date.now() - started, ...report }));
  return report;
}
