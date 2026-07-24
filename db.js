// SQLite-backed data layer for the shop.
//
// Replaces the old static trio — public/products.js (catalog), stripe-prices.json
// (Stripe IDs) and orders.json (order records) — with one on-disk database
// (shop.db). The catalog is seeded once from public/products.js so there is still
// a checked-in source of truth to bootstrap from, but after the first run the
// database is authoritative and can change at runtime without a redeploy.
//
// Deliberately synchronous (better-sqlite3) and single-process, matching the
// shop's scale. Swap the connection for a client/server database if it grows
// beyond one node.
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRODUCTS, SERIES_NAMES } from "./catalog.js";

const rootDir = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || join(rootDir, "shop.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const nowIso = () => new Date().toISOString();

// ── Schema ────────────────────────────────────────────────────────────
// `IF NOT EXISTS` makes this safe to run on every startup; it only creates
// tables the first time.
db.exec(`
  CREATE TABLE IF NOT EXISTS series (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS products (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    code               TEXT UNIQUE NOT NULL,
    name               TEXT NOT NULL,
    series_code        TEXT NOT NULL REFERENCES series(code),
    color              TEXT,
    price_cents        INTEGER NOT NULL,
    image_url          TEXT,
    in_stock           INTEGER NOT NULL DEFAULT 1,
    is_new             INTEGER NOT NULL DEFAULT 0,
    is_active          INTEGER NOT NULL DEFAULT 1,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    stripe_product_id  TEXT,
    stripe_price_id    TEXT,
    stripe_price_cents INTEGER,
    created_at         TEXT,
    updated_at         TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id  TEXT UNIQUE NOT NULL,
    payment_intent_id  TEXT,
    customer_id        TEXT,
    email              TEXT,
    amount_total       INTEGER,
    currency           TEXT,
    payment_status     TEXT,
    fulfillment_status TEXT NOT NULL DEFAULT 'pending',
    glazes             TEXT,
    created_at         TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_code     TEXT NOT NULL,
    product_name     TEXT,
    unit_price_cents INTEGER,
    qty              INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

// ── Shared helpers ────────────────────────────────────────────────────
// The checkout metadata packs a cart as "C-05×2, PC-20×1". Both the live
// webhook and the legacy-order import parse it back into line items.
export function parseGlazes(glazes) {
  if (!glazes) return [];
  return glazes
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const [code, qtyRaw] = part.split("×");
      const qty = parseInt(qtyRaw, 10);
      return { code: (code || "").trim(), qty: Number.isInteger(qty) && qty > 0 ? qty : 1 };
    })
    .filter(it => it.code);
}

// Maps a DB row to the exact shape the browser catalog used to ship as globals,
// so the front end keeps working with { code, name, series, color, price, img,
// outOfStock, isNew }. Optional flags are omitted when falsey, as before.
function toClientProduct(row) {
  const p = {
    code: row.code,
    name: row.name,
    series: row.series_code,
    color: row.color,
    price: row.price_cents / 100,
  };
  if (row.image_url) p.img = row.image_url;
  if (!row.in_stock) p.outOfStock = true;
  if (row.is_new) p.isNew = true;
  return p;
}

// ── Catalog reads ─────────────────────────────────────────────────────
export function getCatalog() {
  return db
    .prepare(
      `SELECT code, name, series_code, color, price_cents, image_url, in_stock, is_new
       FROM products WHERE is_active = 1
       ORDER BY sort_order, code`
    )
    .all()
    .map(toClientProduct);
}

export function getSeriesMap() {
  const map = {};
  for (const r of db.prepare("SELECT code, name FROM series ORDER BY sort_order, code").all()) {
    map[r.code] = r.name;
  }
  return map;
}

// Authoritative record used to price a checkout line. Prices and stock always
// come from here, never from anything the browser sends.
export function getProductForCheckout(code) {
  return db
    .prepare(
      `SELECT code, name, price_cents, in_stock, is_active, stripe_price_id
       FROM products WHERE code = ?`
    )
    .get(code);
}

export function getStock(code) {
  return db.prepare("SELECT code, name, in_stock FROM products WHERE code = ?").get(code);
}

export function getOutOfStock() {
  return db
    .prepare("SELECT code, name FROM products WHERE in_stock = 0 ORDER BY sort_order, code")
    .all();
}

// Returns the number of rows changed — 0 means no glaze had that code.
export function setStock(code, inStock) {
  return db
    .prepare("UPDATE products SET in_stock = ?, updated_at = ? WHERE code = ?")
    .run(inStock ? 1 : 0, nowIso(), code).changes;
}

export function countPricedProducts() {
  return db
    .prepare("SELECT COUNT(*) AS c FROM products WHERE is_active = 1 AND stripe_price_id IS NOT NULL")
    .get().c;
}

// ── Stripe sync support ───────────────────────────────────────────────
export function getAllProducts() {
  return db
    .prepare(
      `SELECT id, code, name, series_code, color, price_cents, image_url,
              in_stock, is_new, is_active, stripe_product_id, stripe_price_id, stripe_price_cents
       FROM products ORDER BY sort_order, code`
    )
    .all();
}

export function setStripeIds(code, { productId, priceId, priceCents }) {
  db.prepare(
    `UPDATE products
     SET stripe_product_id = ?, stripe_price_id = ?, stripe_price_cents = ?, updated_at = ?
     WHERE code = ?`
  ).run(productId, priceId, priceCents, nowIso(), code);
}

// ── Seeding ───────────────────────────────────────────────────────────
function readStripePrices() {
  const path = join(rootDir, "stripe-prices.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function seedCatalog() {
  const stripePrices = readStripePrices();
  const now = nowIso();

  const insertSeries = db.prepare(
    "INSERT OR IGNORE INTO series (code, name, sort_order) VALUES (?, ?, ?)"
  );
  db.transaction(() => {
    Object.entries(SERIES_NAMES).forEach(([code, name], i) => insertSeries.run(code, name, i));
    // Any series a product references but SERIES_NAMES forgot — keep the FK valid.
    for (const p of PRODUCTS) {
      if (!SERIES_NAMES[p.series]) insertSeries.run(p.series, p.series, 999);
    }
  })();

  const insertProduct = db.prepare(
    `INSERT INTO products
       (code, name, series_code, color, price_cents, image_url,
        in_stock, is_new, is_active, sort_order,
        stripe_product_id, stripe_price_id, stripe_price_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    PRODUCTS.forEach((p, i) => {
      const sp = stripePrices[p.code] || {};
      insertProduct.run(
        p.code,
        p.name,
        p.series,
        p.color ?? null,
        Math.round(p.price * 100),
        p.img ?? null,
        p.outOfStock ? 0 : 1,
        p.isNew ? 1 : 0,
        i,
        sp.productId ?? null,
        sp.priceId ?? null,
        sp.unitAmount ?? null,
        now,
        now
      );
    });
  })();

  console.log(`Seeded catalog: ${Object.keys(SERIES_NAMES).length} series, ${PRODUCTS.length} products.`);
}

// One-time migration of the old flat file into the orders/order_items tables.
function importLegacyOrders() {
  const legacyPath = join(rootDir, "orders.json");
  if (!existsSync(legacyPath)) return;

  let legacy;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(legacy) || legacy.length === 0) return;

  const insOrder = db.prepare(
    `INSERT OR IGNORE INTO orders
       (stripe_session_id, payment_intent_id, customer_id, email,
        amount_total, currency, payment_status, glazes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insItem = db.prepare(
    `INSERT INTO order_items (order_id, product_code, product_name, unit_price_cents, qty)
     VALUES (?, ?, ?, ?, ?)`
  );
  const lookup = db.prepare("SELECT name, price_cents FROM products WHERE code = ?");

  let imported = 0;
  db.transaction(() => {
    for (const o of legacy) {
      if (!o?.sessionId) continue;
      const info = insOrder.run(
        o.sessionId,
        o.paymentIntentId ?? null,
        o.customerId ?? null,
        o.email ?? null,
        o.amountTotal ?? null,
        o.currency ?? null,
        o.paymentStatus ?? null,
        o.glazes ?? null,
        o.createdAt ?? null
      );
      if (info.changes === 0) continue; // already present
      imported++;
      for (const it of parseGlazes(o.glazes)) {
        const prod = lookup.get(it.code);
        insItem.run(info.lastInsertRowid, it.code, prod?.name ?? null, prod?.price_cents ?? null, it.qty);
      }
    }
  })();

  if (imported) console.log(`Imported ${imported} legacy order(s) from orders.json.`);
}

// Populates the catalog on first run and migrates any legacy orders. Idempotent:
// once a table has rows it is left alone, so this is safe to call on every boot.
export function seedIfEmpty() {
  if (db.prepare("SELECT COUNT(*) AS c FROM products").get().c === 0) seedCatalog();
  if (db.prepare("SELECT COUNT(*) AS c FROM orders").get().c === 0) importLegacyOrders();
}
