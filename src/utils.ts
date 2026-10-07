/**
 * Rough token estimate. BGE / Llama tokenizers average ~1.3 tokens per English
 * word, which is accurate enough for sizing chunks without shipping a tokenizer.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/** Normalises text extracted from PDFs (hyphenated line breaks, stray whitespace). */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/([a-z])-\s*\n\s*([a-z])/g, "$1$2") // "atten-\ntion" -> "attention"
    .replace(/([a-z])- ([a-z])/g, "$1$2") // "atten- tion" (pdf.js joins with spaces)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Splits into sentences, keeping paragraph breaks as boundaries. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const flat = para.replace(/\n/g, " ").trim();
    if (!flat) continue;
    // Split only where punctuation is followed by whitespace and a likely sentence start,
    // so decimals ("3.5"), "e.g." mid-sentence and "Fig. 2" mostly stay intact.
    const parts = flat.split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[A-Z])/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** Breaks a sentence that is longer than the budget (common in PDF text without punctuation). */
function splitLong(sentence: string, maxTokens: number): string[] {
  const words = sentence.split(/\s+/);
  const perPiece = Math.max(20, Math.floor(maxTokens / 1.3));
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += perPiece) {
    pieces.push(words.slice(i, i + perPiece).join(" "));
  }
  return pieces;
}

/**
 * Token-aware, sentence-respecting chunker.
 * Packs whole sentences until ~maxTokens, then starts the next chunk with the
 * last ~overlapTokens worth of sentences so context isn't cut mid-thought.
 */
export function chunkText(
  text: string,
  maxTokens = 350,
  overlapTokens = 60
): string[] {
  const sentences = splitSentences(cleanText(text)).flatMap((s) =>
    estimateTokens(s) > maxTokens ? splitLong(s, maxTokens) : [s]
  );

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const t = estimateTokens(sentence);
    if (currentTokens + t > maxTokens && current.length > 0) {
      chunks.push(current.join(" "));
      // Carry the tail of this chunk forward as overlap.
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const ct = estimateTokens(current[i]);
        if (carryTokens + ct > overlapTokens) break;
        carry.unshift(current[i]);
        carryTokens += ct;
      }
      current = carry;
      currentTokens = carryTokens;
    }
    current.push(sentence);
    currentTokens += t;
  }
  if (current.length) chunks.push(current.join(" "));

  // Vectorize metadata is capped at 10 KiB per vector; keep stored text well under it.
  return chunks.filter((c) => c.length > 40).map((c) => c.slice(0, 4000));
}

/** Generates a short unique ID. */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Pulls the first JSON object out of a model response (which may be wrapped in prose or fences). */
export function parseJsonLoose<T>(raw: unknown): T | null {
  if (raw && typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
