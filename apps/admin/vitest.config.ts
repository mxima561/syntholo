import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "next/headers": fileURLToPath(new URL("../../node_modules/next/headers.js", import.meta.url)),
      "@syntholo/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
      "@syntholo/auth/config": fileURLToPath(new URL("../../packages/auth/src/config.ts", import.meta.url)),
      "@syntholo/auth/server": fileURLToPath(new URL("../../packages/auth/src/server.ts", import.meta.url)),
      "@syntholo/auth/client": fileURLToPath(new URL("../../packages/auth/src/client.ts", import.meta.url)),
    },
  },
});
