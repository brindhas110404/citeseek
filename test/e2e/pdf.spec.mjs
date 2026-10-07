import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { offlineAssets } from "./helpers.mjs";

test("two-column PDF: left column first, headers and page numbers removed, hyphens rejoined", async ({ page }) => {
  await offlineAssets(page);
  await page.goto("/");
  await page.waitForFunction(() => window.PdfReader && window.pdfjsLib);
  const b64 = readFileSync("test/fixtures/two-column.pdf").toString("base64");
  const text = await page.evaluate(async (b64) => {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return (await window.PdfReader.extract(new File([buf], "x.pdf"))).text;
  }, b64);
  expect(text.trimStart().startsWith("A Study of Column Reading Order")).toBeTruthy();
  for (const p of [1, 2, 3]) {
    const order = [...text.matchAll(new RegExp(`(LEFT|RIGHT)${p}x(\\d\\d)`, "g"))].map((m) => m[1]);
    expect(order.length).toBe(50);
    expect(order.lastIndexOf("LEFT")).toBeLessThan(order.indexOf("RIGHT"));
  }
  expect(text).not.toContain("Proceedings of the Test Conference");
  expect(text).toContain("transformer");
});
