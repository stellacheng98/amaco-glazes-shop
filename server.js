import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  seedIfEmpty,
  getCatalog,
  getSeriesMap,
  getProductForCheckout,
  countPricedProducts,
  getPieces,
  getPiece,
  insertPiece,
  updatePiece,
  deletePiece,
} from "./db.js";
import { recordOrder, findOrderBySessionId } from "./orders.js";

const rootDir = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 4242;

// Behind Caddy (a loopback reverse proxy) the real visitor IP arrives in
// X-Forwarded-For; without this every request looks like Caddy's 127.0.0.1 and
// the rate limiters below would throttle all traffic as a single client. Trust
// only loopback proxies, so an external client can't spoof the header to dodge a
// limit. Harmless in local dev, where requests arrive directly.
app.set("trust proxy", "loopback");

// Public origin used to build Checkout return URLs. Behind a proxy or on a real
// domain this must be the customer-facing URL, not the local bind address.
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;

// Populate the catalog on first run and migrate any legacy orders.json into the
// database. Idempotent — a table that already has rows is left untouched.
seedIfEmpty();

// ── Checkout availability ─────────────────────────────────────────────
// The browser sends glaze codes and quantities only — never prices — so the
// amount charged always comes from the Stripe Price recorded on each product,
// not from anything a customer could edit in devtools.
//
// Browse-only mode: with no API key or nothing priced in Stripe the shop still
// serves, so the front end can be worked on without Stripe credentials. Checkout
// then says plainly that it is unconfigured rather than failing confusingly.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const missingSetup = [];
if (!process.env.STRIPE_SECRET_KEY) missingSetup.push("STRIPE_SECRET_KEY is not set (copy .env.example to .env)");
else if (countPricedProducts() === 0) missingSetup.push("no glazes are priced in Stripe yet (run `npm run sync-catalog`)");

const checkoutEnabled = missingSetup.length === 0;

// ── Admin (Pieces inventory) ──────────────────────────────────────────
// The /admin page manages the finished-pieces inventory. Write endpoints are
// gated by a shared password (ADMIN_PASSWORD); admin is off when it isn't set.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const adminEnabled = ADMIN_PASSWORD.length > 0;

// ── Webhook ───────────────────────────────────────────────────────────
// All three carry a Checkout Session as event.data.object. `completed` and
// `async_payment_succeeded` land a fulfillable order; `async_payment_failed`
// records it but marks it canceled so nothing ships against money that never
// arrived. With cards pinned on the session, only `completed` fires today — the
// async pair is a standing safety net for any future non-card method.
const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

// Registered before express.json() because signature verification needs the
// raw, unparsed request body.
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  if (webhookSecret && stripe) {
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        webhookSecret
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // Without a signing secret any caller could forge an order, so this path is
    // for local `stripe listen` experiments only.
    console.warn("STRIPE_WEBHOOK_SECRET is not set — accepting webhook unverified.");
    event = JSON.parse(req.body);
  }

  if (CHECKOUT_EVENTS.has(event.type)) {
    const session = event.data?.object ?? {};
    const failed = event.type === "checkout.session.async_payment_failed";
    try {
      recordOrder({
        sessionId: session.id,
        paymentIntentId: session.payment_intent ?? null,
        customerId: session.customer ?? null,
        email: session.customer_details?.email ?? null,
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
        paymentStatus: session.payment_status ?? null,
        // Stripe leaves payment_status "unpaid" on a failed async payment, which
        // is indistinguishable from one still settling — so flag fulfillment
        // explicitly. null on the happy path leaves the existing status intact.
        fulfillmentStatus: failed ? "canceled" : null,
        glazes: session.metadata?.glazes ?? "",
        createdAt: Number.isFinite(session.created)
          ? new Date(session.created * 1000).toISOString()
          : null,
      });
      const label = failed ? "Payment failed" : "Order confirmed";
      console.log(`${label}: ${session.id} (${session.customer_details?.email ?? "no email"})`);
    } catch (err) {
      // Returning 5xx makes Stripe retry, which is what we want for a transient
      // write failure — but not for a payload we will never be able to store.
      console.error(`Could not record order ${session.id}:`, err.message);
      return res.status(500).json({ error: "Could not record order." });
    }
  }

  res.json({ received: true });
});

// ── Rate limiting ─────────────────────────────────────────────────────
// Two layers, both keyed per IP and mounted AFTER the webhook so Stripe's retry
// bursts (from Stripe's own IPs) are never throttled.
//
// The global limiter caps request volume from any single IP. Its job is to blunt
// scrapers/floods — the only Lightsail cost that scales with traffic is outbound
// bandwidth, and product images are offloaded to an external CDN, so a real page
// load only touches this server a handful of times. 200/min leaves shoppers
// untouched while stopping a bot from hammering the box.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again shortly." },
});
app.use(globalLimiter);

// Far stricter, applied only to checkout. Creating a Checkout Session is free at
// Stripe, so this isn't about API cost — it's fraud control: automated card
// testing turns into disputes (~$15 each) and Stripe account risk. This is the
// cheap front layer in front of Stripe Radar; a real shopper rarely starts more
// than a couple of checkouts, so 10 per 15 min per IP is generous for them and
// hostile to a carding bot.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many checkout attempts. Please wait a few minutes and try again." },
});

app.use(express.json());

// ── Build-a-Cup pricing (authoritative, server-side) ──────────────────
// Base 8 oz bisqueware cups start at $20; the customer glazes them with test
// tiles ($1 per glaze, $2 per two-glaze combo). Prices live here — never
// trusted from the browser — so a tampered request can't change what's charged.
const CUPS = {
  "cup-classic": { name: "Classic 8 oz Cup", price_cents: 2000, blurb: "Straight-sided everyday coffee cup.", color: "#E8D9C3" },
  "cup-tall":    { name: "Tall 8 oz Mug",    price_cents: 2400, blurb: "Taller profile with a comfy handle.",  color: "#E3D2B8" },
  "cup-wide":    { name: "Wide 8 oz Tumbler",price_cents: 2800, blurb: "Handleless, wide-mouthed tumbler.",    color: "#EADFCC" },
};
const TILE_CENTS = 100;   // one glaze on one test tile
const COMBO_CENTS = 200;  // two glazes layered on one test tile
const MAX_TILES = 12;

// Finished one-of-a-kind pieces now live in the `pieces` DB table, managed from
// the admin page. Prices/availability are read from the DB at request time, so
// the browser only ever sends a piece id. See db.js and /admin.

// ── Catalog API ───────────────────────────────────────────────────────
// The front end fetches the catalog at load instead of shipping it as a baked-in
// script, so a price, photo or stock change goes live on the next request with
// no redeploy. Prices are shown here for display only; checkout re-prices every
// line from the database, so a tampered value never reaches Stripe.
app.get("/api/products", (_req, res) => {
  res.json(getCatalog());
});

app.get("/api/series", (_req, res) => {
  res.json(getSeriesMap());
});

// Base cups for the Build-a-Cup section. Price shown in dollars for display;
// checkout re-reads CUPS server-side so the amount never depends on the browser.
app.get("/api/cups", (_req, res) => {
  res.json({
    cups: Object.entries(CUPS).map(([id, c]) => ({ id, name: c.name, price: c.price_cents / 100, blurb: c.blurb, color: c.color })),
    tilePrice: TILE_CENTS / 100,
    comboPrice: COMBO_CENTS / 100,
    maxTiles: MAX_TILES,
  });
});

// Finished one-of-a-kind pieces for sale, read from the `pieces` DB table.
app.get("/api/finished-cups", (_req, res) => {
  res.json(getPieces());
});

// ── Checkout ──────────────────────────────────────────────────────────
app.post("/create-checkout-session", checkoutLimiter, async (req, res) => {
  if (!checkoutEnabled) {
    return res.status(503).json({ error: "Checkout isn't set up on this server yet." });
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ error: "Your cart is empty." });
    }

    // The cart can hold glazes (fixed Stripe prices, any qty) and one-of-a-kind
    // pieces (dynamic price_data, qty 1, sell-once). Both are priced/validated
    // here from the DB; the browser only sends codes/ids.
    const lineItems = [];
    const summary = [];
    const seenPieces = new Set();
    for (const item of items) {
      if (item && (item.kind === "piece" || item.pieceId != null)) {
        const pieceId = item.pieceId ?? item.id;
        if (seenPieces.has(String(pieceId))) continue; // merge dupes: one row per piece
        seenPieces.add(String(pieceId));
        const piece = getPiece(pieceId);
        if (!piece) return res.status(400).json({ error: "A piece in your cart is no longer available. Please refresh." });
        const available = piece.stock ?? 0;
        if (available <= 0) return res.status(400).json({ error: `Sorry — "${piece.name}" has already sold out.` });
        let quantity = Number(item.qty);
        if (!Number.isInteger(quantity) || quantity < 1) quantity = 1;
        if (quantity > available) {
          return res.status(400).json({ error: `Only ${available} of "${piece.name}" left. Please lower the quantity.` });
        }
        let cover;
        try { const ph = piece.photos ? JSON.parse(piece.photos) : []; if (ph[0]) cover = [ph[0]]; } catch { /* no cover */ }
        lineItems.push({ price_data: { currency: "usd", unit_amount: piece.price_cents, product_data: { name: piece.name, images: cover } }, quantity });
        summary.push(`piece#${piece.id}×${quantity}`);
        continue;
      }

      const glaze = getProductForCheckout(item.code);
      if (!glaze || !glaze.is_active) {
        return res.status(400).json({ error: `Unknown glaze: ${item.code}` });
      }
      if (!glaze.in_stock || (glaze.stock ?? 0) <= 0) {
        return res.status(400).json({ error: `${glaze.code} ${glaze.name} is out of stock.` });
      }
      if (!glaze.stripe_price_id) {
        return res.status(400).json({ error: `${glaze.code} ${glaze.name} isn't available for purchase yet.` });
      }
      const quantity = Number(item.qty);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return res.status(400).json({ error: `Invalid quantity for ${item.code}.` });
      }
      if (quantity > glaze.stock) {
        return res.status(400).json({ error: `Only ${glaze.stock} of ${glaze.code} ${glaze.name} left. Please lower the quantity.` });
      }
      lineItems.push({ price: glaze.stripe_price_id, quantity });
      summary.push(`${item.code}×${quantity}`);
    }

    if (lineItems.length === 0) return res.status(400).json({ error: "Your cart is empty." });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Card + Apple Pay only, on purpose. Apple Pay is a wallet surfaced
      // through the `card` payment method — Stripe Checkout has no separate
      // "apple_pay" entry for payment_method_types — so listing "card" enables
      // both, and Apple Pay appears automatically on a supported Safari/device.
      // Both settle synchronously, so `checkout.session.completed` always
      // arrives already `paid` and an order is never recorded before the money
      // has. Enabling an async method (ACH, bank debit,
      // Link-with-delayed-settlement) stays a deliberate choice here, not a
      // dashboard toggle flipped behind the code's back — and the webhook's
      // async handlers are ready if that day comes.
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: `${publicUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/shop.html`,
      // Recorded on the session so a fulfilled order shows what to pull and pack
      // without re-reading the line items.
      metadata: {
        glazes: summary.join(", ").slice(0, 500),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Could not create Checkout Session:", err.message);
    res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
});

// ── Build-a-Cup checkout ──────────────────────────────────────────────
// A custom cup is a base cup plus test tiles, each priced server-side. Because
// the combination is arbitrary (not a fixed SKU), the Stripe line items are
// built with price_data rather than pre-made Prices — but every amount still
// comes from CUPS / TILE_CENTS / COMBO_CENTS here, never from the request.
app.post("/create-cup-checkout-session", checkoutLimiter, async (req, res) => {
  if (!checkoutEnabled) {
    return res.status(503).json({ error: "Checkout isn't set up on this server yet." });
  }

  try {
    const cup = CUPS[req.body?.cupId];
    if (!cup) return res.status(400).json({ error: "Please pick a base cup." });

    const tiles = Array.isArray(req.body?.tiles) ? req.body.tiles : [];
    if (tiles.length === 0) return res.status(400).json({ error: "Add at least one glaze tile." });
    if (tiles.length > MAX_TILES) return res.status(400).json({ error: `A cup can hold up to ${MAX_TILES} tiles.` });

    let singles = 0, combos = 0;
    const summary = [];
    for (const tile of tiles) {
      const codes = Array.isArray(tile?.glazes) ? tile.glazes.filter(Boolean) : [];
      if (codes.length < 1 || codes.length > 2) {
        return res.status(400).json({ error: "Each tile is one glaze, or two for a combo." });
      }
      for (const code of codes) {
        const glaze = getProductForCheckout(code);
        if (!glaze || !glaze.is_active) return res.status(400).json({ error: `Unknown glaze: ${code}` });
      }
      if (codes.length === 1) { singles++; summary.push(codes[0]); }
      else { combos++; summary.push(codes.join("+")); }
    }

    const lineItems = [
      { price_data: { currency: "usd", unit_amount: cup.price_cents, product_data: { name: `${cup.name} (bisqueware)` } }, quantity: 1 },
    ];
    if (singles) lineItems.push({ price_data: { currency: "usd", unit_amount: TILE_CENTS, product_data: { name: "Glaze test tile" } }, quantity: singles });
    if (combos) lineItems.push({ price_data: { currency: "usd", unit_amount: COMBO_CENTS, product_data: { name: "Glaze combo tile (2 layered)" } }, quantity: combos });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: `${publicUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/build-a-cup.html`,
      // Recorded so a fulfilled cup order shows the base and exactly which glazes
      // go on which tiles without re-reading the line items.
      metadata: {
        kind: "cup",
        cup: cup.name,
        tiles: summary.join(", ").slice(0, 480),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Could not create Cup Checkout Session:", err.message);
    res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
});

// ── Finished-piece checkout ───────────────────────────────────────────
// One-of-a-kind piece, priced from the `pieces` table and sold once. The browser
// sends only the piece id; the amount and availability are decided here.
app.post("/create-finished-cup-checkout-session", checkoutLimiter, async (req, res) => {
  if (!checkoutEnabled) {
    return res.status(503).json({ error: "Checkout isn't set up on this server yet." });
  }
  try {
    const piece = getPiece(req.body?.cupId);
    if (!piece) return res.status(400).json({ error: "That piece isn't available." });
    if ((piece.stock ?? 0) <= 0) return res.status(400).json({ error: "Sorry — this piece has already sold out." });

    // photos is a JSON array of absolute image URLs (S3). Use the first as the cover.
    let cover;
    try { const ph = piece.photos ? JSON.parse(piece.photos) : []; if (ph[0]) cover = [ph[0]]; } catch { /* no cover */ }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: { currency: "usd", unit_amount: piece.price_cents, product_data: { name: piece.name, images: cover } },
        quantity: 1,
      }],
      success_url: `${publicUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/pieces.html`,
      metadata: { kind: "finished-piece", pieceId: String(piece.id), piece: piece.name, glazes: `piece#${piece.id}×1` },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Could not create Finished-Piece Checkout Session:", err.message);
    res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
});

// ── Admin: Pieces inventory (gated by ADMIN_PASSWORD) ─────────────────
// HTTP Basic auth on the write endpoints; the admin page sends the password.
// The password is compared in constant time. Any username is accepted.
function adminAuth(req, res, next) {
  if (!adminEnabled) return res.status(503).json({ error: "Admin is not configured on this server." });
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  let ok = false;
  if (m) {
    try {
      const pass = Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":");
      const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
      ok = a.length === b.length && timingSafeEqual(a, b);
    } catch { ok = false; }
  }
  if (!ok) {
    res.set("WWW-Authenticate", 'Basic realm="Sample Glaze Admin"');
    return res.status(401).json({ error: "Admin authentication required." });
  }
  next();
}

// Accepts an array of URLs or a newline/comma-separated string; keeps only
// http(s) URLs (piece images are hosted in S3). Capped at 12.
function normalizePhotos(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string") list = input.split(/[\n,]/);
  return list.map(s => String(s).trim()).filter(s => /^https?:\/\//i.test(s)).slice(0, 12);
}
const parsePriceCents = price => { const c = Math.round(Number(price) * 100); return Number.isFinite(c) ? c : NaN; };
// Inventory count for a piece. Accepts `stock` or `count`; NaN means "not provided".
const parseStock = v => { if (v === undefined || v === null || v === "") return NaN; const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, n) : NaN; };

app.get("/api/admin/pieces", adminAuth, (_req, res) => res.json(getPieces()));

app.post("/api/admin/pieces", adminAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const priceCents = parsePriceCents(b.price);
  if (!name) return res.status(400).json({ error: "Name is required." });
  if (!(priceCents > 0)) return res.status(400).json({ error: "Price must be a positive number." });
  const stockRaw = parseStock(b.stock ?? b.count);
  const stock = Number.isNaN(stockRaw) ? 1 : stockRaw;
  const id = insertPiece({ name, priceCents, blurb: String(b.blurb || "").trim(), color: b.color || null, photos: normalizePhotos(b.photos), stock });
  res.json({ id });
});

app.patch("/api/admin/pieces/:id", adminAuth, (req, res) => {
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) return res.status(400).json({ error: "Name can't be empty." }); fields.name = n; }
  if (b.price !== undefined) { const c = parsePriceCents(b.price); if (!(c > 0)) return res.status(400).json({ error: "Invalid price." }); fields.priceCents = c; }
  if (b.blurb !== undefined) fields.blurb = String(b.blurb);
  if (b.color !== undefined) fields.color = b.color;
  if (b.photos !== undefined) fields.photos = normalizePhotos(b.photos);
  if (b.stock !== undefined || b.count !== undefined) {
    const s = parseStock(b.stock ?? b.count);
    if (Number.isNaN(s)) return res.status(400).json({ error: "Invalid stock count." });
    fields.stock = s;
  } else if (b.sold !== undefined) {
    fields.sold = !!b.sold;
  }
  const changed = updatePiece(Number(req.params.id), fields);
  if (!changed) return res.status(404).json({ error: "Piece not found." });
  res.json({ ok: true });
});

app.delete("/api/admin/pieces/:id", adminAuth, (req, res) => {
  const changed = deletePiece(Number(req.params.id));
  if (!changed) return res.status(404).json({ error: "Piece not found." });
  res.json({ ok: true });
});

// ── Order confirmation ────────────────────────────────────────────────
// Backs the success page. Reads the session straight from Stripe so the page
// shows the right thing even if the webhook has not landed yet.
app.get("/order-status", async (req, res) => {
  if (!checkoutEnabled) {
    return res.status(503).json({ error: "Checkout isn't set up on this server yet." });
  }

  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ error: "Missing session_id." });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.json({
      paymentStatus: session.payment_status,
      email: session.customer_details?.email ?? null,
      amountTotal: session.amount_total,
      currency: session.currency,
      glazes: session.metadata?.glazes ?? "",
      // True once the webhook has landed and the order is durably recorded.
      recorded: Boolean(findOrderBySessionId(sessionId)),
    });
  } catch (err) {
    console.error("Could not look up order:", err.message);
    res.status(404).json({ error: "Order not found." });
  }
});

// Only public/ is web-reachable. Server files, .env, orders.json and
// stripe-prices.json live outside it and are never served.
app.use(express.static(join(rootDir, "public"), { extensions: ["html"] }));

const server = app.listen(port, () => {
  console.log(`\n  Sample Glaze running at ${publicUrl}\n`);
  if (checkoutEnabled) {
    console.log(`  Checkout enabled · ${countPricedProducts()} glazes priced in Stripe\n`);
  } else {
    console.log("  Browse-only mode — checkout is disabled:");
    for (const reason of missingSetup) console.log(`    · ${reason}`);
    console.log("");
  }
});

// Node's default here is an unhandled 'error' event and a raw stack trace, which
// is easy to scroll past — leaving an older server still answering on the port
// and the new configuration silently not in effect.
server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${port} is already in use — this server did NOT start.`);
    console.error("  Another server is still answering there, so your changes are not live.\n");
    console.error("  Find and stop it:");
    console.error(`    lsof -ti:${port} | xargs kill\n`);
    console.error("  Or use a different port:");
    console.error(`    PORT=4300 PUBLIC_URL=http://localhost:4300 npm start\n`);
    process.exit(1);
  }
  throw err;
});
