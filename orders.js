// Order store, backed by SQLite (see db.js).
//
// Confirmed Checkout Sessions land in the `orders` table, with one `order_items`
// row per glaze so fulfillment can see exactly what to pull and pack without
// re-parsing a metadata string. Replaces the old orders.json flat file.
import { db, parseGlazes } from "./db.js";

const findBySession = db.prepare("SELECT * FROM orders WHERE stripe_session_id = ?");

export function findOrderBySessionId(sessionId) {
  return findBySession.get(sessionId);
}

const upsertInsert = db.prepare(
  `INSERT INTO orders
     (stripe_session_id, payment_intent_id, customer_id, email,
      amount_total, currency, payment_status, glazes, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const upsertUpdate = db.prepare(
  `UPDATE orders SET
     payment_intent_id = ?, customer_id = ?, email = ?, amount_total = ?,
     currency = ?, payment_status = ?, glazes = ?,
     created_at = COALESCE(?, created_at)
   WHERE stripe_session_id = ?`
);
const deleteItems = db.prepare("DELETE FROM order_items WHERE order_id = ?");
const insertItem = db.prepare(
  `INSERT INTO order_items (order_id, product_code, product_name, unit_price_cents, qty)
   VALUES (?, ?, ?, ?, ?)`
);
const productByCode = db.prepare("SELECT name, price_cents FROM products WHERE code = ?");

// Keyed on the Checkout Session ID so a webhook redelivery — which Stripe does
// on any non-2xx response — updates the existing order and rebuilds its line
// items instead of duplicating them.
export const recordOrder = db.transaction(order => {
  const existing = findBySession.get(order.sessionId);
  let orderId;

  if (existing) {
    upsertUpdate.run(
      order.paymentIntentId ?? null,
      order.customerId ?? null,
      order.email ?? null,
      order.amountTotal ?? null,
      order.currency ?? null,
      order.paymentStatus ?? null,
      order.glazes ?? null,
      order.createdAt ?? null,
      order.sessionId
    );
    orderId = existing.id;
  } else {
    const info = upsertInsert.run(
      order.sessionId,
      order.paymentIntentId ?? null,
      order.customerId ?? null,
      order.email ?? null,
      order.amountTotal ?? null,
      order.currency ?? null,
      order.paymentStatus ?? null,
      order.glazes ?? null,
      order.createdAt ?? null
    );
    orderId = info.lastInsertRowid;
  }

  deleteItems.run(orderId);
  for (const it of parseGlazes(order.glazes)) {
    const prod = productByCode.get(it.code);
    insertItem.run(orderId, it.code, prod?.name ?? null, prod?.price_cents ?? null, it.qty);
  }

  return order;
});
