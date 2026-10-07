import type { Env } from "./types";
import { deleteChat } from "./db";

/** Conversation Durable Objects are keyed by user, so one user can never open another's chat. */
export const chatStub = (env: Env, userId: string, sessionId: string) =>
  env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(`${userId}:${sessionId}`));

/** Erases conversations for good: their message history and their row in the list. */
export async function eraseChats(env: Env, userId: string, ids: string[]) {
  for (const id of ids) {
    await chatStub(env, userId, id).clearHistory().catch(() => {});
    await deleteChat(env, userId, id);
  }
  return ids.length;
}
