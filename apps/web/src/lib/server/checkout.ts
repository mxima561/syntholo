import { loadEffectiveAccess } from "@syntholo/db";
import type { Account } from "@/lib/server/accounts";
import { checkoutContextForAccess, guestCheckoutContext } from "@/lib/commerce/checkout-state";
import type { OfferContext } from "@syntholo/domain";

export async function loadCheckoutContext(account: Account | null): Promise<OfferContext> {
  if (!account) return guestCheckoutContext();
  try {
    const access = await loadEffectiveAccess(account.accountId);
    return checkoutContextForAccess(access);
  } catch {
    return guestCheckoutContext();
  }
}
