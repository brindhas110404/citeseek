#!/usr/bin/env node
// CiteSeek paper atlas builder.
//
// Collects accepted papers from the conferences' own published data and arranges them on a
// globe so that papers about similar things sit together. Covers AI and the fields AI work
// leans on today (vision, language, robotics, speech, health, systems, theory, ...):
//
//   PMLR      ICML, AISTATS, COLT, UAI, CoRL, MIDL, L4DC, CLeaR, CHIL, ML4H, Learning on Graphs,
//             AutoML, CoLLAs, ACML (one citeproc file per volume, with abstracts)
//   NeurIPS   2020+  neurips.cc virtual-site data files (titles, authors, abstracts)
//             2018–19 proceedings.neurips.cc (list pages + abstract pages)
//   ICLR      2020+  iclr.cc virtual-site data files
//   ACL / EMNLP / NAACL 2018+  ACL Anthology full bibliography (with abstracts), main tracks only
//   CVPR / ICCV / WACV  CVF Open Access (list pages + one abstract page per paper)
//   arXiv     recent preprints via OpenAlex, a share per field (AI, vision, robotics, speech,
//             search & recommendation, HCI, software, hardware, security, statistics, health, biology)
//
// Each paper's title + abstract is turned into a meaning vector with a small open model that runs
// on this machine (all-MiniLM-L6-v2 via transformers.js; no API or cost). Papers are grouped into a
// few hundred topics (k-means), topics are spread over a sphere so related ones are neighbours,
// and topics are grouped into colored "regions". Output (served as static files):
//
//   static/atlas/points.json      positions, colors and filters for every paper
//   static/atlas/titles/<n>.json  titles, 2000 per file (hover loads one)
//   static/atlas/search/<ab>.json word index split by first two letters (search loads only what it needs)
//   static/atlas/pages/<n>.json   details (authors, abstract, links), 500 papers per file
//
// Run:  npm run atlas:build        (needs internet; first run ~10–20 min, later runs reuse a cache)
// Env:  ATLAS_FROM_YEAR=2018  ATLAS_ARXIV_CAP=40000  ATLAS_MAILTO=you@example.com
//       ATLAS_SKIP=cvf,arxiv   leave out sources (pmlr, neurips, iclr, acl, cvf, arxiv)
//       ATLAS_CVF_ABSTRACTS=0  don't fetch CVF abstract pages (faster first run, rougher placement)
//       ATLAS_REFRESH=1   re-download everything instead of using .atlas-cache/
//       ATLAS_EMBEDDER=tfidf   skip the neural model (faster, rougher layout)
//       ATLAS_MOCK=http://localhost:8899   send every request to the offline test server

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "static", "atlas");
const CACHE = join(ROOT, ".atlas-cache");
const FROM_YEAR = Number(process.env.ATLAS_FROM_YEAR || 2018);
const TO_YEAR = new Date().getFullYear();
const ARXIV_CAP = Number(process.env.ATLAS_ARXIV_CAP ?? 40000);
const SKIP = new Set((process.env.ATLAS_SKIP || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean));
const CVF_ABSTRACTS = process.env.ATLAS_CVF_ABSTRACTS !== "0";
const MAILTO = process.env.ATLAS_MAILTO || "";
const REFRESH = !!process.env.ATLAS_REFRESH;
const MOCK = process.env.ATLAS_MOCK || "";
const DEV_SERVER = process.env.ATLAS_DEV_SERVER || "http://localhost:8787";
const PAGE_SIZE = 500;
const TITLE_CHUNK = 2000;
const ABSTRACT_MAX = 1400;

// Order matters: indexes are stored in points.json (the first six keep their old numbers).
const VENUES = [
  "NeurIPS", "ICML", "ICLR", "ACL", "EMNLP", "NAACL",
  "AISTATS", "COLT", "UAI", "CoRL", "MIDL", "L4DC", "CLeaR", "CHIL", "ML4H", "LoG", "AutoML", "CoLLAs", "ACML",
  "CVPR", "ICCV", "WACV",
];
const V = Object.fromEntries(VENUES.map((v, i) => [v, i]));
// The field each conference belongs to (shown on the paper card).
const VENUE_DOMAIN = {
  NeurIPS: "Machine learning", ICML: "Machine learning", ICLR: "Machine learning", AISTATS: "Machine learning",
  UAI: "Machine learning", AutoML: "Machine learning", CoLLAs: "Machine learning", ACML: "Machine learning",
  COLT: "Learning theory", ACL: "Language", EMNLP: "Language", NAACL: "Language",
  CVPR: "Computer vision", ICCV: "Computer vision", WACV: "Computer vision",
  CoRL: "Robotics & control", L4DC: "Robotics & control", MIDL: "Health & medicine", CHIL: "Health & medicine",
  ML4H: "Health & medicine", CLeaR: "Causality", LoG: "Graphs",
};
// PMLR index titles ("Proceedings of <name> <year>") → venue.
const PMLR_NAMES = {
  ICML: "ICML", AISTATS: "AISTATS", COLT: "COLT", UAI: "UAI", CoRL: "CoRL", MIDL: "MIDL",
  "Medical Imaging with Deep Learning": "MIDL", L4DC: "L4DC", CLeaR: "CLeaR", CHIL: "CHIL", ML4H: "ML4H",
  "Learning on Graphs": "LoG", AutoML: "AutoML", "AutoML-Conf": "AutoML", CoLLAs: "CoLLAs", ACML: "ACML",
};

// ---------------------------------------------------------------- fetching + cache
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = `CiteSeek-atlas/2.0 (research paper map${MAILTO ? `; mailto:${MAILTO}` : ""})`;

function mockUrl(url) {
  if (!MOCK) return url;
  const u = new URL(url);
  return `${MOCK.replace(/\/$/, "")}/${u.hostname}${u.pathname}${u.search}`;
}

async function fetchRaw(url, { binary = false, okMissing = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(mockUrl(url), { headers: { "User-Agent": UA } });
    } catch (err) {
      if (attempt >= 5) throw new Error(`Couldn't reach ${new URL(url).hostname} (${err.message}). Check your internet connection.`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    if (res.status === 404 && okMissing) return null;
    if ((res.status === 429 || res.status >= 500) && attempt < 6) { await sleep(1500 * 2 ** attempt); continue; }
    throw new Error(`${res.status} from ${url}`);
  }
}

/** Downloads once and keeps a copy in .atlas-cache/ so re-runs are fast and polite. */
async function cached(name, url, opts = {}) {
  const file = join(CACHE, name);
  if (!REFRESH && existsSync(file)) {
    const data = readFileSync(file);
    if (opts.binary) return data;
    const text = data.toString("utf8");
    return text === "__MISSING__" ? null : text;
  }
  const data = await fetchRaw(url, opts);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data ?? "__MISSING__");
  return data;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

function progress(label, n, total) {
  const pct = total ? Math.min(100, Math.round((n / total) * 100)) : 0;
  const bar = "█".repeat(Math.round(pct / 4)).padEnd(25, "░");
  process.stdout.write(`\r  ${label.padEnd(14)} ${bar} ${String(n).padStart(6)}${total ? ` / ${total}` : ""}   `);
}

// ---------------------------------------------------------------- text helpers
const decodeHtml = (s) => String(s || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/\s+/g, " ").trim();
const LATEX = { "\\'e": "é", "\\'a": "á", "\\'i": "í", "\\'o": "ó", "\\'u": "ú", '\\"o': "ö", '\\"u': "ü", '\\"a': "ä", "\\`e": "è", "\\`a": "à", "\\^o": "ô", "\\~n": "ñ", "\\c{c}": "ç", "\\v{s}": "š", "\\v{c}": "č", "\\ss": "ß", "\\o": "ø", "\\&": "&", "\\%": "%", "\\_": "_" };
const delatex = (s) => {
  let t = String(s || "");
  for (const [k, v] of Object.entries(LATEX)) t = t.split(`{${k}}`).join(v).split(k).join(v);
  return t.replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}]/g, "").replace(/``|''/g, '"').replace(/\s+/g, " ").trim();
};
/** Words used by the globe's title search (the browser splits queries the same way). */
const SEARCH_STOP = new Set("a an the of for and or in on to with by from via is are be as at its into".split(" "));
const searchTokens = (t) =>
  String(t).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !SEARCH_STOP.has(w));
const titleKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const authorList = (names) => {
  const a = names.map((x) => String(x).trim()).filter(Boolean);
  return a.length > 3 ? `${a.slice(0, 3).join(", ")} et al.` : a.join(", ");
};
const rec = (o) => ({
  t: o.t, a: o.a || "", y: o.y, v: o.v, k: o.k ?? 0, c: o.c ?? 0, ab: (o.ab || "").slice(0, ABSTRACT_MAX),
  pdf: o.pdf || null, url: o.url || o.pdf || "", d: o.d || (o.k ? "" : VENUE_DOMAIN[VENUES[o.v]] || ""),
});

// ---------------------------------------------------------------- sources
/** PMLR venues: find "Proceedings of <venue> <year>" volumes, then read each volume's citeproc.yaml. */
async function pmlr() {
  const index = await cached("pmlr/index.html", "https://proceedings.mlr.press/");
  const vols = [];
  const names = Object.keys(PMLR_NAMES).sort((x, y) => y.length - x.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`Proceedings of (?:The )?(${names.join("|")}) (\\d{4})$`);
  for (const m of index.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = decodeHtml(m[1]);
    const y = text.match(re);
    const v = m[1].match(/href="\/?(v\d+)\/?"/);
    if (y && v && +y[2] >= FROM_YEAR) vols.push({ vol: v[1], year: +y[2], venue: PMLR_NAMES[y[1]] });
  }
  const out = [];
  for (const { vol, year, venue } of vols) {
    const yaml = await cached(`pmlr/${vol}.yaml`, `https://proceedings.mlr.press/${vol}/assets/bib/citeproc.yaml`, { okMissing: true });
    if (!yaml) continue;
    for (const entry of yaml.split(/\n- title: /).slice(1)) {
      const q = (s) => s.replace(/^'|'$/g, "").replace(/''/g, "'");
      const title = q((entry.match(/^('(?:[^']|'')*'|.*)/) || [])[1] || "");
      const abs = entry.match(/\n {2}abstract: ('(?:[^']|'')*')/);
      const pdf = entry.match(/\n {2}PDF: (\S+)/);
      const url = entry.match(/\n {2}URL: (\S+)/);
      const authorsBlock = (entry.match(/\n {2}author:\s*\n([\s\S]*?)\n {2}\w/) || [])[1] || "";
      const authors = [...authorsBlock.matchAll(/given: (.+)\n\s+family: (.+)/g)].map((m) => `${q(m[1].trim())} ${q(m[2].trim())}`);
      if (!title) continue;
      out.push(rec({ t: delatex(title), a: authorList(authors), y: year, v: V[venue], ab: abs ? delatex(q(abs[1])) : "", pdf: pdf?.[1], url: url?.[1] }));
    }
    progress("PMLR", out.length, 0);
  }
  const per = {};
  for (const p of out) per[VENUES[p.v]] = (per[VENUES[p.v]] || 0) + 1;
  process.stdout.write(`\r  PMLR           ${out.length.toLocaleString()} papers (${Object.entries(per).map(([k, n]) => `${k} ${n}`).join(", ")})\n`);
  return out;
}

/** CVPR / ICCV / WACV from CVF Open Access: list pages, then each paper's page for its abstract. */
function parseCvfList(html, base) {
  const items = [];
  for (const block of html.split(/<dt class="ptitle">/i).slice(1)) {
    const a = block.match(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const pdf = block.match(/href="([^"]*\/papers\/[^"]+?\.pdf)"/i)?.[1] || block.match(/href="([^"]+?_paper\.pdf)"/i)?.[1];
    const authors = [...block.matchAll(/name="query_author"\s+value="([^"]+)"/gi)].map((m) => decodeHtml(m[1]));
    items.push({ t: decodeHtml(a[2]), url: new URL(a[1], base).toString(), pdf: pdf ? new URL(pdf, base).toString() : null, authors });
  }
  return items;
}
async function cvf() {
  const base = "https://openaccess.thecvf.com/";
  const out = [];
  const confs = [["CVPR", () => true], ["ICCV", (y) => y % 2 === 1], ["WACV", () => true]];
  for (const [conf, held] of confs) {
    for (let y = FROM_YEAR; y <= TO_YEAR; y++) {
      if (!held(y)) continue;
      // Newer years list everything on ?day=all; older ones split the list into one page per day.
      let items = parseCvfList((await cached(`cvf/${conf}${y}-all.html`, `${base}${conf}${y}?day=all`, { okMissing: true })) || "", base);
      if (items.length < 20) {
        const main = (await cached(`cvf/${conf}${y}.html`, `${base}${conf}${y}`, { okMissing: true })) || (await cached(`cvf/${conf}${y}.py.html`, `${base}${conf}${y}.py`, { okMissing: true })) || "";
        items = parseCvfList(main, base);
        const days = [...new Set([...main.matchAll(/href="([^"]*\?day=\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]))];
        for (const d of days) {
          const page = await cached(`cvf/${conf}${y}-${d.split("day=")[1]}.html`, new URL(d, base).toString(), { okMissing: true });
          if (page) items.push(...parseCvfList(page, base));
        }
      }
      const seen = new Set();
      items = items.filter((it) => it.t && !seen.has(it.url) && seen.add(it.url));
      if (!items.length) continue;
      let done = 0;
      if (CVF_ABSTRACTS) {
        await pool(items, 8, async (it) => {
          const key = createHash("sha1").update(it.url).digest("hex").slice(0, 20);
          const html = await cached(`cvf/abs/${key}.html`, it.url, { okMissing: true }).catch(() => null);
          const m = html && html.match(/<div id="abstract"[^>]*>([\s\S]*?)<\/div>/i);
          it.ab = m ? decodeHtml(m[1]) : "";
          if (++done % 50 === 0 || done === items.length) progress(`${conf} ${y}`, done, items.length);
        });
      }
      for (const it of items) out.push(rec({ t: it.t, a: authorList(it.authors), y, v: V[conf], ab: it.ab || "", pdf: it.pdf, url: it.url }));
      progress(`${conf} ${y}`, items.length, items.length);
      process.stdout.write("\n");
    }
  }
  return out;
}

/** Virtual-site data files used by NeurIPS and ICLR (and the same "miniconf" format). */
async function virtualSite(host, slug, venue, year) {
  const text = await cached(`${slug}/${year}.json`, `https://${host}/static/virtual/data/${slug}-${year}-orals-posters.json`, { okMissing: true });
  if (!text) return null;
  let list;
  try { const d = JSON.parse(text); list = d.results || d; } catch { return null; }
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (!/poster|oral|spotlight/i.test(p.eventtype || "")) continue;
    const name = (p.name || "").trim();
    if (!name || /^lightning talk/i.test(name) || !(p.authors || []).length) continue;
    // Keep the main conference; skip other tracks (datasets & benchmarks, position papers…)
    if (p.sourceurl && /\/(Track|Position|Datasets)/i.test(p.sourceurl)) continue;
    const key = titleKey(name);
    if (seen.has(key)) continue; // orals are listed again as posters
    seen.add(key);
    const links = [p.paper_url, p.paper_pdf_url, p.url, p.sourceurl].filter(Boolean).map(String);
    const forum = links.map((l) => l.match(/openreview\.net\/forum\?id=([\w-]+)/)?.[1]).find(Boolean);
    const procs = links.find((l) => /proceedings\.neurips\.cc.*\/hash\/.*-Abstract/.test(l));
    const pdf = forum ? `https://openreview.net/pdf?id=${forum}` : procs ? procs.replace("//paper_files", "/paper_files").replace("/hash/", "/file/").replace("-Abstract", "-Paper").replace(/\.html$/, ".pdf") : null;
    const url = forum ? `https://openreview.net/forum?id=${forum}` : procs ? procs.replace("//paper_files", "/paper_files") : `https://${host}${p.virtualsite_url || ""}`;
    out.push(rec({ t: name, a: authorList((p.authors || []).map((a) => a.fullname || a.name || a)), y: year, v: venue, ab: (p.abstract || "").replace(/\s+/g, " ").trim(), pdf, url }));
  }
  return out;
}

/** NeurIPS years without virtual-site data: list page + one abstract page per paper. */
async function neuripsProceedings(year) {
  const base = "https://proceedings.neurips.cc";
  const list = await cached(`nips-proc/${year}.html`, `${base}/paper_files/paper/${year}`, { okMissing: true });
  if (!list) return [];
  const items = [];
  for (const m of list.matchAll(/<a[^>]*href="(\/paper_files\/paper\/\d+\/hash\/([0-9a-f]+)-Abstract(-Conference)?\.html)"[^>]*>([\s\S]*?)<\/a>\s*<span class="paper-authors">([\s\S]*?)<\/span>/g)) {
    items.push({ href: m[1], hash: m[2], suffix: m[3] || "", title: decodeHtml(m[4]), authors: decodeHtml(m[5]) });
  }
  const out = [];
  let done = 0;
  await pool(items, 6, async (it) => {
    const page = await cached(`nips-proc/${year}/${it.hash}.html`, base + it.href, { okMissing: true }).catch(() => null);
    const paras = page ? [...page.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => decodeHtml(m[1])) : [];
    const ab = paras.find((p) => p.length > 150) || "";
    out.push(rec({ t: it.title, a: authorList(it.authors.split(",")), y: year, v: V.NeurIPS, ab, pdf: `${base}/paper_files/paper/${year}/file/${it.hash}-Paper${it.suffix}.pdf`, url: base + it.href }));
    progress(`NeurIPS ${year}`, ++done, items.length);
  });
  process.stdout.write("\n");
  return out;
}

async function neurips() {
  const out = [];
  for (let y = FROM_YEAR; y <= TO_YEAR; y++) {
    const v = await virtualSite("neurips.cc", "neurips", V.NeurIPS, y);
    if (v && v.length) { out.push(...v); progress(`NeurIPS ${y}`, v.length, v.length); process.stdout.write("\n"); }
    else out.push(...(await neuripsProceedings(y)));
  }
  return out;
}

async function iclr() {
  const out = [];
  for (let y = FROM_YEAR; y <= TO_YEAR; y++) {
    const v = await virtualSite("iclr.cc", "iclr", V.ICLR, y);
    if (v && v.length) { out.push(...v); progress(`ICLR ${y}`, v.length, v.length); process.stdout.write("\n"); }
  }
  return out;
}

/** ACL, EMNLP and NAACL main tracks from the ACL Anthology bibliography (abstracts included). */
async function aclAnthology() {
  const gz = await cached("acl/anthology+abstracts.bib.gz", "https://aclanthology.org/anthology+abstracts.bib.gz", { binary: true });
  process.stdout.write("  ACL Anthology  reading bibliography…");
  const bib = gunzipSync(gz).toString("utf8");
  const OLD = /^(P18-[12]|P19-1|D18-1|D19-1|N18-[12]|N19-1)(\d{3})$/;
  const NEW = /^(\d{4})\.(acl-(?:main|long|short)|emnlp-main|naacl-(?:main|long|short))\.(\d+)$/;
  const out = [];
  for (const entry of bib.split(/\n@/)) {
    if (!/^inproceedings/i.test(entry)) continue;
    const url = (entry.match(/\burl\s*=\s*"([^"]+)"/) || [])[1];
    const id = url?.match(/aclanthology\.org\/([^/]+)\/?$/)?.[1];
    if (!id) continue;
    let venue, year;
    const o = id.match(OLD), n = id.match(NEW);
    if (o) {
      if (o[2] === "000") continue; // front matter
      venue = { P: "ACL", D: "EMNLP", N: "NAACL" }[o[1][0]];
      year = 2000 + Number(o[1].slice(1, 3));
    } else if (n) {
      if (n[3] === "0") continue;
      venue = n[2].startsWith("acl") ? "ACL" : n[2].startsWith("emnlp") ? "EMNLP" : "NAACL";
      year = +n[1];
    } else continue;
    if (year < FROM_YEAR) continue;
    const field = (name) => {
      const m = entry.match(new RegExp(`\\b${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s"));
      return m ? delatex(m[1]) : "";
    };
    const title = field("title");
    if (!title) continue;
    const authors = field("author").split(/\s+and\s+/).map((a) => { const [last, first] = a.split(",").map((x) => x.trim()); return first ? `${first} ${last}` : last; });
    out.push(rec({ t: title, a: authorList(authors), y: year, v: V[venue], ab: field("abstract"), pdf: `https://aclanthology.org/${id}.pdf`, url: `https://aclanthology.org/${id}/` }));
  }
  process.stdout.write(`\r  ACL Anthology  ${out.length.toLocaleString()} main-track papers (ACL ${out.filter((p) => p.v === V.ACL).length}, EMNLP ${out.filter((p) => p.v === V.EMNLP).length}, NAACL ${out.filter((p) => p.v === V.NAACL).length})\n`);
  return out;
}

/**
 * Recent arXiv preprints via OpenAlex, a share per field so the map covers what AI work touches
 * today, not only core AI. Shares are fractions of ATLAS_ARXIV_CAP. Subfield ids are OpenAlex's
 * (Scopus ASJC) codes.
 */
const ARXIV_FIELDS = [
  { id: 1702, name: "AI & machine learning", share: 0.24 },
  { id: 1707, name: "Computer vision", share: 0.14 },
  { id: 2207, name: "Robotics & control", share: 0.08 },
  { id: 1711, name: "Speech, audio & signals", share: 0.07 },
  { id: 1710, name: "Search, recommendation & data", share: 0.07 },
  { id: 1709, name: "Human-computer interaction", share: 0.06 },
  { id: 1712, name: "Software & code", share: 0.06 },
  { id: 1708, name: "Hardware & AI systems", share: 0.05 },
  { id: 1705, name: "Networks & security", share: 0.05 },
  { id: 2613, name: "Statistics", share: 0.06 },
  { id: 2718, name: "Health & medicine", share: 0.05 },
  { id: 1312, name: "Biology", share: 0.04 },
  { id: 1703, name: "Theory & algorithms", share: 0.03 },
];
async function arxiv() {
  if (ARXIV_CAP <= 0) return [];
  const API = "https://api.openalex.org";
  const get = async (path, params) => {
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (MAILTO) u.searchParams.set("mailto", MAILTO);
    return JSON.parse(await fetchRaw(u.toString()));
  };
  const src = await get("/sources", { search: "arXiv", "per-page": 25, select: "id,display_name,works_count" });
  const arx = (src.results || []).filter((s) => /arxiv/i.test(s.display_name)).sort((a, b) => b.works_count - a.works_count)[0];
  if (!arx) return [];
  const arxId = arx.id.split("/").pop();
  const since = `${TO_YEAR - 1}-01-01`;
  const out = [];
  const seenIds = new Set();
  const run = async (filter, cap, label, domain) => {
    let cursor = "*", got = 0;
    while (cursor && got < cap) {
      const d = await get("/works", { filter, "per-page": 200, cursor, sort: "publication_date:desc", select: "id,display_name,publication_year,authorships,cited_by_count,abstract_inverted_index,locations" });
      for (const w of d.results || []) {
        if (got >= cap) break;
        if (seenIds.has(w.id)) continue;
        seenIds.add(w.id);
        const loc = (w.locations || []).find((l) => /arxiv\.org\/abs\//.test(l.landing_page_url || ""));
        const aid = loc?.landing_page_url.split("/abs/")[1]?.replace(/v\d+$/, "");
        const words = [];
        for (const [word, pos] of Object.entries(w.abstract_inverted_index || {})) for (const p of pos) words[p] = word;
        out.push(rec({ t: (w.display_name || "").trim(), a: authorList((w.authorships || []).map((a) => a.author?.display_name)), y: w.publication_year, v: 255, k: 1, c: w.cited_by_count || 0, ab: words.filter(Boolean).join(" "), pdf: aid ? `https://arxiv.org/pdf/${aid}` : null, url: aid ? `https://arxiv.org/abs/${aid}` : w.id, d: domain }));
        got++;
      }
      progress(label.slice(0, 14), got, Math.min(cap, d.meta?.count || 0));
      cursor = d.meta?.next_cursor;
      if (!d.results?.length) break;
      await sleep(MAILTO ? 80 : 160);
    }
    process.stdout.write("\n");
    return got;
  };
  let byField = 0;
  for (const f of ARXIV_FIELDS) {
    try { byField += await run(`primary_location.source.id:${arxId},primary_topic.subfield.id:${f.id},from_publication_date:${since}`, Math.round(ARXIV_CAP * f.share), `arXiv ${f.name}`, f.name); }
    catch (err) { console.log(`\n  (arXiv ${f.name} skipped: ${err.message})`); }
  }
  // Older OpenAlex setups don't accept the subfield filter: fall back to all of computer science.
  if (!byField) await run(`primary_location.source.id:${arxId},primary_topic.field.id:17,from_publication_date:${since}`, ARXIV_CAP, "arXiv", "Computer science");
  return out;
}

// ---------------------------------------------------------------- embeddings
const STOP = new Set(("a an the of for and or in on to with by from via using use based towards toward into over under than that this these those its their our we is are be as at it not new more most can do does via vs versus through without within across between beyond about how what when why which while learning learned learn model models neural network networks deep data method methods approach approaches efficient improving improved improve better large scale scalable task tasks framework analysis study towards problem problems paper results show propose proposed novel performance").split(/\s+/));
const tokens = (s) => (String(s).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOP.has(w));

async function embedNeural(texts) {
  let tf;
  try { tf = await import("@huggingface/transformers"); }
  catch {
    console.log("  Installing the embedding model runtime (one time, a few hundred MB)…");
    execSync("npm install --no-save --no-audit --no-fund @huggingface/transformers@4", { cwd: ROOT, stdio: "inherit" });
    tf = await import("@huggingface/transformers");
  }
  tf.env.cacheDir = join(CACHE, "models");
  tf.env.allowLocalModels = false;
  // Try a few published copies / precisions of the same model; report every failure.
  let extractor, lastErr;
  const tried = [];
  for (const [model, opts] of [
    ["Xenova/all-MiniLM-L6-v2", { dtype: "q8" }],
    ["Xenova/all-MiniLM-L6-v2", { dtype: "fp32" }],
    ["onnx-community/all-MiniLM-L6-v2-ONNX", { dtype: "q8" }],
    ["onnx-community/all-MiniLM-L6-v2-ONNX", {}],
  ]) {
    try {
      console.log(`  Loading ${model} (${opts.dtype || "default"})…`);
      extractor = await tf.pipeline("feature-extraction", model, opts);
      break;
    } catch (err) { lastErr = err; tried.push(`${model}/${opts.dtype || "default"}: ${String(err.message || err).slice(0, 160)}`); }
  }
  if (!extractor) throw new Error(`couldn't load the model.\n    ${tried.join("\n    ")}`);
  const D = 384, n = texts.length, out = new Float32Array(n * D);
  const B = 64;
  const t0 = Date.now();
  for (let i = 0; i < n; i += B) {
    const batch = texts.slice(i, i + B);
    const res = await extractor(batch, { pooling: "mean", normalize: true });
    out.set(res.data, i * D);
    if ((i / B) % 5 === 0 || i + B >= n) {
      const rate = (i + batch.length) / ((Date.now() - t0) / 1000);
      progress("Embedding", Math.min(n, i + B), n);
      process.stdout.write(`${Math.round(rate)}/s `);
    }
  }
  process.stdout.write("\n");
  return { vectors: out, dim: D, kind: "all-MiniLM-L6-v2" };
}

/** Fallback: TF-IDF of title (weighted) + abstract, hashed and randomly projected to 256 dims. */
function embedTfidf(records) {
  const D = 256, n = records.length;
  const df = new Map();
  const docs = records.map((r) => {
    const tf = new Map();
    for (const w of tokens(r.t)) tf.set(w, (tf.get(w) || 0) + 3);
    const tt = tokens(r.t);
    for (let i = 0; i + 1 < tt.length; i++) { const b = `${tt[i]}_${tt[i + 1]}`; tf.set(b, (tf.get(b) || 0) + 3); }
    for (const w of tokens(r.ab).slice(0, 220)) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return tf;
  });
  const hash = (s, seed) => { let h = 2166136261 ^ seed; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
  const out = new Float32Array(n * D);
  docs.forEach((tf, i) => {
    const v = out.subarray(i * D, i * D + D);
    for (const [w, c] of tf) {
      const d = df.get(w);
      if (d < 2) continue;
      const wgt = (1 + Math.log(c)) * Math.log(n / d);
      // sparse random projection: each term touches 4 dims with ±1
      for (let s = 0; s < 4; s++) { const h = hash(w, s * 7919); v[h % D] += (h & 1024 ? 1 : -1) * wgt; }
    }
    let norm = 0; for (let k = 0; k < D; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm) || 1; for (let k = 0; k < D; k++) v[k] /= norm;
  });
  return { vectors: out, dim: D, kind: "tf-idf" };
}

/**
 * Neural embeddings are remembered per paper (by a hash of its text) in .atlas-cache/, so adding
 * sources later only embeds the new papers.
 */
const STORE = join(CACHE, "embed-store-minilm.bin"), STORE_KEYS = join(CACHE, "embed-store-minilm.keys");
function loadStore() {
  if (REFRESH || !existsSync(STORE) || !existsSync(STORE_KEYS)) return { map: new Map(), vecs: [] };
  const keys = readFileSync(STORE_KEYS, "utf8").split("\n").filter(Boolean);
  const buf = readFileSync(STORE);
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (all.length !== keys.length * 384) return { map: new Map(), vecs: [] };
  const map = new Map(keys.map((k, i) => [k, i]));
  return { map, vecs: [all] };
}
async function embedNeuralCached(texts) {
  const keyOf = (t) => createHash("sha1").update(t).digest("hex").slice(0, 20);
  const keys = texts.map(keyOf);
  const store = loadStore();
  const prev = store.vecs[0] || new Float32Array(0);
  const missing = [...new Set(keys.filter((k) => !store.map.has(k)))];
  const textOf = new Map(keys.map((k, i) => [k, texts[i]]));
  console.log(`  ${(keys.length - missing.length).toLocaleString()} papers already embedded, ${missing.length.toLocaleString()} new.`);
  let fresh = { vectors: new Float32Array(0), dim: 384 };
  if (missing.length) fresh = await embedNeural(missing.map((k) => textOf.get(k)));
  const D = 384;
  const n = texts.length, out = new Float32Array(n * D);
  const freshIdx = new Map(missing.map((k, i) => [k, i]));
  keys.forEach((k, i) => {
    const src = store.map.has(k) ? prev.subarray(store.map.get(k) * D, store.map.get(k) * D + D) : fresh.vectors.subarray(freshIdx.get(k) * D, freshIdx.get(k) * D + D);
    out.set(src, i * D);
  });
  if (missing.length) {
    const allKeys = [...store.map.keys(), ...missing];
    const merged = new Float32Array(allKeys.length * D);
    merged.set(prev, 0);
    merged.set(fresh.vectors, prev.length);
    writeFileSync(STORE, Buffer.from(merged.buffer));
    writeFileSync(STORE_KEYS, allKeys.join("\n"));
  }
  return { vectors: out, dim: D, kind: "neural" };
}

async function embed(records) {
  const texts = records.map((r) => `${r.t}. ${r.ab}`.slice(0, 1100));
  const sig = createHash("sha1").update(texts.join("\n")).digest("hex").slice(0, 16);
  const mode = process.env.ATLAS_EMBEDDER === "tfidf" ? "tfidf" : "neural";
  // Cache files are named by what they actually contain (v2 = fixed naming), so a fallback
  // result is never mistaken for neural embeddings on the next run.
  const fileFor = (kind) => join(CACHE, `embeddings-v2-${kind}-${sig}.bin`);
  const load = (kind) => {
    const buf = readFileSync(fileFor(kind));
    console.log(`  Reusing cached ${kind} embeddings (${records.length.toLocaleString()} papers).`);
    return { vectors: new Float32Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + buf.byteLength)), dim: buf.readUInt32LE(0), kind };
  };
  const save = (res) => {
    const head = Buffer.alloc(4); head.writeUInt32LE(res.dim);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(fileFor(res.kind), Buffer.concat([head, Buffer.from(res.vectors.buffer)]));
    return res;
  };
  if (!REFRESH && mode === "tfidf" && existsSync(fileFor(mode))) return load(mode);
  if (mode === "neural") {
    try { return await embedNeuralCached(texts); }
    catch (err) {
      console.log(`\n  ⚠ The local AI model couldn't run, so papers will be placed with a simpler word-matching method.`);
      console.log(`    Reason: ${err.message}`);
    }
  }
  if (!REFRESH && existsSync(fileFor("tfidf"))) return load("tfidf");
  return save({ ...embedTfidf(records), kind: "tfidf" });
}

// ---------------------------------------------------------------- clustering + layout
function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 3266489909 >>> 0) / 4294967296); }
function gaussian(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** Random projection to `d` dims (keeps cosine structure; makes k-means fast). */
function project(X, n, D, d) {
  const r = rng(42), R = new Float32Array(D * d);
  for (let i = 0; i < R.length; i++) R[i] = gaussian(r) / Math.sqrt(d);
  const Y = new Float32Array(n * d);
  for (let i = 0; i < n; i++) {
    const xo = i * D, yo = i * d;
    for (let k = 0; k < D; k++) { const x = X[xo + k]; if (!x) continue; const ro = k * d; for (let j = 0; j < d; j++) Y[yo + j] += x * R[ro + j]; }
    let s = 0; for (let j = 0; j < d; j++) s += Y[yo + j] ** 2; s = Math.sqrt(s) || 1;
    for (let j = 0; j < d; j++) Y[yo + j] /= s;
  }
  return Y;
}

/** Spherical k-means (cosine) with k-means++ seeding. Returns assignments and unit centroids. */
function kmeans(Y, n, d, K, iters = 12, weights = null, label = "") {
  const r = rng(7);
  const C = new Float32Array(K * d);
  const dist = new Float32Array(n).fill(Infinity);
  let first = Math.floor(r() * n);
  C.set(Y.subarray(first * d, first * d + d), 0);
  for (let c = 1; c < K; c++) {
    let total = 0;
    const co = (c - 1) * d;
    for (let i = 0; i < n; i++) {
      let s = 0; const yo = i * d;
      for (let j = 0; j < d; j++) s += Y[yo + j] * C[co + j];
      const dd = Math.max(0, 1 - s);
      if (dd < dist[i]) dist[i] = dd;
      total += dist[i] * dist[i] * (weights ? weights[i] : 1);
    }
    let t = r() * total, pick = n - 1;
    for (let i = 0; i < n; i++) { t -= dist[i] * dist[i] * (weights ? weights[i] : 1); if (t <= 0) { pick = i; break; } }
    C.set(Y.subarray(pick * d, pick * d + d), c * d);
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0, bs = -Infinity; const yo = i * d;
      for (let c = 0; c < K; c++) {
        let s = 0; const co = c * d;
        for (let j = 0; j < d; j++) s += Y[yo + j] * C[co + j];
        if (s > bs) { bs = s; best = c; }
      }
      assign[i] = best;
    }
    C.fill(0);
    const cnt = new Float64Array(K);
    for (let i = 0; i < n; i++) { const c = assign[i], w = weights ? weights[i] : 1; cnt[c] += w; const yo = i * d, co = c * d; for (let j = 0; j < d; j++) C[co + j] += Y[yo + j] * w; }
    for (let c = 0; c < K; c++) {
      const co = c * d;
      if (!cnt[c]) { const p = Math.floor(r() * n); C.set(Y.subarray(p * d, p * d + d), co); continue; }
      let s = 0; for (let j = 0; j < d; j++) s += C[co + j] ** 2; s = Math.sqrt(s) || 1;
      for (let j = 0; j < d; j++) C[co + j] /= s;
    }
    if (label) progress(label, it + 1, iters);
  }
  if (label) process.stdout.write("\n");
  return { assign, C };
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

/** PCA of rows (Float32 matrix) to k components, via power iteration. */
function pcaRows(rows, d, k) {
  const n = rows.length;
  const mean = new Float64Array(d);
  for (const v of rows) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const comps = [];
  for (let c = 0; c < k; c++) {
    let w = Float64Array.from({ length: d }, (_, j) => Math.sin(j * 12.9898 + c * 78.233) + 0.01);
    for (let it = 0; it < 40; it++) {
      const nw = new Float64Array(d);
      for (const v of rows) {
        let s = 0; for (let j = 0; j < d; j++) s += (v[j] - mean[j]) * w[j];
        for (let j = 0; j < d; j++) nw[j] += (v[j] - mean[j]) * s;
      }
      for (const p of comps) { let pr = 0; for (let j = 0; j < d; j++) pr += nw[j] * p[j]; for (let j = 0; j < d; j++) nw[j] -= pr * p[j]; }
      let s = 0; for (let j = 0; j < d; j++) s += nw[j] ** 2; s = Math.sqrt(s) || 1;
      w = nw.map((x) => x / s);
    }
    comps.push(w);
  }
  return rows.map((v) => comps.map((p) => { let s = 0; for (let j = 0; j < d; j++) s += (v[j] - mean[j]) * p[j]; return s; }));
}

/**
 * Spreads topics over the whole sphere: PCA start (similar topics begin near each other), then
 * size-weighted repulsion + a pull towards each topic's nearest neighbours.
 */
function sphereLayout(counts, C, d) {
  const n = counts.length;
  const rows = Array.from({ length: n }, (_, i) => C.subarray(i * d, i * d + d));
  const P0 = pcaRows(rows, d, 3).map((p) => norm3([p[0] + 1e-6, p[1], p[2]]));
  const total = counts.reduce((a, b) => a + b, 0);
  const rad = counts.map((c) => 1.85 * Math.sqrt(c / total));
  const mass = counts.map((c) => Math.sqrt(c / total) * Math.sqrt(n));
  const K = Math.min(5, n - 1);
  const nn = rows.map((v, i) => {
    const sims = [];
    for (let j = 0; j < n; j++) if (j !== i) { let s = 0; const u = rows[j]; for (let k = 0; k < d; k++) s += v[k] * u[k]; sims.push([j, s]); }
    return sims.sort((a, b) => b[1] - a[1]).slice(0, K).map(([j]) => j);
  });
  const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
  P0.forEach((p, i) => { X[i] = p[0]; Y[i] = p[1]; Z[i] = p[2]; });
  const ITER = 260;
  const fx = new Float64Array(n), fy = new Float64Array(n), fz = new Float64Array(n);
  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER;
    fx.fill(0); fy.fill(0); fz.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = X[i] - X[j], dy = Y[i] - Y[j], dz = Z[i] - Z[j];
        const d2 = dx * dx + dy * dy + dz * dz + 1e-4, want = rad[i] + rad[j];
        const f = (0.6 / n) / d2 + (d2 < want * want ? 0.04 * (want * want - d2) / d2 : 0);
        fx[i] += dx * f * mass[j]; fy[i] += dy * f * mass[j]; fz[i] += dz * f * mass[j];
        fx[j] -= dx * f * mass[i]; fy[j] -= dy * f * mass[i]; fz[j] -= dz * f * mass[i];
      }
      for (const j of nn[i]) { const pull = 0.02 * cool; fx[i] += (X[j] - X[i]) * pull; fy[i] += (Y[j] - Y[i]) * pull; fz[i] += (Z[j] - Z[i]) * pull; }
    }
    const step = 0.08 * cool + 0.01;
    for (let i = 0; i < n; i++) {
      let mx = fx[i] * step, my = fy[i] * step, mz = fz[i] * step;
      const m = Math.hypot(mx, my, mz), cap = 0.12 * cool + 0.01;
      if (m > cap) { mx *= cap / m; my *= cap / m; mz *= cap / m; }
      const q = norm3([X[i] + mx, Y[i] + my, Z[i] + mz]);
      X[i] = q[0]; Y[i] = q[1]; Z[i] = q[2];
    }
  }
  return { centers: Array.from({ length: n }, (_, i) => [X[i], Y[i], Z[i]]), rad };
}

function tangentBasis(c) {
  const up = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm3([up[1] * c[2] - up[2] * c[1], up[2] * c[0] - up[0] * c[2], up[0] * c[1] - up[1] * c[0]]);
  const e2 = [c[1] * e1[2] - c[2] * e1[1], c[2] * e1[0] - c[0] * e1[2], c[0] * e1[1] - c[1] * e1[0]];
  return [e1, e2];
}

// ---------------------------------------------------------------- naming
const titleCase = (s) => s.replace(/_/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bLlms?\b/g, (m) => m.toUpperCase()).replace(/\b(Gnn|Rl|Nlp|Vae|Gan|Ner|Qa|Asr|Mt)s?\b/g, (m) => m.toUpperCase());
function keywordNames(groups, records, maxWords = 2) {
  // groups: array of arrays of record indices
  const df = new Map();
  const tfs = groups.map((idx) => {
    const tf = new Map();
    for (const i of idx) {
      const tt = tokens(records[i].t);
      for (const w of new Set(tt)) tf.set(w, (tf.get(w) || 0) + 1);
      for (let k = 0; k + 1 < tt.length; k++) { const b = `${tt[k]}_${tt[k + 1]}`; tf.set(b, (tf.get(b) || 0) + 1.6); }
    }
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return tf;
  });
  return tfs.map((tf, g) => {
    const size = groups[g].length || 1;
    const scored = [...tf.entries()]
      .filter(([, c]) => c >= Math.max(2, size * 0.04))
      .map(([w, c]) => [w, (c / size) * Math.log(1 + groups.length / df.get(w))])
      .sort((a, b) => b[1] - a[1]);
    const picked = [];
    for (const [w] of scored) {
      if (picked.some((p) => p.includes(w) || w.includes(p) || w.split("_").some((x) => p.split("_").includes(x)))) continue;
      picked.push(w);
      if (picked.length >= maxWords) break;
    }
    return picked.length ? picked.map(titleCase).join(" · ") : "Miscellaneous";
  });
}

/** Asks the local dev server (Workers AI, Llama 3.1 8B) for short region names. Optional. */
const GENERIC = /^(natural language processing|nlp|deep learning( techniques)?|machine learning|artificial intelligence|ai|computer science|language models?|neural networks?|research|ai research|language model applications)$/i;
async function llmNames(groups, records, fallback) {
  try {
    const items = groups.map((idx, g) => ({
      keywords: fallback[g],
      // Other regions' keywords, so the model names what makes this one different.
      others: fallback.filter((_, j) => j !== g),
      titles: idx.slice().sort(() => 0.5 - Math.random()).slice(0, 14).map((i) => records[i].t),
    }));
    const res = await fetch(`${DEV_SERVER}/api/atlas/name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { names } = await res.json();
    // Reject empty, generic or repeated names; those regions keep their keyword names.
    const used = new Set();
    return names.map((n, i) => {
      const ok = typeof n === "string" && n.length > 2 && n.length < 44 && !GENERIC.test(n.trim()) && !used.has(n.toLowerCase());
      const name = ok ? n.trim() : fallback[i];
      used.add(name.toLowerCase());
      return name;
    });
  } catch (err) {
    console.log(`  (Dev server not reachable for AI region names: ${err.message}. Using keyword names.)`);
    return fallback;
  }
}

const PALETTE = ["#e3b26b", "#7fc8a9", "#f08a5d", "#9ab0f0", "#e48fb0", "#c9d96f", "#8fd3e8", "#d9a0f0", "#f2d17b", "#a3c48c", "#f4a6a0", "#b8b0e8", "#e6c79c", "#9fd8c4", "#f0b8d8", "#b4d88a"];

// ---------------------------------------------------------------- main
async function main() {
  const t0 = Date.now();
  console.log(`\nCiteSeek paper atlas · ${FROM_YEAR}–${TO_YEAR}${MOCK ? ` · MOCK ${MOCK}` : ""}\n`);
  mkdirSync(CACHE, { recursive: true });

  console.log("1/5  Collecting papers from official sources…");
  const sources = { pmlr: [], neurips: [], iclr: [], acl: [], cvf: [], arxiv: [] };
  const errors = [];
  const attempt = async (name, fn) => {
    if (SKIP.has(name)) return console.log(`  (${name} skipped by ATLAS_SKIP)`);
    try { sources[name] = await fn(); } catch (err) { errors.push(`${name}: ${err.message}`); console.log(`\n  ⚠ ${name} skipped: ${err.message}`); }
  };
  await attempt("pmlr", pmlr);
  await attempt("neurips", neurips);
  await attempt("iclr", iclr);
  await attempt("acl", aclAnthology);
  await attempt("cvf", cvf);
  await attempt("arxiv", arxiv);

  // De-duplicate by title: conference version wins over the arXiv preprint.
  const seen = new Set();
  const papers = [];
  for (const list of [sources.pmlr, sources.neurips, sources.iclr, sources.acl, sources.cvf, sources.arxiv]) {
    for (const p of list) {
      const key = titleKey(p.t);
      if (!key || seen.has(key) || !p.y) continue;
      seen.add(key);
      papers.push(p);
    }
  }
  if (papers.length < 100) throw new Error(`Only ${papers.length} papers collected. ${errors.join("; ")}`);
  const n = papers.length;
  console.log(`  → ${n.toLocaleString()} unique papers`);

  console.log("\n2/5  Reading each paper's meaning (title + abstract)…");
  const emb = await embed(papers);
  console.log(`  Using ${emb.kind} embeddings.`);

  console.log("\n3/5  Grouping into topics…");
  const d = 96;
  const Yp = project(emb.vectors, n, emb.dim, d);
  const K = Math.max(40, Math.min(640, Math.round(Math.sqrt(n) * 1.5)));
  const { assign, C } = kmeans(Yp, n, d, K, 12, null, "Topics");
  const members = Array.from({ length: K }, () => []);
  for (let i = 0; i < n; i++) members[assign[i]].push(i);
  // drop empty topics
  const live = members.map((m, k) => [m, k]).filter(([m]) => m.length > 0);
  const topicMembers = live.map(([m]) => m);
  const Ct = new Float32Array(live.length * d);
  live.forEach(([, k], t) => Ct.set(C.subarray(k * d, k * d + d), t * d));
  const T = topicMembers.length;
  const counts = topicMembers.map((m) => m.length);

  // Regions = groups of related topics, each with a color.
  const R = Math.min(16, Math.max(4, Math.round(T / 30)));
  const { assign: regionOf, C: Cr } = kmeans(Ct, T, d, R, 25, Float64Array.from(counts));
  const regionMembers = Array.from({ length: R }, () => []);
  topicMembers.forEach((m, t) => regionMembers[regionOf[t]].push(...m));

  console.log("\n4/5  Arranging on the globe and naming areas…");
  const { centers, rad } = sphereLayout(counts, Ct, d);
  const topicNames = keywordNames(topicMembers, papers, 2);
  const regionKw = keywordNames(regionMembers, papers, 2);
  const regionNames = await llmNames(regionMembers, papers, regionKw);

  // Place papers: within each topic, a local 2D PCA keeps similar papers next to each other.
  const pos = new Int16Array(n * 3);
  const topicOf = new Uint16Array(n);
  const order = []; // output order: grouped by topic
  topicMembers.forEach((m, t) => {
    const c = centers[t];
    const [e1, e2] = tangentBasis(c);
    const rows = m.map((i) => Yp.subarray(i * d, i * d + d));
    const uv = m.length > 3 ? pcaRows(rows, d, 2) : m.map((_, k) => [Math.cos(k * 2.4), Math.sin(k * 2.4)]);
    // Fill the topic's disc evenly (sunflower slots) while keeping neighbours together:
    // papers sorted by direction in the local PCA plane take the slots sorted by angle.
    const mm = m.length;
    const ang0 = uv.map(([a2, b2]) => Math.atan2(b2, a2));
    const byAngle = ang0.map((_, k) => k).sort((x, y) => ang0[x] - ang0[y]);
    const slots = Array.from({ length: mm }, (_, j) => {
      const th = (j * 2.399963) % (2 * Math.PI);
      return { th, r: rad[t] * Math.sqrt((j + 0.5) / mm) };
    }).sort((x, y) => x.th - y.th);
    const slotOf = new Array(mm);
    byAngle.forEach((k, j) => { slotOf[k] = slots[j]; });
    m.forEach((i, k) => {
      const ang = slotOf[k].th, rr = { [k]: slotOf[k].r };
      const q = norm3([
        c[0] + (e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang)) * rr[k],
        c[1] + (e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang)) * rr[k],
        c[2] + (e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)) * rr[k],
      ]);
      pos[i * 3] = Math.round(q[0] * 32767); pos[i * 3 + 1] = Math.round(q[1] * 32767); pos[i * 3 + 2] = Math.round(q[2] * 32767);
      topicOf[i] = t;
      order.push(i);
    });
  });

  console.log("\n5/5  Writing files…");
  // Write into a temporary folder and swap it in at the end, so a failure never leaves you
  // without a globe.
  const FINAL = OUT;
  const TMP = `${OUT}.tmp`;
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "pages"), { recursive: true });
  // Reorder everything by topic so each detail page holds related papers.
  const P = (arr, w) => { const o = new arr.constructor(arr.length); order.forEach((i, j) => { for (let k = 0; k < w; k++) o[j * w + k] = arr[i * w + k]; }); return o; };
  const posO = P(pos, 3), topicO = P(topicOf, 1);
  const yearO = Uint8Array.from(order, (i) => Math.max(0, Math.min(255, papers[i].y - 2000)));
  const kindO = Uint8Array.from(order, (i) => papers[i].k);
  const venueO = Uint8Array.from(order, (i) => papers[i].v);
  const citesO = Uint16Array.from(order, (i) => Math.min(65535, papers[i].c || 0));
  const regionCenter = Array.from({ length: R }, () => [0, 0, 0]);
  const regionCount = new Array(R).fill(0);
  topicMembers.forEach((m, t) => { const r = regionOf[t]; regionCount[r] += m.length; for (let k = 0; k < 3; k++) regionCenter[r][k] += centers[t][k] * m.length; });
  const regionOrder = regionCount.map((c, r) => [c, r]).sort((a, b) => b[0] - a[0]).map(([, r]) => r);
  const regionRank = new Map(regionOrder.map((r, i) => [r, i]));
  const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
  const byVenue = {};
  for (const p of papers) { const k = p.k ? "arXiv" : VENUES[p.v]; byVenue[k] = (byVenue[k] || 0) + 1; }
  const years = papers.map((p) => p.y);
  // Titles in small chunks (hover loads one chunk), plus a word index split by each word's
  // first two characters (search loads only the pieces for the words typed). Nothing large
  // is downloaded up front.
  const orderedTitles = order.map((i) => papers[i].t);
  mkdirSync(join(TMP, "titles"), { recursive: true });
  for (let j = 0; j < n; j += TITLE_CHUNK) {
    writeFileSync(join(TMP, "titles", `${j / TITLE_CHUNK}.json`), JSON.stringify(orderedTitles.slice(j, j + TITLE_CHUNK)));
  }
  const shards = new Map(); // "di" → Map(token → [ids])
  orderedTitles.forEach((t, id) => {
    for (const tok of new Set(searchTokens(t))) {
      const key = tok.slice(0, 2);
      if (!shards.has(key)) shards.set(key, new Map());
      const m = shards.get(key);
      if (!m.has(tok)) m.set(tok, []);
      m.get(tok).push(id);
    }
  });
  mkdirSync(join(TMP, "search"), { recursive: true });
  for (const [key, m] of shards) {
    // ids are increasing, so store gaps between them (much smaller numbers)
    const out = {};
    for (const [tok, ids] of m) out[tok] = ids.map((v, k) => (k ? v - ids[k - 1] : v));
    writeFileSync(join(TMP, "search", `${key}.json`), JSON.stringify(out));
  }
  const points = {
    v: 2,
    generatedAt: new Date().toISOString(),
    source: "PMLR, NeurIPS, ICLR, ACL Anthology, CVF Open Access, OpenAlex (arXiv)",
    embedder: emb.kind,
    // (a loop, not Math.min(...years): spreading 100k+ values overflows the call stack)
    years: years.reduce(([lo, hi], y) => [Math.min(lo, y), Math.max(hi, y)], [Infinity, -Infinity]),
    count: n,
    counts: { conference: papers.filter((p) => !p.k).length, arxiv: papers.filter((p) => p.k).length, byVenue },
    venues: VENUES,
    domains: Object.fromEntries(Object.entries(papers.reduce((m, p) => { if (p.d) m[p.d] = (m[p.d] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1])),
    pageSize: PAGE_SIZE,
    titleChunk: TITLE_CHUNK,
    searchShards: [...shards.keys()].sort(),
    subfields: regionOrder.map((r, i) => ({ name: regionNames[r], color: PALETTE[i % PALETTE.length], count: regionCount[r], center: norm3(regionCenter[r]).map((x) => +x.toFixed(4)) })),
    topics: topicMembers.map((m, t) => ({ name: topicNames[t], sub: regionRank.get(regionOf[t]), count: m.length, center: centers[t].map((x) => +x.toFixed(4)) })),
    pos: b64(posO), topic: b64(topicO), year: b64(yearO), kind: b64(kindO), venue: b64(venueO), cites: b64(citesO),
  };
  writeFileSync(join(TMP, "points.json"), JSON.stringify(points));
  for (let j = 0; j < n; j += PAGE_SIZE) {
    const page = order.slice(j, j + PAGE_SIZE).map((i) => ({ ...papers[i], tp: topicOf[i] }));
    writeFileSync(join(TMP, "pages", `${j / PAGE_SIZE}.json`), JSON.stringify(page));
  }
    if (existsSync(FINAL)) rmSync(FINAL, { recursive: true, force: true });
  renameSync(TMP, FINAL);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nDone in ${mins} min: ${n.toLocaleString()} papers in ${T} topics and ${R} regions (${emb.kind}).`);
  console.log(`By venue: ${Object.entries(byVenue).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" · ")}`);
  console.log(`Regions: ${regionOrder.map((r) => regionNames[r]).join(" | ")}`);
  if (errors.length) console.log(`Skipped: ${errors.join(" · ")}`);
  console.log("Reload CiteSeek to see the globe.\n");
}

main().catch((err) => { console.error(`\n✖ ${err.message}`); process.exit(1); });
