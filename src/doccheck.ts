import type { Env } from "./types";

/**
 * "Is this a research paper?" CiteSeek is built for papers (citations, sections, a brief with
 * key points), so before indexing an upload we check what it is. Strong signals of a paper
 * (abstract, references, in-text citations...) pass straight through; anything weaker is
 * classified by Llama 3.1 8B. If the model is unavailable we fall back to the signals alone.
 */
export type DocCheck = { paper: boolean; kind: string; reason: string; score: number };

export function paperSignals(text: string): number {
  const head = text.slice(0, 6000).toLowerCase();
  const all = text.toLowerCase();
  let s = 0;
  if (/\babstract\b/.test(head)) s += 0.25;
  if (/\b(references|bibliography|works cited)\b/.test(all.slice(-Math.max(8000, all.length * 0.35)))) s += 0.25;
  if (/\b(introduction|related work|methodology|methods|conclusions?|discussion|experiments?)\b/.test(all)) s += 0.1;
  const bracketCites = (text.match(/\[\d{1,3}(?:[,–-]\s?\d{1,3})*\]/g) || []).length;
  const authorYear = (text.match(/\b[A-Z][a-zA-Z-]+(?: et al\.)?,? (?:19|20)\d{2}[a-z]?\b/g) || []).length;
  const etAl = (text.match(/\bet al\.?/g) || []).length;
  if (bracketCites + authorYear >= 8 || etAl >= 3) s += 0.2;
  if (/\b(figure|fig\.|table)\s+\d/i.test(text)) s += 0.1;
  if (/\b(arxiv|doi\.org|doi:|proceedings|journal|conference|university|institute)\b/.test(all)) s += 0.1;
  return Math.min(1, s);
}

export async function checkDocument(env: Env, text: string, model: string): Promise<DocCheck> {
  const score = paperSignals(text);
  if (score >= 0.6) return { paper: true, kind: "research paper", reason: "", score };
  try {
    const res: any = await (env.AI as any).run(model, {
      messages: [
        {
          role: "system",
          content:
            "You decide whether a document is a scholarly research paper (journal or conference article, preprint, thesis, " +
            "technical report or survey). Lecture notes, slides, resumes, cover letters, news articles, blog posts, " +
            "book chapters, manuals, legal documents and essays are NOT research papers. " +
            'Reply with ONLY JSON: {"paper": true|false, "kind": "<2-4 word description of what it is>", "reason": "<one short sentence>"}',
        },
        { role: "user", content: `Document start:\n${text.slice(0, 3500)}\n\nDocument end:\n${text.slice(-800)}` },
      ],
      max_tokens: 90,
      temperature: 0,
    });
    const raw = String(res?.response ?? "");
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const paper = json.paper === true || json.paper === "true";
    return {
      paper,
      kind: String(json.kind || (paper ? "research paper" : "document")).toLowerCase().slice(0, 40),
      reason: String(json.reason || "").slice(0, 200),
      score,
    };
  } catch {
    const paper = score >= 0.35;
    return { paper, kind: paper ? "research paper" : "document", reason: paper ? "" : "It doesn't have the usual parts of a paper (abstract, references, citations).", score };
  }
}
