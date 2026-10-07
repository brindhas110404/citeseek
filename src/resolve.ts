import type { Env } from "./types";

/**
 * Finds a free PDF and an abstract for a paper on the globe, by title.
 *
 * The globe stores one link per paper (from the conference's own data). That link often fails:
 * OpenReview (ICLR, newer NeurIPS) blocks automated downloads, some papers have no free PDF on
 * the publisher's site, and some conference data has no abstract. Most ML papers also have an
 * open copy elsewhere, so we ask three free scholarly indexes, by title:
 *   arXiv · Semantic Scholar · OpenAlex
 * Results are cached in KV for a week so repeat clicks don't hit those services again.
 */

export type PdfCandidate = { url: string; source: string };
export type Lookup = { abstract?: string; abstractSource?: string; pdfs: PdfCandidate[] };

const UA = "Mozilla/5.0 (compatible; CiteSeek/1.0; research-paper reader)";
const TIMEOUT_MS = 7000;

export const normTitle = (t: string) =>
  t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** True when two titles name the same paper (tolerates punctuation, case, small edits). */
export function sameTitle(a: string, b: string): boolean {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const A = new Set(x.split(" ")), B = new Set(y.split(" "));
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.max(A.size, B.size) >= 0.85;
}

/** Turns a paper's page link into its PDF link where the pattern is known. */
export function pdfFromPage(u: string): string {
  try {
    const url = new URL(u);
    if (url.hostname === "openreview.net" && url.pathname === "/forum") return `https://openreview.net/pdf?id=${url.searchParams.get("id")}`;
    if (url.hostname.endsWith("arxiv.org") && url.pathname.startsWith("/abs/")) return `https://arxiv.org/pdf/${url.pathname.slice(5)}`;
    if (url.hostname === "aclanthology.org" && /^\/[\w.-]+\/?$/.test(url.pathname) && !url.pathname.endsWith(".pdf")) {
      return `https://aclanthology.org/${url.pathname.replace(/^\/|\/$/g, "")}.pdf`;
    }
  } catch {}
  return u;
}

async function get(url: string, accept = "application/json"): Promise<Response | null> {
  try {
    return await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

const unXml = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** arXiv's search API (Atom XML). */
export async function fromArxiv(title: string): Promise<Lookup> {
  const words = normTitle(title).split(" ").filter((w) => w.length > 2).slice(0, 12);
  if (!words.length) return { pdfs: [] };
  const q = words.map((w) => `ti:${w}`).join("+AND+");
  const res = await get(`https://export.arxiv.org/api/query?search_query=${q}&max_results=5`, "application/atom+xml");
  if (!res?.ok) return { pdfs: [] };
  const xml = await res.text();
  for (const entry of xml.split("<entry>").slice(1)) {
    const t = unXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
    if (!sameTitle(t, title)) continue;
    const id = entry.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/)?.[1];
    const abstract = unXml(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "");
    return {
      ...(abstract ? { abstract, abstractSource: "arXiv" } : {}),
      pdfs: id ? [{ url: `https://arxiv.org/pdf/${id.replace(/v\d+$/, "")}`, source: "arXiv" }] : [],
    };
  }
  return { pdfs: [] };
}

/** Semantic Scholar's title-match endpoint. */
export async function fromSemanticScholar(title: string): Promise<Lookup> {
  const res = await get(
    `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(title)}&fields=title,abstract,openAccessPdf,externalIds`
  );
  if (!res?.ok) return { pdfs: [] };
  const data = await res.json<any>().catch(() => null);
  const p = data?.data?.[0];
  if (!p || !sameTitle(p.title || "", title)) return { pdfs: [] };
  const pdfs: PdfCandidate[] = [];
  if (p.externalIds?.ArXiv) pdfs.push({ url: `https://arxiv.org/pdf/${p.externalIds.ArXiv}`, source: "arXiv" });
  if (p.openAccessPdf?.url) pdfs.push({ url: p.openAccessPdf.url, source: "Semantic Scholar" });
  return { ...(p.abstract ? { abstract: p.abstract, abstractSource: "Semantic Scholar" } : {}), pdfs };
}

/** OpenAlex works search (abstracts come as an inverted index). */
export async function fromOpenAlex(title: string): Promise<Lookup> {
  const res = await get(
    `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=5&select=display_name,abstract_inverted_index,best_oa_location,locations,ids`
  );
  if (!res?.ok) return { pdfs: [] };
  const data = await res.json<any>().catch(() => null);
  for (const w of data?.results || []) {
    if (!sameTitle(w.display_name || "", title)) continue;
    const pdfs: PdfCandidate[] = [];
    const seen = new Set<string>();
    for (const loc of [w.best_oa_location, ...(w.locations || [])]) {
      const u = loc?.pdf_url;
      if (u && !seen.has(u)) { seen.add(u); pdfs.push({ url: u, source: "OpenAlex" }); }
    }
    let abstract = "";
    if (w.abstract_inverted_index) {
      const words: string[] = [];
      for (const [word, positions] of Object.entries<number[]>(w.abstract_inverted_index)) for (const i of positions) words[i] = word;
      abstract = words.filter(Boolean).join(" ");
    }
    return { ...(abstract ? { abstract, abstractSource: "OpenAlex" } : {}), pdfs: pdfs.slice(0, 4) };
  }
  return { pdfs: [] };
}

/** Asks all three indexes at once and merges what they found (arXiv copies first). */
export async function lookupPaper(env: Env, title: string): Promise<Lookup> {
  const key = `atlas:lookup:${normTitle(title).slice(0, 400)}`;
  const cached = await env.PAPERS_KV.get(key, "json").catch(() => null) as Lookup | null;
  if (cached) return cached;
  const parts = await Promise.all([fromArxiv(title), fromSemanticScholar(title), fromOpenAlex(title)]);
  const pdfs: PdfCandidate[] = [];
  const seen = new Set<string>();
  for (const p of parts.flatMap((x) => x.pdfs).sort((a, b) => Number(b.source === "arXiv") - Number(a.source === "arXiv"))) {
    const k = p.url.replace(/^https?:\/\//, "").replace(/v\d+$/, "");
    if (!seen.has(k)) { seen.add(k); pdfs.push(p); }
  }
  const withAbstract = parts.find((p) => p.abstract && p.abstract.length > 80);
  const out: Lookup = { pdfs, ...(withAbstract ? { abstract: withAbstract.abstract!.slice(0, 3000), abstractSource: withAbstract.abstractSource } : {}) };
  // Cache hits for a week; misses for a day (the services may simply have been busy).
  const ttl = out.pdfs.length || out.abstract ? 7 * 86400 : 86400;
  await env.PAPERS_KV.put(key, JSON.stringify(out), { expirationTtl: ttl }).catch(() => {});
  return out;
}

/** Downloads one candidate. Returns the response if it's really a PDF, else a reason. */
export async function downloadPdf(url: string, hostOk: (u: URL) => boolean): Promise<{ res?: Response; reason?: string }> {
  let current: URL;
  try { current = new URL(url); } catch { return { reason: "bad link" }; }
  if (!hostOk(current)) return { reason: "not an allowed host" };
  for (let hop = 0; hop < 5; hop++) {
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "application/pdf,*/*;q=0.5" },
        signal: AbortSignal.timeout(20000),
      });
    } catch (err: any) {
      return { reason: err?.name === "TimeoutError" ? "timed out" : "couldn't connect" };
    }
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current);
      if (!hostOk(current)) return { reason: "redirected to an unknown site" };
      continue;
    }
    if (!res.ok) return { reason: res.status === 403 || res.status === 401 ? "the site blocks automatic downloads" : `the site returned ${res.status}` };
    const type = res.headers.get("Content-Type") || "";
    if (!/pdf|octet-stream/i.test(type)) return { reason: "the link opens a web page, not a PDF" };
    if (Number(res.headers.get("Content-Length") || 0) > 40_000_000) return { reason: "the PDF is over 40 MB" };
    return { res };
  }
  return { reason: "too many redirects" };
}
