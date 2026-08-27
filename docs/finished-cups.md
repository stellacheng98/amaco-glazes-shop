# Adding finished cups (one-of-a-kind pieces for sale)

Finished cups shown in the **Cups** section come from the `FINISHED_CUPS` list in
`server.js`. Each cup is a unique piece: it sells once, then you mark it `sold`.
Prices live in `FINISHED_CUPS` (server-side, authoritative) — the browser only
ever sends a cup id.

## 1. Add the photos

Put the photo files in **`public/cups/`**, named `‹id›-‹n›.jpg`:

```
public/cups/fc-004-1.jpg   ← cover (shown in the grid)
public/cups/fc-004-2.jpg   ← detail shot
public/cups/fc-004-3.jpg   ← detail shot
```

Square-ish, ~1000×1000px, under ~500 KB each (JPG/PNG/WebP). The site serves them
at `https://<site>/cups/fc-004-1.jpg`.

## 2. Add the cup to the inventory

In `server.js`, add an entry to `FINISHED_CUPS`:

```js
{
  id: "fc-004", name: "Speckled Teal Mug", price_cents: 5000, sold: false,
  blurb: "Wheel-thrown 10 oz mug in Mayco Speckled Teal, cone 6, dinnerware safe.",
  photos: ["cups/fc-004-1.jpg", "cups/fc-004-2.jpg", "cups/fc-004-3.jpg"],
  color: "#4A8A8A",   // fallback swatch shown until the photo loads
},
```

- `price_cents` is the price in cents (`5000` = $50.00).
- `sold: true` hides the Buy button and shows a "Sold" badge — set it after a piece sells.
- `color` is a fallback swatch; it shows if a photo is missing.

## 3. Deploy

Commit and push, then on each box:

```bash
cd amaco-glazes-shop && git pull --ff-only && sudo systemctl restart glaze-shop
```

(No `sync-catalog` needed — finished cups are priced at checkout with Stripe
`price_data`, not pre-made Stripe Prices.)

## Prefer to hand it off?

Send the photos + each cup's name, price, and a one-line description to
customerservice@sampleglaze.com (or drop them in `public/cups/`), and they can be
wired in for you.
