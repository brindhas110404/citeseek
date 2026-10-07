/**
 * CiteSeek PDF reader (runs in the browser with pdf.js).
 *
 * Research PDFs are hard to read as plain text: two-column pages interleave when read line by
 * line, words are hyphenated across lines, every page repeats a running header and a page number,
 * and scanned papers contain no text at all. This file:
 *   1. rebuilds lines from pdf.js text items and detects two-column pages (left column first),
 *   2. joins lines into paragraphs, rejoins hyphenated words and fixes ligatures,
 *   3. drops running headers/footers and bare page numbers,
 *   4. falls back to OCR (tesseract.js, loaded only when needed) when a PDF has almost no text.
 *
 * window.PdfReader.extract(file, onProgress) → { text, metaTitle, pages, ocr }
 * window.PdfReader.layoutPage(items, pageWidth) is exposed for testing.
 */
(function () {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const OCR_MAX_PAGES = 40;
  const LIGATURES = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st", "­": "" };

  /**
   * Groups pdf.js text items into lines: [{ y, x0, x1, h, text }] sorted top to bottom.
   * Items on the same baseline but separated by a wide gap (two columns side by side) become
   * separate lines, so column detection can tell them apart.
   */
  function toLines(items, pageWidth = 0) {
    const parts = items
      .filter((it) => it.str && it.str.trim())
      .map((it) => {
        const [, , , d, x, y] = it.transform;
        const h = Math.abs(d) || it.height || 10;
        return { x, y, w: it.width || it.str.length * h * 0.5, h, s: it.str };
      })
      .sort((a, b) => b.y - a.y || a.x - b.x);
    // 1. rows: items whose baselines are within half a font height
    const rows = [];
    for (const p of parts) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row.y - p.y) < Math.max(2, Math.min(row.h, p.h) * 0.5)) { row.items.push(p); row.h = Math.max(row.h, p.h); }
      else rows.push({ y: p.y, h: p.h, items: [p] });
    }
    // 2. split each row at wide horizontal gaps (column gutters)
    const lines = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let seg = null;
      for (const q of row.items) {
        const gap = seg ? q.x - seg.x1 : 0;
        const mid = pageWidth / 2;
        // A wide gap, or a smaller one that straddles the middle of the page (tight gutters).
        const gutter = seg && pageWidth && seg.x1 <= mid + 4 && q.x >= mid - 4 && gap > row.h * 0.5;
        if (seg && (gap > Math.max(row.h * 1.1, 8) || gutter)) { lines.push(seg); seg = null; }
        if (!seg) seg = { y: row.y, h: row.h, x0: q.x, x1: q.x + q.w, parts: [] };
        seg.parts.push(q);
        seg.x1 = Math.max(seg.x1, q.x + q.w);
      }
      if (seg) lines.push(seg);
    }
    for (const l of lines) {
      let t = "", end = null;
      for (const q of l.parts) {
        // Insert a space where pdf.js split words into separate items without one.
        if (end !== null && q.x - end > q.h * 0.15 && !/\s$/.test(t) && !/^\s/.test(q.s)) t += " ";
        t += q.s;
        end = q.x + q.w;
      }
      l.text = t.replace(/\s+/g, " ").trim();
    }
    return lines;
  }

  /**
   * Orders a page's lines for reading. If the page has two columns (lots of lines confined to
   * each half, with a gutter in the middle), each stretch between full-width lines (title,
   * abstract, wide figures) is read left column first, then right column.
   */
  function layoutPage(items, pageWidth) {
    const lines = toLines(items, pageWidth);
    if (!lines.length) return [];
    const mid = pageWidth / 2;
    const gutter = pageWidth * 0.02;
    const side = (l) => (l.x1 <= mid + gutter ? "L" : l.x0 >= mid - gutter ? "R" : "W");
    const left = lines.filter((l) => side(l) === "L").length;
    const right = lines.filter((l) => side(l) === "R").length;
    const twoColumn = left >= 6 && right >= 6 && (left + right) / lines.length > 0.6;
    if (!twoColumn) return lines;
    const out = [];
    let L = [], R = [];
    const flush = () => { out.push(...L, ...R); L = []; R = []; };
    for (const l of lines) {
      const s = side(l);
      if (s === "W") { flush(); out.push(l); }
      else (s === "L" ? L : R).push(l);
    }
    flush();
    return out;
  }

  /** Joins ordered lines into paragraphs and cleans hyphenation and ligatures. */
  function linesToText(lines) {
    let out = "";
    let prev = null;
    for (const l of lines) {
      let t = l.text.replace(/[ﬁﬂﬀﬃﬄﬅﬆ­]/g, (c) => LIGATURES[c]);
      if (prev) {
        const gap = prev.y - l.y;
        // New paragraph: a big vertical gap, a jump back up (next column) after a full stop, or a
        // short last line ending a sentence.
        const ended = /[.:?!]$/.test(out);
        const newPara = gap > Math.max(prev.h, l.h) * 1.6 || (gap < 0 && ended) || (ended && /^[A-Z0-9•\-–(]/.test(t) && prev.x1 - prev.x0 < (l.x1 - l.x0) * 0.75);
        if (/[a-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1); // "trans-" + "former"
        else out += newPara ? "\n\n" : " ";
      }
      out += t;
      prev = l;
    }
    return out;
  }

  const norm = (s) => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

  /**
   * Removes running headers/footers and page numbers. Only lines physically in the top or bottom
   * 8% of a page are candidates; one is dropped if (ignoring digits) it recurs on most pages, or
   * if it's a bare page number.
   * pages: [{ lines, height }]
   */
  function stripRepeats(pages) {
    const isEdge = (l, h) => l.y > h * 0.92 || l.y < h * 0.08;
    const count = new Map();
    for (const { lines, height } of pages) {
      for (const k of new Set(lines.filter((l) => isEdge(l, height)).map((l) => norm(l.text)))) count.set(k, (count.get(k) || 0) + 1);
    }
    const repeated = new Set(
      pages.length >= 3 ? [...count].filter(([k, n]) => n >= Math.max(3, pages.length * 0.5) && k.length < 120).map(([k]) => k) : []
    );
    return pages.map(({ lines, height }) =>
      lines.filter((l) => {
        if (!isEdge(l, height)) return true;
        if (repeated.has(norm(l.text))) return false;
        return !/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text);
      })
    );
  }

  let tesseractLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    tesseractLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { tesseractLoading = null; reject(new Error("Couldn't load the text recognizer for scanned PDFs. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
    return tesseractLoading;
  }

  async function ocrPdf(pdf, onProgress) {
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker("eng");
    try {
      const n = Math.min(pdf.numPages, OCR_MAX_PAGES);
      const texts = [];
      for (let i = 1; i <= n; i++) {
        onProgress?.(`Scanned PDF: recognizing text on page ${i}/${n}…`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const { data } = await worker.recognize(canvas);
        texts.push(data.text.replace(/([a-z])-\n([a-z])/g, "$1$2").replace(/([^\n])\n(?!\n)/g, "$1 ").trim());
      }
      return texts.join("\n\n");
    } finally {
      await worker.terminate().catch(() => {});
    }
  }

  async function extract(file, onProgress) {
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let metaTitle = "";
    try { metaTitle = ((await pdf.getMetadata())?.info?.Title || "").trim(); } catch {}

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(`Reading page ${i}/${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const { width, height } = page.getViewport({ scale: 1 });
      pages.push({ lines: layoutPage((await page.getTextContent()).items, width), height });
    }
    const text = stripRepeats(pages).map(linesToText).filter(Boolean).join("\n\n").trim();

    // Almost no text layer: it's a scan (or images of text). Recognize it instead.
    if (text.length < Math.max(200, pdf.numPages * 120)) {
      const ocr = await ocrPdf(pdf, onProgress);
      if (ocr.trim().length > text.length) return { text: ocr, metaTitle, pages: pdf.numPages, ocr: true };
    }
    return { text, metaTitle, pages: pdf.numPages, ocr: false };
  }

  window.PdfReader = { extract, layoutPage, linesToText, stripRepeats, toLines };
})();
