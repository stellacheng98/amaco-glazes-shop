// ── State ──
let cart = [];
let activeFilter = "all";
let searchQuery = "";

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
    const bgAlpha = p.color + "28";
    return `
    <div class="product-card">
      <div class="card-swatch" style="background:${bgAlpha}">
        <div class="card-swatch-bg" style="background:radial-gradient(circle at 30% 30%, ${p.color}55, transparent 70%)"></div>
        <div class="card-swatch-circle" style="background:linear-gradient(145deg, ${lighten(p.color)}, ${p.color})"></div>
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
  itemsEl.innerHTML = cart.map(item => `
    <div class="cart-item">
      <div class="cart-item-swatch" style="background:${item.color}"></div>
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
  `).join("");

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

function checkout() {
  alert("Checkout coming soon!\n\nTotal: " + document.getElementById("cart-total").textContent);
}

// ── Init ──
initHeroSwatches();
renderProducts();
