import type { ChatMessage, Env, Paper, SourceRef } from "./types";
import { paperIndexNs, paperVectorId } from "./types";
import { parseJsonLoose } from "./utils";

export const MODELS = {
  embed: "@cf/baai/bge-base-en-v1.5",
  rerank: "@cf/baai/bge-reranker-base",
  chat: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  fast: "@cf/meta/llama-3.1-8b-instruct-fast",
} as const;

const CANDIDATES = 20; // pulled from Vectorize before reranking
const KEEP = 6; // passages handed to the LLM
const MIN_SCORE = 0.3; // cosine floor for a passage to be considered at all

// Workers AI model typings vary by version; call through a loose signature.
type LooseAi = { run(model: string, input: unknown): Promise<any> };
const ai = (env: Env) => env.AI as unknown as LooseAi;

/** Embeds a batch of strings with BGE (768-d). */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = await ai(env).run(MODELS.embed, { text: texts });
  return res.data ?? res;
}

/**
 * Turns a follow-up like "what about its limitations?" into a standalone query
 * ("limitations of the Transformer architecture") so retrieval finds the right passages.
 */
export async function rewriteQuery(
  env: Env,
  history: Array<{ role: string; content: string }>,
  question: string
): Promise<string> {
  if (history.length === 0) return question;
  try {
    const transcript = history
      .slice(-4)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 400)}`)
      .join("\n");
    const res = await ai(env).run(MODELS.fast, {
      messages: [
        {
          role: "system",
          content:
            "Rewrite the user's latest question as a standalone search query for a research-paper search engine. " +
            "Resolve pronouns and references using the conversation. Output ONLY the query, no quotes or explanation.",
        },
        { role: "user", content: `Conversation:\n${transcript}\n\nLatest question: ${question}` },
      ],
      max_tokens: 60,
      temperature: 0,
    });
    const q = String(res?.response ?? "").trim().replace(/^["']|["']$/g, "");
    return q && q.length < 300 ? q : question;
  } catch {
    return question;
  }
}

/** Text that represents a whole paper in the user's paper index. */
export const paperProfileText = (p: Pick<Paper, "title" | "summary" | "keyPoints">) =>
  [p.title, p.summary, ...(p.keyPoints || [])].filter(Boolean).join(". ").slice(0, 2000);

/** Adds (or refreshes) a paper's summary vector in its owner's paper index. */
export async function indexPaperProfile(env: Env, userId: string, p: Pick<Paper, "id" | "title" | "summary" | "keyPoints">) {
  const [values] = await embed(env, [paperProfileText(p)]);
  await env.VECTORIZE.upsert([
    { id: paperVectorId(p.id), values, namespace: paperIndexNs(userId), metadata: { paperId: p.id, kind: "paper" } },
  ]);
}

/** Whole-library questions only search passages in this many of the most relevant papers. */
export const SHORTLIST = 8;

export type Retrieval = { sources: SourceRef[]; shortlist: string[] };

/**
 * Finds the passages that best answer a question.
 *
 * Each paper's passages live in their own Vectorize namespace (which also keeps users apart).
 * With a few papers we search them all. With more, we first search the user's *paper index*
 * (one summary vector per paper) to shortlist the most relevant papers, then search passages in
 * just those, so a question costs two searches whether the library holds 10 papers or 1,000.
 * Papers that don't have a summary vector yet are always searched, so nothing is skipped.
 * Finally a cross-encoder reranks the candidates.
 */
export async function retrieve(env: Env, query: string, papers: Pick<Paper, "id" | "paperVec">[], userId: string): Promise<Retrieval> {
  if (papers.length === 0) return { sources: [], shortlist: [] };
  const [vector] = await embed(env, [query]);

  let shortlist = papers.map((p) => p.id);
  if (papers.length > SHORTLIST) {
    const inScope = new Set(papers.map((p) => p.id));
    const profiled = await env.VECTORIZE.query(vector, { topK: Math.min(50, SHORTLIST * 3), namespace: paperIndexNs(userId), returnMetadata: "all" })
      .catch(() => ({ matches: [] as VectorizeMatch[] }));
    const ranked = profiled.matches
      .map((m) => String((m.metadata as Record<string, string> | undefined)?.paperId || ""))
      .filter((id) => inScope.has(id));
    const unprofiled = papers.filter((p) => !p.paperVec).map((p) => p.id);
    shortlist = [...new Set([...ranked.slice(0, SHORTLIST), ...unprofiled])];
    if (!shortlist.length) shortlist = papers.slice(0, SHORTLIST).map((p) => p.id);
  }

  const perPaper = shortlist.length === 1 ? CANDIDATES : Math.max(5, Math.ceil(CANDIDATES / shortlist.length) + 3);
  const results = await Promise.all(
    shortlist.map((ns) => env.VECTORIZE.query(vector, { topK: perPaper, returnMetadata: "all", namespace: ns }).catch(() => ({ matches: [] as VectorizeMatch[] })))
  );
  const matches = results.flatMap((r) => r.matches).sort((a, b) => b.score - a.score).slice(0, CANDIDATES);

  console.log(
    `[retrieve] query="${query.slice(0, 80)}" papers=${papers.length} searched=${shortlist.length} matches=${matches.length} top=${matches[0]?.score?.toFixed(3) ?? "none"}`
  );

  const candidates = matches
    .filter((m) => m.score >= MIN_SCORE && m.metadata?.text)
    .map((m) => {
      const meta = m.metadata as Record<string, string>;
      return {
        paperId: meta.paperId,
        title: meta.title ?? "Untitled",
        chunkIndex: Number(meta.chunkIndex ?? 0),
        score: m.score,
        text: meta.text,
      };
    });

  if (candidates.length === 0) return { sources: [], shortlist };

  // Rerank with a cross-encoder; fall back to vector order if it's unavailable.
  let ordered = candidates;
  if (candidates.length > KEEP) {
    try {
      const res = await ai(env).run(MODELS.rerank, {
        query,
        contexts: candidates.map((c) => ({ text: c.text })),
        top_k: KEEP,
      });
      const ranked: Array<{ id: number; score: number }> = res?.response ?? [];
      if (ranked.length) ordered = ranked.map((r) => candidates[r.id]).filter(Boolean);
    } catch (err) {
      console.warn("Rerank failed, using vector order:", err);
    }
  }

  return { sources: ordered.slice(0, KEEP).map((c, i) => ({ n: i + 1, ...c })), shortlist };
}

export function buildSystemPrompt(sources: SourceRef[], overviews: Paper[]): string {
  const overviewText = overviews
    .filter((p) => p.summary)
    .map((p) => `• "${p.title}": ${p.summary}`)
    .join("\n");

  const passages = sources
    .map((s) => `[${s.n}] (from "${s.title}", passage ${s.chunkIndex + 1})\n${s.text}`)
    .join("\n\n");

  return `You are CiteSeek, a research assistant that answers questions about the user's uploaded papers.

Rules:
- Answer ONLY from the paper overviews and numbered passages below. Never use outside knowledge.
- Cite every factual claim with the passage number in square brackets, e.g. [1] or [2][4]. Put citations right after the claim.
- Prefer citing numbered passages. If a claim comes only from a paper overview, cite it as [brief]. Never write any other label in brackets.
- If the passages don't contain the answer, say so plainly and suggest what to ask or upload instead.
- Be precise and clear. Use short paragraphs or bullet lists. Use **bold** for key terms.

Paper overviews:
${overviewText || "(none available)"}

Numbered passages:
${passages || "(no relevant passages were found for this question)"}`;
}

/** Cleans a candidate title and rejects ones that look like file names, IDs or junk. */
export function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/\s+/g, " ").replace(/^["'“]|["'”.]$/g, "").trim();
  if (t.length < 6 || t.length > 250) return undefined;
  if (/^(untitled|unknown|n\/a|none|title)$/i.test(t)) return undefined;
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(t)) return undefined; // arXiv id
  if (/\.(pdf|docx?|tex|dvi|txt)$/i.test(t) || /microsoft word|^slide|^doi:/i.test(t)) return undefined;
  if (!/[a-z]{3,}/i.test(t) || t.split(" ").length < 2) return undefined;
  return t;
}

/**
 * Asks the LLM for a summary, key points and starter questions for a newly ingested paper.
 * When `detectTitle` is set, it also reads the paper's real title from the first page.
 */
export async function summarizePaper(
  env: Env,
  title: string,
  text: string,
  opts: { detectTitle?: boolean; titleHint?: string } = {}
): Promise<Pick<Paper, "summary" | "keyPoints" | "questions"> & { title?: string }> {
  // Abstract + introduction carry most of a paper's framing; the tail adds conclusions.
  const head = text.slice(0, 9000);
  const tail = text.length > 12000 ? text.slice(-3000) : "";
  const titleLine = opts.detectTitle
    ? `Paper title: unknown. Read it from the first page.${opts.titleHint ? ` (The PDF's metadata says "${opts.titleHint}", which may be wrong.)` : ""}`
    : `Paper title: ${title}`;
  const prompt = `${titleLine}

Beginning of the paper:
${head}
${tail ? `\n...\n\nEnd of the paper:\n${tail}` : ""}

Return a JSON object with exactly these keys:
${opts.detectTitle ? `- "title": the paper's exact title as printed on its first page (not the authors, venue or arXiv id), in normal title case.\n` : ""}- "summary": 2-3 plain-English sentences on what the paper does and why it matters.
- "keyPoints": array of 3-4 short bullet strings (max 15 words each) with its main contributions or findings.
- "questions": array of 4 specific questions a reader could ask about this paper (max 12 words each).
Output only the JSON.`;

  const res = await ai(env).run(MODELS.chat, {
    messages: [
      { role: "system", content: "You summarise research papers accurately and concisely. You output strict JSON." },
      { role: "user", content: prompt },
    ],
    max_tokens: 800,
    temperature: 0.2,
  });

  const parsed = parseJsonLoose<{ title?: string; summary?: string; keyPoints?: string[]; questions?: string[] }>(
    res?.response
  );
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];

  return {
    title: opts.detectTitle ? cleanTitle(parsed?.title) ?? cleanTitle(opts.titleHint) : undefined,
    summary: typeof parsed?.summary === "string" ? parsed.summary : undefined,
    keyPoints: strings(parsed?.keyPoints),
    questions: strings(parsed?.questions),
  };
}

/** Builds the chat messages array for the answer model. */
export function buildMessages(
  system: string,
  history: Array<{ role: string; content: string }>,
  question: string
) {
  return [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content })),
    { role: "user", content: question },
  ];
}

/**
 * Reads a Workers AI SSE stream and yields text deltas.
 * Handles both the `response` field and streamed `choices[0].delta.content`
 * field returned by supported models.
 */
export async function* readAiStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.response ?? json.choices?.[0]?.delta?.content ?? "";
        if (delta) yield delta;
      } catch {
        /* ignore keep-alives / partial lines */
      }
    }
  }
}

export { ai as looseAi };
