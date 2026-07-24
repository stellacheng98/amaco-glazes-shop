// Creates a Stripe Product + Price for every glaze in the database and records
// the resulting IDs back on each product row (stripe_product_id / stripe_price_id).
//
// Run once before starting the server, and again whenever glazes or prices
// change:
//
//   npm run sync-catalog
//
// Safe to re-run: a glaze that already has a Stripe price is skipped, and a
// glaze whose database price no longer matches the price recorded in Stripe gets
// a new Price minted and attached as the product's default. The catalog is
// seeded from public/products.js automatically if the database is empty.
import "dotenv/config";
import Stripe from "stripe";
import { seedIfEmpty, getAllProducts, getSeriesMap, setStripeIds } from "../db.js";

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const CURRENCY = "usd";

async function createGlazeProduct(row, seriesNames) {
  const product = await stripe.products.create({
    name: `${row.code} ${row.name}`,
    description: `${seriesNames[row.series_code] || row.series_code} series · 4 oz jar`,
    images: row.image_url ? [row.image_url] : undefined,
    metadata: { glaze_code: row.code, series: row.series_code },
    default_price_data: {
      currency: CURRENCY,
      unit_amount: row.price_cents,
    },
  });
  return { productId: product.id, priceId: product.default_price };
}

// The database price changed, so mint a new Price and make it the default. Stripe
// prices are immutable, so the old one is deactivated rather than edited.
async function repriceGlazeProduct(row) {
  const price = await stripe.prices.create({
    product: row.stripe_product_id,
    currency: CURRENCY,
    unit_amount: row.price_cents,
  });
  await stripe.products.update(row.stripe_product_id, { default_price: price.id });
  if (row.stripe_price_id) await stripe.prices.update(row.stripe_price_id, { active: false });
  return price.id;
}

async function syncCatalog() {
  seedIfEmpty();

  const seriesNames = getSeriesMap();
  const products = getAllProducts();
  let created = 0;
  let repriced = 0;
  let unchanged = 0;

  for (const row of products) {
    if (!row.stripe_product_id) {
      const { productId, priceId } = await createGlazeProduct(row, seriesNames);
      // Written per glaze so an interrupted run doesn't orphan products in Stripe
      // that the database has no record of.
      setStripeIds(row.code, { productId, priceId, priceCents: row.price_cents });
      created++;
      console.log(`created  ${row.code} ${row.name} → ${priceId}`);
    } else if (row.stripe_price_cents !== row.price_cents) {
      const priceId = await repriceGlazeProduct(row);
      setStripeIds(row.code, { productId: row.stripe_product_id, priceId, priceCents: row.price_cents });
      repriced++;
      console.log(`repriced ${row.code} ${row.name} → ${priceId}`);
    } else {
      unchanged++;
    }
  }

  console.log(`\nDone. ${created} created, ${repriced} repriced, ${unchanged} unchanged.`);
  console.log(`${products.length} glazes recorded in the database.`);
}

syncCatalog().catch(err => {
  console.error("Catalog sync failed:", err.message);
  process.exit(1);
});
