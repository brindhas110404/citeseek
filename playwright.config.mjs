// End-to-end tests: `npm test`. They run the whole app offline (test/mock-entry.ts fakes Workers AI
// and Vectorize) in a real browser. First time on a machine: `npx playwright install chromium`.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.CITESEEK_TEST_PORT || 8791);

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1360, height: 900 },
    // The globe needs WebGL; headless Chromium provides it through SwiftShader.
    launchOptions: { args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `npx wrangler dev -c test/wrangler.mock.toml --test-scheduled --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
  },
});
