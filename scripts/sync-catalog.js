// Creates a Stripe Product + Price for every glaze in products.js and records
// the resulting price IDs in stripe-prices.json.
//
// Run once before starting the server, and again whenever glazes or prices
// change in products.js:
//
//   npm run sync-catalog
//
// Safe to re-run: glazes already recorded in stripe-prices.json are skipped,
// and a glaze whose local price no longer matches Stripe gets a new Price
// attached as the product's default.
import "dotenv/config";
import Stripe from "stripe";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRODUCTS, SERIES_NAMES } from "../catalog.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(rootDir, "stripe-prices.json");

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CURRENCY = "usd";

// Stripe stores amounts in the smallest currency unit, so $7.99 is 799 cents.
const toMinorUnits = dollars => Math.round(dollars * 100);

function readExistingCatalog() {
  if (!existsSync(catalogPath)) return {};
  try {
    return JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    console.warn("stripe-prices.json is unreadable — starting a fresh mapping.");
    return {};
  }
}

async function createGlazeProduct(glaze) {
  const product = await stripe.products.create({
    name: `${glaze.code} ${glaze.name}`,
    description: `${SERIES_NAMES[glaze.series] || glaze.series} series · 4 oz jar`,
    images: glaze.img ? [glaze.img] : undefined,
    metadata: { glaze_code: glaze.code, series: glaze.series },
    default_price_data: {
      currency: CURRENCY,
      unit_amount: toMinorUnits(glaze.price),
    },
  });
  return product;
}

// The local price changed, so mint a new Price and make it the default. Stripe
// prices are immutable, so the old one is deactivated rather than edited.
async function repriceGlazeProduct(glaze, productId, stalePriceId) {
  const price = await stripe.prices.create({
    product: productId,
    currency: CURRENCY,
    unit_amount: toMinorUnits(glaze.price),
  });
  await stripe.products.update(productId, { default_price: price.id });
  await stripe.prices.update(stalePriceId, { active: false });
  return price;
}

async function syncCatalog() {
  const catalog = readExistingCatalog();
  let created = 0;
  let repriced = 0;
  let unchanged = 0;

  for (const glaze of PRODUCTS) {
    const existing = catalog[glaze.code];

    if (!existing) {
      const product = await createGlazeProduct(glaze);
      catalog[glaze.code] = {
        productId: product.id,
        priceId: product.default_price,
        unitAmount: toMinorUnits(glaze.price),
      };
      created++;
      console.log(`created  ${glaze.code} ${glaze.name} → ${product.default_price}`);
    } else if (existing.unitAmount !== toMinorUnits(glaze.price)) {
      const price = await repriceGlazeProduct(glaze, existing.productId, existing.priceId);
      catalog[glaze.code] = {
        productId: existing.productId,
        priceId: price.id,
        unitAmount: toMinorUnits(glaze.price),
      };
      repriced++;
      console.log(`repriced ${glaze.code} ${glaze.name} → ${price.id}`);
    } else {
      unchanged++;
    }

    // Persist after every glaze so an interrupted run doesn't orphan products
    // in Stripe that this file has no record of.
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  }

  console.log(`\nDone. ${created} created, ${repriced} repriced, ${unchanged} unchanged.`);
  console.log(`Mapping written to stripe-prices.json (${Object.keys(catalog).length} glazes).`);
}

syncCatalog().catch(err => {
  console.error("Catalog sync failed:", err.message);
  process.exit(1);
});
