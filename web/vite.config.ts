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
    proxy: { "/v1": "http://127.0.0.1:7357" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});
