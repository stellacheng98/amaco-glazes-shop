// Finished cups: a grid of one-of-a-kind pieces, and a detail view with a photo
// gallery. Buying goes through the server's finished-cup checkout, which prices
// and gates availability from its own inventory (never the browser).

let CUPS = [];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = n => `$${n.toFixed(2)}`;

// Falls back to a solid color swatch when a photo file is missing (e.g. before
// real photos are uploaded).
function artStyle(photo, color) {
  return photo
    ? `background-image:url('${esc(photo)}'),linear-gradient(${color},${color});`
    : `background:${color};`;
}

async function init() {
  try {
    CUPS = await fetch("/api/finished-cups").then(r => r.json());
  } catch (_) {
    document.getElementById("cups-root").innerHTML = `<div class="cups-empty">Couldn't load finished pieces. Please refresh.</div>`;
    return;
  }
  const id = new URLSearchParams(location.search).get("id");
  if (id) renderDetail(id); else renderGrid();
}

function renderGrid() {
  const root = document.getElementById("cups-root");
  const cards = CUPS.map(c => `
    <a class="cup-card" href="cups.html?id=${encodeURIComponent(c.id)}">
      <div class="cup-card-art" style="${artStyle(c.photos[0], c.color)}">
        <span class="cup-card-badge ${c.sold ? "sold" : ""}">${c.sold ? "Sold" : "One of a kind"}</span>
      </div>
      <div class="cup-card-body">
        <span class="cup-card-name">${esc(c.name)}</span>
        <span class="cup-card-price ${c.sold ? "sold" : ""}">${money(c.price)}</span>
      </div>
    </a>`).join("");
  root.innerHTML = `
    <div class="cups-head">
      <p class="cups-eyebrow">Finished pieces</p>
      <h1 class="cups-title">One-of-a-kind pieces</h1>
      <p class="cups-sub">Each of these is a finished piece — glazed, fired, and photographed. Every piece is unique and sells only once. Looking for something made just for you? See <a href="custom.html">custom orders</a>.</p>
    </div>
    ${CUPS.length ? `<div class="cups-grid">${cards}</div>` : `<div class="cups-empty">No finished pieces listed yet — check back soon.</div>`}`;
}

function renderDetail(id) {
  const root = document.getElementById("cups-root");
  const c = CUPS.find(x => x.id === id);
  if (!c) {
    root.innerHTML = `<div class="cups-empty">We couldn't find that piece.<div style="margin-top:16px"><a class="cd-back" href="cups.html">← Back to pieces</a></div></div>`;
    return;
  }
  const photos = c.photos.length ? c.photos : [null];
  const thumbs = photos.map((p, i) => `<div class="cd-thumb ${i === 0 ? "on" : ""}" style="${artStyle(p, c.color)}" onclick="setMain(${i})"></div>`).join("");
  const buy = c.sold
    ? `<button class="btn-primary full-width sold" disabled>Sold</button>`
    : `<button class="btn-primary full-width" id="buy-btn" onclick="buyCup('${esc(c.id)}')">Buy this piece →</button>`;
  root.innerHTML = `
    <a class="cd-back" href="cups.html">← Back to pieces</a>
    <div class="cd-grid">
      <div class="cd-gallery">
        <div class="cd-main" id="cd-main" style="${artStyle(photos[0], c.color)}"></div>
        ${photos.length > 1 ? `<div class="cd-thumbs">${thumbs}</div>` : ""}
      </div>
      <div>
        <span class="cd-oneoff">One of a kind</span>
        <h1 class="cd-name">${esc(c.name)}</h1>
        <div class="cd-price">${money(c.price)}</div>
        <div class="cd-avail ${c.sold ? "sold" : "in"}">${c.sold ? "Sold" : "Available — ships in 3–5 days"}</div>
        <p class="cd-blurb">${esc(c.blurb || "")}</p>
        <div class="cd-err" id="cd-err" role="alert"></div>
        ${buy}
        <p class="cd-note">Secure payment via Stripe · Shipping calculated at checkout. One-of-a-kind pieces are final sale.</p>
      </div>
    </div>`;
  window._photos = photos.map(p => artStyle(p, c.color));
  document.title = `${c.name} — Sample Glaze`;
}

function setMain(i) {
  document.getElementById("cd-main").style.cssText = window._photos[i];
  document.querySelectorAll(".cd-thumb").forEach((t, idx) => t.classList.toggle("on", idx === i));
}

function showError(msg) {
  const el = document.getElementById("cd-err");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 6000);
}

async function buyCup(id) {
  const btn = document.getElementById("buy-btn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Starting checkout…";
  try {
    const res = await fetch("/create-finished-cup-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cupId: id }),
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

init();
