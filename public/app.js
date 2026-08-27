// ── State ──
// The catalog is fetched from the server at load (see init) rather than shipped
// as a baked-in script, so a price, photo or stock change is live on next load
// without a redeploy. These start empty and are filled once the fetch resolves.
let PRODUCTS = [];
let SERIES_NAMES = {};
let PIECES = [];   // one-of-a-kind finished pieces (for cart rehydration)

let cart = [];
let activeFilter = "all";
let searchQuery = "";

// ── Cart persistence ──
// Only the identity is stored — { code, qty } for a glaze, { kind:"piece", id }
// for a one-of-a-kind piece. Name/price/photo are re-hydrated from PRODUCTS /
// PIECES on load, so a catalog or price change is never served stale from a
// shopper's browser — same trust model the server uses when it re-prices.
const CART_KEY = "amaco-cart-v1";

function pieceToCartItem(pc) {
  return { kind: "piece", id: pc.id, name: pc.name, price: pc.price, img: (pc.photos && pc.photos[0]) || null, color: pc.color, qty: 1 };
}

function saveCart() {
  try {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify(cart.map(i => (i.kind === "piece" ? { kind: "piece", id: i.id } : { code: i.code, qty: i.qty })))
    );
  } catch (_) {
    // Private mode or storage full — degrade to in-memory-only, as before.
  }
}

// Returns { items, dropped } where `dropped` names entries that are no longer
// purchasable (left the catalog, went out of stock, or a piece that sold).
function loadCart() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
  } catch (_) {
    return { items: [], dropped: [] };
  }
  if (!Array.isArray(stored)) return { items: [], dropped: [] };

  const items = [];
  const dropped = [];
  for (const entry of stored) {
    if (entry && (entry.kind === "piece" || entry.id != null)) {
      const pc = PIECES.find(p => String(p.id) === String(entry.id));
      if (!pc) { dropped.push("a piece"); continue; }
      if (pc.sold) { dropped.push(pc.name); continue; }
      items.push(pieceToCartItem(pc));
      continue;
    }
    const product = PRODUCTS.find(p => p.code === entry.code);
    if (!product) { dropped.push(entry.code); continue; }
    if (product.outOfStock) { dropped.push(product.name); continue; }
    // Clamp to the server's accepted range (1..99).
    const qty = Math.min(99, Math.max(1, Math.floor(Number(entry.qty) || 0)));
    items.push({ kind: "glaze", ...product, qty });
  }
  return { items, dropped };
}

// ── Toast ──
function showToast(message) {
  const el = document.createElement("div");
  el.className = "cart-toast";
  el.textContent = message;
  el.style.cssText = `
    position: fixed; left: 50%; bottom: 28px;
    transform: translateX(-50%) translateY(12px);
    max-width: min(420px, 90vw); z-index: 2000;
    background: var(--ink, #3a3226); color: #fff;
    padding: 13px 20px; border-radius: 12px;
    font-size: .88rem; line-height: 1.5;
    box-shadow: 0 8px 30px rgba(0,0,0,.18);
    opacity: 0; transition: opacity .3s ease, transform .3s ease;
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(12px)";
    setTimeout(() => el.remove(), 300);
  }, 5000);
}

// ── Hero floating swatches ──
function initHeroSwatches() {
  const container = document.getElementById("hero-swatches");
  if (!container) return;
  const picks = PRODUCTS.filter(p => !p.outOfStock)
    .sort(() => Math.random() - .5).slice(0, 10);
  picks.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "hero-swatch";
    const size = 32 + Math.random() * 48;
    const left = 2 + Math.random() * 96;
    const top  = 5 + Math.random() * 90;
    const delay = Math.random() * 6;
    const dur   = 5 + Math.random() * 5;
    el.style.cssText = `
      width:${size}px; height:${size}px;
      left:${left}%; top:${top}%;
      background:${p.color};
      animation-duration:${dur}s;
      animation-delay:-${delay}s;
    `;
    container.appendChild(el);
  });
}

// ── Render Products ──
function renderProducts() {
  const grid = document.getElementById("products-grid");
  const q = searchQuery.toLowerCase();
  const filtered = PRODUCTS.filter(p => {
    const matchSeries = activeFilter === "all" || p.series === activeFilter;
    const matchSearch = !q ||
      p.name.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (SERIES_NAMES[p.series] || "").toLowerCase().includes(q);
    return matchSeries && matchSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="no-results">
        <span class="no-results-icon">🔍</span>
        No glazes found — try a different search or filter.
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const bgAlpha = p.color + "22";
    const imgHtml = p.img
      ? `<img class="card-img" src="${p.img}" alt="${p.code} ${p.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"  />
         <div class="card-swatch-circle" style="background:linear-gradient(145deg,${lighten(p.color)},${p.color});display:none"></div>`
      : `<div class="card-swatch-circle" style="background:linear-gradient(145deg,${lighten(p.color)},${p.color})"></div>`;
    // The whole card links to its detail page; the add button stops the click
    // from bubbling so "+" still just adds to the cart without navigating.
    return `
    <div class="product-card" onclick="location.href='product.html?code=${encodeURIComponent(p.code)}'">
      <div class="card-swatch" style="background:${bgAlpha}">
        ${imgHtml}
        <div class="badge-row">
          <span class="badge badge-series">${p.series}</span>
          ${p.outOfStock
            ? `<span class="badge badge-oos">Out of stock</span>`
            : p.isNew
            ? `<span class="badge badge-new">New</span>`
            : ""}
        </div>
      </div>
      <div class="card-body">
        <div class="card-code">${p.code}</div>
        <div class="card-name">${p.name}</div>
        <div class="card-footer">
          <div class="card-price">
            <span class="card-price-amount">$${p.price.toFixed(2)}</span>
            <span class="card-price-label">4 oz jar</span>
          </div>
          <button
            class="add-btn"
            id="btn-${p.code.replace(/[^a-z0-9]/gi,'')}"
            onclick="event.stopPropagation(); addToCart('${p.code}')"
            ${p.outOfStock ? "disabled" : ""}
            aria-label="Add ${p.name} to cart"
          >+</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function lighten(hex) {
  // shift color 20% lighter for gradient top
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const lr = Math.min(255, r + 50);
  const lg = Math.min(255, g + 50);
  const lb = Math.min(255, b + 50);
  return `rgb(${lr},${lg},${lb})`;
}

// ── Filters ──
// Guarded: these controls only exist on the shop page. app.js also runs on
// pages that just need the cart (e.g. about), where they are absent.
const filterChips = document.getElementById("filter-chips");
if (filterChips) {
  filterChips.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.dataset.series;
    renderProducts();
  });
}

const searchInput = document.getElementById("search");
if (searchInput) {
  searchInput.addEventListener("input", e => {
    searchQuery = e.target.value;
    renderProducts();
  });
}

// ── Cart ──
function addToCart(code) {
  const product = PRODUCTS.find(p => p.code === code);
  if (!product || product.outOfStock) return;

  const existing = cart.find(i => i.kind !== "piece" && i.code === code);
  if (existing) existing.qty++;
  else cart.push({ kind: "glaze", ...product, qty: 1 });

  updateCartUI();

  // pulse button
  const safeId = code.replace(/[^a-z0-9]/gi, "");
  const btn = document.getElementById(`btn-${safeId}`);
  if (btn) {
    btn.textContent = "✓";
    btn.classList.add("added");
    setTimeout(() => { btn.textContent = "+"; btn.classList.remove("added"); }, 800);
  }
}

// Add a one-of-a-kind piece. Only one of each (qty 1) and never a sold piece.
function addPieceToCart(id) {
  const pc = PIECES.find(p => String(p.id) === String(id));
  if (!pc || pc.sold) return;
  if (cart.some(i => i.kind === "piece" && String(i.id) === String(id))) {
    showToast(`${pc.name} is already in your cart.`);
    return;
  }
  cart.push(pieceToCartItem(pc));
  updateCartUI();
  showToast(`Added ${pc.name} to your cart.`);
}

function changeQty(code, delta) {
  const item = cart.find(i => i.kind !== "piece" && i.code === code);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter(i => !(i.kind !== "piece" && i.code === code));
  updateCartUI();
}

function removePiece(id) {
  cart = cart.filter(i => !(i.kind === "piece" && String(i.id) === String(id)));
  updateCartUI();
}

function updateCartUI() {
  saveCart();

  const total = cart.reduce((s, i) => s + i.qty, 0);
  document.getElementById("cart-count").textContent = total;

  const itemsEl  = document.getElementById("cart-items");
  const footerEl = document.getElementById("cart-footer");

  if (cart.length === 0) {
    itemsEl.innerHTML = `<div class="cart-empty"><span class="cart-empty-icon">🏺</span>Your cart is empty.</div>`;
    footerEl.style.display = "none";
    return;
  }

  footerEl.style.display = "block";
  itemsEl.innerHTML = cart.map(item => {
    // Show the photo, falling back to the color swatch if missing or it fails to
    // load — same pattern as the product cards.
    const alt = item.kind === "piece" ? item.name : `${item.code} ${item.name}`;
    const thumb = item.img
      ? `<img class="cart-item-img" src="${item.img}" alt="${alt}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
         <div class="cart-item-swatch" style="background:${item.color};display:none"></div>`
      : `<div class="cart-item-swatch" style="background:${item.color}"></div>`;

    if (item.kind === "piece") {
      // One-of-a-kind: no quantity, just a remove control.
      return `
      <div class="cart-item">
        ${thumb}
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-sub">One of a kind</div>
        </div>
        <div class="cart-item-right">
          <span class="cart-item-price">$${item.price.toFixed(2)}</span>
          <div class="cart-item-controls">
            <button class="qty-btn" onclick="removePiece('${item.id}')" aria-label="Remove piece">✕</button>
          </div>
        </div>
      </div>`;
    }

    return `
    <div class="cart-item">
      ${thumb}
      <div class="cart-item-info">
        <div class="cart-item-name">${item.code} ${item.name}</div>
        <div class="cart-item-sub">4 oz · $${item.price.toFixed(2)} each</div>
      </div>
      <div class="cart-item-right">
        <span class="cart-item-price">$${(item.price * item.qty).toFixed(2)}</span>
        <div class="cart-item-controls">
          <button class="qty-btn" onclick="changeQty('${item.code}', -1)">−</button>
          <span class="qty-num">${item.qty}</span>
          <button class="qty-btn" onclick="changeQty('${item.code}', 1)">+</button>
        </div>
      </div>
    </div>
  `;
  }).join("");

  const grand = cart.reduce((s, i) => s + i.price * i.qty, 0);
  document.getElementById("cart-total").textContent = `$${grand.toFixed(2)}`;
}

// ── Product detail page ──
// Renders product.html from the ?code= query param against the live catalog.
// Reuses addToCart/toggleCart, so the cart works here exactly as on the shop.
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function renderProductDetail() {
  const root = document.getElementById("product-detail");
  if (!root) return;

  const code = new URLSearchParams(location.search).get("code");
  const p = PRODUCTS.find(x => x.code === code);

  if (!p) {
    root.innerHTML = `
      <div class="pdp-empty">
        <span class="pdp-empty-icon">🔍</span>
        We couldn't find that glaze.
        <div style="margin-top:20px"><a class="pdp-back" href="shop.html">← Back to shop</a></div>
      </div>`;
    document.title = "Glaze not found — Sample Glaze";
    return;
  }

  const seriesName = SERIES_NAMES[p.series] || p.series;
  const media = p.img
    ? `<img src="${p.img}" alt="${escapeHtml(p.code + " " + p.name)}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
       <div class="pdp-swatch" style="background:${p.color};display:none"></div>`
    : `<div class="pdp-swatch" style="background:${p.color}"></div>`;

  // Quick facts — only rows the AMACO source actually gave us; Size and Series
  // are always known. See db.js for how `specs` is sourced and stored.
  const s = p.specs || {};
  const factRows = [
    ["Finish", s.finish],
    ["Fired color", s.firedColor],
    ["Effect", s.effect],
    ["Over texture", s.overTexture],
    ["Cone", s.cone],
    ["Size", "4 oz sample jar"],
    ["Series", seriesName],
  ].filter(([, v]) => v);
  const factsHtml = `
    <section class="facts">
      <h2>Quick facts</h2>
      <dl>${factRows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
    </section>`;

  // How to use — application/run/cone tips, shown only where AMACO states them.
  const howtoItems = [];
  if (s.application) howtoItems.push(s.application);
  if (s.run) howtoItems.push(s.run);
  if (s.cone) howtoItems.push(`Fire to ${s.cone}.`);
  const howtoHtml = howtoItems.length
    ? `<section class="howto">
         <h2>How to use</h2>
         <ul>${howtoItems.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
       </section>`
    : "";

  // The brand's own name and its source page drive the attribution line, so a
  // Mayco glaze credits Mayco (and links to maycocolors.com) rather than AMACO.
  const brand = p.brand || "AMACO";
  const sourceUrl = s.sourceUrl || s.amacoUrl;
  let sourceHtml = "";
  if (sourceUrl) {
    let host = "the manufacturer's site";
    try { host = new URL(sourceUrl).host.replace(/^www\./, ""); } catch { /* keep fallback */ }
    sourceHtml = `<br><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">View the original glaze on ${escapeHtml(host)} ↗</a>`;
  }

  root.innerHTML = `
    <a class="pdp-back" href="shop.html">← Back to shop</a>
    <div class="pdp-grid">
      <div class="pdp-media">${media}</div>
      <div class="pdp-info">
        <div class="pdp-series">${escapeHtml(seriesName)}</div>
        <div class="pdp-code">${escapeHtml(p.code)}</div>
        <h1 class="pdp-name">${escapeHtml(p.name)}</h1>
        <div class="pdp-rowline">
          <span class="pdp-price">$${p.price.toFixed(2)} <span>· 4 oz jar</span></span>
          <span class="pdp-stock ${p.outOfStock ? "out" : "in"}">${p.outOfStock ? "Out of stock" : "In stock"}</span>
        </div>
        ${p.description ? `<p class="pdp-desc">${escapeHtml(p.description)}</p>` : ""}
        ${factsHtml}
        ${howtoHtml}
        <div class="pdp-actions">
          <button class="btn-primary" onclick="addToCart('${p.code}'); showToast('Added ${escapeHtml(p.name)} to your cart.')"
            ${p.outOfStock ? "disabled" : ""}>Add to cart →</button>
        </div>
        <p class="pdp-note">Secure payment via Stripe · Shipping calculated at checkout</p>
        <p class="pdp-attribution">${escapeHtml(p.code)} ${escapeHtml(p.name)} is a ${escapeHtml(brand)} brand glaze, resold here as a 4 oz sample. Sample Glaze is not affiliated with or endorsed by ${escapeHtml(brand)}.${sourceHtml}</p>
      </div>
    </div>`;

  document.title = `${p.code} ${p.name} — Sample Glaze`;
  if (p.description) {
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "description"; document.head.appendChild(meta); }
    meta.content = p.description;
  }
}

// ── Cart drawer ──
function toggleCart() {
  const drawer  = document.getElementById("cart-drawer");
  const overlay = document.getElementById("cart-overlay");
  const open = drawer.classList.toggle("open");
  overlay.classList.toggle("open", open);
  document.body.style.overflow = open ? "hidden" : "";
}

// ── Checkout ──
// Sends only identities — glaze { code, qty } or piece { kind, pieceId }. The
// server re-prices each from the DB, so the amount never depends on the browser.
async function checkout() {
  if (cart.length === 0) return;

  const btn = document.getElementById("checkout-btn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Starting checkout…";

  try {
    const res = await fetch("/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: cart.map(i => (i.kind === "piece" ? { kind: "piece", pieceId: i.id } : { code: i.code, qty: i.qty })),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Checkout is unavailable right now.");

    // Hand off to Stripe's hosted Checkout page.
    window.location.href = data.url;
  } catch (err) {
    showCheckoutError(err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function showCheckoutError(message) {
  const el = document.getElementById("checkout-error");
  if (!el) return;
  el.textContent = message;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 6000);
}

// ── Init ──
// Fetch the catalog first, then render and rehydrate the cart against it. The
// cart stores only { code, qty }, so it must not be restored until PRODUCTS is
// populated or every entry would look dropped.
async function init() {
  try {
    const [products, series] = await Promise.all([
      fetch("/api/products").then(r => { if (!r.ok) throw new Error("products"); return r.json(); }),
      fetch("/api/series").then(r => { if (!r.ok) throw new Error("series"); return r.json(); }),
    ]);
    PRODUCTS = products;
    SERIES_NAMES = series;
  } catch (_) {
    // On the shop page, surface the failure in the grid. On cart-only pages
    // (no grid) there is nothing to render, so just bail — the cart stays empty.
    const grid = document.getElementById("products-grid");
    if (grid) {
      grid.innerHTML = `
      <div class="no-results">
        <span class="no-results-icon">⚠️</span>
        We couldn't load the catalog. Please refresh the page.
      </div>`;
    }
    return;
  }

  initHeroSwatches();
  // The product grid, hero swatches and filters are shop-only; the cart runs
  // everywhere app.js is loaded.
  if (document.getElementById("products-grid")) renderProducts();
  if (document.getElementById("product-detail")) renderProductDetail();

  // Pieces power the cart's one-of-a-kind items on every page (rehydration and
  // the Pieces page's add-to-cart). A failure here just leaves PIECES empty.
  PIECES = await fetch("/api/finished-cups").then(r => (r.ok ? r.json() : [])).catch(() => []);

  // Restore the cart from a prior visit / the Stripe round trip.
  const { items, dropped } = loadCart();
  cart = items;
  updateCartUI();
  if (dropped.length) {
    const names = dropped.join(", ");
    showToast(
      dropped.length === 1
        ? `${names} is no longer available and was removed from your cart.`
        : `${names} are no longer available and were removed from your cart.`
    );
  }
}

init();

// Back/forward from Stripe restores the page from bfcache with the *old* in-memory
// cart still in the heap. Re-read storage so a cleared (paid) or changed cart wins.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  cart = loadCart().items;
  updateCartUI();
});
