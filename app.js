// ── State ──
let cart = [];
let activeFilter = "all";
let searchQuery = "";

// ── Render Products ──
function renderProducts() {
  const grid = document.getElementById("products-grid");
  const filtered = PRODUCTS.filter(p => {
    const matchSeries = activeFilter === "all" || p.series === activeFilter;
    const q = searchQuery.toLowerCase();
    const matchSearch = !q ||
      p.name.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (SERIES_NAMES[p.series] || "").toLowerCase().includes(q);
    return matchSeries && matchSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="no-results">No glazes found — try a different search or filter.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => `
    <div class="product-card">
      <div class="card-swatch" style="background: ${swatchBg(p.color)}">
        <div class="card-swatch-inner" style="background: ${p.color}"></div>
        <span class="series-badge">${p.series}</span>
        ${p.outOfStock ? `<span class="out-of-stock-badge">Out of Stock</span>` : ""}
        ${p.isNew && !p.outOfStock ? `<span class="new-badge">NEW</span>` : ""}
      </div>
      <div class="card-body">
        <div class="card-code">${p.code}</div>
        <div class="card-name">${p.name}</div>
        <div class="card-footer">
          <div class="card-price">
            $${p.price.toFixed(2)}<span class="size-label">/ 4 oz</span>
          </div>
          <button class="add-btn" onclick="addToCart('${p.code}')"
            ${p.outOfStock ? "disabled title='Out of stock'" : ""}
            aria-label="Add ${p.code} ${p.name} to cart">+</button>
        </div>
      </div>
    </div>
  `).join("");
}

function swatchBg(hex) {
  // light pastel background from the swatch color
  return hex + "22";
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
  if (existing) {
    existing.qty++;
  } else {
    cart.push({ ...product, qty: 1 });
  }
  updateCartUI();
  // brief pulse on add button
  const btn = document.querySelector(`button[aria-label="Add ${code} ${product.name} to cart"]`);
  if (btn) {
    btn.textContent = "✓";
    setTimeout(() => btn.textContent = "+", 700);
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

  const itemsEl = document.getElementById("cart-items");
  const footerEl = document.getElementById("cart-footer");

  if (cart.length === 0) {
    itemsEl.innerHTML = `<p class="cart-empty">Your cart is empty.</p>`;
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
      <div class="cart-item-controls">
        <button class="qty-btn" onclick="changeQty('${item.code}', -1)">−</button>
        <span class="qty-num">${item.qty}</span>
        <button class="qty-btn" onclick="changeQty('${item.code}', 1)">+</button>
      </div>
      <div class="cart-item-price">$${(item.price * item.qty).toFixed(2)}</div>
    </div>
  `).join("");

  const grandTotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  document.getElementById("cart-total").textContent = `$${grandTotal.toFixed(2)}`;
}

// ── Cart Drawer Toggle ──
function toggleCart() {
  const drawer = document.getElementById("cart-drawer");
  const overlay = document.getElementById("cart-overlay");
  const open = drawer.classList.toggle("open");
  overlay.classList.toggle("open", open);
  document.body.style.overflow = open ? "hidden" : "";
}

// ── Checkout placeholder ──
function checkout() {
  alert("Checkout coming soon! Your cart total: " +
    document.getElementById("cart-total").textContent);
}

// ── Init ──
renderProducts();
