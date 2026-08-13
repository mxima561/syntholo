import { defineConfig } from "drizzle-kit";
import { selectMigrationDatabaseUrl } from "./src/migration-config.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: selectMigrationDatabaseUrl(process.env),
  },
});
