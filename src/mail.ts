import type { Env } from "./types";

/**
 * Sends one email. Supported senders, in order:
 *  1. Cloudflare Email Service: a `send_email` binding named EMAIL (needs a domain on
 *     Cloudflare and the Workers Paid plan).
 *  2. Brevo: BREVO_API_KEY secret, free for 300 emails a day. EMAIL_FROM must be a sender
 *     address you've verified in Brevo (a Gmail address works; no domain needed).
 *  3. Neither: nothing is sent. The message is printed to the `npm run dev` terminal, and the
 *     caller may show the link on screen when running on localhost.
 */
export type MailResult = { sent: boolean; via: "cloudflare" | "brevo" | "console" };

export const mailConfigured = (env: Env) => !!env.EMAIL || (!!env.BREVO_API_KEY && !!env.EMAIL_FROM);

export async function sendMail(
  env: Env,
  msg: { to: string; subject: string; text: string; html: string }
): Promise<MailResult> {
  const from = env.EMAIL_FROM || "no-reply@citeseek.app";
  if (env.EMAIL) {
    await env.EMAIL.send({ to: msg.to, from: { email: from, name: "CiteSeek" }, subject: msg.subject, html: msg.html, text: msg.text });
    return { sent: true, via: "cloudflare" };
  }
  if (env.BREVO_API_KEY && env.EMAIL_FROM) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY.trim(), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "CiteSeek", email: from },
        to: [{ email: msg.to }],
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      let reason = body.slice(0, 300);
      try { reason = JSON.parse(body).message || reason; } catch {}
      throw new Error(`Brevo refused the email (${res.status}): ${reason}`);
    }
    return { sent: true, via: "brevo" };
  }
  console.log(`\n✉  [email not sent: no email service configured]\n   To: ${msg.to}\n   Subject: ${msg.subject}\n\n${msg.text.replace(/^/gm, "   ")}\n`);
  return { sent: false, via: "console" };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain, client-safe email: one message, one button, the link spelled out as a fallback. */
export function linkEmail(o: { heading: string; intro: string; button: string; link: string; footer: string }) {
  const text = `${o.heading}\n\n${o.intro}\n\n${o.button}: ${o.link}\n\n${o.footer}\n\n- CiteSeek`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3ede0;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d2a23">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;background:#fbf8f2;border:1px solid #e6dcc8;border-radius:14px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 28px 24px">
<div style="font-family:Georgia,serif;font-size:20px;font-weight:600;color:#2e5a43;margin-bottom:18px">CiteSeek</div>
<h1 style="font-family:Georgia,serif;font-weight:500;font-size:22px;margin:0 0 10px">${esc(o.heading)}</h1>
<p style="font-size:15px;line-height:1.55;margin:0 0 22px;color:#3b4a41">${esc(o.intro)}</p>
<a href="${esc(o.link)}" style="display:inline-block;background:#2e5a43;color:#fbf8f2;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">${esc(o.button)}</a>
<p style="font-size:12.5px;line-height:1.5;color:#6d786f;margin:22px 0 0">Button not working? Paste this into your browser:<br><span style="word-break:break-all;color:#2e5a43">${esc(o.link)}</span></p>
<p style="font-size:12.5px;line-height:1.5;color:#6d786f;margin:14px 0 0">${esc(o.footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}
