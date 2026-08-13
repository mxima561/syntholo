import type { MemberActor, StaffActor } from "@syntholo/domain";
import { minute } from "../clock.js";

export const memberActor = (
  patch: Partial<MemberActor> = {},
): MemberActor => ({
  kind: "member",
  actorId: "actor_member",
  clerkUserId: "user_member",
  accountId: "account_1",
  membershipId: "membership_1",
  role: "owner",
  authenticatedAt: minute(0),
  ...patch,
});

export const staffActor = (patch: Partial<StaffActor> = {}): StaffActor => ({
  kind: "staff",
  actorId: "actor_staff",
  workosUserId: "workos_user_staff",
  staffId: "staff_1",
  role: "coach",
  permissions: ["content:publish"],
  authenticatedAt: minute(0),
  ...patch,
});
