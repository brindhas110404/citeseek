#!/usr/bin/env node
// Runs automatically before `npm run deploy` (npm's "predeploy" hook).
// Stops the deploy if something required is missing, and warns about optional settings,
// printing the exact command to fix each one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m, fix) => console.log(`  ! ${m}${fix ? `\n      → ${fix}` : ""}`);
const bad = [];
const fail = (m, fix) => { bad.push(m); console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ""}`); };

console.log("\nCiteSeek deploy check\n");

// 1. Cloudflare resources in wrangler.toml
const toml = readFileSync("wrangler.toml", "utf8");
if (/RELAX_LIMITS/.test(toml)) fail("wrangler.toml turns rate limits off (RELAX_LIMITS); that's for tests only", "remove the RELAX_LIMITS line from wrangler.toml");
if (toml.includes("REPLACE_WITH_D1_ID")) fail("No D1 database yet (accounts can't be stored)", "npm run setup");
else ok("D1 database is set");
if (toml.includes("REPLACE_WITH_KV_ID")) fail("No KV namespace yet (paper text can't be stored)", "npm run setup");
else ok("KV namespace is set");

// 2. Paper atlas (the globe)
if (existsSync("static/atlas/points.json")) ok("Paper atlas is built");
else warn("Paper atlas isn't built, so the globe will be empty", "npm run atlas:build   (with npm run dev running)");

// 3. Secrets on Cloudflare (local .dev.vars values are NOT deployed)
let secrets = null;
try {
  const out = execFileSync("npx", ["wrangler", "secret", "list", "--format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  secrets = new Set(JSON.parse(out.slice(out.indexOf("["))).map((s) => s.name));
} catch {
  console.log("  · Couldn't read secrets (normal before the first deploy). Add them right after it; they take effect without redeploying.");
}
if (secrets) {
  const has = (n) => secrets.has(n);
  if (has("BREVO_API_KEY") && has("EMAIL_FROM")) ok("Brevo email is set up (reset and confirmation emails will be sent)");
  else if (has("BREVO_API_KEY") || has("EMAIL_FROM")) {
    warn(`Email is half set up: missing ${has("BREVO_API_KEY") ? "EMAIL_FROM" : "BREVO_API_KEY"}`,
      `npx wrangler secret put ${has("BREVO_API_KEY") ? "EMAIL_FROM" : "BREVO_API_KEY"}`);
  } else {
    warn("No email service: \"Forgot password?\" by email won't send anything (recovery keys still work)",
      "npx wrangler secret put BREVO_API_KEY   and   npx wrangler secret put EMAIL_FROM");
  }
  if (has("TURNSTILE_SITE_KEY") && has("TURNSTILE_SECRET_KEY")) ok("Turnstile bot check is on");
  else warn("Turnstile bot check is off (sign-up and sign-in work, without the bot check)",
    "npx wrangler secret put TURNSTILE_SITE_KEY   and   npx wrangler secret put TURNSTILE_SECRET_KEY");
}

if (bad.length) {
  console.log(`\nDeploy stopped: fix the ✗ item${bad.length > 1 ? "s" : ""} above, then run npm run deploy again.\n`);
  process.exit(1);
}
console.log("\nLooks good. Deploying...\n");
