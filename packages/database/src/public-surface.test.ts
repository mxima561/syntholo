import * as domainPublic from "@syntholo/domain";
import { describe, expect, it } from "vitest";
import * as databasePublic from "./index.js";

describe("public authority surfaces", () => {
  it("does not export transaction repository constructors", () => {
    type ConstructorIsPrivate = "TransactionEntitlementRepository" extends
      keyof typeof databasePublic ? false : true;
    const constructorIsPrivate: ConstructorIsPrivate = true;
    expect(constructorIsPrivate).toBe(true);
    expect(Object.hasOwn(databasePublic, "TransactionEntitlementRepository"))
      .toBe(false);
  });

  it("does not export the trusted-authentication registry mutator", () => {
    type RegistryIsPrivate = "registerTrustedActorAuthentication" extends
      keyof typeof domainPublic ? false : true;
    const registryIsPrivate: RegistryIsPrivate = true;
    expect(registryIsPrivate).toBe(true);
    expect(Object.hasOwn(domainPublic, "registerTrustedActorAuthentication"))
      .toBe(false);
  });
});
