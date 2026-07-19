// Loads the glaze catalog from products.js so the browser and the server share
// one source of truth. products.js is a plain browser script (it declares bare
// globals rather than exporting), so it's evaluated in a throwaway VM context
// instead of imported.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

function loadCatalog() {
  const source = readFileSync(join(rootDir, "public", "products.js"), "utf8");
  const context = createContext({});
  // products.js declares PRODUCTS/SERIES_NAMES with `const`, which stays in the
  // script's lexical scope rather than landing on the context object, so the
  // values are handed over explicitly by code appended to the same script.
  const handoff = ";globalThis.__catalog = { PRODUCTS, SERIES_NAMES };";
  runInContext(source + handoff, context, { filename: "products.js" });

  const { PRODUCTS, SERIES_NAMES } = context.__catalog ?? {};
  if (!Array.isArray(PRODUCTS) || PRODUCTS.length === 0) {
    throw new Error("Could not read PRODUCTS from public/products.js");
  }
  return { products: PRODUCTS, seriesNames: SERIES_NAMES ?? {} };
}

export const { products: PRODUCTS, seriesNames: SERIES_NAMES } = loadCatalog();

export function findProduct(code) {
  return PRODUCTS.find(p => p.code === code);
}
