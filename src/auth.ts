import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types";
import { adoptLegacyPapers, ensureSchema } from "./db";
import { devAutoConfirm, emailInfo, emailProblem, setUserEmail, verifiedByOther } from "./email";
import {
  LIMITS, clearLoginFailures, clientIp, loginBlocked, passwordProblem, recordLoginFailure,
  signupBlocked, turnstileEnabled, verifyTurnstile,
} from "./guard";

export interface User { id: string; username: string }
export type AppEnv = { Bindings: Env; Variables: { user: User; sessionHash: string } };

/** "Chrome on macOS", "Safari on iPhone"... from the User-Agent, for the devices list. */
export function deviceName(ua: string | undefined): string {
  const s = ua || "";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox"
    : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /curl|python|node|wrangler/i.test(s) ? "Script" : "Browser";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Mac OS X|Macintosh/.test(s) ? "macOS"
    : /Windows/.test(s) ? "Windows" : /CrOS/.test(s) ? "ChromeOS" : /Linux/.test(s) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const COOKIE = "cs_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // the Workers runtime caps PBKDF2 at 100k iterations

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randomHex = (bytes: number) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return toHex(bits);
}

export const sha256 = async (s: string) => toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** Constant-time comparison of two equal-length hex strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function usernameProblem(username: unknown): string | null {
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return "Usernames are 3–32 characters: letters, numbers, dots, dashes or underscores.";
  }
  return null;
}

type AuthBody = { username?: string; password?: string; turnstileToken?: string; recoveryKey?: string; email?: string };

// ---------------- Recovery keys ----------------
// Accounts have no email address, so a forgotten password is reset with a recovery key that is
// shown once at sign-up. Only its hash is stored. Keys are 20 random characters (100 bits), so a
// plain SHA-256 is enough; brute-forcing one is out of reach even without the rate limits.
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
const KEY_LEN = 20;

function newRecoveryKey(): string {
  const out: string[] = [];
  while (out.length < KEY_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 240 && out.length < KEY_LEN) out.push(KEY_ALPHABET[b % 30]); // 240 = 8 × 30, no modulo bias
    }
  }
  return out.join("").match(/.{5}/g)!.join("-");
}
const normalizeKey = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, "");
const keyHash = (userId: string, key: string) => sha256(`${userId}:${normalizeKey(key)}`);

/** Creates (or replaces) a user's recovery key and returns it. The old key stops working. */
async function issueRecoveryKey(env: Env, userId: string): Promise<string> {
  const key = newRecoveryKey();
  await env.DB.prepare(
    `INSERT INTO recovery_keys (user_id, key_hash, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at`
  ).bind(userId, await keyHash(userId, key), Date.now()).run();
  return key;
}

async function hasRecoveryKey(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 FROM recovery_keys WHERE user_id = ?`).bind(userId).first());
}

/** GET /api/auth/config: what the sign-in form needs to know. */
export function authConfig(c: Context<AppEnv>) {
  return c.json({
    turnstileSiteKey: turnstileEnabled(c.env) ? c.env.TURNSTILE_SITE_KEY : null,
    minPassword: 10,
  });
}

export async function startSession(c: Context<AppEnv>, userId: string) {
  const token = randomHex(32);
  const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, device, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 86_400_000, deviceName(c.req.header("User-Agent")), now)
    .run();
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function signup(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const { username, password, turnstileToken, email } = await c.req.json<AuthBody>().catch(() => ({} as AuthBody));
  const ip = clientIp(c);
  if (!(await verifyTurnstile(c.env, turnstileToken, ip))) {
    return c.json({ error: "Please complete the human check and try again.", code: "turnstile" }, 400);
  }
  const blocked = await signupBlocked(c.env, ip);
  if (blocked) return c.json({ error: blocked, code: "rate_limited" }, 429);

  const badName = usernameProblem(username);
  if (badName) return c.json({ error: badName, field: "username" }, 400);
  const badPass = passwordProblem(String(password ?? ""), username!);
  if (badPass) return c.json({ error: badPass, field: "password" }, 400);
  const addr = typeof email === "string" ? email.trim() : "";
  if (addr) {
    const badEmail = emailProblem(addr);
    if (badEmail) return c.json({ error: badEmail, field: "email" }, 400);
    if (await verifiedByOther(c.env, addr, "")) return c.json({ error: "That email is already used by another account.", field: "email" }, 409);
  }

  const taken = await c.env.DB.prepare(`SELECT 1 FROM users WHERE username = ?`).bind(username).first();
  if (taken) return c.json({ error: "That username is taken. Try another, or sign in.", field: "username" }, 409);

  const isFirstUser = !(await c.env.DB.prepare(`SELECT 1 FROM users LIMIT 1`).first());
  const id = randomHex(8);
  const salt = randomHex(16);
  await c.env.DB.prepare(`INSERT INTO users (id, username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, username, await hashPassword(password!, salt), salt, Date.now())
    .run();

  const imported = isFirstUser ? await adoptLegacyPapers(c.env, id) : 0;
  const recoveryKey = await issueRecoveryKey(c.env, id);
  const mail = addr ? await setUserEmail(c, id, username!, addr) : null;
  await startSession(c, id);
  return c.json({
    user: { id, username, hasRecoveryKey: true, email: addr || null, emailVerified: !!mail?.verified },
    imported, recoveryKey,
    ...(mail ? { emailSent: mail.sent, ...("mailError" in mail ? { mailError: mail.mailError } : {}), ...("devLink" in mail ? { devLink: mail.devLink } : {}) } : {}),
  });
}

export async function login(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const { username, password, turnstileToken } = await c.req.json<AuthBody>().catch(() => ({} as AuthBody));
  const ip = clientIp(c);
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    return c.json({ error: "Enter your username and password." }, 400);
  }
  if (!(await verifyTurnstile(c.env, turnstileToken, ip))) {
    return c.json({ error: "Please complete the human check and try again.", code: "turnstile" }, 400);
  }
  // Rate limits make knowing a username useless for guessing its password.
  const blocked = await loginBlocked(c.env, username, ip);
  if (blocked) return c.json({ error: blocked, code: "rate_limited" }, 429);

  const row = await c.env.DB.prepare(`SELECT id, username, pass_hash, salt FROM users WHERE username = ?`)
    .bind(username).first<{ id: string; username: string; pass_hash: string; salt: string }>();
  if (!row) {
    await recordLoginFailure(c.env, username, ip, false);
    return c.json({ error: "No account with that username.", code: "no_user", field: "username" }, 404);
  }
  const hash = await hashPassword(password, row.salt);
  if (!safeEqual(hash, row.pass_hash)) {
    const left = await recordLoginFailure(c.env, username, ip, true);
    const mins = LIMITS.loginPerUser.windowMs / 60_000;
    const error = left === 0
      ? `Wrong password. This account is locked for ${mins} minutes.`
      : left <= 2
        ? `Wrong password. ${left} ${left === 1 ? "try" : "tries"} left before a ${mins}-minute lock.`
        : "Wrong password.";
    return c.json({ error, code: "bad_password", field: "password" }, 401);
  }
  await clearLoginFailures(c.env, username);
  await startSession(c, row.id);
  await devAutoConfirm(c, row.id);
  return c.json({ user: { id: row.id, username: row.username, hasRecoveryKey: await hasRecoveryKey(c.env, row.id), ...(await emailInfo(c.env, row.id)) } });
}

/**
 * POST /api/auth/reset: { username, recoveryKey, password } sets a new password.
 * Wrong keys count toward the same lockout as wrong passwords. On success every existing
 * session is signed out, the used key is replaced with a fresh one, and you're signed in.
 */
export async function resetPassword(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const { username, recoveryKey, password, turnstileToken } = await c.req.json<AuthBody>().catch(() => ({} as AuthBody));
  const ip = clientIp(c);
  if (typeof username !== "string" || !username.trim()) return c.json({ error: "Enter your username.", field: "username" }, 400);
  if (typeof recoveryKey !== "string" || normalizeKey(recoveryKey).length !== KEY_LEN) {
    return c.json({ error: "Recovery keys are 20 letters and numbers, like ABCDE-FGHJK-MNPQR-STVWX.", field: "recoveryKey" }, 400);
  }
  if (!(await verifyTurnstile(c.env, turnstileToken, ip))) {
    return c.json({ error: "Please complete the human check and try again.", code: "turnstile" }, 400);
  }
  const blocked = await loginBlocked(c.env, username, ip);
  if (blocked) return c.json({ error: blocked, code: "rate_limited" }, 429);

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.username, k.key_hash FROM users u LEFT JOIN recovery_keys k ON k.user_id = u.id WHERE u.username = ?`
  ).bind(username).first<{ id: string; username: string; key_hash: string | null }>();
  if (!row) {
    await recordLoginFailure(c.env, username, ip, false);
    return c.json({ error: "No account with that username.", code: "no_user", field: "username" }, 404);
  }
  if (!row.key_hash || !safeEqual(await keyHash(row.id, recoveryKey), row.key_hash)) {
    const left = await recordLoginFailure(c.env, username, ip, true);
    const mins = LIMITS.loginPerUser.windowMs / 60_000;
    const error = !row.key_hash
      ? "This account never saved a recovery key, so it can't be reset here. Ask whoever runs this CiteSeek to reset it."
      : left === 0
        ? `That recovery key doesn't match. This account is locked for ${mins} minutes.`
        : `That recovery key doesn't match.${left <= 2 ? ` ${left} ${left === 1 ? "try" : "tries"} left before a ${mins}-minute lock.` : ""}`;
    return c.json({ error, code: row.key_hash ? "bad_key" : "no_key", field: "recoveryKey" }, 401);
  }
  const badPass = passwordProblem(String(password ?? ""), row.username);
  if (badPass) return c.json({ error: badPass, field: "password" }, 400);

  const salt = randomHex(16);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?`).bind(await hashPassword(password!, salt), salt, row.id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.id),
  ]);
  await clearLoginFailures(c.env, username);
  const newKey = await issueRecoveryKey(c.env, row.id); // a key works once
  await startSession(c, row.id);
  return c.json({ user: { id: row.id, username: row.username, hasRecoveryKey: true, ...(await emailInfo(c.env, row.id)) }, recoveryKey: newKey });
}

/** POST /api/account/recovery-key: { password } creates a new recovery key (the old one stops working). */
export async function regenerateRecoveryKey(c: Context<AppEnv>) {
  const user = c.get("user");
  const { password } = await c.req.json<AuthBody>().catch(() => ({} as AuthBody));
  const ip = clientIp(c);
  if (typeof password !== "string" || !password) return c.json({ error: "Enter your password.", field: "password" }, 400);
  const blocked = await loginBlocked(c.env, user.username, ip);
  if (blocked) return c.json({ error: blocked, code: "rate_limited" }, 429);
  const row = await c.env.DB.prepare(`SELECT pass_hash, salt FROM users WHERE id = ?`).bind(user.id)
    .first<{ pass_hash: string; salt: string }>();
  if (!row || !safeEqual(await hashPassword(password, row.salt), row.pass_hash)) {
    await recordLoginFailure(c.env, user.username, ip, true);
    return c.json({ error: "Wrong password.", field: "password" }, 403); // not 401: the app treats 401 as "signed out"
  }
  await clearLoginFailures(c.env, user.username);
  return c.json({ recoveryKey: await issueRecoveryKey(c.env, user.id) });
}

export async function logout(c: Context<AppEnv>) {
  const token = getCookie(c, COOKIE);
  if (token) {
    await ensureSchema(c.env);
    await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
  }
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ success: true });
}

async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = await sha256(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.username, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(hash, now).first<User & { last_seen: number | null }>();
  if (!row) return null;
  c.set("sessionHash", hash);
  // "Last active" for the devices list, written at most once an hour.
  if (!row.last_seen || now - row.last_seen > 3_600_000) {
    await c.env.DB.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).bind(now, hash).run();
  }
  return { id: row.id, username: row.username };
}

/** Requires a signed-in user for every /api route except the auth endpoints. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  await ensureSchema(c.env);
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Please sign in." }, 401);
  c.set("user", user);
  await next();
};

/** Re-confirms the signed-in user's password for sensitive actions (counts toward lockout). */
export async function checkPassword(c: Context<AppEnv>, user: User, password: unknown): Promise<boolean> {
  if (typeof password !== "string" || !password) return false;
  const ip = clientIp(c);
  if (await loginBlocked(c.env, user.username, ip)) return false;
  const row = await c.env.DB.prepare(`SELECT pass_hash, salt FROM users WHERE id = ?`).bind(user.id).first<{ pass_hash: string; salt: string }>();
  const ok = !!row && safeEqual(await hashPassword(password, row.salt), row.pass_hash);
  if (ok) await clearLoginFailures(c.env, user.username);
  else await recordLoginFailure(c.env, user.username, ip, true);
  return ok;
}

export async function me(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const user = await currentUser(c);
  if (user) await devAutoConfirm(c, user.id);
  return user
    ? c.json({ user: { ...user, hasRecoveryKey: await hasRecoveryKey(c.env, user.id), ...(await emailInfo(c.env, user.id)) } })
    : c.json({ user: null }, 401);
}
