import { describe, expect, it, vi } from "vitest";
import {
  AcademyUnavailableError,
  asAcademyUnavailable,
  isAcademyUnavailableError,
} from "./unavailable";

const getReadyDbImpl = vi.hoisted(() => vi.fn());

vi.mock("@syntholo/db", () => ({
  getDb: vi.fn(),
  getReadyDb: getReadyDbImpl,
}));

describe("AcademyUnavailableError", () => {
  it("wraps bootstrap failures without exposing vendor internals", async () => {
    getReadyDbImpl.mockRejectedValue(new Error("DATABASE_URL is not configured"));
    const { getReadyDb } = await import("./client");
    const error = await getReadyDb().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcademyUnavailableError);
    expect((error as Error).message).toBe("Academy is temporarily unavailable.");
    expect((error as Error).message).not.toMatch(/Northstar|maria@northstar/i);
  });

  it("preserves an already typed unavailable error", () => {
    const original = new AcademyUnavailableError();
    expect(asAcademyUnavailable(original)).toBe(original);
    expect(isAcademyUnavailableError(original)).toBe(true);
  });
});
