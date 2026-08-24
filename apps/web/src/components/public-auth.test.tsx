import { Children, isValidElement, type FunctionComponent, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { PublicSignIn, PublicSignUp } from "./public-auth";

function unwrap(tree: ReactElement) {
  const type = tree.type as FunctionComponent<Record<string, unknown>>;
  const rendered = type(tree.props as Record<string, unknown>);
  if (!isValidElement(rendered)) {
    throw new Error("auth frame did not render");
  }
  return rendered;
}

function clerkChild(tree: ReactElement) {
  const main = unwrap(tree);
  const card = (main.props as { children: unknown }).children;
  const nodes = isValidElement(card) ? Children.toArray((card.props as { children: unknown }).children) : [];
  const clerk = nodes.find((node) => isValidElement(node) && typeof (node.props as { path?: string }).path === "string");
  if (!isValidElement(clerk)) {
    throw new Error("missing Clerk child");
  }
  return clerk.props as Record<string, unknown>;
}

function hrefs(tree: ReactElement) {
  const main = unwrap(tree);
  const card = (main.props as { children: unknown }).children;
  const nodes = isValidElement(card) ? Children.toArray((card.props as { children: unknown }).children) : [];
  return nodes
    .filter(isValidElement)
    .map((node) => (node.props as { href?: string }).href)
    .filter((href): href is string => typeof href === "string");
}

describe("public auth routing", () => {
  it("keeps sign-up navigation on the local embedded route", () => {
    expect(clerkChild(PublicSignIn())).toMatchObject({
      path: "/sign-in",
      routing: "path",
      signUpUrl: "/sign-up",
      fallbackRedirectUrl: "/learn",
    });
  });

  it("keeps sign-in navigation on the local embedded route", () => {
    expect(clerkChild(PublicSignUp())).toMatchObject({
      path: "/sign-up",
      routing: "path",
      signInUrl: "/sign-in",
      fallbackRedirectUrl: "/learn",
    });
  });

  it("centers the sign-in card with a home/waitlist path", () => {
    const tree = PublicSignIn();
    expect((unwrap(tree).props as { className?: string }).className).toContain("public-auth-page");
    expect(hrefs(tree)).toEqual(["/", "/"]);
  });
});
