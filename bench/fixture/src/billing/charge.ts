import { withRetry } from "../util/retry.js";
import type { Money } from "../util/money.js";
import { chargeId } from "../util/ids.js";

export interface ChargeRequest { customerId: string; amount: Money; idempotencyKey: string; }
export interface Charge { id: string; status: "succeeded" | "failed"; amount: Money; }

export async function charge(req: ChargeRequest): Promise<Charge> {
  return withRetry(async () => {
    const res = await fetch("https://payments.internal/v1/charges", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": req.idempotencyKey },
      body: JSON.stringify({ customer: req.customerId, amount: req.amount }),
    });
    if (!res.ok) throw Object.assign(new Error("charge failed"), { status: res.status });
    return { id: chargeId(), status: "succeeded", amount: req.amount };
  });
}
