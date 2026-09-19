import { multiply, type Money } from "../util/money.js";
/** VAT is applied at the order level, never per line, to avoid rounding drift. */
export const VAT_RATE = 0.2;
export function withVat(subtotal: Money): Money { return subtotal + multiply(subtotal, VAT_RATE); }
