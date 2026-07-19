// Minimal file-backed order store.
//
// This shop has no database, so confirmed orders are appended to orders.json.
// It is deliberately simple and single-process; swap this module for real
// database calls if the shop grows beyond one server.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ordersPath = join(dirname(fileURLToPath(import.meta.url)), "orders.json");

function readOrders() {
  if (!existsSync(ordersPath)) return [];
  try {
    return JSON.parse(readFileSync(ordersPath, "utf8"));
  } catch {
    return [];
  }
}

export function findOrderBySessionId(sessionId) {
  return readOrders().find(o => o.sessionId === sessionId);
}

// Keyed on the Checkout Session ID so a webhook redelivery — which Stripe does
// on any non-2xx response — updates the existing order instead of duplicating it.
export function recordOrder(order) {
  const orders = readOrders();
  const index = orders.findIndex(o => o.sessionId === order.sessionId);
  if (index === -1) orders.push(order);
  else orders[index] = { ...orders[index], ...order };
  writeFileSync(ordersPath, JSON.stringify(orders, null, 2) + "\n");
  return order;
}
