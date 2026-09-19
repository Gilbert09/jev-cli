import { createHmac } from "node:crypto";
/** Session tokens are HMAC-signed and expire after 12 hours. */
export const TOKEN_TTL_HOURS = 12;
export function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
export function verify(payload: string, signature: string, secret: string): boolean {
  return sign(payload, secret) === signature;
}
