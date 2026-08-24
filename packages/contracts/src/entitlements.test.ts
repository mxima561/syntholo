import { describe, expect, it } from "vitest";
import {
  MemberAccessQuerySchema,
  MemberAccessResponseSchema,
} from "./entitlements";

const response = {
  accountId: "10000000-0000-4000-8000-000000000001",
  capabilities: {
    academy_course: true,
    support: false,
    circle_write: false,
    operator_club: false,
    business_os: false,
  },
  holds: ["commerce"],
  seatLimit: 3,
  reservedSeats: 1,
  explanations: [
    {
      capability: "academy_course",
      sourceGrantIds: ["10000000-0000-4000-8000-000000000011"],
    },
    { capability: "support", sourceGrantIds: [] },
    { capability: "circle_write", sourceGrantIds: [] },
    { capability: "operator_club", sourceGrantIds: [] },
    { capability: "business_os", sourceGrantIds: [] },
  ],
};

describe("member access contracts", () => {
  it("accepts only an empty query object", () => {
    expect(MemberAccessQuerySchema.parse({})).toEqual({});
    expect(() => MemberAccessQuerySchema.parse({ accountId: response.accountId }))
      .toThrow();
    expect(() => MemberAccessQuerySchema.parse({ unknown: "value" })).toThrow();
  });

  it("parses the exact canonical response", () => {
    expect(MemberAccessResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts every evaluator-valid additive source without an arbitrary cap", () => {
    const sourceGrantIds = Array.from({ length: 65 }, (_value, index) =>
      `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
    const candidate = {
      ...response,
      explanations: response.explanations.map((explanation, index) =>
        index === 0 ? { ...explanation, sourceGrantIds } : explanation),
    };
    expect(MemberAccessResponseSchema.parse(candidate)).toEqual(candidate);
  });

  it.each([
    ["internal top-level data", { ...response, internalVersion: 1 }],
    ["internal explanation data", {
      ...response,
      explanations: response.explanations.map((value, index) =>
        index === 0 ? { ...value, sourceId: "secret" } : value),
    }],
    ["wrong capability order", {
      ...response,
      explanations: [response.explanations[1], response.explanations[0],
        ...response.explanations.slice(2)],
    }],
    ["noncanonical source ordering", {
      ...response,
      explanations: response.explanations.map((value, index) => index === 0
        ? { ...value, sourceGrantIds: [
          "20000000-0000-4000-8000-000000000012",
          "10000000-0000-4000-8000-000000000011",
        ] }
        : value),
    }],
    ["duplicate holds", { ...response, holds: ["commerce", "commerce"] }],
    ["seat overflow", { ...response, reservedSeats: 4 }],
    ["true capability without a source", {
      ...response,
      explanations: response.explanations.map((value, index) => index === 0
        ? { ...value, sourceGrantIds: [] }
        : value),
    }],
    ["false capability with a source", {
      ...response,
      explanations: response.explanations.map((value, index) => index === 1
        ? { ...value, sourceGrantIds: ["20000000-0000-4000-8000-000000000012"] }
        : value),
    }],
    ["one grant contributing to two capabilities", {
      ...response,
      capabilities: { ...response.capabilities, support: true },
      explanations: response.explanations.map((value, index) => index === 1
        ? { ...value, sourceGrantIds: response.explanations[0]!.sourceGrantIds }
        : value),
    }],
  ])("rejects %s", (_case, candidate) => {
    expect(() => MemberAccessResponseSchema.parse(candidate)).toThrow();
  });
});
