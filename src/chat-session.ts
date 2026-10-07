import { DurableObject } from "cloudflare:workers";
import type { Env, ChatMessage } from "./types";

/**
 * ChatSession Durable Object — one instance per conversation.
 * Stores the full message history (including the passages each answer cited)
 * in the object's embedded SQLite database.
 */
export class ChatSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources TEXT,
        timestamp TEXT NOT NULL
      )
    `);
    // Older sessions won't have this column.
    const cols = ctx.storage.sql.exec(`PRAGMA table_info(messages)`).toArray();
    if (!cols.some((c) => c.name === "search_query")) {
      ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN search_query TEXT`);
    }
  }

  async addMessage(message: ChatMessage): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (role, content, sources, timestamp, search_query) VALUES (?, ?, ?, ?, ?)`,
      message.role,
      message.content,
      message.sources ? JSON.stringify(message.sources) : null,
      message.timestamp,
      message.searchQuery ?? null
    );
  }

  async getHistory(limit = 50): Promise<ChatMessage[]> {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT role, content, sources, timestamp, search_query FROM messages ORDER BY id DESC LIMIT ?`,
        limit
      )
      .toArray();

    return rows.reverse().map((row) => {
      let sources: ChatMessage["sources"];
      if (row.sources) {
        const parsed = JSON.parse(row.sources as string);
        // Sessions from the original app stored plain title strings; drop those.
        sources = Array.isArray(parsed) && typeof parsed[0] === "object" ? parsed : undefined;
      }
      return {
        role: row.role as ChatMessage["role"],
        content: row.content as string,
        timestamp: row.timestamp as string,
        sources,
        searchQuery: (row.search_query as string) ?? undefined,
      };
    });
  }

  /** Last N messages as plain role/content pairs for the LLM context window. */
  async getContextMessages(limit = 6): Promise<Array<{ role: string; content: string }>> {
    const history = await this.getHistory(limit);
    return history.map((m) => ({ role: m.role, content: m.content }));
  }

  async clearHistory(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM messages`);
  }
}
