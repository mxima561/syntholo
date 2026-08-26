import { requireAcademyAccess } from "@/lib/server/accounts";
import { getPrimaryCourse } from "@/lib/server/courses";
import { getCertificate, hasSchoolPermission, listPendingInvitations, listSeatMembers } from "@syntholo/db";
import { remainingAcademySeats } from "@syntholo/domain";
import { getPurchasesForUser } from "@/lib/server/purchases";
import { revokeInvitationAction, revokeMembershipAction, switchAcademyAction, updateProfileAction } from "@/app/learn/actions";
import { InviteTeammateForm } from "./invite-form";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import type { Route } from "next";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { account, access } = await requireAcademyAccess();
  const course = await getPrimaryCourse();
  const [purchases, certificate, members, invites] = await Promise.all([
    getPurchasesForUser(account.id),
    course ? getCertificate(account.id, course.id) : Promise.resolve(null),
    listSeatMembers(account.accountId),
    listPendingInvitations(account.accountId),
  ]);
  const occupied = access.reservedSeats;
  const remaining = remainingAcademySeats(occupied);
  const seatChangesHeld = access.holds.includes("seat_changes");
  const canManageMembers = hasSchoolPermission(account.membershipRole, "manage_members");

  return (
    <div className="member-page simple-page">
      <span className="eyebrow"><span className="eyebrow-dot" /> Workspace</span>
      <h1>Settings</h1>
      <div className="settings-grid">
        <section>
          <span className="micro-label">Student ID</span>
          <h2><code>{account.publicId}</code></h2>
          <p>Use this ID with support or operations. Internal record {account.id}.</p>
        </section>
        {account.memberships.length > 1 ? (
          <section>
            <span className="micro-label">Active academy</span>
            <h2>Switch workspace</h2>
            <p>You belong to more than one academy account. Switching is validated against your memberships.</p>
            <form action={switchAcademyAction} className="profile-form">
              <label>
                Academy
                <select defaultValue={account.accountId} name="accountId">
                  {account.memberships.map((item) => (
                    <option key={item.accountId} value={item.accountId}>
                      {item.name} · {item.role}
                    </option>
                  ))}
                </select>
              </label>
              <Button size="small" type="submit">Use this academy</Button>
            </form>
          </section>
        ) : null}
        <section>
          <span className="micro-label">Access</span>
          <h2>Academy access</h2>
          <p>
            {access.capabilities.academy_course
              ? "Lifetime course access is active on this account."
              : "Academy access is not active."}
            {access.capabilities.support ? " Support is included." : " The support window is not active."}
          </p>
          {certificate ? <p><Link href={"/learn/certificate" as Route}>Certificate issued {certificate.issuedAt.toLocaleDateString("en-US")}</Link></p> : null}
        </section>
        <section className="settings-span">
          <span className="micro-label">Profile</span>
          <h2>Edit your details</h2>
          <form action={updateProfileAction} className="profile-form">
            <label>First name<input defaultValue={account.firstName} name="firstName" required /></label>
            <label>Last name<input defaultValue={account.lastName} name="lastName" /></label>
            <label>Business name<input defaultValue={account.businessName} name="businessName" /></label>
            <label>Role / title<input defaultValue={account.jobTitle} name="jobTitle" /></label>
            <label>Timezone<input defaultValue={account.timezone} name="timezone" /></label>
            <p>{account.email}</p>
            <Button size="small" type="submit">Save profile</Button>
          </form>
        </section>
        <section className="settings-span">
          <span className="micro-label">Seats</span>
          <h2>Team ({occupied} of 3)</h2>
          <p>
            Academy access is shared by this business account. {remaining === 0
              ? "All three seats are taken."
              : `${remaining} seat${remaining === 1 ? "" : "s"} left.`}
          </p>
          <ul className="seat-list">
            {members.map((member) => (
              <li key={member.id}>
                <span>
                  {member.firstName} {member.lastName} · {member.email} · {member.role}
                  {member.id === account.membershipId ? " (you)" : ""}
                </span>
                {canManageMembers && member.id !== account.membershipId && !seatChangesHeld ? (
                  <form action={revokeMembershipAction}>
                    <input type="hidden" name="membershipId" value={member.id} />
                    <Button size="small" type="submit" variant="secondary">Remove</Button>
                  </form>
                ) : null}
              </li>
            ))}
            {invites.map((invite) => (
              <li key={invite.id}>
                <span>{invite.email} · pending invite</span>
                {canManageMembers && !seatChangesHeld ? (
                  <form action={revokeInvitationAction}>
                    <input type="hidden" name="invitationId" value={invite.id} />
                    <Button size="small" type="submit" variant="secondary">Revoke</Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {seatChangesHeld ? <p>Seat changes are on hold for this account.</p> : null}
          {canManageMembers && remaining > 0 && !seatChangesHeld ? <InviteTeammateForm /> : null}
        </section>
        <section>
          <span className="micro-label">Purchases</span>
          <h2>Billing</h2>
          {purchases.length === 0 ? (
            <p>No paid purchases on this account yet. <Link href="/pricing">See academy offers</Link>.</p>
          ) : purchases.map((purchase) => (
            <p key={purchase.id}>{purchase.offer} · {purchase.status} · {purchase.id.slice(0, 8)}</p>
          ))}
          <Button href="/learn/settings/billing" size="small" variant="secondary">Open billing</Button>
        </section>
      </div>
    </div>
  );
}
