import type { Money } from "../util/money.js";
import { withRetry } from "../util/retry.js";

/**
 * Refund window.
 *
 * A refund is accepted up to 90 days after the charge. Beyond that the payment
 * provider rejects it and the finance team has to issue a manual credit note,
 * so we fail fast here rather than surfacing a provider error to the customer.
 */
export const REFUND_WINDOW_DAYS = 90;

export function isRefundable(chargedAt: Date, now: Date): boolean {
  const ageDays = (now.getTime() - chargedAt.getTime()) / 86_400_000;
  return ageDays <= REFUND_WINDOW_DAYS;
}

export async function refund(chargeIdValue: string, amount: Money): Promise<void> {
  await withRetry(async () => {
    const res = await fetch(`https://payments.internal/v1/charges/${chargeIdValue}/refunds`, {
      method: "POST", body: JSON.stringify({ amount }),
    });
    if (!res.ok) throw Object.assign(new Error("refund failed"), { status: res.status });
  });
}
