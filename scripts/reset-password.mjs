#!/usr/bin/env node
// Owner tool: set a new password for a CiteSeek account, for someone who lost both their
// password and their recovery key.
//
//   npm run reset-password -- <username>            # the local database used by `npm run dev`
//   npm run reset-password -- <username> --remote   # the deployed database on Cloudflare
//   npm run reset-password -- --list [--remote]     # list accounts
//
// It asks for the new password (typing is hidden), hashes it exactly like the app does
// (PBKDF2-SHA256, 100k iterations, random salt) and signs the account out everywhere.
import { execFileSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import readline from "node:readline";

const DB = "citeseek-db";
const args = process.argv.slice(2);
const where = args.includes("--remote") ? "--remote" : "--local";
const username = args.find((a) => !a.startsWith("--"));

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DB, where, "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? []; // skip any banner wrangler prints first
}

if (args.includes("--list")) {
  const rows = d1(
    `SELECT u.username, datetime(u.created_at/1000,'unixepoch') AS created,
            CASE WHEN k.user_id IS NULL THEN 'no' ELSE 'yes' END AS recovery_key
     FROM users u LEFT JOIN recovery_keys k ON k.user_id = u.id ORDER BY u.created_at`
  );
  console.table(rows);
  process.exit(0);
}

if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
  console.error("Usage: npm run reset-password -- <username> [--remote]   (or --list)");
  process.exit(1);
}

const [user] = d1(`SELECT id, username FROM users WHERE username = '${username}' COLLATE NOCASE`);
if (!user) {
  console.error(`No account named "${username}" in the ${where.slice(2)} database. Try --list.`);
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : s.replace(/[^\r\n]/g, "•"));
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const password = await askHidden(`New password for ${user.username}: `);
if (password.length < 10) { console.error("Use at least 10 characters."); process.exit(1); }
if (password.toLowerCase().includes(user.username.toLowerCase())) { console.error("The password can't contain the username."); process.exit(1); }
if ((await askHidden("Type it again: ")) !== password) { console.error("The passwords don't match."); process.exit(1); }

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const hash = hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256));

d1(
  `UPDATE users SET pass_hash = '${hash}', salt = '${hex(salt)}' WHERE id = '${user.id}';
   DELETE FROM sessions WHERE user_id = '${user.id}';
   DELETE FROM auth_attempts WHERE key = 'u:${user.username.toLowerCase()}';`
);
console.log(`✓ Password changed for ${user.username} (${where.slice(2)} database). They've been signed out everywhere and can sign in now.`);
