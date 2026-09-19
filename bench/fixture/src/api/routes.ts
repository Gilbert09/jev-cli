import { createOrder } from "../orders/create.js";
import { cancelOrder } from "../orders/cancel.js";
export const routes = {
  "POST /orders": createOrder,
  "POST /orders/:id/cancel": cancelOrder,
};
