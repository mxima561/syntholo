/** Academy home after a successful member sign-in or sign-up. */
export const MEMBER_HOME_PATH = "/learn" as const;
export const RESET_PASSWORD_PATH = "/reset-password" as const;
export const SIGN_IN_PATH = "/signin" as const;

export function memberHomeUrl(origin = typeof window === "undefined" ? "" : window.location.origin): string {
  return `${origin}${MEMBER_HOME_PATH}`;
}

export function resetPasswordUrl(origin = typeof window === "undefined" ? "" : window.location.origin): string {
  return `${origin}${RESET_PASSWORD_PATH}`;
}

export function goToMemberHome(): void {
  window.location.assign(MEMBER_HOME_PATH);
}
