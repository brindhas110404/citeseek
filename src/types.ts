import type { ChatSession } from "./chat-session";

// ---- Cloudflare bindings ----
export interface Env {
  AI: Ai;
  PAPERS_KV: KVNamespace;
  DB: D1Database;
  /** Cloudflare Turnstile keys. The bot check is on only when both are set. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /**
   * Password-reset emails (see src/mail.ts). Set ONE way to send:
   *  - EMAIL: Cloudflare Email Service binding (needs your own domain + Workers Paid), or
   *  - BREVO_API_KEY: Brevo's free API (300/day; verify EMAIL_FROM as a sender in Brevo).
   * With neither, links are printed to the dev terminal instead of sent.
   */
  EMAIL?: { send(message: { to: string; from: string | { email: string; name?: string }; subject: string; html: string; text: string }): Promise<unknown> };
  BREVO_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Public address of the app, used in emailed links. Defaults to the address the request came in on. */
  APP_URL?: string;
  /** Test-only: turns off rate limits (set in test/wrangler.mock.toml, never in production). */
  RELAX_LIMITS?: string;
  VECTORIZE: Vectorize;
  CHAT_SESSION: DurableObjectNamespace<ChatSession>;
  INGESTION_WORKFLOW: Workflow;
  ASSETS: Fetcher;
}

// ---- Application types ----
export type PaperStatus = "processing" | "ready" | "failed";
/** Where the paper lives: the library, the archive, or Recently deleted. */
export type PaperState = "active" | "archived" | "deleted";

export interface Paper {
  id: string;
  title: string;
  filename: string;
  uploadedAt: string;
  status: PaperStatus;
  /** Human-readable progress label while processing, e.g. "Embedding 3/9". */
  stage?: string;
  chunkCount: number;
  wordCount: number;
  summary?: string;
  keyPoints?: string[];
  questions?: string[];
  error?: string;
  /** True when no title was typed; the real title is detected during ingestion. */
  autoTitle?: boolean;
  /** True once the paper's summary vector is in the user's paper index (see rag.ts). */
  paperVec?: boolean;
  state?: PaperState;
  archivedAt?: number;
  deletedAt?: number;
  /** When a deleted paper will be erased for good (deletedAt + 30 days). */
  purgeAt?: number;
}

/** A retrieved passage that backed an answer; shown when a citation is clicked. */
export interface SourceRef {
  n: number;
  paperId: string;
  title: string;
  chunkIndex: number;
  score: number;
  text: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sources?: SourceRef[];
  /** The standalone search query used for retrieval (after follow-up rewriting). */
  searchQuery?: string;
}

export interface PaperIngestionParams {
  paperId: string;
  userId: string;
  title: string;
  filename: string;
  autoTitle?: boolean;
  /** Title from the PDF's embedded metadata, if any (often missing or wrong). */
  titleHint?: string;
}

// ---- KV key helpers ----
/** Legacy (pre-accounts) metadata key; only read when importing old papers. */
export const metaKey = (id: string) => `meta:${id}`;
export const contentKey = (id: string) => `content:${id}`;
export const vectorId = (paperId: string, i: number) => `${paperId}-${i}`;
/** One "summary vector" per paper (title + brief), kept in a per-user namespace for picking papers. */
export const paperVectorId = (paperId: string) => `${paperId}-paper`;
export const paperIndexNs = (userId: string) => `u-${userId}`;
