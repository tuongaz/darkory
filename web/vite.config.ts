import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Sonner, Radix Select's viewport, Radix ScrollArea, and react-style-singleton under Radix's
 * scroll lock add <style> elements at run time, which the Install's Content-Security-Policy
 * (style-src 'self') refuses and reports as errors. Their CSS is in globals.css instead, so the
 * build (and Vitest, which inlines these packages to run them through this) turns the injection
 * off. A patch that no longer matches its package fails rather than letting the errors back.
 */
const stylePatches: { file: string; from: RegExp; to: string }[] = [
  { file: "/sonner/dist/index.mjs", from: /if \(!code \|\| typeof document == 'undefined'\) return/, to: "return" },
  { file: "/react-style-singleton/dist/es2015/singleton.js", from: /if \(counter == 0\) \{/, to: "if (false) {" },
  // jsx("style", { dangerouslySetInnerHTML: { __html: `[data-radix-…-viewport]{…}` }, nonce }) → null
  {
    file: "/@radix-ui/react-select/dist/index.mjs",
    from: /jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*`\[data-radix-select-viewport\][^`]*`\s*\},\s*nonce\s*\}\s*\)/,
    to: "null",
  },
  {
    file: "/@radix-ui/react-scroll-area/dist/index.mjs",
    from: /jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*`\[data-radix-scroll-area-viewport\][^`]*`\s*\},\s*nonce\s*\}\s*\)/,
    to: "null",
  },
];

function noInjectedStyles(): Plugin {
  return {
    name: "darkory:no-injected-styles",
    transform(code, id) {
      const patch = stylePatches.find((p) => id.split("?")[0].endsWith(p.file));
      if (!patch) return;
      const found = code.match(new RegExp(patch.from.source, "g"))?.length ?? 0;
      if (found !== 1) this.error(`${patch.file} no longer injects styles as expected (${found} matches); update noInjectedStyles`);
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
    // Run the packages stylePatches changes, and those that import them, through Vite, so the
    // tests see what the build ships. Vitest would take the scroll lock's CommonJS builds, which
    // load each other outside Vite; their ES builds are what the app bundles.
    server: {
      deps: { inline: ["sonner", "radix-ui", /@radix-ui\//, "react-remove-scroll", "react-remove-scroll-bar", "react-style-singleton"] },
    },
    alias: ["react-remove-scroll", "react-remove-scroll-bar", "react-style-singleton"].map((pkg) => ({
      find: new RegExp(`^${pkg}$`),
      replacement: `${pkg}/dist/es2015/index.js`,
    })),
    restoreMocks: true,
  },
});
