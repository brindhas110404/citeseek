import type { Context } from "hono";
import type { AppEnv } from "./auth";
import { hashPassword, randomHex, safeEqual, sha256, startSession } from "./auth";
import { ensureSchema } from "./db";
import { clearLoginFailures, clientIp, loginBlocked, passwordProblem, rateLimited, recordLoginFailure, verifyTurnstile } from "./guard";
import { linkEmail, mailConfigured, sendMail } from "./mail";
import type { Env } from "./types";

/**
 * Email-based password reset:
 *  - An account can have one email (optional). It must be confirmed via an emailed link
 *    before reset links are sent to it, so a typo can never hand someone else your account.
 *  - "Forgot password" takes an email and always answers the same way, so it can't be used to
 *    find out whose email has an account.
 *  - Links are single-use; reset links last 30 minutes, confirmation links 24 hours.
 */
const MIN = 60_000;
const RESET_TTL = 30 * MIN;
const VERIFY_TTL = 24 * 60 * MIN;

export const emailProblem = (email: string): string | null =>
  email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? "That doesn't look like an email address." : null;

const appOrigin = (c: Context<AppEnv>) => (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, "");
const isLocal = (c: Context<AppEnv>) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname);
/** On localhost with no email service, hand the link back so you can test without email. */
const devLinkOk = (c: Context<AppEnv>) => isLocal(c) && !mailConfigured(c.env);

/** Why an email failed: the real reason on localhost (for you), a plain message for everyone else. */
const failMessage = (c: Context<AppEnv>, err: unknown) =>
  isLocal(c) ? String((err as Error)?.message || err) : "The email couldn't be sent right now. Please try again in a few minutes.";

type EmailRow = { email: string; verified_at: number | null };

/** Local dev without an email service: confirm an address that was saved before auto-confirm existed. */
export async function devAutoConfirm(c: Context<AppEnv>, userId: string) {
  if (!devLinkOk(c)) return;
  const row = await c.env.DB.prepare(`SELECT email, verified_at FROM user_emails WHERE user_id = ?`).bind(userId).first<EmailRow>();
  if (row && !row.verified_at && !(await verifiedByOther(c.env, row.email, userId))) {
    await c.env.DB.prepare(`UPDATE user_emails SET verified_at = ? WHERE user_id = ?`).bind(Date.now(), userId).run();
  }
}

export async function emailInfo(env: Env, userId: string) {
  const row = await env.DB.prepare(`SELECT email, verified_at FROM user_emails WHERE user_id = ?`).bind(userId).first<EmailRow>();
  return { email: row?.email ?? null, emailVerified: !!row?.verified_at };
}

export async function verifiedByOther(env: Env, email: string, userId: string) {
  return !!(await env.DB.prepare(`SELECT 1 FROM user_emails WHERE LOWER(email) = LOWER(?) AND verified_at IS NOT NULL AND user_id != ?`)
    .bind(email, userId).first());
}

async function issueToken(env: Env, userId: string, purpose: "verify" | "reset", email: string, ttl: number) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.batch([
    // one live link per purpose: a newer email replaces the older link
    env.DB.prepare(`UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL`).bind(now, userId, purpose),
    env.DB.prepare(`INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(await sha256(token), userId, purpose, email, now + ttl),
  ]);
  if (Math.random() < 0.05) await env.DB.prepare(`DELETE FROM email_tokens WHERE expires_at < ?`).bind(now - 7 * 24 * 60 * MIN).run();
  return token;
}

async function findToken(env: Env, token: unknown, purpose: "verify" | "reset") {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT t.token_hash, t.user_id, t.email, t.expires_at, t.used_at, u.username
     FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.purpose = ?`
  ).bind(await sha256(token), purpose).first<{ token_hash: string; user_id: string; email: string; expires_at: number; used_at: number | null; username: string }>();
}

const tokenError = (t: { expires_at: number; used_at: number | null } | null, what: string) =>
  !t ? `This ${what} link isn't valid. Check you copied all of it, or request a new one.`
    : t.used_at ? `This ${what} link was already used or replaced by a newer one. Request a new one if you need it.`
      : t.expires_at < Date.now() ? `This ${what} link has expired. Request a new one.`
        : null;

/** Saves (or replaces) a user's email as unconfirmed and emails a confirmation link. */
export async function setUserEmail(c: Context<AppEnv>, userId: string, username: string, email: string) {
  const env = c.env;
  email = email.toLowerCase();
  // Running on your own computer with no email service: there's nothing to send, so confirm it now.
  if (devLinkOk(c) && !(await verifiedByOther(env, email, userId))) {
    await env.DB.prepare(
      `INSERT INTO user_emails (user_id, email, verified_at, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, verified_at = excluded.verified_at, created_at = excluded.created_at`
    ).bind(userId, email, Date.now(), Date.now()).run();
    return { verified: true, sent: false, devAuto: true };
  }
  const current = await env.DB.prepare(`SELECT email, verified_at FROM user_emails WHERE user_id = ?`).bind(userId).first<EmailRow>();
  if (current && current.email.toLowerCase() === email.toLowerCase() && current.verified_at) return { verified: true, sent: false };
  await env.DB.prepare(
    `INSERT INTO user_emails (user_id, email, verified_at, created_at) VALUES (?, ?, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, verified_at = NULL, created_at = excluded.created_at`
  ).bind(userId, email, Date.now()).run();
  const token = await issueToken(env, userId, "verify", email, VERIFY_TTL);
  const link = `${appOrigin(c)}/?verify=${token}`;
  let mailError: string | undefined;
  const { sent } = await sendMail(env, {
    to: email,
    subject: "Confirm your email for CiteSeek",
    ...linkEmail({
      heading: "Confirm your email",
      intro: `Confirm this address for the CiteSeek account "${username}" so you can reset your password by email if you ever forget it.`,
      button: "Confirm email",
      link,
      footer: "This link works once and expires in 24 hours. If you didn't create a CiteSeek account, ignore this email and nothing will happen.",
    }),
  }).catch((err) => { console.error("Email failed:", err); mailError = failMessage(c, err); return { sent: false }; });
  return { verified: false, sent, ...(mailError ? { mailError } : {}), ...(devLinkOk(c) ? { devLink: link } : {}) };
}

// ---------------- Routes ----------------

/** POST /api/auth/forgot { email } → emails a reset link if a confirmed account uses it. */
export async function forgotPassword(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const { email, turnstileToken } = await c.req.json<{ email?: string; turnstileToken?: string }>().catch(() => ({} as { email?: string; turnstileToken?: string }));
  const ip = clientIp(c);
  const addr = typeof email === "string" ? email.trim() : "";
  const bad = emailProblem(addr);
  if (bad) return c.json({ error: bad, field: "email" }, 400);
  if (!(await verifyTurnstile(c.env, turnstileToken, ip))) {
    return c.json({ error: "Please complete the human check and try again.", code: "turnstile" }, 400);
  }
  const waitIp = await rateLimited(c.env, `fp:${ip}`, 10, 60 * MIN);
  const waitEmail = waitIp ? null : await rateLimited(c.env, `fe:${addr.toLowerCase()}`, 3, 60 * MIN);
  const wait = waitIp ?? waitEmail;
  if (wait) return c.json({ error: `Too many reset requests. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`, code: "rate_limited" }, 429);

  // Confirmed accounts first; addresses are matched ignoring case.
  const row = await c.env.DB.prepare(
    `SELECT e.user_id, e.email, e.verified_at, u.username FROM user_emails e JOIN users u ON u.id = e.user_id
     WHERE LOWER(e.email) = LOWER(?) ORDER BY e.verified_at IS NULL LIMIT 1`
  ).bind(addr).first<{ user_id: string; email: string; verified_at: number | null; username: string }>();

  let devLink: string | undefined;
  let mailError: string | undefined;
  if (row && !row.verified_at) {
    // The address is on an account but was never confirmed, so a reset link can't go to it yet
    // (it might be a typo for someone else's address). Send the confirmation link instead, and
    // say why, rather than sending nothing. The page shows the same message either way.
    const token = await issueToken(c.env, row.user_id, "verify", row.email, VERIFY_TTL);
    const link = `${appOrigin(c)}/?verify=${token}`;
    await sendMail(c.env, {
      to: row.email,
      subject: "Confirm your email to reset your CiteSeek password",
      ...linkEmail({
        heading: "Confirm your email first",
        intro: `Someone (hopefully you) asked to reset the password for the CiteSeek account "${row.username}", but this address hasn't been confirmed yet, so we can't send a reset link to it. Confirm it with the button below, then use "Forgot password?" again.`,
        button: "Confirm email",
        link,
        footer: "This link works once and expires in 24 hours. If you didn't ask for this, ignore this email and nothing will change. You can also reset your password with your recovery key.",
      }),
    }).catch((err) => { console.error("Email failed:", err); if (isLocal(c)) mailError = failMessage(c, err); });
    if (devLinkOk(c)) devLink = link;
  } else if (row) {
    const token = await issueToken(c.env, row.user_id, "reset", addr, RESET_TTL);
    const link = `${appOrigin(c)}/?reset=${token}`;
    await sendMail(c.env, {
      to: addr,
      subject: "Reset your CiteSeek password",
      ...linkEmail({
        heading: "Reset your password",
        intro: `Someone (hopefully you) asked to reset the password for the CiteSeek account "${row.username}". Choose a new one with the button below.`,
        button: "Choose a new password",
        link,
        footer: "This link works once and expires in 30 minutes. If you didn't ask for this, ignore this email; your password won't change.",
      }),
    }).catch((err) => { console.error("Email failed:", err); if (isLocal(c)) mailError = failMessage(c, err); });
    if (devLinkOk(c)) devLink = link;
  }
  // Same answer whether or not the address has an account.
  return c.json({ ok: true, minutes: RESET_TTL / MIN, ...(devLink ? { devLink } : {}), ...(mailError ? { mailError } : {}), ...(devLinkOk(c) ? { devMode: true } : {}) });
}

/** POST /api/auth/reset-token { token } → whose password the link resets (to show on the form). */
export async function checkResetToken(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const { token } = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  const t = await findToken(c.env, token, "reset");
  const err = tokenError(t, "reset");
  return err ? c.json({ error: err }, 400) : c.json({ username: t!.username });
}

/** POST /api/auth/reset-link { token, password } → sets the new password and signs in. */
export async function resetWithLink(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const { token, password } = await c.req.json<{ token?: string; password?: string }>().catch(() => ({} as { token?: string; password?: string }));
  const t = await findToken(c.env, token, "reset");
  const err = tokenError(t, "reset");
  if (err) return c.json({ error: err, code: "bad_link" }, 400);
  const badPass = passwordProblem(String(password ?? ""), t!.username);
  if (badPass) return c.json({ error: badPass, field: "password" }, 400);
  const salt = randomHex(16);
  const now = Date.now();
  const res = await c.env.DB.batch([
    // claim the token first; if another request already used it, changes = 0
    c.env.DB.prepare(`UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).bind(now, t!.token_hash),
  ]);
  if (!res[0].meta.changes) return c.json({ error: tokenError({ ...t!, used_at: now }, "reset"), code: "bad_link" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?`).bind(await hashPassword(password!, salt), salt, t!.user_id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(t!.user_id),
    c.env.DB.prepare(`UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL`).bind(now, t!.user_id),
  ]);
  await clearLoginFailures(c.env, t!.username);
  await startSession(c, t!.user_id);
  const hasKey = !!(await c.env.DB.prepare(`SELECT 1 FROM recovery_keys WHERE user_id = ?`).bind(t!.user_id).first());
  return c.json({ user: { id: t!.user_id, username: t!.username, hasRecoveryKey: hasKey, ...(await emailInfo(c.env, t!.user_id)) } });
}

/** POST /api/auth/verify-email { token } → confirms the address. Works signed in or out. */
export async function verifyEmail(c: Context<AppEnv>) {
  await ensureSchema(c.env);
  const { token } = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  const t = await findToken(c.env, token, "verify");
  const err = tokenError(t, "confirmation");
  if (err) return c.json({ error: err }, 400);
  if (await verifiedByOther(c.env, t!.email, t!.user_id)) {
    return c.json({ error: "That email is already confirmed on another CiteSeek account." }, 409);
  }
  const now = Date.now();
  const r = await c.env.DB.prepare(`UPDATE user_emails SET verified_at = ? WHERE user_id = ? AND LOWER(email) = LOWER(?)`).bind(now, t!.user_id, t!.email).run();
  await c.env.DB.prepare(`UPDATE email_tokens SET used_at = ? WHERE token_hash = ?`).bind(now, t!.token_hash).run();
  if (!r.meta.changes) return c.json({ error: "This link is for an email you've since changed. Use the newest confirmation email." }, 400);
  return c.json({ ok: true, email: t!.email, username: t!.username });
}

/** Tells the old (confirmed) address that the account's email was changed or removed. */
async function notifyOldEmail(c: Context<AppEnv>, oldEmail: string, username: string, newEmail: string | null) {
  const masked = newEmail ? newEmail.replace(/^(.)[^@]*(@.*)$/, "$1•••$2") : null;
  const { text, html } = linkEmail({
    heading: newEmail ? "Your CiteSeek email was changed" : "Your CiteSeek email was removed",
    intro: newEmail
      ? `The email on the CiteSeek account "${username}" was just changed from this address to ${masked}. Password reset links will go there from now on.`
      : `This address was just removed from the CiteSeek account "${username}". Password reset links won't be sent here any more.`,
    button: "Open CiteSeek",
    link: appOrigin(c),
    footer: "If you made this change, you can ignore this email. If you didn't, sign in and change your password, or use your recovery key.",
  });
  await sendMail(c.env, { to: oldEmail, subject: "Your CiteSeek email was changed", text, html }).catch((err) => console.error("Email failed:", err));
}

/** POST /api/account/email { email, password } → add, change or (with "") remove your email. */
export async function updateEmail(c: Context<AppEnv>) {
  const user = c.get("user");
  const { email, password } = await c.req.json<{ email?: string; password?: string }>().catch(() => ({} as { email?: string; password?: string }));
  const ip = clientIp(c);
  if (typeof password !== "string" || !password) return c.json({ error: "Enter your password.", field: "password" }, 400);
  const blocked = await loginBlocked(c.env, user.username, ip);
  if (blocked) return c.json({ error: blocked, code: "rate_limited" }, 429);
  const row = await c.env.DB.prepare(`SELECT pass_hash, salt FROM users WHERE id = ?`).bind(user.id).first<{ pass_hash: string; salt: string }>();
  if (!row || !safeEqual(await hashPassword(password, row.salt), row.pass_hash)) {
    await recordLoginFailure(c.env, user.username, ip, true);
    return c.json({ error: "Wrong password.", field: "password" }, 403); // not 401: the app treats 401 as "signed out"
  }
  await clearLoginFailures(c.env, user.username);
  const addr = typeof email === "string" ? email.trim() : "";
  const previous = await c.env.DB.prepare(`SELECT email, verified_at FROM user_emails WHERE user_id = ?`).bind(user.id).first<EmailRow>();
  if (!addr) {
    await c.env.DB.prepare(`DELETE FROM user_emails WHERE user_id = ?`).bind(user.id).run();
    if (previous?.verified_at) c.executionCtx.waitUntil(notifyOldEmail(c, previous.email, user.username, null));
    return c.json({ email: null, emailVerified: false });
  }
  const bad = emailProblem(addr);
  if (bad) return c.json({ error: bad, field: "email" }, 400);
  if (await verifiedByOther(c.env, addr, user.id)) return c.json({ error: "That email is already used by another account.", field: "email" }, 409);
  const wait = await rateLimited(c.env, `ve:${user.id}`, 5, 60 * MIN);
  if (wait) return c.json({ error: `Too many confirmation emails. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`, code: "rate_limited" }, 429);
  const r = await setUserEmail(c, user.id, user.username, addr);
  if (previous?.verified_at && previous.email.toLowerCase() !== addr.toLowerCase()) {
    c.executionCtx.waitUntil(notifyOldEmail(c, previous.email, user.username, addr));
  }
  return c.json({ email: addr, emailVerified: r.verified, sent: r.sent, ...("mailError" in r ? { mailError: r.mailError } : {}), ...("devLink" in r ? { devLink: r.devLink } : {}) });
}

/** POST /api/account/email/resend → sends the confirmation link again. */
export async function resendVerification(c: Context<AppEnv>) {
  const user = c.get("user");
  const info = await emailInfo(c.env, user.id);
  if (!info.email) return c.json({ error: "Add an email first." }, 400);
  if (info.emailVerified) return c.json({ ...info });
  const wait = await rateLimited(c.env, `ve:${user.id}`, 5, 60 * MIN);
  if (wait) return c.json({ error: `Too many confirmation emails. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`, code: "rate_limited" }, 429);
  const r = await setUserEmail(c, user.id, user.username, info.email);
  return c.json({ ...info, emailVerified: r.verified, sent: r.sent, ...("mailError" in r ? { mailError: r.mailError } : {}), ...("devLink" in r ? { devLink: r.devLink } : {}) });
}
