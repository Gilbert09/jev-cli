import { orderId } from "../util/ids.js";
import { withVat } from "../billing/tax.js";
import type { Money } from "../util/money.js";
export interface Line { sku: string; qty: number; unitPrice: Money; }
export function createOrder(customerId: string, lines: Line[]) {
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
  return { id: orderId(), customerId, lines, total: withVat(subtotal), state: "draft" as const };
}
