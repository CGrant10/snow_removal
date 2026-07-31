/* ============================================================
   Job board — the admin side.

   Reads and writes the same Google Sheet the public form writes to,
   through the admin actions in apps_script/Code.gs. The passphrase is
   never stored in the page source; it is typed, held in this tab, and
   checked by the script on every request.

   The public form (index.html) never loads this file and never sees a
   passphrase. Anonymous in, authenticated out.
   ============================================================ */

const CFG = window.SNOW_CONFIG;
const $ = (id) => document.getElementById(id);
const KEY = "snow.admin.pass";

let pass = "";
let rows = [];
let statuses = ["New", "Quoted", "Scheduled", "Done", "Declined"];
let filter = "open";          // "open" = anything not Done/Declined
let query = "";

/* ------------------------------------------------------------ api */
async function call(action, extra) {
  const url = CFG.delivery.gsheet.url;
  if (!/^https:\/\/script\.google\.com\//.test(url)) {
    throw new Error("no Apps Script URL in config.js");
  }

  // text/plain for the same reason as the form: Apps Script does not
  // answer CORS preflights.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, passphrase: pass, ...extra }),
    redirect: "follow",
  });

  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "rejected");
  return data;
}

/* ------------------------------------------------------------ gate */
function boot() {
  const saved = localStorage.getItem(KEY) || sessionStorage.getItem(KEY);
  $("gateBtn").addEventListener("click", signIn);
  $("pass").addEventListener("keydown", (e) => e.key === "Enter" && signIn());
  $("signOut").addEventListener("click", signOut);
  $("refreshBtn").addEventListener("click", () => load(true));
  $("search").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });

  wireUpdater([$("appVersion")], $("updatePill"));

  if (saved) {
    pass = saved;
    openBoard();
  }
}

async function signIn() {
  const err = $("gateErr");
  const btn = $("gateBtn");
  pass = $("pass").value;
  if (!pass) return;

  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Checking…";

  try {
    await call("list", { limit: 1 });
    (($("remember").checked) ? localStorage : sessionStorage).setItem(KEY, pass);
    openBoard();
  } catch (ex) {
    pass = "";
    err.textContent = ex.message === "wrong passphrase"
      ? "That passphrase didn't work."
      : `Couldn't reach the sheet: ${ex.message}`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Open the board";
  }
}

function signOut() {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
  pass = "";
  rows = [];
  $("board").hidden = true;
  $("gate").hidden = false;
  $("pass").value = "";
}

function openBoard() {
  $("gate").hidden = true;
  $("board").hidden = false;
  load();
}

/* ------------------------------------------------------------ load */
async function load(manual) {
  const btn = $("refreshBtn");
  btn.classList.add("spin");
  try {
    const data = await call("list", {});
    rows = data.reservations || [];
    if (data.statuses) statuses = data.statuses;
    renderFilters();
    render();
  } catch (ex) {
    if (ex.message === "wrong passphrase") return signOut();
    $("empty").textContent = `Couldn't load the board: ${ex.message}`;
    $("empty").hidden = false;
  } finally {
    btn.classList.remove("spin");
    if (manual) btn.blur();
  }
}

/* ------------------------------------------------------------ filters */
function renderFilters() {
  const groups = [
    { id: "open", label: "Open" },
    ...statuses.map((s) => ({ id: s, label: s })),
    { id: "all", label: "All" },
  ];

  $("statusFilter").innerHTML = "";
  groups.forEach((g) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (filter === g.id ? " sel" : "");
    b.textContent = g.label + (count(g.id) ? ` ${count(g.id)}` : "");
    b.addEventListener("click", () => { filter = g.id; renderFilters(); render(); });
    $("statusFilter").appendChild(b);
  });
}

const isOpen = (r) => r.Status !== "Done" && r.Status !== "Declined";

function count(id) {
  if (id === "all") return rows.length;
  if (id === "open") return rows.filter(isOpen).length;
  return rows.filter((r) => r.Status === id).length;
}

function visible() {
  let out = rows;
  if (filter === "open") out = out.filter(isOpen);
  else if (filter !== "all") out = out.filter((r) => r.Status === filter);

  if (query) {
    out = out.filter((r) =>
      [r.Name, r.Address, r.City, r.Phone, r.Reference, r.Services]
        .join(" ").toLowerCase().includes(query));
  }
  return out;
}

/* ------------------------------------------------------------ render */
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const days = Math.floor((Date.now() - d) / 86400000);
  const time = d.toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return days <= 0 ? `Today, ${d.toLocaleTimeString(undefined,
    { hour: "numeric", minute: "2-digit" })}` : time;
}

function render() {
  const list = visible();
  const host = $("jobs");
  host.innerHTML = "";

  $("counts").textContent =
    `${count("open")} open · ${rows.length} total`;

  if (!list.length) {
    $("empty").textContent = rows.length
      ? "Nothing matches that filter."
      : "No reservations yet. The first one will show up here.";
    $("empty").hidden = false;
    return;
  }
  $("empty").hidden = true;

  list.forEach((r) => host.appendChild(jobCard(r)));
}

function jobCard(r) {
  const el = document.createElement("article");
  el.className = "job" + (isOpen(r) ? "" : " closed");

  const tel = String(r.Phone || "").replace(/[^\d+]/g, "");
  const maps = encodeURIComponent(
    [r.Address, r.City, r.ZIP].filter(Boolean).join(", "));

  const detail = (k, v) => v
    ? `<div class="d"><span class="k">${k}</span><span>${esc(v)}</span></div>` : "";

  el.innerHTML = `
    <div class="jobTop">
      <div>
        <h2>${esc(r.Name)}</h2>
        <p class="muted sm">${esc(when(r.Received))} · ${esc(r.Reference)}</p>
      </div>
      <div class="pill st-${esc(String(r.Status || "New").toLowerCase())}">
        ${esc(r.Status || "New")}
      </div>
    </div>

    <p class="addr">${esc([r.Address, r.City, r.ZIP].filter(Boolean).join(", "))}</p>

    <div class="acts">
      <a class="act" href="tel:${tel}"><svg><use href="#i-phone"></use></svg>Call</a>
      <a class="act" href="sms:${tel}"><svg><use href="#i-msg"></use></svg>Text</a>
      <a class="act" target="_blank" rel="noopener"
         href="https://www.google.com/maps/search/?api=1&query=${maps}">
         <svg><use href="#i-pin"></use></svg>Map</a>
    </div>

    <div class="details">
      ${detail("Services", r.Services)}
      ${detail("Plan", r.Plan + (r.Trigger ? ` · after ${r.Trigger}` : ""))}
      ${detail("When", [r["Start date"], r["Time of day"]].filter(Boolean).join(" · "))}
      ${detail("Driveway", [r.Driveway, r.Surface].filter(Boolean).join(" · "))}
      ${detail("Watch for", r.Flags)}
      ${detail("Snow goes", r["Snow goes"])}
      ${detail("Customer said", r["Crew notes"])}
      ${detail("Estimate", r.Estimate ? `$${r.Estimate} ${r["Estimate basis"] || ""}` : "")}
      ${detail("Contact", [r.Phone, r.Email].filter(Boolean).join(" · ")
        + (r["Text OK"] === "No" ? " (no texts)" : ""))}
    </div>

    <div class="jobFoot">
      <select class="statusSel" aria-label="Status">
        ${statuses.map((s) => `<option${s === (r.Status || "New") ? " selected" : ""}>${s}</option>`).join("")}
      </select>
      <input class="officeNotes" placeholder="Office notes…"
             value="${esc(r["Office notes"])}">
      <span class="saved" hidden>Saved</span>
    </div>`;

  const sel = el.querySelector(".statusSel");
  const notes = el.querySelector(".officeNotes");
  const saved = el.querySelector(".saved");

  const push = async (patch) => {
    el.classList.add("saving");
    try {
      await call("update", { reference: r.Reference, ...patch });
      Object.assign(r, patch.status ? { Status: patch.status } : {},
                       "officeNotes" in patch ? { "Office notes": patch.officeNotes } : {});
      saved.hidden = false;
      setTimeout(() => (saved.hidden = true), 1600);
      if (patch.status) { renderFilters(); render(); }
    } catch (ex) {
      alert(`Couldn't save that: ${ex.message}`);
      if (patch.status) sel.value = r.Status || "New";
    } finally {
      el.classList.remove("saving");
    }
  };

  sel.addEventListener("change", () => push({ status: sel.value }));
  // Save on blur rather than per keystroke — one Apps Script call per edit.
  notes.addEventListener("change", () => push({ officeNotes: notes.value }));

  return el;
}

boot();
