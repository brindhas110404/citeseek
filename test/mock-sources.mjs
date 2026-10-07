// Offline stand-ins for every source scripts/build-atlas.mjs reads, so the build can be tested
// without internet:  node test/mock-sources.mjs 8899   then
//   ATLAS_MOCK=http://localhost:8899 ATLAS_EMBEDDER=tfidf npm run atlas:build
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const PORT = Number(process.argv[2] || 8899);
const SCALE = Number(process.env.MOCK_PER_YEAR || 120); // papers per venue-year

const AREAS = [
  ["language models", "reasoning", "chain of thought", "prompting", "instruction tuning"],
  ["machine translation", "multilingual", "low-resource languages", "translation quality"],
  ["reinforcement learning", "policy optimization", "exploration", "reward shaping", "offline rl"],
  ["diffusion models", "image generation", "score matching", "denoising", "text-to-image"],
  ["graph neural networks", "message passing", "molecular graphs", "node classification"],
  ["adversarial robustness", "certified defenses", "adversarial examples", "attacks"],
  ["federated learning", "privacy", "differential privacy", "client heterogeneity"],
  ["speech recognition", "audio", "spoken language", "speech synthesis"],
  ["question answering", "retrieval augmented generation", "open-domain qa", "dense retrieval"],
  ["optimization", "stochastic gradient descent", "convergence", "adaptive methods"],
  ["causal inference", "treatment effects", "counterfactuals", "causal discovery"],
  ["vision transformers", "object detection", "segmentation", "self-supervised vision"],
  ["fairness", "bias", "algorithmic fairness", "demographic parity"],
  ["bayesian inference", "variational inference", "uncertainty", "gaussian processes"],
  ["sentiment analysis", "social media", "hate speech", "emotion detection"],
  ["robotics", "manipulation", "sim-to-real", "imitation learning"],
];
const PREFIX = ["Towards", "Rethinking", "Scaling", "Understanding", "Improving", "Efficient", "Robust", "On the", "A Theory of", "Benchmarking"];
const r = (s) => { const x = Math.sin(s * 9301 + 49297) * 233280; return x - Math.floor(x); };

function paper(seed, nlpBias) {
  const a = Math.floor(r(seed) * AREAS.length * (nlpBias ? 0.6 : 1)) % AREAS.length;
  const area = AREAS[(a + (nlpBias ? [0, 1, 8, 14, 7][seed % 5] : 0)) % AREAS.length];
  const k1 = area[Math.floor(r(seed + 1) * area.length)], k2 = area[Math.floor(r(seed + 2) * area.length)];
  const title = `${PREFIX[Math.floor(r(seed + 3) * PREFIX.length)]} ${k1} for ${k2} (${seed})`;
  const abstract = `We study ${k1} in the context of ${k2}. Our method for ${area[0]} improves over prior ${area[1] || k1} baselines and analyses ${k2}.`;
  return { title, abstract, authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Katherine Johnson"].slice(0, 1 + (seed % 4)) };
}

function paperIn(area, seed) {
  const k1 = area[Math.floor(r(seed + 1) * area.length)], k2 = area[Math.floor(r(seed + 2) * area.length)];
  return { title: `${PREFIX[Math.floor(r(seed + 3) * PREFIX.length)]} ${k1} for ${k2} (${seed})`, abstract: `We study ${k1} and ${k2} in ${area[0]}.`, authors: ["Ada Lovelace", "Alan Turing"] };
}

// CVF Open Access: 2021+ lists everything on ?day=all; 2019 splits the list into day pages.
function cvfList(conf, year, day) {
  let s = "<html><body><dl>";
  const n = Math.round(SCALE * 0.6);
  for (let i = 0; i < n; i++) {
    if (day && i % 2 !== (day === "a" ? 0 : 1)) continue;
    const p = paperIn(AREAS[[11, 3, 5, 15][i % 4]], 600000 + year * 1000 + i + { CVPR: 0, ICCV: 300, WACV: 600 }[conf]);
    const slug = `Author_${conf}_${year}_${i}`;
    s += `<dt class="ptitle"><br><a href="/content/${conf}${year}/html/${slug}_${conf}_${year}_paper.html">${p.title.replace(/&/g, "&amp;")}</a></dt>
<dd><form id="form-${i}" action="/${conf}${year}_search" method="post" class="authsearch"><input type="hidden" name="query_author" value="Ada Lovelace"><a href="#" onclick="">Ada Lovelace</a>,</form></dd>
<dd>[<a href="/content/${conf}${year}/papers/${slug}_${conf}_${year}_paper.pdf">pdf</a>] [<a href="/content/${conf}${year}/supplemental/${slug}_supplemental.pdf">supp</a>]</dd>`;
  }
  return s + "</dl></body></html>";
}

const ICML_VOLS = { 2018: 80, 2019: 97, 2020: 119, 2021: 139, 2022: 162, 2023: 202, 2024: 235, 2025: 267, 2026: 306 };
// Other PMLR venues: [label in the index, year, volume]
const OTHER_VOLS = [["AISTATS", 2023, 206], ["AISTATS", 2024, 238], ["CoRL", 2023, 229], ["Medical Imaging with Deep Learning", 2023, 227], ["COLT", 2024, 247], ["AutoML-Conf", 2022, 188]];
const VOL_YEAR = { ...Object.fromEntries(Object.entries(ICML_VOLS).map(([y, v]) => [v, +y])), ...Object.fromEntries(OTHER_VOLS.map(([, y, v]) => [v, y])) };

function pmlrIndex() {
  const lis = Object.entries(ICML_VOLS).map(([y, v]) => `<li><a href="v${v}">Volume ${v}</a> Proceedings of ICML ${y}</li>`);
  for (const [name, y, v] of OTHER_VOLS) lis.push(`<li><a href="v${v}">Volume ${v}</a> Proceedings of ${name} ${y}</li>`);
  lis.push(`<li><a href="v292">Volume 292</a> TerraBytes at ICML 2025</li>`, `<li><a href="v184">Volume 184</a> Proceedings of ICML 2022 Workshop on Healthcare AI</li>`);
  return `<html><body><ul>${lis.join("\n")}</ul></body></html>`;
}
function pmlrYaml(vol, year) {
  let s = "\n";
  for (let i = 0; i < SCALE; i++) {
    const p = paper(vol * 1000 + i);
    s += `\n- title: '${p.title.replace(/'/g, "''")}'\n  abstract: '${p.abstract.replace(/'/g, "''")} It''s simple.'\n  volume: ${vol}\n  URL: https://proceedings.mlr.press/v${vol}/p${i}.html\n  PDF: https://proceedings.mlr.press/v${vol}/p${i}/p${i}.pdf\n  container-title: 'Proceedings of ICML'\n  author: \n${p.authors.map((a) => `  - given: ${a.split(" ")[0]}\n    family: ${a.split(" ")[1]}`).join("\n")}\n  editor: \n  - given: Ed\n    family: Itor\n  id: p${i}\n`;
  }
  return s;
}
function virtualJson(conf, year) {
  const results = [];
  for (let i = 0; i < SCALE; i++) {
    const p = paper((conf === "iclr" ? 500000 : 700000) + year * 1000 + i);
    const base = { name: p.title, abstract: p.abstract, authors: p.authors.map((fullname) => ({ fullname })), eventtype: "Poster", decision: "Accept (poster)" };
    if (conf === "iclr" || year >= 2021) base.paper_url = `https://openreview.net/forum?id=mock${year}${i}`;
    else base.paper_pdf_url = `https://proceedings.neurips.cc//paper_files/paper/${year}/hash/${(year * 1000 + i).toString(16).padStart(8, "0")}-Abstract.html`;
    results.push(base);
    if (i % 20 === 0) results.push({ ...base, eventtype: "Oral" }); // duplicate oral entries
  }
  results.push({ name: "Lightning Talks 4B-1", eventtype: "Poster", authors: [] });
  results.push({ name: "A dataset track paper", abstract: "x", eventtype: "Poster", authors: [{ fullname: "D B" }], sourceurl: `https://openreview.net/group?id=NeurIPS.cc/${year}/Datasets_and_Benchmarks_Track` });
  return JSON.stringify({ count: results.length, results });
}
const hashOf = (year, i) => (year * 100000 + i).toString(16).padStart(32, "0");
function nipsList(year) {
  let s = `<html><body><ul class="paper-list">`;
  for (let i = 0; i < SCALE; i++) {
    const p = paper(900000 + year * 1000 + i);
    s += `<li class="" data-track="none"><div class="paper-content"><a title="paper title" href="/paper_files/paper/${year}/hash/${hashOf(year, i)}-Abstract.html">${p.title.replace(/&/g, "&amp;")}</a>\n<span class="paper-authors">${p.authors.join(", ")}</span></div></li>`;
  }
  return s + "</ul></body></html>";
}
function nipsAbstract(year, hash) {
  const i = parseInt(hash, 16) - year * 100000;
  const p = paper(900000 + year * 1000 + i);
  return `<html><body><h4>Abstract</h4><p>Short.</p><p>${p.abstract} This paragraph is long enough to be detected as the abstract of the paper by the parser in the build script.</p></body></html>`;
}
function aclBib() {
  const entries = [];
  const vols = [];
  for (const [pre, venue] of [["P", "ACL"], ["D", "EMNLP"], ["N", "NAACL"]]) for (const y of [18, 19]) vols.push([`${pre}${y}-1`, 2000 + y, venue, (n) => `${pre}${y}-1${String(n).padStart(3, "0")}`]);
  for (let y = 2020; y <= 2026; y++) {
    vols.push([`${y}.acl-long`, y, "ACL", (n) => `${y}.acl-long.${n}`]);
    vols.push([`${y}.emnlp-main`, y, "EMNLP", (n) => `${y}.emnlp-main.${n}`]);
    if (y % 2 === 0 || y === 2025) vols.push([`${y}.naacl-long`, y, "NAACL", (n) => `${y}.naacl-long.${n}`]);
    vols.push([`${y}.findings-acl`, y, "Findings", (n) => `${y}.findings-acl.${n}`]); // excluded
  }
  vols.push(["2017.acl-long", 2017, "ACL", (n) => `P17-1${String(n).padStart(3, "0")}`]); // too old
  let seed = 1;
  for (const [, year, venue, id] of vols) {
    for (let n = 0; n <= SCALE; n++) {
      const p = paper(300000 + seed++, true);
      entries.push(`@inproceedings{k${seed},\n    title = "${n === 0 ? "Proceedings front matter" : p.title.replace("for", "for {\\'e}l{\\\"o}")}",\n    author = "${p.authors.map((a) => `${a.split(" ")[1]}, ${a.split(" ")[0]}`).join(" and\n      ")}",\n    booktitle = "Proceedings of ${venue} ${year}",\n    year = "${year}",\n    url = "https://aclanthology.org/${id(n)}/",\n    abstract = "${p.abstract}",\n}`);
    }
  }
  return gzipSync(Buffer.from(entries.join("\n\n")));
}

const ARXIV_N = Number(process.env.MOCK_ARXIV || 600);
function openalexWorks(url) {
  // Per-field requests (primary_topic.subfield.id:NNNN) get papers from one area each.
  const sub = Number((url.searchParams.get("filter") || "").match(/subfield\.id:(\d+)/)?.[1] || 0);
  const cursor = url.searchParams.get("cursor");
  const page = cursor === "*" ? 0 : Number(cursor);
  const per = Number(url.searchParams.get("per-page") || 25);
  const results = [];
  for (let i = page * per; i < Math.min(ARXIV_N, (page + 1) * per); i++) {
    const p = sub ? paperIn(AREAS[sub % AREAS.length], 100000 + sub * 1000 + i) : paper(100000 + i);
    const inv = {}; p.abstract.split(" ").forEach((w, k) => (inv[w] = [...(inv[w] || []), k]));
    // every 10th preprint duplicates a conference title (to test de-duplication)
    const title = i % 10 === 0 ? paper(80 * 1000 + (i % SCALE)).title : p.title;
    results.push({ id: `https://openalex.org/W${i}`, display_name: title, publication_year: 2025, authorships: p.authors.map((n) => ({ author: { display_name: n } })), cited_by_count: i % 300, abstract_inverted_index: inv, locations: [{ landing_page_url: `https://arxiv.org/abs/2501.${String(10000 + i)}v1` }] });
  }
  for (const r of results) if (sub) r.id += `-${sub}`;
  return { meta: { count: ARXIV_N, next_cursor: (page + 1) * per < ARXIV_N ? String(page + 1) : null }, results };
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const [, host, ...rest] = url.pathname.split("/");
  const path = "/" + rest.join("/");
  const send = (code, body, type = "text/html") => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
  const json = (o) => send(200, JSON.stringify(o), "application/json");
  let m;
  if (host === "proceedings.mlr.press") {
    if (path === "/") return send(200, pmlrIndex());
    if ((m = path.match(/^\/v(\d+)\/assets\/bib\/citeproc\.yaml$/))) {
      const year = VOL_YEAR[+m[1]];
      return year ? send(200, pmlrYaml(+m[1], +year), "text/yaml") : send(404, "nf");
    }
  }
  if (host === "neurips.cc" && (m = path.match(/neurips-(\d{4})-orals-posters\.json$/))) return +m[1] >= 2020 ? send(200, virtualJson("neurips", +m[1]), "application/json") : send(404, "nf");
  if (host === "iclr.cc" && (m = path.match(/iclr-(\d{4})-orals-posters\.json$/))) return +m[1] >= 2020 ? send(200, virtualJson("iclr", +m[1]), "application/json") : send(404, "nf");
  if (host === "proceedings.neurips.cc") {
    if ((m = path.match(/^\/paper_files\/paper\/(\d{4})$/))) return +m[1] <= 2019 ? send(200, nipsList(+m[1])) : send(404, "nf");
    if ((m = path.match(/^\/paper_files\/paper\/(\d{4})\/hash\/([0-9a-f]+)-Abstract/))) return send(200, nipsAbstract(+m[1], m[2]));
  }
  if (host === "openaccess.thecvf.com") {
    const day = url.searchParams.get("day");
    if ((m = path.match(/^\/(CVPR|ICCV|WACV)(\d{4})$/))) {
      const [, conf, y] = m;
      if (+y < 2019 || (conf === "ICCV" && +y % 2 === 0)) return send(404, "nf");
      if (+y >= 2021) return day === "all" ? send(200, cvfList(conf, +y)) : send(200, `<a href="?day=all">All</a>`);
      if (day === "2019-06-18") return send(200, cvfList(conf, +y, "a"));
      if (day === "2019-06-19") return send(200, cvfList(conf, +y, "b"));
      if (day === "all") return send(404, "nf");
      return send(200, `<html><a href="/${conf}${y}?day=2019-06-18">Day 1</a> <a href="/${conf}${y}?day=2019-06-19">Day 2</a></html>`);
    }
    if ((m = path.match(/\/html\/(.+)_paper\.html$/))) return send(200, `<html><div id="abstract">\nWe present work on vision and images for ${m[1]}. This abstract is long enough.\n</div></html>`);
  }
  if (host === "aclanthology.org" && path === "/anthology+abstracts.bib.gz") { res.writeHead(200, { "Content-Type": "application/gzip" }); return res.end(aclBib()); }
  if (host === "api.openalex.org") {
    if (path === "/sources") return json({ results: [{ id: "https://openalex.org/S4306400194", display_name: "arXiv (Cornell University)", works_count: 2000000 }] });
    if (path === "/works") {
      return json(openalexWorks(url));
    }
  }
  send(404, "not found");
}).listen(PORT, () => console.log(`mock sources on :${PORT}`));
