import { test, expect } from "@playwright/test";
import { openApp, signUp } from "./helpers.mjs";

// Needs a built atlas (npm run atlas:build, or the mock build described in the README).
test.beforeEach(async ({ page }) => {
  const r = await page.request.get("/atlas/points.json");
  test.skip(!r.ok(), "No paper atlas built");
  await signUp(page);
  await openApp(page);
  await expect(page.locator("#atlas")).toHaveClass(/ready/, { timeout: 40_000 });
});

test("loads light: no big title file up front, search finds papers", async ({ page }) => {
  const fetched = [];
  page.on("request", (r) => fetched.push(r.url()));
  await page.fill("#atlas .atlas-search input", "learning");
  await expect(page.locator("#atlas .atlas-results button").first()).toBeVisible();
  expect(fetched.some((u) => u.endsWith("/atlas/titles.json"))).toBeFalsy();
});

test("keyboard: spin, open the centre paper, close it", async ({ page }) => {
  await page.focus("#atlas .atlas-canvas");
  for (const k of ["ArrowLeft", "ArrowUp", "+", "+"]) await page.keyboard.press(k);
  await page.keyboard.press("Enter");
  await expect(page.locator("#atlas .atlas-card")).toBeVisible();
  await expect(page.locator("#atlas .card-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#atlas .atlas-card")).toBeHidden();
});

test("regions dropdown lists every region and adds up to the total", async ({ page }) => {
  const data = await (await page.request.get("/atlas/points.json")).json();
  await page.click("#atlas .legend-toggle");
  const rows = page.locator("#atlas .legend-row");
  await expect(rows).toHaveCount(data.subfields.length + 1);
  expect(data.subfields.reduce((n, s) => n + s.count, 0)).toBe(data.count);
  await rows.nth(1).click();
  await expect(page.locator("#atlas .legend-toggle")).toContainText(data.subfields[0].name);
});
