// ── State ──
let cart = [];
let activeFilter = "all";
let searchQuery = "";

// ── Cart persistence ──
// Only { code, qty } is stored. Name/price/color are re-hydrated from PRODUCTS
// on load, so a catalog or price change is never served stale from a shopper's
// browser — same trust model the server uses when it re-prices each code.
const CART_KEY = "amaco-cart-v1";

function saveCart() {
  try {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify(cart.map(i => ({ code: i.code, qty: i.qty })))
    );
  } catch (_) {
    // Private mode or storage full — degrade to in-memory-only, as before.
  }
}

// Returns { items, dropped } where `dropped` names entries that are no longer
// purchasable (left the catalog or went out of stock) so we can tell the user.
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
    const product = PRODUCTS.find(p => p.code === entry.code);
    if (!product) {
      dropped.push(entry.code);
      continue;
    }
    if (product.outOfStock) {
      dropped.push(product.name);
      continue;
    }
    // Clamp to the server's accepted range (1..99).
    const qty = Math.min(99, Math.max(1, Math.floor(Number(entry.qty) || 0)));
    items.push({ ...product, qty });
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
    return `
    <div class="product-card">
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
            onclick="addToCart('${p.code}')"
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
document.getElementById("filter-chips").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
  activeFilter = chip.dataset.series;
  renderProducts();
});

document.getElementById("search").addEventListener("input", e => {
  searchQuery = e.target.value;
  renderProducts();
});

// ── Cart ──
function addToCart(code) {
  const product = PRODUCTS.find(p => p.code === code);
  if (!product || product.outOfStock) return;

  const existing = cart.find(i => i.code === code);
  if (existing) existing.qty++;
  else cart.push({ ...product, qty: 1 });

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

function changeQty(code, delta) {
  const item = cart.find(i => i.code === code);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter(i => i.code !== code);
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
    // Show the product photo, falling back to the color swatch if it is missing
    // or fails to load — same pattern as the product cards.
    const thumb = item.img
      ? `<img class="cart-item-img" src="${item.img}" alt="${item.code} ${item.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
         <div class="cart-item-swatch" style="background:${item.color};display:none"></div>`
      : `<div class="cart-item-swatch" style="background:${item.color}"></div>`;
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

// ── Cart drawer ──
function toggleCart() {
  const drawer  = document.getElementById("cart-drawer");
  const overlay = document.getElementById("cart-overlay");
  const open = drawer.classList.toggle("open");
  overlay.classList.toggle("open", open);
  document.body.style.overflow = open ? "hidden" : "";
}

// ── Checkout ──
// Sends glaze codes and quantities only. The server resolves each code to a
// Stripe Price, so the amount charged never depends on anything sent here.
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
        items: cart.map(i => ({ code: i.code, qty: i.qty })),
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
initHeroSwatches();
renderProducts();

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

// Back/forward from Stripe restores the page from bfcache with the *old* in-memory
// cart still in the heap. Re-read storage so a cleared (paid) or changed cart wins.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  cart = loadCart().items;
  updateCartUI();
});
