export type MemberActor = Readonly<{
  kind: "member";
  actorId: string;
  clerkUserId: string;
  accountId: string;
  membershipId: string;
  role: "owner" | "teammate";
  authenticatedAt: Date;
}>;

export type StaffActor = Readonly<{
  kind: "staff";
  actorId: string;
  workosUserId: string;
  staffId: string;
  role: "coach" | "admin";
  permissions: readonly string[];
  authenticatedAt: Date;
}>;

export type Actor = MemberActor | StaffActor;
