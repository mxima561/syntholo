export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return;

  try {
    const { getReadyDb } = await import("@/lib/db/client");
    await getReadyDb();
    console.log("[syntholo] database ready: schema verified, curriculum seeded");
  } catch (error) {
    console.warn(
      "[syntholo] database bootstrap failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
