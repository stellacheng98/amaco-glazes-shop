import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findProduct } from "./catalog.js";
import { recordOrder, findOrderBySessionId } from "./orders.js";

const rootDir = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 4242;

// Public origin used to build Checkout return URLs. Behind a proxy or on a real
// domain this must be the customer-facing URL, not the local bind address.
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;

// ── Stripe price lookup ───────────────────────────────────────────────
// Written by `npm run sync-catalog`. The browser sends glaze codes and
// quantities only — never prices — so the amount charged always comes from
// Stripe, not from anything a customer could edit in devtools.
const stripePricesPath = join(rootDir, "stripe-prices.json");

// Browse-only mode: with no API key or no synced catalog the shop still serves,
// so the front end can be worked on without Stripe credentials. Checkout says
// plainly that it is unconfigured rather than failing in a confusing way.
const missingSetup = [];
if (!process.env.STRIPE_SECRET_KEY) missingSetup.push("STRIPE_SECRET_KEY is not set (copy .env.example to .env)");
if (!existsSync(stripePricesPath)) missingSetup.push("stripe-prices.json is missing (run `npm run sync-catalog`)");

const checkoutEnabled = missingSetup.length === 0;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const STRIPE_PRICES = existsSync(stripePricesPath)
  ? JSON.parse(readFileSync(stripePricesPath, "utf8"))
  : {};

// ── Webhook ───────────────────────────────────────────────────────────
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

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object ?? {};
    try {
      recordOrder({
        sessionId: session.id,
        paymentIntentId: session.payment_intent ?? null,
        customerId: session.customer ?? null,
        email: session.customer_details?.email ?? null,
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
        paymentStatus: session.payment_status ?? null,
        glazes: session.metadata?.glazes ?? "",
        createdAt: Number.isFinite(session.created)
          ? new Date(session.created * 1000).toISOString()
          : null,
      });
      console.log(`Order confirmed: ${session.id} (${session.customer_details?.email ?? "no email"})`);
    } catch (err) {
      // Returning 5xx makes Stripe retry, which is what we want for a transient
      // write failure — but not for a payload we will never be able to store.
      console.error(`Could not record order ${session.id}:`, err.message);
      return res.status(500).json({ error: "Could not record order." });
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// ── Checkout ──────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  if (!checkoutEnabled) {
    return res.status(503).json({ error: "Checkout isn't set up on this server yet." });
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ error: "Your cart is empty." });
    }

    const lineItems = [];
    for (const item of items) {
      const glaze = findProduct(item.code);
      const stripePrice = STRIPE_PRICES[item.code];

      if (!glaze || !stripePrice) {
        return res.status(400).json({ error: `Unknown glaze: ${item.code}` });
      }
      if (glaze.outOfStock) {
        return res.status(400).json({ error: `${glaze.code} ${glaze.name} is out of stock.` });
      }

      const quantity = Number(item.qty);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return res.status(400).json({ error: `Invalid quantity for ${item.code}.` });
      }

      lineItems.push({ price: stripePrice.priceId, quantity });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${publicUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/index.html`,
      // Recorded on the session so a fulfilled order shows what to pull and pack
      // without re-reading the line items.
      metadata: {
        glazes: lineItems
          .map((line, i) => `${items[i].code}×${line.quantity}`)
          .join(", ")
          .slice(0, 500),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Could not create Checkout Session:", err.message);
    res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
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
  console.log(`\n  Sample Glaze Co. running at ${publicUrl}\n`);
  if (checkoutEnabled) {
    console.log(`  Checkout enabled · ${Object.keys(STRIPE_PRICES).length} glazes priced in Stripe\n`);
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
