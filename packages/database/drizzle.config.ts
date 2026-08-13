import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";
import { selectMigrationDatabaseUrl } from "./src/migration-config.js";

export default defineConfig({
  dialect: "postgresql",
  schema: fileURLToPath(new URL("./src/schema/index.ts", import.meta.url)),
  out: fileURLToPath(new URL("./drizzle", import.meta.url)),
  dbCredentials: {
    url: selectMigrationDatabaseUrl(process.env),
  },
});
