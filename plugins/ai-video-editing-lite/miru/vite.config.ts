import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), review: resolve(import.meta.dirname, "review.html") } },
  },
  server: { proxy: { "/api": "http://localhost:8790", "/m": "http://localhost:8790", "/auth": "http://localhost:8790", "/mcp": "http://localhost:8790" } },
  test: { include: ["worker/**/*.test.ts", "src/**/*.test.ts"] },
});
