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
    description        TEXT,
    specs              TEXT,
    brand              TEXT,
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

  -- Finished one-of-a-kind pieces (the "Pieces" section). Each row is a unique
  -- item: it sells once (sold flag). Prices are authoritative here. Photos are a
  -- JSON array of image URLs (hosted in S3), managed from the admin page.
  CREATE TABLE IF NOT EXISTS pieces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    price_cents  INTEGER NOT NULL,
    blurb        TEXT,
    color        TEXT,
    photos       TEXT,
    sold         INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT,
    updated_at   TEXT
  );
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
  if (row.description) p.description = row.description;
  // specs is a small JSON bundle of detail-page facts (finish, cone, …). Parse
  // it back to an object; ignore it silently if it's ever malformed.
  if (row.specs) {
    try { p.specs = JSON.parse(row.specs); } catch { /* leave specs off */ }
  }
  // The shop began as AMACO-only, so rows predating multi-brand have no brand;
  // treat those as AMACO.
  p.brand = row.brand || "AMACO";
  if (!row.in_stock) p.outOfStock = true;
  if (row.is_new) p.isNew = true;
  return p;
}

// ── Catalog reads ─────────────────────────────────────────────────────
export function getCatalog() {
  return db
    .prepare(
      `SELECT code, name, series_code, color, price_cents, image_url, description, specs, brand, in_stock, is_new
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

// Ensure every series referenced by the catalog exists (idempotent).
function ensureSeries() {
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
}

// Prepared lazily: the `brand` column is added by ensureProductColumns() at boot,
// which runs before any insert — preparing this at module load would fail on an
// older database that predates the column.
let _insertProductStmt = null;
function insertProductRow(p, sortOrder, now, stripePrices) {
  if (!_insertProductStmt) {
    _insertProductStmt = db.prepare(
      `INSERT INTO products
         (code, name, series_code, color, price_cents, image_url, description, specs, brand,
          in_stock, is_new, is_active, sort_order,
          stripe_product_id, stripe_price_id, stripe_price_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
    );
  }
  const sp = stripePrices[p.code] || {};
  _insertProductStmt.run(
    p.code,
    p.name,
    p.series,
    p.color ?? null,
    Math.round(p.price * 100),
    p.img ?? null,
    p.description ?? null,
    p.specs ? JSON.stringify(p.specs) : null,
    p.brand ?? null,
    p.outOfStock ? 0 : 1,
    p.isNew ? 1 : 0,
    sortOrder,
    sp.productId ?? null,
    sp.priceId ?? null,
    sp.unitAmount ?? null,
    now,
    now
  );
}

function seedCatalog() {
  const stripePrices = readStripePrices();
  const now = nowIso();
  ensureSeries();
  db.transaction(() => {
    PRODUCTS.forEach((p, i) => insertProductRow(p, i, now, stripePrices));
  })();
  console.log(`Seeded catalog: ${Object.keys(SERIES_NAMES).length} series, ${PRODUCTS.length} products.`);
}

// Inserts any catalog entries not already in the DB (matched by code) without
// touching existing rows. This is how new glazes — e.g. a whole new brand added
// to products.js — reach a database that was seeded before they existed;
// seedCatalog only runs on an empty DB.
function insertMissingProducts() {
  const stripePrices = readStripePrices();
  const now = nowIso();
  const existing = new Set(db.prepare("SELECT code FROM products").all().map(r => r.code));
  const missing = PRODUCTS.map((p, i) => [p, i]).filter(([p]) => !existing.has(p.code));
  if (missing.length === 0) return;
  ensureSeries(); // a new brand may bring new series
  db.transaction(() => {
    for (const [p, i] of missing) insertProductRow(p, i, now, stripePrices);
  })();
  console.log(`Inserted ${missing.length} new product(s) into the catalog.`);
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

// Adds columns to an already-created products table. Older databases were
// created before these columns existed, and `CREATE TABLE IF NOT EXISTS` never
// alters an existing table — so add them here, guarded, on boot.
function ensureProductColumns() {
  const cols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
  if (!cols.includes("description")) db.exec("ALTER TABLE products ADD COLUMN description TEXT");
  if (!cols.includes("specs")) db.exec("ALTER TABLE products ADD COLUMN specs TEXT");
  if (!cols.includes("brand")) db.exec("ALTER TABLE products ADD COLUMN brand TEXT");
}

// Backfills description and specs from products.js into rows that don't have
// them yet. Because seedCatalog only runs on a fresh (empty) database, an
// existing box would otherwise never pick up fields added to the source. Only
// fills where the column is still empty, so a value edited at runtime is never
// clobbered on the next boot.
function backfillProductContent() {
  const updDesc = db.prepare(
    `UPDATE products SET description = ?, updated_at = ?
     WHERE code = ? AND (description IS NULL OR description = '')`
  );
  const updSpecs = db.prepare(
    `UPDATE products SET specs = ?, updated_at = ?
     WHERE code = ? AND (specs IS NULL OR specs = '')`
  );
  const updBrand = db.prepare(
    `UPDATE products SET brand = ?, updated_at = ?
     WHERE code = ? AND (brand IS NULL OR brand = '')`
  );
  const now = nowIso();
  let descFilled = 0, specsFilled = 0, brandFilled = 0;
  db.transaction(() => {
    for (const p of PRODUCTS) {
      if (p.description) descFilled += updDesc.run(p.description, now, p.code).changes;
      if (p.specs) specsFilled += updSpecs.run(JSON.stringify(p.specs), now, p.code).changes;
      if (p.brand) brandFilled += updBrand.run(p.brand, now, p.code).changes;
    }
  })();
  if (descFilled) console.log(`Backfilled descriptions for ${descFilled} product(s).`);
  if (specsFilled) console.log(`Backfilled specs for ${specsFilled} product(s).`);
  if (brandFilled) console.log(`Backfilled brand for ${brandFilled} product(s).`);
}

// Populates the catalog on first run and migrates any legacy orders. Idempotent:
// once a table has rows it is left alone, so this is safe to call on every boot.
// ── Pieces (finished one-of-a-kind items) ─────────────────────────────
function toClientPiece(row) {
  let photos = [];
  try { photos = row.photos ? JSON.parse(row.photos) : []; } catch { photos = []; }
  return {
    id: row.id,
    name: row.name,
    price: row.price_cents / 100,
    blurb: row.blurb || "",
    color: row.color || "#E8D9C3",
    photos,
    sold: !!row.sold,
  };
}

// Public/catalog view of the pieces, newest-listed first.
export function getPieces() {
  return db.prepare("SELECT * FROM pieces ORDER BY sort_order DESC, id DESC").all().map(toClientPiece);
}

// Authoritative row used to price and gate a piece checkout.
export function getPiece(id) {
  return db.prepare("SELECT * FROM pieces WHERE id = ?").get(id);
}

export function insertPiece({ name, priceCents, blurb, color, photos }) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO pieces (name, price_cents, blurb, color, photos, sold, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(name, priceCents, blurb ?? null, color ?? null, JSON.stringify(photos ?? []), Date.parse(now) || 0, now, now);
  return info.lastInsertRowid;
}

// Partial update: only the provided fields are changed.
export function updatePiece(id, fields) {
  const sets = [];
  const vals = [];
  if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
  if (fields.priceCents !== undefined) { sets.push("price_cents = ?"); vals.push(fields.priceCents); }
  if (fields.blurb !== undefined) { sets.push("blurb = ?"); vals.push(fields.blurb); }
  if (fields.color !== undefined) { sets.push("color = ?"); vals.push(fields.color); }
  if (fields.photos !== undefined) { sets.push("photos = ?"); vals.push(JSON.stringify(fields.photos)); }
  if (fields.sold !== undefined) { sets.push("sold = ?"); vals.push(fields.sold ? 1 : 0); }
  if (sets.length === 0) return 0;
  sets.push("updated_at = ?"); vals.push(nowIso());
  vals.push(id);
  return db.prepare(`UPDATE pieces SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes;
}

export function deletePiece(id) {
  return db.prepare("DELETE FROM pieces WHERE id = ?").run(id).changes;
}

// Seed a few example pieces the first time so the section isn't empty.
function seedPieces() {
  if (db.prepare("SELECT COUNT(*) AS c FROM pieces").get().c > 0) return;
  const samples = [
    { name: "Cobalt Pour Mug", priceCents: 4800, blurb: "Wheel-thrown 10 oz mug in Blue Surf breaking green over carved texture. Cone 6, dinnerware safe.", color: "#2C5F8A", photos: [] },
    { name: "Amber Crystal Tumbler", priceCents: 5200, blurb: "Handleless 8 oz tumbler finished in Desert Dusk — amber matte with melting purple-blue crystals.", color: "#B0783E", photos: [] },
  ];
  samples.forEach((p, i) => insertPiece({ ...p }));
  console.log(`Seeded ${samples.length} example piece(s).`);
}

export function seedIfEmpty() {
  ensureProductColumns();
  if (db.prepare("SELECT COUNT(*) AS c FROM products").get().c === 0) seedCatalog();
  else insertMissingProducts();
  if (db.prepare("SELECT COUNT(*) AS c FROM orders").get().c === 0) importLegacyOrders();
  backfillProductContent();
  seedPieces();
}
