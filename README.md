# Sample Glaze Co.

A shop for AMACO mid-high fire glaze samples. Browse by series, filter and search, add samples to a cart, and pay via Stripe Checkout.

## Stack

Vanilla HTML/CSS/JS on the front end — no framework, no build step. A small Express server backs checkout, because Stripe requires a secret key that must never reach the browser.

| Path | Purpose |
| --- | --- |
| `public/index.html` | Shop page — nav, hero, filters, product grid, cart drawer |
| `public/about.html` | About page |
| `public/success.html` | Post-payment order confirmation |
| `public/products.js` | `PRODUCTS` array — the glaze catalog |
| `public/app.js` | Cart state, filtering, search, rendering, checkout call |
| `public/styles.css` | All styling |
| `server.js` | Static hosting, Checkout Session creation, webhook handling |
| `catalog.js` | Loads `public/products.js` server-side so both sides share one catalog |
| `orders.js` | File-backed order store (`orders.json`) |
| `scripts/sync-catalog.js` | Creates a Stripe Product + Price per glaze |

Only `public/` is web-reachable. Server files, `.env`, `orders.json`, and `stripe-prices.json` sit outside it and are never served.

## Prerequisites

- Node.js 18+ — the only requirement for browsing the shop locally

For checkout, additionally:

- A Stripe account ([dashboard.stripe.com](https://dashboard.stripe.com))
- The [Stripe CLI](https://stripe.com/docs/stripe-cli), to forward webhooks while developing

## Running locally

### Quick preview (no Stripe account needed)

To just look at the shop — browse glazes, filter, search, use the cart:

```bash
npm install
npm start
```

Open **http://localhost:4242**.

With no `STRIPE_SECRET_KEY` and no `stripe-prices.json`, the server starts in **browse-only mode**. It prints what's missing and serves the full site; only checkout is disabled, and clicking **Checkout** shows "Checkout isn't set up on this server yet" rather than failing obscurely.

```
  Sample Glaze Co. running at http://localhost:4242

  Browse-only mode — checkout is disabled:
    · STRIPE_SECRET_KEY is not set (copy .env.example to .env)
    · stripe-prices.json is missing (run `npm run sync-catalog`)
```

This is the mode to use for front-end and design work. Edit anything in `public/`, save, reload — there's no build step. Follow the full setup below when you need checkout working.

### Full setup (with checkout)

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
```

Fill in `.env`. Get your keys from **Dashboard → Developers → API keys**. Use **test-mode** keys — test mode takes fake cards and never moves real money.

See [Stripe keys](#stripe-keys) below for which key does what and where each belongs.

**3. Create the Stripe catalog**

```bash
npm run sync-catalog
```

This creates a Stripe Product and Price for each of the 101 glazes and writes the resulting IDs to `stripe-prices.json`. It's safe to re-run: existing glazes are skipped, and a glaze whose price changed in `products.js` gets a new Price attached as its default.

Run it again whenever you add glazes or change prices.

**4. Forward webhooks**

In a second terminal:

```bash
stripe listen --forward-to localhost:4242/webhook
```

Copy the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET` in `.env`.

**5. Start the server**

```bash
npm start
```

Visit http://localhost:4242. On startup the server confirms checkout is live:

```
  Sample Glaze Co. running at http://localhost:4242

  Checkout enabled · 101 glazes priced in Stripe
```

If it says *browse-only* instead, it will name what's still missing.

### Server tips

Stop the server with `Ctrl+C`.

Port 4242 already in use? Either stop what's there (`lsof -ti:4242 | xargs kill`) or run on another port. `PUBLIC_URL` must match, since it builds the Checkout return URLs:

```bash
PORT=4300 PUBLIC_URL=http://localhost:4300 npm start
```

Point `stripe listen --forward-to` at the same port.

A busy port is worth taking seriously: the new server exits while the old one keeps serving, so edits and environment changes appear to have no effect. The server calls this out explicitly on startup — see [When checkout says it isn't set up](#when-checkout-says-it-isnt-set-up).

There's no file watching. Front-end edits under `public/` just need a browser reload, but changes to `server.js`, `catalog.js`, or `orders.js` need a restart.

### Testing a payment

A full test run uses two terminal windows.

**Terminal 1 — the server**

```bash
cd /Users/stellacheng/Code/amaco-glazes-shop
export STRIPE_SECRET_KEY=sk_test_your_key   # or put it in .env and skip this
npm start
```

You want to see:

```
  Sample Glaze Co. running at http://localhost:4242

  Checkout enabled · 101 glazes priced in Stripe
```

If it says **browse-only** instead, check two things:

- `export` and `npm start` ran in the *same* terminal window — a new tab or window does not inherit the variable
- the key pasted whole. A truncated key reads as "not set" rather than failing as an auth error, so it looks identical to having no key at all

**Terminal 2 — webhook forwarding**

```bash
stripe listen --forward-to localhost:4242/webhook
```

Leave it running. Copy the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET` in `.env`, then restart the server so it picks the value up.

**Then buy something**

At http://localhost:4242, add glazes to the cart, hit **Checkout**, and pay with Stripe's test card:

| Field | Value |
| --- | --- |
| Card | `4242 4242 4242 4242` |
| Expiry | Any future date |
| CVC | Any 3 digits |
| ZIP | Any 5 digits |

Three things should happen, and it's worth checking all three:

| Where | What you should see |
| --- | --- |
| Browser | Redirect to the confirmation page with your glazes and total |
| `stripe listen` | `checkout.session.completed [evt_…]` |
| Server | `Order confirmed: cs_test_… (email)`, and a new entry in `orders.json` |

The confirmation page reads the session from Stripe directly, so it shows "paid" even when webhooks are broken. **Only `orders.json` proves fulfilment would actually fire.**

Worth testing once: close the browser tab immediately after paying, before the redirect. The order should still be recorded, because fulfilment keys off the webhook rather than the customer returning.

More test cards — including ones that decline or require 3D Secure — are at [stripe.com/docs/testing](https://stripe.com/docs/testing).

### When checkout says it isn't set up

`Checkout isn't set up on this server yet` means the server is running in browse-only mode. In order of likelihood:

**An old server is still on the port.** The most common cause, and the most confusing: a previously started server still holds port 4242, so the new one exits and the old, keyless one keeps answering. The server now prints a clear message when this happens, but if you suspect it:

```bash
lsof -i:4242 -sTCP:LISTEN     # what's actually listening
lsof -ti:4242 | xargs kill    # stop it
```

**The key isn't reaching the process.** Check the startup banner rather than guessing — it names exactly what's missing.

**No `stripe-prices.json`.** Run `npm run sync-catalog`. The server needs both a key and a synced catalog before it will enable checkout.

## Stripe keys

Stripe issues two keys per mode. They are not interchangeable, and the difference is the whole security model.

| | Secret key (`sk_…`) | Publishable key (`pk_…`) |
| --- | --- | --- |
| **Runs where** | Server only | Browser |
| **Can it be public?** | **No** — treat as a password | Yes, by design |
| **What it can do** | Everything: charge cards, issue refunds, read customers and payouts | Only start a payment the customer is already making |
| **Used by this shop** | Yes — `server.js`, `scripts/sync-catalog.js` | Not currently (see below) |

**The secret key controls your money.** Anyone holding it can refund, charge, and read your customer list. It must never appear in front-end code, in a Git commit, or in a URL.

**The publishable key is meant to be seen.** It ships inside your JavaScript where any visitor can read it. That's fine — on its own it cannot move money or read data.

### Why this shop only needs the secret key

Checkout here is **redirect-based**: the server creates a Checkout Session and sends the customer to Stripe's own hosted page. Card details are entered on Stripe's domain and never touch this site, so there is no Stripe.js in the browser and nothing to initialize with a publishable key.

The publishable key becomes necessary only if the payment form moves onto this site — [embedded Checkout](https://stripe.com/docs/checkout/embedded/quickstart) or [Elements](https://stripe.com/docs/payments/elements) — where the browser tokenizes the card directly:

```html
<script src="https://js.stripe.com/v3/"></script>
<script>
  // Publishable key is fine to hard-code — it is public information.
  const stripe = Stripe("pk_test_…");
</script>
```

### Supplying the secret key

The server reads `STRIPE_SECRET_KEY` from the environment. Two reasonable approaches:

**In `.env`** (convenient; the file is gitignored):

```bash
STRIPE_SECRET_KEY=sk_test_...
```

**Per shell session** (keeps it off disk entirely):

```bash
export STRIPE_SECRET_KEY=sk_test_...
npm start
```

In production, prefer your host's secrets manager over a deployed `.env` file.

Without the key the server runs in browse-only mode — the shop works, checkout is disabled.

### Commit guard

`.githooks/pre-commit` blocks any commit whose staged changes contain a Stripe secret or restricted key. Hooks aren't shared by Git automatically, so enable it once per clone:

```bash
git config core.hooksPath .githooks
```

Bypass with `git commit --no-verify` if it ever misfires.

### If a secret key leaks

Roll it immediately: **Dashboard → Developers → API keys → Roll key**. This invalidates the old key. Rolling is cheap, so do it on any doubt — including a key pasted into a chat, a ticket, or a screenshot.

## How checkout works

1. The browser POSTs `/create-checkout-session` with **glaze codes and quantities only**.
2. The server resolves each code to a Stripe Price ID from `stripe-prices.json`, rejecting unknown, out-of-stock, or invalid-quantity items.
3. Stripe creates a Checkout Session; the browser is redirected to Stripe's hosted payment page.
4. On success, Stripe returns the customer to `/success.html?session_id=…`, which reads `/order-status` to display the result.
5. Stripe sends `checkout.session.completed` to `/webhook`. The signature is verified, then the order is written to `orders.json`.

**Prices are never taken from the browser.** The client sends codes; the amount charged always comes from Stripe. A customer editing devtools cannot change what they pay.

Fulfilment keys off the webhook, not the success page — a customer can close the tab before redirecting, and the payment is still valid.

### Adding or editing a glaze

Add an entry to `PRODUCTS` in `public/products.js`, then re-run `npm run sync-catalog`:

```js
{ code: "C-03", name: "Smoke", series: "C", color: "#8A9090", price: 7.99, outOfStock: true,
  img: "https://cdn11.bigcommerce.com/..." },
```

`color` is the swatch shown while the image loads. Omit `outOfStock` for in-stock items.

## Deploying to production

> **This is no longer a static site.** It previously could be served from GitHub Pages; now that checkout requires a server, it needs a host that runs Node — Railway, Render, Fly.io, a VPS, or similar. GitHub Pages cannot run it.

**1. Switch to live mode.** In the Stripe Dashboard, toggle off test mode and grab the live secret key (`sk_live_…`). Activating your account for live payments requires business and bank details.

**2. Set environment variables** on the host:

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Live secret key (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | From the webhook endpoint you register in step 4 |
| `PUBLIC_URL` | Your real domain, e.g. `https://shop.example.com` |
| `PORT` | Usually set by the host automatically |

`PUBLIC_URL` must be your customer-facing domain — it builds the Checkout return URLs, so a wrong value sends paying customers to a dead page.

**3. Build the live catalog.** Stripe product and price IDs differ between test and live mode, so `stripe-prices.json` from local development is useless in production. Run `npm run sync-catalog` once against the live key, on the server or with the live key set locally, and make sure the resulting file is present in the deployment.

**4. Register the webhook.** In **Dashboard → Developers → Webhooks**, add an endpoint at `https://your-domain.com/webhook` subscribed to `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.

**5. Serve over HTTPS.** Stripe redirects back to `PUBLIC_URL`, and sending customers to a plain-HTTP checkout return is unacceptable. Most hosts terminate TLS for you.

### Deployment checklist

- [ ] Live keys set, and `.env` is **not** committed (it's gitignored)
- [ ] `stripe-prices.json` generated against the live key
- [ ] Webhook endpoint registered and its signing secret set
- [ ] `PUBLIC_URL` matches the real domain, over HTTPS
- [ ] A real test purchase completed and confirmed in the Stripe Dashboard

## Known limitations

Worth understanding before taking real money:

- **`orders.json` is not a real datastore.** It's a single-process flat file with no locking. It works for low volume on one server, but it will lose writes under concurrency and won't survive a host with an ephemeral filesystem — most PaaS hosts wipe it on redeploy. Swap `orders.js` for a database before any real traffic.
- **No inventory enforcement.** `outOfStock` is a flag in `products.js`, checked at checkout, but nothing decrements on purchase. The same jar can be sold twice.
- **No shipping or tax.** Checkout charges for glazes only. Enable Stripe Tax and shipping rates on the Checkout Session if you need them.
- **The cart is in-memory** and clears on reload.
- **Product images are hotlinked** from AMACO's CDN. If those URLs rotate or the CDN blocks external referrers, images break and the hex `color` swatch shows instead. Self-host them if that matters.
- **`about.html` is on an older design** than the rest of the site — different fonts and CSS variables.
