"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { inviteTeammateAction, type InviteState } from "@/app/learn/actions";

const initial: InviteState = {};

export function InviteTeammateForm() {
  const [state, formAction, pending] = useActionState(inviteTeammateAction, initial);
  return (
    <form action={formAction} className="profile-form">
      <label>
        Teammate email
        <input name="email" type="email" required placeholder="ops@example.com" />
      </label>
      <Button size="small" type="submit" disabled={pending}>
        {pending ? "Creating invite…" : "Create invite link"}
      </Button>
      {state.error ? <p>{state.error}</p> : null}
      {state.inviteUrl ? (
        <p>
          Share this link (shown once): <code>{state.inviteUrl}</code>
        </p>
      ) : null}
    </form>
  );
}
