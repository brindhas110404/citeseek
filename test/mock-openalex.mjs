// A small fake OpenAlex API for testing scripts/build-atlas.mjs offline.
// node test/mock-openalex.mjs [port]   then   OPENALEX_URL=http://localhost:<port> npm run atlas:build
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || 8899);
const SUBFIELDS = {
  "Artificial Intelligence": ["Natural Language Processing Techniques", "Topic Modeling", "Multimodal Machine Learning Applications", "Speech and dialogue systems", "Reinforcement Learning in Robotics", "Explainable Artificial Intelligence (XAI)", "Adversarial Robustness in Machine Learning", "Machine Learning and Algorithms", "Neural Networks and Applications", "Domain Adaptation and Few-Shot Learning"],
  "Computer Vision and Pattern Recognition": ["Generative Adversarial Networks and Image Synthesis", "Advanced Neural Network Applications", "Human Pose and Action Recognition", "Advanced Image and Video Retrieval Techniques", "3D Shape Modeling and Analysis", "Video Surveillance and Tracking Methods"],
  "Signal Processing": ["Speech Recognition and Synthesis", "Music and Audio Processing"],
  "Computational Theory and Mathematics": ["Stochastic Gradient Optimization Techniques", "Bayesian Methods and Mixture Models", "Sparse and Compressive Sensing Techniques"],
  "Information Systems": ["Recommender Systems and Techniques", "Graph Neural Networks", "Privacy-Preserving Technologies in Data"],
  "Linguistics and Language": ["Text Readability and Simplification", "Lexicography and Language Studies"],
  "Statistics and Probability": ["Statistical Methods and Inference", "Causal Inference Techniques"],
};
const SCALE = !!process.env.MOCK_SCALE;
if (SCALE) {
  // ~1,500 topics, like real AI venues in OpenAlex
  const parts = ["Neural", "Graph", "Language", "Vision", "Speech", "Policy", "Causal", "Sparse", "Federated", "Bayesian", "Contrastive", "Diffusion", "Robust", "Efficient", "Multilingual", "Temporal", "Spatial", "Quantum", "Medical", "Fairness"];
  const objs = ["Models", "Optimization", "Retrieval", "Generation", "Inference", "Representation Learning", "Benchmarks", "Alignment", "Compression", "Reasoning", "Segmentation", "Translation", "Planning", "Estimation", "Detection"];
  const subs = Object.keys(SUBFIELDS);
  let k = 0;
  for (const a of parts) for (const b of objs) for (const c of ["Methods", "Systems", "Theory", "Applications", "Analysis"]) {
    if (k >= 1500) break;
    SUBFIELDS[subs[k % subs.length]].push(`${a} ${b} ${c}`); k++;
  }
}
const TOPICS = Object.entries(SUBFIELDS).flatMap(([sub, names], si) =>
  names.map((name, i) => ({ id: `https://openalex.org/T${10000 + si * 100 + i}`, display_name: name, subfield: { id: `https://openalex.org/subfields/${1700 + si}`, display_name: sub }, field: { display_name: si === 5 ? "Arts and Humanities" : "Computer Science" } })));
const VENUES = {
  "Neural Information Processing Systems": ["Neural Information Processing Systems", "Advances in Neural Information Processing Systems 35", "NeurIPS Workshop on Datasets"],
  "International Conference on Machine Learning": ["International Conference on Machine Learning", "International Conference on Machine Learning and Applications"],
  "International Conference on Learning Representations": ["International Conference on Learning Representations"],
  "Annual Meeting of the Association for Computational Linguistics": ["Proceedings of the 60th Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers)", "Proceedings of the 61st Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers)", "Findings of the Association for Computational Linguistics: ACL 2023"],
  "Empirical Methods in Natural Language Processing": ["Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing"],
  "North American Chapter of the Association for Computational Linguistics": ["Proceedings of the 2022 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies"],
};
let sid = 1000;
const SOURCES = [];
for (const [q, names] of Object.entries(VENUES)) for (const n of names) SOURCES.push({ id: `https://openalex.org/S${sid++}`, display_name: n, type: "conference", works_count: 4000, q });
SOURCES.push({ id: "https://openalex.org/S4306400194", display_name: "arXiv (Cornell University)", type: "repository", works_count: 2_000_000, q: "arXiv" });

const PER_SOURCE = SCALE ? 5000 : 160; // works per source
const rnd = (s) => { const x = Math.sin(s) * 10000; return x - Math.floor(x); };
const WORDS = ["Efficient", "Scalable", "Robust", "Learning", "Towards", "Understanding", "Benchmarking", "Rethinking", "Contrastive", "Diffusion", "Sparse", "Causal", "Language", "Models", "Agents", "Transformers", "Alignment"];

function work(srcIdx, i, arxiv) {
  const seed = srcIdx * 100000 + i + 1;
  const topic = TOPICS[Math.floor(rnd(seed) * TOPICS.length)];
  const words = topic.display_name.split(/\s+/).slice(0, 3);
  const title = `${WORDS[Math.floor(rnd(seed + 1) * WORDS.length)]} ${words.join(" ")} ${WORDS[Math.floor(rnd(seed + 2) * WORDS.length)]} #${seed}`;
  const abs = `We study ${topic.display_name.toLowerCase()} and propose a new method that improves results on standard benchmarks.`.split(" ");
  const inv = {};
  abs.forEach((w, p) => (inv[w] = [...(inv[w] || []), p]));
  const arxivId = `23${String(10 + (seed % 12)).padStart(2, "0")}.${String(10000 + seed).slice(-5)}`;
  return {
    id: `https://openalex.org/W${seed}`,
    doi: arxiv ? null : `https://doi.org/10.1234/mock.${seed}`,
    display_name: title,
    publication_year: 2018 + (seed % 9),
    authorships: [{ author: { display_name: "Ada Lovelace" } }, { author: { display_name: "Alan Turing" } }, { author: { display_name: "Grace Hopper" } }, { author: { display_name: "Katherine Johnson" } }].slice(0, 1 + (seed % 4)),
    cited_by_count: Math.floor(rnd(seed + 3) * 900),
    primary_topic: seed % 41 === 0 ? null : topic,
    abstract_inverted_index: inv,
    best_oa_location: { pdf_url: seed % 3 === 0 ? `https://openreview.net/pdf?id=mock${seed}` : null },
    primary_location: { landing_page_url: `https://example.org/${seed}`, pdf_url: null },
    locations: seed % 2 === 0 || arxiv ? [{ landing_page_url: `https://arxiv.org/abs/${arxivId}v2` }] : [],
  };
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/sources") {
    const q = url.searchParams.get("search") || "";
    return send(200, { results: SOURCES.filter((s) => s.q.toLowerCase() === q.toLowerCase() || (q === "arXiv" && s.q === "arXiv")) });
  }
  if (url.pathname === "/works") {
    const filter = url.searchParams.get("filter") || "";
    if (filter.includes("subfield.id")) return send(400, { error: "Invalid query parameters error." }); // exercise the fallback
    const ids = (filter.match(/source\.id:([^,]+)/)?.[1] || "").split("|");
    const isArxiv = ids.includes("S4306400194");
    const all = ids.flatMap((id) => {
      const idx = SOURCES.findIndex((s) => s.id.endsWith(id));
      return idx < 0 ? [] : Array.from({ length: isArxiv ? (SCALE ? 15000 : 900) : PER_SOURCE }, (_, i) => work(idx, i, isArxiv));
    });
    // Conference papers also appear on arXiv, to exercise de-duplication.
    const cursor = url.searchParams.get("cursor");
    const page = cursor === "*" ? 0 : Number(cursor);
    const per = Number(url.searchParams.get("per-page") || 25);
    const slice = all.slice(page * per, page * per + per);
    return send(200, { meta: { count: all.length, next_cursor: (page + 1) * per < all.length ? String(page + 1) : null }, results: slice });
  }
  send(404, { error: "not found" });
}).listen(PORT, () => console.log(`mock OpenAlex on :${PORT}`));
