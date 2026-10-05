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
    // `make dev` runs this on the Install's usual port (7357) with the server behind it on 7358,
    // so a proxy in front (such as `tailscale serve`) needs no change between dev and a real run.
    // Alone, `npm run dev` listens on 5173 beside a `darkory serve` on 7357.
    host: process.env.VITE_HOST ?? "127.0.0.1",
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    // Vite refuses unknown Host headers; a Tailscale name reaches it through `tailscale serve`.
    allowedHosts: [".ts.net"],
    // Same origin for the API, so the cookie rides along. Host is passed through unchanged, and
    // the server checks a write's Origin against it or DARKORY_PUBLIC_URL.
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
