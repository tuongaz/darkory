import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Sonner, and react-style-singleton under Radix's scroll lock, add <style> elements at run time,
 * which the Install's Content-Security-Policy (style-src 'self') refuses and reports as errors.
 * Their CSS is in globals.css instead, so the build turns the injection off. A patch that no
 * longer matches its package fails the build rather than letting the errors back.
 */
function noInjectedStyles(): Plugin {
  const patches = [
    { file: "/sonner/dist/index.mjs", from: "if (!code || typeof document == 'undefined') return", to: "return" },
    { file: "/react-style-singleton/dist/es2015/singleton.js", from: "if (counter == 0) {", to: "if (false) {" },
  ];
  return {
    name: "darkory:no-injected-styles",
    apply: "build",
    transform(code, id) {
      const patch = patches.find((p) => id.split("?")[0].endsWith(p.file));
      if (!patch) return;
      if (!code.includes(patch.from)) this.error(`${patch.file} no longer injects styles as expected; update noInjectedStyles`);
      return code.replace(patch.from, patch.to);
    },
  };
}

// The build goes to dist/app, which embed.go serves when present; the committed dist/index.html
// is the placeholder a binary built without node serves instead.
export default defineConfig({
  plugins: [react(), tailwindcss(), noInjectedStyles()],
  // `@/` is src/, as components.json tells the shadcn CLI.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
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
