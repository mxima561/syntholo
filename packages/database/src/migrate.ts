import { createDatabase } from "./client.js";
import { selectMigrationDatabaseUrl } from "./migration-config.js";
import { migrateDatabase } from "./migrations.js";

const database = createDatabase({
  applicationName: "syntholo-migrations",
  url: selectMigrationDatabaseUrl(process.env),
});

try {
  await migrateDatabase(database);
} finally {
  await database.close();
}
