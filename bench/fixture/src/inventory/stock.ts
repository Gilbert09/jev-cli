const levels = new Map<string, number>();
export function setStock(sku: string, qty: number) { levels.set(sku, qty); }
export function available(sku: string): number { return levels.get(sku) ?? 0; }
export function decrement(sku: string, qty: number) {
  const cur = available(sku);
  if (cur < qty) throw new Error(`insufficient stock for ${sku}`);
  levels.set(sku, cur - qty);
}
