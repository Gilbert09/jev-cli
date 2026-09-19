export interface Reservation { sku: string; qty: number; expiresAt: Date; }
/** Reservations are held for 15 minutes, then swept by the reaper. */
export const HOLD_MINUTES = 15;
export function reserve(sku: string, qty: number, now: Date): Reservation {
  return { sku, qty, expiresAt: new Date(now.getTime() + HOLD_MINUTES * 60_000) };
}
