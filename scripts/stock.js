// Toggle a glaze's stock flag without writing SQL by hand.
//
//   npm run stock              → list every out-of-stock glaze
//   npm run stock -- C-05      → show one glaze's current status
//   npm run stock -- C-05 out  → mark it out of stock
//   npm run stock -- C-05 in   → mark it in stock
//
// The `--` is how npm forwards arguments to the script; running the file
// directly (`node scripts/stock.js C-05 out`) doesn't need it.
import { getStock, setStock, getOutOfStock } from "../db.js";

const [code, state] = process.argv.slice(2);

const describe = row => `${row.code} ${row.name} — ${row.in_stock ? "in stock" : "OUT of stock"}`;

// No code: list what's currently out of stock.
if (!code) {
  const oos = getOutOfStock();
  if (oos.length === 0) {
    console.log("All glazes are in stock.");
  } else {
    console.log(`Out of stock (${oos.length}):`);
    for (const r of oos) console.log(`  ${r.code}  ${r.name}`);
  }
  process.exit(0);
}

const current = getStock(code);
if (!current) {
  console.error(`No glaze with code "${code}".`);
  process.exit(1);
}

// Code only: just report its status.
if (!state) {
  console.log(describe(current));
  process.exit(0);
}

const normalized = state.toLowerCase();
let inStock;
if (["in", "instock", "in-stock", "1", "true"].includes(normalized)) inStock = true;
else if (["out", "oos", "outofstock", "out-of-stock", "0", "false"].includes(normalized)) inStock = false;
else {
  console.error(`Unknown state "${state}" — use "in" or "out".`);
  process.exit(1);
}

if (Boolean(current.in_stock) === inStock) {
  console.log(`No change — ${current.code} is already ${inStock ? "in stock" : "out of stock"}.`);
  process.exit(0);
}

setStock(code, inStock);
console.log(describe(getStock(code)));
