// Pieces admin. Talks to the gated /api/admin/pieces endpoints. The admin
// password is asked once and kept for the session; every request carries it as
// HTTP Basic auth. Photos are S3 URLs entered by hand.

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = n => `$${Number(n).toFixed(2)}`;

function authHeader() {
  let pw = sessionStorage.getItem("sg_admin_pw");
  if (!pw) {
    pw = prompt("Admin password:") || "";
    sessionStorage.setItem("sg_admin_pw", pw);
  }
  return "Basic " + btoa("admin:" + pw);
}
function clearAuth() { sessionStorage.removeItem("sg_admin_pw"); }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearAuth();
    throw new Error("Wrong admin password — reload and try again.");
  }
  if (res.status === 503) throw new Error("Admin isn't configured on this server (ADMIN_PASSWORD not set).");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function flash(id, msg, isErr) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 4000);
}

async function load() {
  const list = document.getElementById("plist");
  let pieces;
  try {
    pieces = await api("GET", "/api/admin/pieces");
  } catch (err) {
    list.innerHTML = `<div class="adm-empty">${esc(err.message)}</div>`;
    return;
  }
  if (!pieces.length) { list.innerHTML = `<div class="adm-empty">No pieces yet — add one above.</div>`; return; }
  list.innerHTML = pieces.map(p => {
    const cover = p.photos && p.photos[0] ? `background-image:url('${esc(p.photos[0])}')` : `background:${esc(p.color || "#E8D9C3")}`;
    return `
      <div class="prow">
        <div class="pthumb" style="${cover}"></div>
        <div>
          <div class="pname">${esc(p.name)} ${p.sold ? '<span class="psold">· Sold</span>' : ""}</div>
          <div class="pmeta">${money(p.price)} · ${p.photos.length} photo${p.photos.length === 1 ? "" : "s"} · id ${p.id}</div>
        </div>
        <div class="pactions">
          <button class="btn-sm" onclick="toggleSold(${p.id}, ${p.sold ? "false" : "true"})">${p.sold ? "Mark available" : "Mark sold"}</button>
          <button class="btn-sm danger" onclick="removePiece(${p.id}, '${esc(p.name).replace(/'/g, "\\'")}')">Delete</button>
        </div>
      </div>`;
  }).join("");
}

async function addPiece() {
  const btn = document.getElementById("add-btn");
  btn.disabled = true;
  try {
    await api("POST", "/api/admin/pieces", {
      name: document.getElementById("f-name").value,
      price: document.getElementById("f-price").value,
      color: document.getElementById("f-color").value.trim(),
      blurb: document.getElementById("f-blurb").value,
      photos: document.getElementById("f-photos").value,
    });
    ["f-name", "f-price", "f-color", "f-blurb", "f-photos"].forEach(id => (document.getElementById(id).value = ""));
    flash("add-msg", "Piece added.");
    load();
  } catch (err) {
    flash("add-err", err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function toggleSold(id, sold) {
  try { await api("PATCH", `/api/admin/pieces/${id}`, { sold }); load(); }
  catch (err) { alert(err.message); }
}

async function removePiece(id, name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  try { await api("DELETE", `/api/admin/pieces/${id}`); load(); }
  catch (err) { alert(err.message); }
}

load();
