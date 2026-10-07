// One-time setup: creates the Vectorize index and KV namespace on your
// Cloudflare account and writes the KV id into wrangler.toml.
// Safe to re-run: existing resources are detected and skipped.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd) => {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

console.log("1/3  Vectorize index 'citeseek-embeddings'...");
const vec = run("npx wrangler vectorize create citeseek-embeddings --dimensions=768 --metric=cosine");
if (vec.ok) console.log("     created.");
else if (/duplicate_name|already exists/i.test(vec.out)) console.log("     already exists, skipping.");
else { console.error(vec.out); process.exit(1); }

const tomlPath = new URL("../wrangler.toml", import.meta.url);
let toml = readFileSync(tomlPath, "utf8");
console.log("2/3  KV namespace for paper storage...");
if (!toml.includes("REPLACE_WITH_KV_ID")) {
  console.log("     wrangler.toml already has a KV id, skipping.");
} else {
  const kv = run("npx wrangler kv namespace create PAPERS_KV");
  let id = kv.out.match(/"?\bid"?\s*[=:]\s*"([0-9a-f]{32})"/)?.[1];
  if (!id) {
    // It may already exist from a previous run; look it up by title.
    const list = run("npx wrangler kv namespace list");
    try {
      const all = JSON.parse(list.out.slice(list.out.indexOf("[")));
      id = all.find((n) => /PAPERS_KV/.test(n.title))?.id;
    } catch {}
  }
  if (!id) { console.error(kv.out); process.exit(1); }
  toml = toml.replace("REPLACE_WITH_KV_ID", id);
  writeFileSync(tomlPath, toml);
  console.log(`     using ${id} (saved to wrangler.toml).`);
}
console.log("3/3  D1 database for accounts and paper details...");
if (!toml.includes("REPLACE_WITH_D1_ID")) {
  console.log("     wrangler.toml already has a D1 id, skipping.");
} else {
  const d1 = run("npx wrangler d1 create citeseek-db");
  let id = d1.out.match(/"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/)?.[1];
  if (!id) {
    // Already created on a previous run: look it up by name.
    const list = run("npx wrangler d1 list --json");
    try { id = JSON.parse(list.out.slice(list.out.indexOf("["))).find((d) => d.name === "citeseek-db")?.uuid; } catch {}
  }
  if (!id) { console.error(d1.out); process.exit(1); }
  toml = toml.replace("REPLACE_WITH_D1_ID", id);
  writeFileSync(tomlPath, toml);
  console.log(`     using ${id} (saved to wrangler.toml). Tables are created automatically on first use.`);
}
console.log("\nDone. Run `npm run dev` to start CiteSeek locally, or `npm run deploy` to put it online.");
