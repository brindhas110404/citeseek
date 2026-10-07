import { test, expect } from "@playwright/test";
import { PASSWORD, addPaper, openApp, signUp } from "./helpers.mjs";
import { readFileSync } from "node:fs";

test("devices: see and sign out other devices", async ({ page, browser, baseURL }) => {
  const name = await signUp(page);
  const phone = await browser.newContext({ baseURL, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1" });
  await phone.request.post("/api/auth/login", { data: { username: name, password: PASSWORD } });
  await openApp(page);
  await page.click("#keyBtn");
  await expect(page.locator("#deviceList")).toContainText("Safari on iPhone");
  await expect(page.locator("#deviceList .this")).toHaveCount(1);
  await page.click("#signOutOthers");
  await expect(page.locator("#deviceList li")).toHaveCount(1);
  expect((await phone.request.get("/api/auth/me")).status()).toBe(401);
  await phone.close();
});

test("download my data includes papers, their text and conversations", async ({ page }) => {
  await signUp(page);
  const id = await addPaper(page, "Exported Paper");
  await page.request.post("/api/chat", { data: { message: "What is it about?", paperId: id } });
  await openApp(page);
  await page.click("#keyBtn");
  const download = page.waitForEvent("download");
  await page.click("#exportBtn");
  const data = JSON.parse(readFileSync(await (await download).path(), "utf8"));
  expect(data.papers[0].title).toBe("Exported Paper");
  expect(data.papers[0].text.length).toBeGreaterThan(500);
  expect(data.conversations[0].messages.length).toBe(2);
});

test("delete account erases everything", async ({ page }) => {
  const name = await signUp(page);
  const id = await addPaper(page, "Doomed Paper");
  await openApp(page);
  await page.click("#keyBtn");
  await page.click("#delAcctBtn");
  await page.fill("#delAcctName", "someone-else");
  await page.fill("#delAcctPass", PASSWORD);
  await page.click("#delAcctGo");
  await expect(page.locator("#delAcctError")).toContainText("Type your username");
  await page.fill("#delAcctName", name);
  await page.click("#delAcctGo");
  await expect(page.locator("#authError")).toContainText("has been deleted");
  const again = await page.request.post("/api/auth/login", { data: { username: name, password: PASSWORD } });
  expect((await again.json()).code).toBe("no_user");
  expect((await page.request.get(`/api/papers/${id}`)).status()).toBe(401);
});
