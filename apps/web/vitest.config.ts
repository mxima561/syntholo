import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    { find: "@syntholo/auth/config", replacement: fileURLToPath(new URL("../../packages/auth/src/config.ts", import.meta.url)) },
    { find: "@syntholo/auth/server", replacement: fileURLToPath(new URL("../../packages/auth/src/server.ts", import.meta.url)) },
    { find: "@syntholo/auth/client", replacement: fileURLToPath(new URL("../../packages/auth/src/client.ts", import.meta.url)) },
    { find: "@syntholo/auth/neon", replacement: fileURLToPath(new URL("../../packages/auth/src/neon.ts", import.meta.url)) },
    { find: "@syntholo/db", replacement: fileURLToPath(new URL("../../packages/db/src", import.meta.url)) },
    { find: "@syntholo/domain", replacement: fileURLToPath(new URL("../../packages/domain/src", import.meta.url)) },
    { find: "@syntholo/contracts", replacement: fileURLToPath(new URL("../../packages/contracts/src", import.meta.url)) },
    ],
  },
});

