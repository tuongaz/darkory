import { defineConfig, devices } from "@playwright/test";

// `npm run lab`: the design lab (/dev/design) under `vite dev`, which alone serves it, with no
// Darkory server: the lab draws sample records. Screenshots go to e2e/screenshots/ (gitignored).
const port = 5199;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.lab.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results/lab",
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: "npx vite",
    env: { VITE_PORT: String(port) },
    url: `http://127.0.0.1:${port}/dev/design`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
