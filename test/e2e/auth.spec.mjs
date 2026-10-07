import { test, expect } from "@playwright/test";
import { PASSWORD, offlineAssets, uid } from "./helpers.mjs";

test.beforeEach(async ({ page }) => { await offlineAssets(page); await page.goto("/"); });

test("sign up shows a one-time recovery key, then the app", async ({ page }) => {
  await page.click(".auth-tabs [data-auth-tab=signup]");
  await expect(page.locator("#authPass")).toHaveAttribute("placeholder", "At least 10 characters");
  await page.fill("#authUser", uid("su"));
  await page.fill("#authPass", PASSWORD);
  await page.click("#authSubmit");
  await expect(page.locator("#keyModal")).toBeVisible();
  await expect(page.locator("#keyCode")).toHaveText(/^([A-Z2-9]{5}-){3}[A-Z2-9]{5}$/);
  await expect(page.locator("#keyDone")).toBeDisabled();
  await page.check("#keySaved");
  await page.click("#keyDone");
  await expect(page.locator("#auth")).toBeHidden();
});

test("clear errors for an unknown user and a wrong password", async ({ page }) => {
  const name = uid("err");
  await page.request.post("/api/auth/signup", { data: { username: name, password: PASSWORD } });
  await page.request.post("/api/auth/logout");
  await page.fill("#authUser", uid("nobody"));
  await page.fill("#authPass", PASSWORD);
  await page.click("#authSubmit");
  await expect(page.locator("#authError")).toContainText("No account with that username");
  await page.fill("#authUser", name);
  await page.fill("#authPass", "not-the-password-1");
  await page.click("#authSubmit");
  await expect(page.locator("#authError")).toContainText("Wrong password");
});

test("weak passwords are refused at sign-up", async ({ page }) => {
  const r = await page.request.post("/api/auth/signup", { data: { username: uid("weak"), password: "password123" } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/common/i);
});

test("reset a forgotten password with the recovery key", async ({ page }) => {
  const name = uid("rk");
  const r = await page.request.post("/api/auth/signup", { data: { username: name, password: PASSWORD } });
  const { recoveryKey } = await r.json();
  await page.request.post("/api/auth/logout");
  await page.click("#forgotBtn");
  await page.click("#forgotUseKey");
  await page.fill("#authUser", name);
  await page.fill("#authKey", recoveryKey.toLowerCase().replace(/-/g, " "));
  await page.fill("#authPass", "Brand-new-pass-77");
  await page.click("#authSubmit");
  await expect(page.locator("#keyTitle")).toHaveText("Password changed");
  const login = await page.request.post("/api/auth/login", { data: { username: name, password: "Brand-new-pass-77" } });
  expect(login.ok()).toBeTruthy();
});

test("email reset (local mode: confirmed instantly, link opens directly)", async ({ page }) => {
  const name = uid("em");
  const email = `${name}@example.com`;
  await page.request.post("/api/auth/signup", { data: { username: name, password: PASSWORD, email } });
  await page.request.post("/api/auth/logout");
  await page.click("#forgotBtn");
  await page.fill("#forgotEmail", email);
  await page.click("#forgotSend");
  await expect(page.locator("#authTitle")).toHaveText("Choose a new password");
  await page.fill("#authPass", "Fresh-pass-2026x");
  await page.click("#authSubmit");
  await expect(page.locator("#auth")).toBeHidden();
});
