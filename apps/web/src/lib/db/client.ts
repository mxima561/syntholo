import { getReadyDb as connectReadyDb } from "@syntholo/db";
import { asAcademyUnavailable } from "./unavailable";

export { getDb } from "@syntholo/db";
export type { DatabaseClient } from "@syntholo/db";

export async function getReadyDb() {
  try {
    return await connectReadyDb();
  } catch (error) {
    throw asAcademyUnavailable(error);
  }
}
