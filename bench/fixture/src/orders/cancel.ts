import { canTransition, type OrderState } from "./lifecycle.js";
import { isRefundable, refund } from "../billing/refund.js";
export async function cancelOrder(o: { id: string; state: OrderState; chargeId?: string; chargedAt?: Date }, now: Date) {
  if (!canTransition(o.state, "cancelled")) throw new Error(`cannot cancel from ${o.state}`);
  if (o.chargeId && o.chargedAt && isRefundable(o.chargedAt, now)) await refund(o.chargeId, 0);
  return { ...o, state: "cancelled" as const };
}
