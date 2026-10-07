import { expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PASSWORD = "Forest-sand-42";
export const uid = (prefix = "t") => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/**
 * Optional: serve CDN scripts from local copies (set CITESEEK_TEST_ASSETS to a folder holding
 * three.min.js, pdf.min.js and pdf.worker.min.js). Only needed where cdnjs is unreachable.
 */
export async function offlineAssets(page) {
  const dir = process.env.CITESEEK_TEST_ASSETS;
  if (!dir) return;
  await page.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/(three\.js|pdf\.js)\/.+\/([\w.]+\.js)$/, (route) => {
    const file = join(dir, route.request().url().split("/").pop());
    return existsSync(file)
      ? route.fulfill({ status: 200, body: readFileSync(file), headers: { "Content-Type": "application/javascript" } })
      : route.continue();
  });
}

/** Text that reads like a research paper (abstract, citations, references) on a given topic. */
export function paperText(topic) {
  const w = topic.split(" ");
  const body = Array.from({ length: 12 }, () =>
    `We study ${topic}. Our ${w[0]} method improves ${w.at(-1)} results on standard ${w[1] || w[0]} benchmarks [1], [2], [3]. ` +
    `Smith et al. 2020 and Lee et al. 2021 studied ${topic} too. Figure 1 shows ${w[0]} trends.`).join(" ");
  return `Abstract\n${body}\n1 Introduction\n${body}\nReferences\n[1] A. Smith et al. 2020. Proceedings of the conference on ${topic}.\n[2] B. Lee et al. 2021. Journal of ${w[0]}.`;
}

export async function signUp(page, username = uid()) {
  const r = await page.request.post("/api/auth/signup", { data: { username, password: PASSWORD } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return username;
}

/** Uploads a paper through the API and waits until it's indexed. Returns its id. */
export async function addPaper(page, title, text = paperText(title.toLowerCase())) {
  const r = await page.request.post("/api/papers", { multipart: { text, title, filename: `${title.slice(0, 20)}.txt` } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const id = (await r.json()).paper.id;
  await expect.poll(async () => (await (await page.request.get(`/api/papers/${id}`)).json()).status, { timeout: 30_000 }).toBe("ready");
  return id;
}

/** Opens the app signed in (cookies come from page.request) and waits for the home screen. */
export async function openApp(page) {
  await offlineAssets(page);
  await page.goto("/");
  await expect(page.locator("#auth")).toBeHidden();
}
