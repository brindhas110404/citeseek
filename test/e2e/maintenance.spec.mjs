import { test, expect } from "@playwright/test";

test("the daily cleanup job runs", async ({ request }) => {
  const r = await request.get("/__scheduled?cron=23+4+*+*+*");
  expect(r.ok()).toBeTruthy();
});

test("browser errors are accepted for logging", async ({ request }) => {
  const r = await request.post("/api/log", { data: { message: "test error", source: "spec", page: "/" } });
  expect(r.status()).toBe(204);
});
