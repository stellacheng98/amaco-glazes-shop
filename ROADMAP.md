# Roadmap — making the shop dynamic

The shop began fully static: the catalog was a hardcoded array in
`public/products.js` (loaded into the browser *and* eval'd server-side via a VM),
Stripe price IDs lived in a generated `stripe-prices.json`, and confirmed orders
were appended to a flat `orders.json`. Changing a price, photo, or stock level
meant editing code and redeploying.

This roadmap moves those behind a database and an API so catalog, stock, and
orders change at runtime. It is delivered in four phases. **Phases 1 and 2 are
done;** Phases 3 and 4 are planned below.

Data lives in a single SQLite database, `shop.db` (see `db.js`), chosen to match
the shop's single-process scale with zero extra infrastructure. Moving to
Postgres later is a connection swap, not a rewrite.

---

## ✅ Phase 1 — DB-backed catalog (done)

The catalog stopped being a baked-in script and became data served from the
database.

- **Tables:** `series`, `products`.
- **`products`** carries `price_cents`, `image_url`, `in_stock`, `is_new`,
  `is_active`, `sort_order`, and the Stripe linkage (`stripe_product_id`,
  `stripe_price_id`, `stripe_price_cents`) folded in from the old
  `stripe-prices.json`.
- **API:** `GET /api/products`, `GET /api/series`.
- The front end (`public/app.js`) fetches the catalog at load instead of loading
  `public/products.js` as a script; the `<script src="products.js">` tag is gone.
- `public/products.js` is retained as the **seed source** — `seedIfEmpty()`
  populates the database from it on first run.
- Prices are still re-priced server-side at checkout from the database, so the
  browser never influences the amount charged.

## ✅ Phase 2 — DB-backed orders (done)

Orders moved from the flat file into relational tables with real line items.

- **Tables:** `orders`, `order_items`.
- **`orders`** adds `fulfillment_status` (`pending` → `packed` → `shipped`) —
  something the flat file could not track.
- **`order_items`** stores one row per glaze (`product_code`, `product_name`,
  `unit_price_cents`, `qty`) instead of the old `"C-05×2, …"` metadata string,
  so the shop can report on what actually sells.
- `orders.js` was rewritten onto SQLite; the webhook upsert stays idempotent on
  redelivery (order is upserted by session ID, line items rebuilt).
- Any existing `orders.json` is imported into the tables once, on first run.

---

## 🔜 Phase 3 — Admin & real inventory (planned)

Goal: make the catalog editable by a merchant, not just at seed time, and track
real stock. This is what makes the shop *fully* dynamic — today, edits to
`public/products.js` only affect a fresh (empty) database; an admin API removes
that limitation.

### Schema changes

- **`products.stock_qty`** (`INTEGER`) — replace the `in_stock` boolean with a
  real count. `in_stock` becomes a derived `stock_qty > 0`.
- **`inventory_movements`** — audit log so stock changes are traceable and
  orders can decrement atomically.

  | column | type | notes |
  | --- | --- | --- |
  | `id` | INTEGER PK | |
  | `product_code` | TEXT | |
  | `delta` | INTEGER | negative on sale, positive on restock |
  | `reason` | TEXT | `sale` / `restock` / `manual` / `correction` |
  | `order_id` | INTEGER FK, nullable | set when the movement is a sale |
  | `created_at` | TEXT | |

- **`admin_users`** — `id`, `email`, `password_hash`, `created_at`. Only if the
  admin panel needs real auth (a single shared token via env var is a lighter
  interim option).

### Behaviour

- On `checkout.session.completed`, decrement `stock_qty` per line item and write
  an `inventory_movements` row inside the same transaction that records the
  order. Closes the "same jar sold twice" gap noted in the README.

### API (all admin, auth-protected)

| Method & path | Purpose |
| --- | --- |
| `POST /api/admin/products` | Create a glaze; auto-create its Stripe Product + Price (absorbs `scripts/sync-catalog.js`) |
| `PATCH /api/admin/products/:code` | Edit name/price/photo/flags; re-price in Stripe when `price_cents` changes |
| `DELETE /api/admin/products/:code` | Soft-delete via `is_active = 0` |
| `PATCH /api/admin/products/:code/stock` | Adjust `stock_qty`; writes an `inventory_movements` row |
| `GET /api/admin/orders` | Fulfillment dashboard — list orders + items |
| `PATCH /api/admin/orders/:id` | Advance `fulfillment_status` (mark packed/shipped) |

Once product CRUD auto-syncs Stripe, `scripts/sync-catalog.js` is retired; the
manual sync step disappears from setup.

## 🔜 Phase 4 — Customer-facing dynamic features (planned)

Goal: features that a live catalog + order history unlock.

### Tables

- **`restock_subscriptions`** — `id`, `email`, `product_code`, `created_at`,
  `notified_at` (nullable). Backs an "email me when this is back" control on
  out-of-stock cards; a restock (positive `inventory_movements`) triggers the
  notification. Highest value-to-effort item here.
- **`reviews`** — `id`, `product_code`, `rating` (1–5), `body`, `author`,
  `created_at`, `status` (moderation). Per-glaze ratings and notes.
- **`customers`** — `id`, `email`, `created_at`, and account fields. Optional:
  order history can first be derived by grouping `orders` on `email`, so this
  table is only needed once real accounts (login, saved details) are wanted.

### API

| Method & path | Purpose |
| --- | --- |
| `POST /api/restock-subscribe` | `{ email, code }` — register for a back-in-stock alert |
| `GET /api/products/:code/reviews` | List approved reviews |
| `POST /api/products/:code/reviews` | Submit a review (enters moderation) |
| `GET /api/account/orders?email=` | Order history for a customer |

Notification delivery (email) needs a provider (e.g. Stripe already emails
receipts; a transactional-email service covers restock alerts). Out of scope for
the table/API design but noted as the dependency.

---

## Sequencing notes

- **Phase 3 before Phase 4.** Restock alerts (4) depend on real inventory
  movements (3); reviews and accounts lean on the admin/moderation surface (3).
- **Auth.** Phases 3–4 introduce the first authenticated surface. Start with a
  single admin token in an env var; graduate to `admin_users` + sessions only if
  more than one operator needs access.
- **Stripe.** Product CRUD in Phase 3 subsumes `scripts/sync-catalog.js`. Until
  then, `npm run sync-catalog` remains the way to price glazes in Stripe.
