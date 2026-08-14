import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionMemberAccess } from "./production-member-access";

const useAuth = vi.hoisted(() => vi.fn());

vi.mock("@clerk/react", () => ({ useAuth }));

const memberActor = {
  kind: "member",
  actorId: "10000000-0000-4000-8000-000000000001",
  clerkUserId: "user_clerk_1",
  accountId: "20000000-0000-4000-8000-000000000002",
  membershipId: "30000000-0000-4000-8000-000000000003",
  role: "owner",
  authenticatedAt: "2026-08-14T12:00:00.000Z",
} as const;

const memberAccess = {
  accountId: memberActor.accountId,
  capabilities: {
    academy_course: true,
    support: true,
    circle_write: true,
    operator_club: false,
    business_os: false,
  },
  holds: [],
  seatLimit: 3,
  reservedSeats: 1,
  explanations: [
    { capability: "academy_course", sourceGrantIds: ["40000000-0000-4000-8000-000000000004"] },
    { capability: "support", sourceGrantIds: ["50000000-0000-4000-8000-000000000005"] },
    { capability: "circle_write", sourceGrantIds: ["60000000-0000-4000-8000-000000000006"] },
    { capability: "operator_club", sourceGrantIds: [] },
    { capability: "business_os", sourceGrantIds: [] },
  ],
} as const;

function signedIn(fetcher: typeof fetch) {
  useAuth.mockReturnValue({
    getToken: vi.fn(async () => "clerk-session-token"),
    isLoaded: true,
    isSignedIn: true,
    sessionId: "session_clerk_1",
  });
  vi.stubGlobal("fetch", fetcher);
}

afterEach(() => {
  useAuth.mockReset();
  vi.unstubAllGlobals();
});

describe("ProductionMemberAccess", () => {
  it("offers the local sign-in route after Clerk reports a signed-out browser", () => {
    useAuth.mockReturnValue({
      getToken: vi.fn(),
      isLoaded: true,
      isSignedIn: false,
      sessionId: null,
    });

    render(<ProductionMemberAccess />);

    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Member sign in" })).toHaveAttribute(
      "href",
      "/sign-in",
    );
  });

  it("does not invent an account when Clerk is signed in but the member API has no actor", async () => {
    signedIn(vi.fn(async () => new Response(null, { status: 401 })));

    render(<ProductionMemberAccess />);

    expect(await screen.findByRole("heading", { name: "Account not provisioned" }))
      .toBeInTheDocument();
    expect(screen.queryByText(/Maria Chen|Northstar Advisory/u)).not.toBeInTheDocument();
  });

  it("shows authorized access only after both identity and entitlement APIs approve it", async () => {
    const responses = [
      new Response(JSON.stringify(memberActor), { status: 200 }),
      new Response(JSON.stringify(memberAccess), { status: 200 }),
    ];
    signedIn(vi.fn(async () => responses.shift() as Response));

    render(<ProductionMemberAccess />);

    expect(await screen.findByRole("heading", { name: "Academy access confirmed" }))
      .toBeInTheDocument();
    expect(screen.queryByText(/Maria Chen|Northstar Advisory/u)).not.toBeInTheDocument();
  });

  it("does not treat a real account without course entitlement as authorized", async () => {
    const responses = [
      new Response(JSON.stringify(memberActor), { status: 200 }),
      new Response(JSON.stringify({
        ...memberAccess,
        capabilities: { ...memberAccess.capabilities, academy_course: false },
        explanations: memberAccess.explanations.map((explanation) =>
          explanation.capability === "academy_course"
            ? { ...explanation, sourceGrantIds: [] }
            : explanation),
      }), { status: 200 }),
    ];
    signedIn(vi.fn(async () => responses.shift() as Response));

    render(<ProductionMemberAccess />);

    expect(await screen.findByRole("heading", { name: "Academy access required" }))
      .toBeInTheDocument();
  });

  it("fails closed when the member API cannot resolve access", async () => {
    signedIn(vi.fn(async () => new Response(null, { status: 503 })));

    render(<ProductionMemberAccess />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Access temporarily unavailable" }))
        .toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Academy access confirmed" }))
      .not.toBeInTheDocument();
  });
});
