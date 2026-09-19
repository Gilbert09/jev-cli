import { randomUUID } from "node:crypto";
export const orderId = () => `ord_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const chargeId = () => `chg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
