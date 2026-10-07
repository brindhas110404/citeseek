import { test, expect } from "@playwright/test";
import { addPaper, openApp, paperText, signUp } from "./helpers.mjs";
import { readFileSync } from "node:fs";

test("ask a paper a question and open the cited passage", async ({ page }) => {
  await signUp(page);
  const id = await addPaper(page, "Attention Transformer Models");
  await openApp(page);
  await page.click(`.paper[data-id="${id}"]`);
  await page.fill("#chatInput", "What is attention?");
  await page.keyboard.press("Enter");
  const cite = page.locator(".msg.assistant .cite:not(.cite-brief)").first();
  await expect(cite).toBeVisible();
  await cite.click();
  await expect(page.locator("#drawer")).toHaveClass(/open/);
  await expect(page.locator("#drawerTitle")).toHaveText("Attention Transformer Models");
});

test("whole-library questions search only the most relevant papers", async ({ page }) => {
  await signUp(page);
  const topics = ["protein folding structure", "galaxy formation dark matter", "robot grasping control", "speech recognition acoustics",
    "graph neural molecules", "diffusion image synthesis", "federated learning privacy", "machine translation languages",
    "causal inference treatment", "quantum error correction"];
  for (const t of topics) await addPaper(page, t.replace(/\b\w/g, (c) => c.toUpperCase()));
  const res = await page.request.post("/api/chat", { data: { message: "How does quantum error correction work?" } });
  const meta = JSON.parse(/event: meta\ndata: (.*)/.exec(await res.text())[1]);
  expect(meta.sources.map((s) => s.title)).toContain("Quantum Error Correction");
  const papers = (await (await page.request.get("/api/papers")).json()).papers;
  expect(papers.every((p) => p.paperVec)).toBeTruthy();
});

test("a non-paper is flagged, and Add anyway still adds it", async ({ page }) => {
  await signUp(page);
  await page.emulateMedia({ reducedMotion: "reduce" }); // plain upload form instead of the basketball court
  await openApp(page);
  await page.setInputFiles("#fileInput", { name: "resume.txt", mimeType: "text/plain", buffer: Buffer.from(readFileSync("test/fixtures/resume.txt", "utf8").repeat(2)) });
  await page.click("#uploadBtn");
  const toast = page.locator(".toast", { hasText: "not a research paper" });
  await expect(toast).toBeVisible();
  await toast.locator(".toast-action").click();
  await expect(page.locator(".paper")).toHaveCount(1);
});

test("archive, delete and restore papers and conversations", async ({ page }) => {
  await signUp(page);
  const id = await addPaper(page, "Archive Me Please");
  await page.request.post("/api/chat", { data: { message: "first question", paperId: id } });
  await page.request.post("/api/chat", { data: { message: "second question", paperId: id } });
  await openApp(page);
  const row = page.locator(`.paper[data-id="${id}"]`);
  await row.locator("[data-toggle]").click();
  const chats = page.locator(`.paper[data-id="${id}"] + .chat-list [data-chat]`);
  await expect(chats).toHaveCount(2);
  await chats.first().hover();
  await chats.first().locator("[data-chat-arc]").click();
  await expect(chats).toHaveCount(1);
  await chats.first().hover();
  await chats.first().locator("[data-chat-del]").click();
  await expect(page.locator("#archiveCount")).toHaveText("1");
  await expect(page.locator("#trashCount")).toHaveText("1");
  await page.click("#navTrash");
  await expect(page.locator(".chat-tag")).toContainText("Archive Me Please");
  await page.locator("[data-chat-restore]").first().click();
  await expect(page.locator("#trashCount")).toHaveText("");
  await page.click("#homeBtn");
  await row.hover();
  await row.locator("[data-del]").click();
  await page.click("#navTrash");
  await expect(page.locator(`[data-forever="${id}"]`)).toBeVisible();
  await page.click(`[data-forever="${id}"]`);
  await page.click(`[data-forever="${id}"]`);
  await expect(page.locator(`[data-forever="${id}"]`)).toHaveCount(0);
  expect((await page.request.get(`/api/papers/${id}`)).status()).toBe(404);
});
