import { format, type Money } from "../util/money.js";
export interface Invoice { orderId: string; total: Money; lines: Array<{ label: string; amount: Money }>; }
export function render(inv: Invoice): string {
  const lines = inv.lines.map((l) => `${l.label}: ${format(l.amount)}`).join("\n");
  return `Invoice for ${inv.orderId}\n${lines}\nTotal: ${format(inv.total)}`;
}
