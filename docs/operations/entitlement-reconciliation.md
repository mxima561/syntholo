# Entitlement commerce reconciliation

Task 8 never drops an authoritative provider money event merely because access
cannot be granted safely. Suspended or held accounts, product-slot conflicts,
source-identity collisions, and linked Academy/Club dispositions create an
append-only `commerce_reconciliations` work item with a 48-hour review deadline.
The original payment/receipt remains immutable, no parked item grants access or
starts Business OS provisioning, and `entitlements.reconciliation_required.v1`
enters the durable worker receipt lane without closing the work item.

## Authority and visibility

Only a Cloudflare Access staff actor with role `admin`, permission
`entitlements:manage`, and recent authentication may list, claim, or resolve
these records. Coaches, members, worker jobs, and the signed-provider system
login have no raw table access. Never copy provider identifiers, token material,
customer PII, or free-form customer data into logs, tickets, or event payloads;
use the admin-only projection and correlation/reconciliation IDs.

The queue is account-scoped and ordered by `reviewDueAt`, then ID. Normal review
uses the closed UnitOfWork repository commands:

1. List `open` and `claimed` items; prioritize any item at or past its 48-hour
   deadline.
2. Claim one exact reconciliation ID with a fresh command ID.
3. Compare the immutable provider event and source fingerprint to the provider
   dashboard without changing its target account or source.
4. Resolve through an action allowed for that incident kind. Record a bounded
   reason and, where required, Stripe's exact millisecond paid-through instant.
5. Confirm its status is terminal and that only its own holds were released.
   Separate incidents for the same source remain independently actionable.

## Incident and resolution matrix

| Incident kind | Meaning | Permitted disposition |
| --- | --- | --- |
| `parked_paid_receipt` | A valid payment was retained with zero grants because current account, hold, parent, or singleton state blocked fulfillment. | Fulfill through the dedicated product/setup reconciliation command after every precondition and hold is clear, or use `refund`. A lost dispute/refund terminalizes the receipt and prevents later fulfillment. |
| `provider_source_collision` | The same immutable provider identity arrived with a different account, target, offer, or fingerprint. | `manual` only after the external provider action is complete; never reparent or mutate the existing product source. |
| `linked_academy_refund` | An Academy refund is pending disposition of every linked nonterminal Club billing obligation. | `club_cancelled` with the authoritative paid-through instant, `club_refunded`, or `abort_refund`. Academy refund finalizes only when all child obligations are dispositioned. |
| `linked_club_cancellation` | An Academy dispute terminalized access while a separate Club billing obligation still needs provider cancellation/refund. | `club_cancelled` with the authoritative paid-through instant or `club_refunded`; the Club's distinct financial receipt is never falsely marked as losing the Academy dispute. |

An exact redelivery of a resolved provider event returns the stored terminal
incident and does not create another alert. A genuinely new provider event gets a
new fingerprint and work item. `abort_refund` closes only the parent refund
request; any original parked Club payment remains open until it receives its own
financial disposition. Ordinary denied entitlement commands emit no outbox;
provider money conflicts are instead applied reconciliation mutations so the
queue, decision, audit, and alert commit atomically.

## Failure and escalation

- If claim or resolution returns a typed denial, leave the item open/claimed,
  inspect the reason, and correct the provider/current-state mismatch. Do not
  perform raw SQL updates.
- If the 48-hour deadline is missed, page the commerce operations owner and the
  on-call engineering owner with only the reconciliation ID and correlation ID.
- If provider truth cannot be established, keep access/provisioning blocked and
  choose the provider refund/manual-action path. Never manufacture fulfillment.
- A worker handler receipt proves durable delivery only; it is not evidence that
  a human resolution occurred. The queue row remains the source of operational
  truth until a terminal `resolved_*` state commits.
