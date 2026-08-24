/** HighLevel is an external login only. Syntholo must not hold HighLevel API credentials. */
export async function getHighLevelLocation(): Promise<never> {
  throw new Error("HighLevel is an external login only; Syntholo must not hold HighLevel API credentials.");
}
