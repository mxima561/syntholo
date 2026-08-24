import { getReadyDb } from "../src/client";

function bootstrapEmails(): string[] {
  const raw = process.env.STAFF_BOOTSTRAP_EMAILS ?? process.env.ADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

async function main() {
  const emails = bootstrapEmails();
  if (emails.length === 0) {
    console.error("Set STAFF_BOOTSTRAP_EMAILS or ADMIN_EMAILS to a comma-separated list of staff emails.");
    process.exit(1);
  }

  const db = await getReadyDb();
  for (const email of emails) {
    await db`
      INSERT INTO staff (email, role, status)
      VALUES (${email}, 'admin', 'active')
      ON CONFLICT (email) DO NOTHING
    `;
    console.log(`staff ready: ${email}`);
  }
  await db.end({ timeout: 5 });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
