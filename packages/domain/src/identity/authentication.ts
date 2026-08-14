import type { Actor } from "./actor.js";

const canonicalAuthenticationTimes = new WeakMap<Actor, number | null>();

export function registerTrustedActorAuthentication<T extends Actor>(
  actor: T,
  authenticatedAt: Date | null,
): T {
  if (canonicalAuthenticationTimes.has(actor)) {
    throw new Error("ACTOR_AUTHENTICATION_ALREADY_REGISTERED");
  }
  const timestamp = authenticatedAt instanceof Date
    && Number.isFinite(authenticatedAt.getTime())
    ? authenticatedAt.getTime()
    : null;
  canonicalAuthenticationTimes.set(actor, timestamp);
  return actor;
}

export function trustedActorAuthenticationTime(actor: Actor): number | null {
  return canonicalAuthenticationTimes.has(actor)
    ? canonicalAuthenticationTimes.get(actor) ?? null
    : null;
}
