// Seeds the database from public/products.js and migrates any legacy orders.json.
//
// The server runs this automatically on startup, so it is rarely needed by hand;
// it is here for an explicit one-off (e.g. priming a fresh database before the
// first `npm run sync-catalog`). Idempotent — tables that already have rows are
// left untouched.
import { seedIfEmpty } from "../db.js";

seedIfEmpty();
console.log("Database ready.");
