// Pieces admin. The UI stays locked until the password is accepted by the gated
// /api/admin/pieces endpoint; a wrong password never reveals the admin content.
// The password is asked once and kept for the session; every request carries it
// as HTTP Basic auth. Photos are S3 URLs entered by hand.

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = n => `$${Number(n).toFixed(2)}`;

function authHeader() {
  const pw = sessionStorage.getItem("sg_admin_pw") || "";
  return "Basic " + btoa("admin:" + pw);
}
function clearAuth() { sessionStorage.removeItem("sg_admin_pw"); }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("Wrong admin password.");
  if (res.status === 503) throw new Error("Admin isn't configured on this server (ADMIN_PASSWORD not set).");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function showLock(msg) {
  document.getElementById("admin-content").style.display = "none";
  const lock = document.getElementById("admin-lock");
  lock.style.display = "";
  if (msg) document.getElementById("lock-msg").textContent = msg;
}

// Ask for the password (if needed), then verify it against the gated API. Only
// reveal the admin UI on success; otherwise keep it hidden and stay on the lock.
async function unlock() {
  if (!sessionStorage.getItem("sg_admin_pw")) {
    const pw = prompt("Admin password:");
    if (pw === null) { showLock("Enter the admin password to manage pieces."); return; }
    sessionStorage.setItem("sg_admin_pw", pw);
  }
  try {
    const pieces = await api("GET", "/api/admin/pieces");
    document.getElementById("admin-lock").style.display = "none";
    document.getElementById("admin-content").style.display = "";
    renderList(pieces);
  } catch (err) {
    clearAuth();
    showLock(err.message || "Wrong admin password.");
  }
}

async function refresh() {
  try { renderList(await api("GET", "/api/admin/pieces")); }
  catch (err) { clearAuth(); showLock(err.message); }
}

function renderList(pieces) {
  const list = document.getElementById("plist");
  if (!pieces.length) { list.innerHTML = `<div class="adm-empty">No pieces yet — add one above.</div>`; return; }
  list.innerHTML = pieces.map(p => {
    const cover = p.photos && p.photos[0] ? `background-image:url('${esc(p.photos[0])}')` : `background:${esc(p.color || "#E8D9C3")}`;
    const stock = p.stock ?? (p.sold ? 0 : 0);
    const stockLabel = stock > 0 ? `${stock} in stock` : `<span class="psold">Sold out</span>`;
    return `
      <div class="prow">
        <div class="pthumb" style="${cover}"></div>
        <div>
          <div class="pname">${esc(p.name)}</div>
          <div class="pmeta">${money(p.price)} · ${stockLabel} · ${p.photos.length} photo${p.photos.length === 1 ? "" : "s"} · id ${p.id}</div>
        </div>
        <div class="pactions">
          <button class="btn-sm" onclick="setCount(${p.id}, ${stock})">Set qty</button>
          <button class="btn-sm danger" onclick="removePiece(${p.id}, '${esc(p.name).replace(/'/g, "\\'")}')">Delete</button>
        </div>
      </div>`;
  }).join("");
}

function flash(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 4000);
}

async function addPiece() {
  const btn = document.getElementById("add-btn");
  btn.disabled = true;
  try {
    await api("POST", "/api/admin/pieces", {
      name: document.getElementById("f-name").value,
      price: document.getElementById("f-price").value,
      stock: document.getElementById("f-stock").value,
      color: document.getElementById("f-color").value.trim(),
      blurb: document.getElementById("f-blurb").value,
      photos: document.getElementById("f-photos").value,
    });
    ["f-name", "f-price", "f-color", "f-blurb", "f-photos"].forEach(id => (document.getElementById(id).value = ""));
    document.getElementById("f-stock").value = "1";
    flash("add-msg", "Piece added.");
    refresh();
  } catch (err) {
    if (/password/i.test(err.message)) { clearAuth(); showLock(err.message); }
    else flash("add-err", err.message);
  } finally {
    btn.disabled = false;
  }
}

async function setCount(id, current) {
  const input = prompt("Quantity in stock:", String(current ?? 0));
  if (input === null) return;
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n) || n < 0) { alert("Enter a whole number (0 or more)."); return; }
  try { await api("PATCH", `/api/admin/pieces/${id}`, { stock: n }); refresh(); }
  catch (err) { if (/password/i.test(err.message)) { clearAuth(); showLock(err.message); } else alert(err.message); }
}

async function removePiece(id, name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  try { await api("DELETE", `/api/admin/pieces/${id}`); refresh(); }
  catch (err) { if (/password/i.test(err.message)) { clearAuth(); showLock(err.message); } else alert(err.message); }
}

unlock();
