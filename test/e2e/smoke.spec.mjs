import { test, expect } from "@playwright/test";
import { offlineAssets, openApp, signUp } from "./helpers.mjs";

test("pages load with no script errors (signed out and signed in)", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await offlineAssets(page);
  await page.goto("/");
  await expect(page.locator("#auth")).toBeVisible();
  await signUp(page);
  await openApp(page);
  await page.click("#keyBtn");
  await expect(page.locator("#acctModal")).toBeVisible();
  expect(errors).toEqual([]);
});
