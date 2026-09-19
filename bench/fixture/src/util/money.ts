/** Money is minor units (pence/cents) throughout. Never floats. */
export type Money = number;

export function add(a: Money, b: Money): Money { return a + b; }
export function multiply(a: Money, factor: number): Money { return Math.round(a * factor); }
export function format(a: Money, currency = "GBP"): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(a / 100);
}
