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
 *
 * xterm.js (the Session panel's terminal) writes CSS it computes at run time (the theme, the cell
 * size) into three <style> elements, and a truecolor cell's colour into a style attribute. Its
 * <style> elements become `darkoryStyleSheet`: an element that renders nothing and puts what is
 * written to it into a constructed stylesheet the document adopts, and its style attributes are
 * written through the CSSOM. The policy allows both.
 */
const stylePatches: { file: string; from: RegExp; to: string; count?: number; prelude?: string }[] = [
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
  // The Viewport's scrollbar colours and the DOM renderer's theme and cell size:
  // `this._document.createElement("style")` → `darkoryStyleSheet(this._document)`.
  {
    file: "/@xterm/xterm/lib/xterm.mjs",
    from: /([\w$]+(?:\.[\w$]+)*)\.createElement\("style"\)/,
    to: "darkoryStyleSheet($1)",
    count: 3,
    prelude: `function darkoryStyleSheet(doc) {
  const el = doc.createElement("template");
  let text = "";
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    sheet = undefined;
  }
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set: (v) => {
      text = String(v);
      sheet?.replaceSync(text);
    },
  });
  const remove = el.remove.bind(el);
  el.remove = () => {
    if (sheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
    remove();
  };
  return el;
}
`,
  },
  // A truecolor cell: `_addStyle(t,e){t.setAttribute("style",`${t.getAttribute("style")||""}${e};`)}`.
  {
    file: "/@xterm/xterm/lib/xterm.mjs",
    from: /_addStyle\(([\w$]+),([\w$]+)\)\{\1\.setAttribute\("style",`\$\{\1\.getAttribute\("style"\)\|\|""\}\$\{\2\};`\)\}/,
    to: '_addStyle($1,$2){$1.style.cssText+=$2+";"}',
  },
];

function noInjectedStyles(): Plugin {
  return {
    name: "darkory:no-injected-styles",
    transform(code, id) {
      const patches = stylePatches.filter((p) => id.split("?")[0].endsWith(p.file));
      if (patches.length === 0) return;
      for (const patch of patches) {
        const all = new RegExp(patch.from.source, "g");
        const found = code.match(all)?.length ?? 0;
        if (found !== (patch.count ?? 1)) this.error(`${patch.file} no longer injects styles as expected (${found} matches); update noInjectedStyles`);
        code = (patch.prelude ?? "") + code.replace(all, patch.to);
      }
      return code;
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
    // the server checks a write's Origin against it or DARKORY_PUBLIC_URL. `ws` carries the
    // Session panel's terminal (a WebSocket under /v1/runner).
    proxy: { "/v1": { target: process.env.DARKORY_URL ?? "http://127.0.0.1:7357", ws: true } },
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
      deps: {
        inline: ["sonner", "radix-ui", /@radix-ui\//, "react-remove-scroll", "react-remove-scroll-bar", "react-style-singleton", "@xterm/xterm"],
      },
    },
    alias: [
      ...["react-remove-scroll", "react-remove-scroll-bar", "react-style-singleton"].map((pkg) => ({
        find: new RegExp(`^${pkg}$`),
        replacement: `${pkg}/dist/es2015/index.js`,
      })),
      // Its ES build, which the app bundles and stylePatches changes; Vitest would take lib/xterm.js.
      { find: /^@xterm\/xterm$/, replacement: "@xterm/xterm/lib/xterm.mjs" },
    ],
    restoreMocks: true,
  },
});
