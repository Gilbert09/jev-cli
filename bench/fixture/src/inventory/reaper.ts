import type { Reservation } from "./reserve.js";
export function sweep(reservations: Reservation[], now: Date): Reservation[] {
  return reservations.filter((r) => r.expiresAt > now);
}
