export type OrderState = "draft" | "reserved" | "paid" | "shipped" | "cancelled";
const ALLOWED: Record<OrderState, OrderState[]> = {
  draft: ["reserved", "cancelled"],
  reserved: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: [],
  cancelled: [],
};
export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED[from].includes(to);
}
