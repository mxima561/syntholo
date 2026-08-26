"use client";

import { useEffect, useState } from "react";
import { authClient } from "@syntholo/auth/client";
import { Button } from "@/components/ui/button";
import { MEMBER_HOME_PATH } from "@/lib/auth/member-destination";

function sessionHasUser(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const payload = "data" in result ? (result as { data?: unknown }).data : result;
  if (!payload || typeof payload !== "object") return false;
  const user = "user" in payload ? (payload as { user?: unknown }).user : null;
  return Boolean(user && typeof user === "object");
}

export function MemberEntryCta({ size = "small" }: { size?: "small" | "medium" | "large" }) {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authClient
      .getSession()
      .then((result) => {
        if (!cancelled) setSignedIn(sessionHasUser(result));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (signedIn) {
    return (
      <Button href={MEMBER_HOME_PATH} size={size} variant="quiet">
        Go to academy
      </Button>
    );
  }

  return (
    <Button href="/signin" size={size} variant="quiet">
      Member sign in
    </Button>
  );
}
