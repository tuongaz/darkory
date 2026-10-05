import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The build goes to dist/app, which embed.go serves when present; the committed dist/index.html
// is the placeholder a binary built without node serves instead.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/app",
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` beside `darkory serve`: same origin for the API, so the cookie rides along.
    proxy: { "/v1": process.env.DARKORY_URL ?? "http://127.0.0.1:7357" },
  },
  test: {
    // The Playwright suite in e2e/ runs against the real binary with `npm run e2e`.
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});
