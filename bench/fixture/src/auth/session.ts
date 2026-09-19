import { TOKEN_TTL_HOURS } from "./token.js";
export interface Session { userId: string; issuedAt: Date; }
export function isExpired(s: Session, now: Date): boolean {
  return now.getTime() - s.issuedAt.getTime() > TOKEN_TTL_HOURS * 3_600_000;
}
