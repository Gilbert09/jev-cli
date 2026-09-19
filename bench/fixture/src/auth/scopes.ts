export type Scope = "orders:read" | "orders:write" | "billing:refund";
export function has(granted: Scope[], needed: Scope): boolean { return granted.includes(needed); }
