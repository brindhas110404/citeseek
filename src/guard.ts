import type { Context } from "hono";
import type { Env } from "./types";

/**
 * Abuse protection for sign-in and sign-up:
 *  - failed-login limits per username and per network address
 *  - sign-up limits per network address
 *  - password strength rules
 *  - Cloudflare Turnstile bot check (on when TURNSTILE_SECRET_KEY is set)
 */

const MIN = 60_000;
export const LIMITS = {
  loginPerUser: { max: 5, windowMs: 15 * MIN },   // wrong passwords for one account
  loginPerIp: { max: 20, windowMs: 15 * MIN },    // failed sign-ins from one address
  signupPerIp: { max: 10, windowMs: 60 * MIN },   // sign-up attempts from one address
};

export const clientIp = (c: Context) =>
  c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "local";

const userKey = (username: string) => `u:${username.toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;
const signupKey = (ip: string) => `su:${ip}`;

async function recent(env: Env, key: string, windowMs: number): Promise<{ n: number; oldest: number }> {
  // The offline test setup (test/wrangler.mock.toml) signs up dozens of accounts a minute.
  // Never set this in the real wrangler.toml; `npm run deploy` refuses if it is.
  if (env.RELAX_LIMITS === "1") return { n: 0, oldest: Date.now() };
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(at) AS oldest FROM auth_attempts WHERE key = ? AND at > ?`)
    .bind(key, Date.now() - windowMs)
    .first<{ n: number; oldest: number | null }>();
  return { n: row?.n ?? 0, oldest: row?.oldest ?? Date.now() };
}

async function record(env: Env, ...keys: string[]) {
  const now = Date.now();
  await env.DB.batch(keys.map((k) => env.DB.prepare(`INSERT INTO auth_attempts (key, at) VALUES (?, ?)`).bind(k, now)));
  // Occasionally sweep out old rows so the table stays small.
  if (Math.random() < 0.05) {
    await env.DB.prepare(`DELETE FROM auth_attempts WHERE at < ?`).bind(now - 24 * 60 * MIN).run();
  }
}

/**
 * Generic limiter: counts this attempt under `key` and returns the minutes to wait if the
 * key already had `max` attempts in the window (in which case this one isn't counted).
 */
export async function rateLimited(env: Env, key: string, max: number, windowMs: number): Promise<number | null> {
  const r = await recent(env, key, windowMs);
  if (r.n >= max) return minutesUntil(r.oldest, windowMs);
  await record(env, key);
  return null;
}

const minutesUntil = (oldest: number, windowMs: number) => Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / MIN));

/** Returns an error message if this sign-in should be blocked for now. */
export async function loginBlocked(env: Env, username: string, ip: string): Promise<string | null> {
  const [u, a] = await Promise.all([
    recent(env, userKey(username), LIMITS.loginPerUser.windowMs),
    recent(env, ipKey(ip), LIMITS.loginPerIp.windowMs),
  ]);
  if (u.n >= LIMITS.loginPerUser.max) {
    const m = minutesUntil(u.oldest, LIMITS.loginPerUser.windowMs);
    return `Too many wrong passwords for this account. Try again in ${m} minute${m === 1 ? "" : "s"}.`;
  }
  if (a.n >= LIMITS.loginPerIp.max) {
    const m = minutesUntil(a.oldest, LIMITS.loginPerIp.windowMs);
    return `Too many failed sign-ins from your network. Try again in ${m} minute${m === 1 ? "" : "s"}.`;
  }
  return null;
}

/** Records a failed sign-in and returns how many tries are left for this account. */
export async function recordLoginFailure(env: Env, username: string, ip: string, knownUser: boolean): Promise<number> {
  await record(env, ...(knownUser ? [userKey(username)] : []), ipKey(ip));
  if (!knownUser) return LIMITS.loginPerUser.max;
  const u = await recent(env, userKey(username), LIMITS.loginPerUser.windowMs);
  return Math.max(0, LIMITS.loginPerUser.max - u.n);
}

export async function clearLoginFailures(env: Env, username: string) {
  await env.DB.prepare(`DELETE FROM auth_attempts WHERE key = ?`).bind(userKey(username)).run();
}

/** Counts this sign-up attempt and returns an error message if the address is over its limit. */
export async function signupBlocked(env: Env, ip: string): Promise<string | null> {
  const s = await recent(env, signupKey(ip), LIMITS.signupPerIp.windowMs);
  if (s.n >= LIMITS.signupPerIp.max) {
    const m = minutesUntil(s.oldest, LIMITS.signupPerIp.windowMs);
    return `Too many sign-up attempts from your network. Try again in ${m} minute${m === 1 ? "" : "s"}.`;
  }
  await record(env, signupKey(ip));
  return null;
}

// ---------------- Password strength ----------------

const MIN_PASSWORD = 10;

// The most common leaked passwords (and close variants) that would be guessed first.
const COMMON = new Set(`
password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword 123456 1234567 12345678
123456789 1234567890 12345678910 0123456789 9876543210 qwerty qwerty123 qwertyuiop qwerty12345 1q2w3e4r 1q2w3e4r5t
1qaz2wsx zaq12wsx asdfghjkl asdfgh zxcvbnm iloveyou iloveyou1 princess sunshine football baseball basketball
superman batman letmein welcome welcome1 welcome123 admin admin123 administrator monkey dragon master shadow
trustno1 abc123 abcd1234 abcdef abcdefgh abcdefghij 111111 1111111111 000000 0000000000 121212 123123 123123123
654321 666666 7777777 888888 987654321 secret secret123 changeme changeme123 starwars pokemon minecraft whatever
freedom computer internet hello123 helloworld ninja mustang michael jennifer jordan23 hunter2 charlie access
loveme lovely flower cheese chocolate summer2024 summer2025 summer2026 winter2025 spring2026 autumn2025
citeseek citeseek123 research research123 student student123 university
`.trim().split(/\s+/));

export function passwordProblem(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "That password is too long.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[!.?#*]+$/, ""))) return "That's one of the most common passwords. Pick something less guessable.";
  if (/^(.)\1+$/.test(password)) return "Don't use a single repeated character.";
  if (username && lower.includes(username.toLowerCase())) return "Your password can't contain your username.";
  if (new Set(password).size < 4) return "Use a few more different characters.";
  return null;
}

/** 0–4 strength score, used for the meter on the sign-up form (mirrored in the browser). */
export function passwordScore(password: string): number {
  let s = 0;
  if (password.length >= MIN_PASSWORD) s++;
  if (password.length >= 14) s++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) s++;
  if (/\d/.test(password) && /[^a-zA-Z0-9]/.test(password)) s++;
  return s;
}

// ---------------- Cloudflare Turnstile ----------------

export const turnstileEnabled = (env: Env) => !!env.TURNSTILE_SECRET_KEY && !!env.TURNSTILE_SITE_KEY;

/** Verifies a Turnstile token with Cloudflare. Always passes when Turnstile isn't configured. */
export async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  if (typeof token !== "string" || !token) return false;
  try {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET_KEY!);
    body.append("response", token);
    if (ip !== "local") body.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const data = (await res.json()) as { success?: boolean };
    return !!data.success;
  } catch (err) {
    console.warn("Turnstile verification failed:", err);
    return false;
  }
}
