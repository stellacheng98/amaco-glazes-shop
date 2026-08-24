// Build-a-Cup: pick a base cup, add glaze test tiles ($1 single / $2 combo),
// then hand off to the server's dynamic Stripe checkout. All prices are read
// back from the server at checkout — nothing here is trusted for the amount.

let CUPS = [];
let TILE_PRICE = 1, COMBO_PRICE = 2, MAX_TILES = 12;
let GLAZES = [];
let byCode = {};

let selectedCupId = null;
let tiles = [];           // [{ glazes: ["PC-11"] } | { glazes: ["PC-11","SW-100"] }]
let mode = "single";      // "single" | "combo"
let comboPick = [];       // codes chosen so far in combo mode
let search = "";

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function init() {
  try {
    const [cupsData, products] = await Promise.all([
      fetch("/api/cups").then(r => r.json()),
      fetch("/api/products").then(r => r.json()),
    ]);
    CUPS = cupsData.cups || [];
    TILE_PRICE = cupsData.tilePrice ?? 1;
    COMBO_PRICE = cupsData.comboPrice ?? 2;
    MAX_TILES = cupsData.maxTiles ?? 12;
    GLAZES = products;
    byCode = Object.fromEntries(products.map(p => [p.code, p]));
  } catch (_) {
    document.getElementById("cup-options").innerHTML = `<div class="tile-empty">Couldn't load the builder. Please refresh.</div>`;
    return;
  }
  renderCups();
  renderGlazes();
  renderSummary();
  updateComboHint();
}

function renderCups() {
  const el = document.getElementById("cup-options");
  el.innerHTML = CUPS.map(c => `
    <button class="cup-opt ${c.id === selectedCupId ? "sel" : ""}" onclick="selectCup('${c.id}')">
      <div class="cup-opt-art" style="background:${c.color || "#EADFCC"}">☕</div>
      <div class="cup-opt-body">
        <div class="cup-opt-name">${esc(c.name)}</div>
        <div class="cup-opt-blurb">${esc(c.blurb || "")}</div>
        <div class="cup-opt-price">$${c.price.toFixed(2)}</div>
      </div>
    </button>`).join("");
}

function selectCup(id) {
  selectedCupId = id;
  renderCups();
  renderSummary();
}

function setMode(m) {
  mode = m;
  comboPick = [];
  document.getElementById("mode-single").classList.toggle("on", m === "single");
  document.getElementById("mode-combo").classList.toggle("on", m === "combo");
  renderGlazes();
  updateComboHint();
}

function updateComboHint() {
  const hint = document.getElementById("combo-hint");
  if (mode !== "combo") { hint.textContent = "Tap a glaze to add it as its own $1 tile."; return; }
  if (comboPick.length === 0) hint.innerHTML = "Combo mode: pick <b>two</b> glazes to layer on one $2 tile.";
  else hint.innerHTML = `Combo mode: <b>${esc(comboPick[0])}</b> selected — pick one more to pair.`;
}

function renderGlazes() {
  const grid = document.getElementById("glz-grid");
  const q = search.toLowerCase();
  const list = GLAZES.filter(p => {
    if (p.outOfStock) return false;
    if (!q) return true;
    return p.code.toLowerCase().includes(q)
      || p.name.toLowerCase().includes(q)
      || (p.series || "").toLowerCase().includes(q)
      || (p.brand || "").toLowerCase().includes(q);
  });
  if (list.length === 0) { grid.innerHTML = `<div class="tile-empty">No glazes match "${esc(search)}".</div>`; return; }
  grid.innerHTML = list.map(p => {
    const bg = p.img ? `background-image:url('${esc(p.img)}')` : `background:${p.color}`;
    const picked = mode === "combo" && comboPick.includes(p.code);
    return `
      <button class="glz ${picked ? "picked" : ""}" onclick="pickGlaze('${esc(p.code)}')" title="${esc(p.code + " " + p.name)}">
        <span class="glz-swatch" style="${bg}"></span>
        <span class="glz-meta">
          <span class="glz-code">${esc(p.code)}</span>
          <span class="glz-name">${esc(p.name)}</span>
        </span>
      </button>`;
  }).join("");
}

function pickGlaze(code) {
  if (tiles.length >= MAX_TILES && !(mode === "combo" && comboPick.length === 1)) {
    return showError(`A cup can hold up to ${MAX_TILES} tiles.`);
  }
  if (mode === "single") {
    tiles.push({ glazes: [code] });
    renderSummary();
    return;
  }
  // combo mode
  if (comboPick.includes(code)) { comboPick = comboPick.filter(c => c !== code); }
  else if (comboPick.length < 2) { comboPick.push(code); }
  if (comboPick.length === 2) {
    tiles.push({ glazes: [...comboPick] });
    comboPick = [];
    renderSummary();
  }
  renderGlazes();
  updateComboHint();
}

function removeTile(i) {
  tiles.splice(i, 1);
  renderSummary();
}

function tileCostCents(t) { return t.glazes.length === 2 ? COMBO_PRICE * 100 : TILE_PRICE * 100; }

function renderSummary() {
  const cup = CUPS.find(c => c.id === selectedCupId);
  document.getElementById("summary-cup").innerHTML = cup
    ? `<strong>${esc(cup.name)}</strong> · $${cup.price.toFixed(2)}`
    : `<span class="muted">No cup selected yet.</span>`;

  const listEl = document.getElementById("tile-list");
  if (tiles.length === 0) {
    listEl.innerHTML = `<li class="tile-empty">No tiles yet — add a glaze.</li>`;
  } else {
    listEl.innerHTML = tiles.map((t, i) => {
      const chips = t.glazes.map(code => {
        const p = byCode[code];
        const bg = p && p.img ? `background-image:url('${esc(p.img)}');background-size:cover` : `background:${p ? p.color : "#ccc"}`;
        return `<span class="tile-chip" style="${bg}" title="${esc(code)}"></span>`;
      }).join("");
      const label = t.glazes.join(" + ");
      const cost = t.glazes.length === 2 ? COMBO_PRICE : TILE_PRICE;
      return `
        <li class="tile-row">
          <span class="tile-chips">${chips}</span>
          <span class="tile-label">${esc(label)}</span>
          <span class="tile-cost">$${cost.toFixed(2)}</span>
          <button class="tile-x" onclick="removeTile(${i})" aria-label="Remove tile">✕</button>
        </li>`;
    }).join("");
  }

  const cupCents = cup ? Math.round(cup.price * 100) : 0;
  const totalCents = cupCents + tiles.reduce((s, t) => s + tileCostCents(t), 0);
  document.getElementById("summary-total").textContent = `$${(totalCents / 100).toFixed(2)}`;
}

function showError(msg) {
  const el = document.getElementById("bac-err");
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 5000);
}

async function cupCheckout() {
  if (!selectedCupId) return showError("Please pick a base cup first.");
  if (tiles.length === 0) return showError("Add at least one glaze tile.");

  const btn = document.getElementById("cup-checkout");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Starting checkout…";
  try {
    const res = await fetch("/create-cup-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cupId: selectedCupId, tiles }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Checkout is unavailable right now.");
    window.location.href = data.url;
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

document.getElementById("glz-search").addEventListener("input", e => { search = e.target.value; renderGlazes(); });
document.getElementById("mode-single").addEventListener("click", () => setMode("single"));
document.getElementById("mode-combo").addEventListener("click", () => setMode("combo"));

init();
