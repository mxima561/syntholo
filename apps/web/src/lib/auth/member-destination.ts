/** Academy home after a successful member sign-in or sign-up. */
export const MEMBER_HOME_PATH = "/learn" as const;

export function memberHomeUrl(origin = typeof window === "undefined" ? "" : window.location.origin): string {
  return `${origin}${MEMBER_HOME_PATH}`;
}

export function goToMemberHome(): void {
  window.location.assign(MEMBER_HOME_PATH);
}
