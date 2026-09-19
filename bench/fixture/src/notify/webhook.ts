import { withRetry } from "../util/retry.js";
import { sign } from "../auth/token.js";
/** Outbound webhooks are signed so the receiver can verify provenance. */
export async function deliver(url: string, event: unknown, secret: string) {
  const body = JSON.stringify(event);
  await withRetry(async () => {
    const res = await fetch(url, { method: "POST", headers: { "x-signature": sign(body, secret) }, body });
    if (!res.ok) throw Object.assign(new Error("delivery failed"), { status: res.status });
  });
}
