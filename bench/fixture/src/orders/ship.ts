import { canTransition, type OrderState } from "./lifecycle.js";
export function markShipped(o: { state: OrderState }, tracking: string) {
  if (!canTransition(o.state, "shipped")) throw new Error("not payable yet");
  return { ...o, state: "shipped" as const, tracking };
}
