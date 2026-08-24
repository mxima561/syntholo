import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { requestContextPlugin } from "../plugins/context.js";
import { safeErrorHandler } from "../plugins/error-handler.js";
import { waitlistRoutes } from "./waitlist.js";

describe("waitlist routes", () => {
  const rows = new Map<string, {
    status: "subscribed" | "already-subscribed";
    email: string;
    source: "school";
    createdAt: string;
  }>();

  const waitlist = {
    async subscribe(input: { email: string; source?: string; correlationId: string }) {
      const email = input.email.trim().toLowerCase();
      const existing = rows.get(email);
      if (existing !== undefined) {
        return { ...existing, status: "already-subscribed" as const };
      }
      const record = {
        status: "subscribed" as const,
        email,
        source: "school" as const,
        createdAt: "2026-08-21T22:00:00.000Z",
      };
      rows.set(email, record);
      return record;
    },
    async getByEmail(email: string) {
      const record = rows.get(email.trim().toLowerCase());
      if (record === undefined) return null;
      return { email: record.email, createdAt: record.createdAt, source: record.source };
    },
  };

  beforeEach(() => {
    rows.clear();
  });

  async function app() {
    const instance = Fastify({ logger: false, genReqId: () => "40000000-0000-4000-8000-000000000099" });
    await instance.register(requestContextPlugin);
    instance.setErrorHandler(safeErrorHandler);
    await instance.register(waitlistRoutes, {
      prefix: "/v1",
      webOrigin: "https://app.syntholo.test",
      waitlist,
    });
    return instance;
  }

  it("POSTs an email, persists it, and returns already-subscribed on a duplicate", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/waitlist",
      headers: {
        origin: "https://app.syntholo.test",
        "content-type": "application/json",
      },
      payload: { email: "  Karim@Example.TEST ", source: "school" },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      status: "subscribed",
      email: "karim@example.test",
      createdAt: "2026-08-21T22:00:00.000Z",
      source: "school",
    });
    expect(await waitlist.getByEmail("Karim@Example.TEST")).toEqual({
      email: "karim@example.test",
      source: "school",
      createdAt: "2026-08-21T22:00:00.000Z",
    });

    const duplicate = await instance.inject({
      method: "POST",
      url: "/v1/waitlist",
      headers: {
        origin: "https://app.syntholo.test",
        "content-type": "application/json",
      },
      payload: { email: "KARIM@example.test" },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(JSON.parse(duplicate.payload)).toEqual({
      status: "already-subscribed",
      email: "karim@example.test",
      createdAt: "2026-08-21T22:00:00.000Z",
      source: "school",
    });
    expect(rows.size).toBe(1);
    await instance.close();
  });

  it("rejects a missing origin before writing", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/waitlist",
      headers: { "content-type": "application/json" },
      payload: { email: "owner@example.test" },
    });
    expect(response.statusCode).toBe(403);
    expect(rows.size).toBe(0);
    await instance.close();
  });

  it("rejects an invalid email before writing", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/waitlist",
      headers: { origin: "https://app.syntholo.test", "content-type": "application/json" },
      payload: { email: "not-an-email" },
    });
    expect(response.statusCode).toBe(400);
    expect(rows.size).toBe(0);
    await instance.close();
  });

  it("rejects a non-school source", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/waitlist",
      headers: { origin: "https://app.syntholo.test", "content-type": "application/json" },
      payload: { email: "owner@example.test", source: "homepage" },
    });
    expect(response.statusCode).toBe(400);
    expect(rows.size).toBe(0);
    await instance.close();
  });
});
