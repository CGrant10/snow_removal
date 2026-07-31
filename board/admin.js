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
let demo = false;             // showing sample data, not a real Sheet

const connected = () =>
  /^https:\/\/script\.google\.com\//.test(CFG.delivery.gsheet.url || "");

/* ------------------------------------------------------------ api */
async function call(action, extra) {
  if (!connected()) throw new Error("not connected");

  // text/plain for the same reason as the form: Apps Script does not
  // answer CORS preflights.
  const res = await fetch(CFG.delivery.gsheet.url, {
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
  wireInstall([$("installBtn"), $("installBtnSm")], $("iosHint"), $("iosHintClose"));
  $("demoBtn").addEventListener("click", startDemo);
  wireAdminCenter();

  // No Sheet wired up yet: say so plainly instead of failing on sign-in,
  // and offer the sample board so the thing can still be shown to someone.
  if (!connected()) {
    $("setupNote").hidden = false;
    $("gateBtn").disabled = true;
    $("pass").disabled = true;
    return;
  }

  if (saved) {
    pass = saved;
    openBoard();
  }
}

/* ------------------------------------------------------------ demo */
const DEMO_ROWS = [
  {
    _row: 2, Received: new Date(Date.now() - 55 * 60e3).toISOString(),
    Reference: "SNO-7K2QP", Status: "New",
    Name: "Marnie Vogel", Phone: "701-555-0144", Email: "marnie@example.com",
    "Text OK": "Yes", Address: "1420 N 12th St", City: "Fargo", ZIP: "58102",
    Services: "Driveway clearing, Sidewalks & steps, Ice melt / sanding",
    Plan: "Per visit, automatic", Trigger: "2 inches",
    "Start date": "2026-11-14", "Time of day": "Before 7 AM",
    Driveway: "2–3 cars", Surface: "Gravel",
    Flags: "Dog in the yard, Do not use salt",
    "Snow goes": "north side, away from the mailbox",
    "Crew notes": "Gate code 4412. Park on the street.",
    Estimate: 95, "Estimate basis": "per visit", "Office notes": "",
  },
  {
    _row: 3, Received: new Date(Date.now() - 27 * 3600e3).toISOString(),
    Reference: "SNO-3B9XR", Status: "Scheduled",
    Name: "Karl Bergstrom", Phone: "701-555-0166", Email: "",
    "Text OK": "No", Address: "7 Prairie Loop", City: "West Fargo", ZIP: "58078",
    Services: "Driveway clearing", Plan: "Season contract", Trigger: "",
    "Start date": "2026-11-01", "Time of day": "Anytime",
    Driveway: "Long / rural", Surface: "Gravel",
    Flags: "Steep or sloped drive", "Snow goes": "", "Crew notes": "",
    Estimate: 485, "Estimate basis": "per month",
    "Office notes": "Signed for the season",
  },
  {
    _row: 4, Received: new Date(Date.now() - 3 * 86400e3).toISOString(),
    Reference: "SNO-QQ104", Status: "Done",
    Name: "Dana Halvorson", Phone: "701-555-0121", Email: "dana@example.com",
    "Text OK": "Yes", Address: "305 Elm St N", City: "Fargo", ZIP: "58102",
    Services: "Ice melt / sanding", Plan: "One time", Trigger: "",
    "Start date": "2026-11-02", "Time of day": "Morning",
    Driveway: "", Surface: "Concrete", Flags: "", "Snow goes": "",
    "Crew notes": "", Estimate: 20, "Estimate basis": "per visit",
    "Office notes": "Paid cash",
  },
];

function startDemo() {
  demo = true;
  rows = DEMO_ROWS.map((r) => ({ ...r }));
  $("gate").hidden = true;
  $("board").hidden = false;
  $("demoBanner").hidden = false;
  renderFilters();
  render();
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
    err.textContent = {
      "wrong passphrase": "That passphrase didn't work.",
      "admin is switched off":
        "The script has no ADMIN_PASSPHRASE set yet. Set one, then deploy a new version.",
      "run setup() first":
        "The Sheet has no Reservations tab yet. Run setup() in the Apps Script editor.",
      "not connected":
        "No Apps Script URL in config.js yet — set up the Sheet first.",
    }[ex.message] || `Couldn't reach the Sheet: ${ex.message}`;
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
  demo = false;
  $("demoBanner").hidden = true;
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
  if (demo) { render(); return; }        // nothing behind the sample rows
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

/* Sheets parses "2026-11-14" into a real Date, and the script hands Dates
   back as ISO strings — so the start date arrives looking like
   "2026-11-14T06:00:00.000Z". Show the day, not the timestamp. */
function dayOnly(v) {
  if (!v) return "";
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;   // already a plain date
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined,
    { weekday: "short", month: "short", day: "numeric" });
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
      ${detail("When", [dayOnly(r["Start date"]), r["Time of day"]].filter(Boolean).join(" · "))}
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
    if (demo) {
      // Reflect it on screen, but never pretend it was written anywhere.
      Object.assign(r, patch.status ? { Status: patch.status } : {},
                       "officeNotes" in patch ? { "Office notes": patch.officeNotes } : {});
      toast("Demo — not saved anywhere");
      if (patch.status) { renderFilters(); render(); }
      return;
    }

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

/* ==================================================================
   Admin center — business info, prices, and the customer alert.

   Reads through settings.js so the board and the form agree on what
   "current" means, and writes through the passphrase-gated actions in
   Code.gs. Everything stored is an override: clearing a field deletes
   the row and the form goes back to the config.js default.
   ================================================================== */

let alertTone = "info";
let alertHours = "24";

function wireAdminCenter() {
  $("settingsBtn").addEventListener("click", openAdminCenter);
  $("centerClose").addEventListener("click", () => ($("adminCenter").hidden = true));

  chipGroup($("alertTone"), (btn) => (alertTone = btn.dataset.tone));
  chipGroup($("alertUntil"), (btn) => {
    alertHours = btn.dataset.hours;
    $("alertCustom").hidden = alertHours !== "custom";
    showUntilNote();
  });

  $("alertCustom").addEventListener("change", showUntilNote);
  $("alertPublish").addEventListener("click", publishAlert);
  $("alertClear").addEventListener("click", clearAlert);
  $("settingsSave").addEventListener("click", saveSettings);
  $("settingsReset").addEventListener("click", resetSettings);
}

/** One-of-many chips: selecting one clears the rest. */
function chipGroup(host, onPick) {
  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    [...host.querySelectorAll(".chip")].forEach((c) => c.classList.remove("sel"));
    btn.classList.add("sel");
    onPick(btn);
  });
}

/** The chosen expiry as a Date, or null for "no end". */
function untilDate() {
  if (alertHours === "custom") {
    const v = $("alertCustom").value;
    return v ? new Date(v) : null;
  }
  if (alertHours === "today") {
    const d = new Date();
    d.setHours(23, 59, 0, 0);
    return d;
  }
  return new Date(Date.now() + Number(alertHours) * 3600_000);
}

function showUntilNote() {
  const d = untilDate();
  $("alertUntilNote").textContent = d && !isNaN(d)
    ? "Comes down " + d.toLocaleString([], {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      })
    : "Pick a date and time.";
}

async function openAdminCenter() {
  $("adminCenter").hidden = false;
  $("settingsErr").hidden = $("alertErr").hidden = true;

  buildPriceFields();
  await refreshSettings();          // newest values, not whatever's cached
  fillSettingsForm();
  showLiveAlert();
  showUntilNote();
}

/** A row per service and per driveway size, straight off config.js, so
    adding a service in config.js gets a price box here for free. */
function buildPriceFields() {
  $("priceFields").innerHTML = (CFG.services || []).map((s) => `
    <label class="field narrow"><span>${s.label}${s.quoteOnly ? " (quoted on site)" : ""}</span>
      <input type="number" min="0" step="1" data-price="${s.id}"></label>`).join("");

  $("sizeFields").innerHTML = (CFG.drivewaySizes || []).map((s) => `
    <label class="field narrow"><span>${s.label}</span>
      <input type="number" min="0" step="0.1" data-size="${s.id}"></label>`).join("");
}

/** CFG already has the overrides folded in by settings.js, so reading
    from it shows the effective value whether it's stored or shipped. */
function fillSettingsForm() {
  const b = CFG.business;
  $("setName").value = b.name || "";
  $("setPhone").value = b.phone || "";
  $("setEmail").value = b.email || "";
  $("setArea").value = b.serviceArea || "";
  $("setTagline").value = b.tagline || "";
  $("setHours").value = b.hours || "";
  $("setTrust").value = (b.trust || []).join("\n");

  (CFG.services || []).forEach((s) => {
    const el = document.querySelector(`[data-price="${s.id}"]`);
    if (el) el.value = s.base;
  });
  (CFG.drivewaySizes || []).forEach((s) => {
    const el = document.querySelector(`[data-size="${s.id}"]`);
    if (el) el.value = s.mult;
  });
  $("setSeason").value = CFG.seasonMonthlyFactor;
}

function showLiveAlert() {
  const el = $("liveAlert");
  const a = liveSettings.alert;
  if (!a || !a.message) {
    el.hidden = true;
    return;
  }
  const ends = a.until ? new Date(a.until) : null;
  el.hidden = false;
  el.textContent = "Live now: “" + a.message + "”" +
    (ends && !isNaN(ends) ? " — until " + ends.toLocaleString() : "");
}

async function publishAlert() {
  const err = $("alertErr");
  const message = $("alertMsg").value.trim();
  err.hidden = true;

  if (!message) return fail(err, "Write a message first.");

  const d = untilDate();
  if (!d || isNaN(d)) return fail(err, "Pick when it should come down.");
  if (d.getTime() <= Date.now()) return fail(err, "That time has already passed.");

  const btn = $("alertPublish");
  btn.disabled = true;
  btn.textContent = "Publishing…";
  try {
    await call("publishAlert", { message, tone: alertTone, until: d.toISOString() });
    await refreshSettings();
    showLiveAlert();
    $("alertMsg").value = "";
    toast("Alert is live");
  } catch (e) {
    fail(err, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Publish alert";
  }
}

async function clearAlert() {
  const err = $("alertErr");
  err.hidden = true;
  try {
    await call("clearAlert", {});
    await refreshSettings();
    showLiveAlert();
    toast("Alert taken down");
  } catch (e) {
    fail(err, e.message);
  }
}

async function saveSettings() {
  const err = $("settingsErr");
  err.hidden = true;

  // Empty string deletes the stored row, which is what puts a field back
  // to the config.js default.
  const patch = {
    "biz.name": $("setName").value.trim(),
    "biz.phone": $("setPhone").value.trim(),
    "biz.email": $("setEmail").value.trim(),
    "biz.serviceArea": $("setArea").value.trim(),
    "biz.tagline": $("setTagline").value.trim(),
    "biz.hours": $("setHours").value.trim(),
    "biz.trust": $("setTrust").value.split("\n")
      .map((t) => t.trim()).filter(Boolean).join(" | "),
    seasonMonthlyFactor: $("setSeason").value.trim(),
  };

  const changedPrices = [];
  (CFG.services || []).forEach((s) => {
    const el = document.querySelector(`[data-price="${s.id}"]`);
    if (!el) return;
    patch["price." + s.id] = el.value.trim();
    if (Number(el.value) !== Number(s.base)) {
      changedPrices.push(`${s.label}: $${s.base} → $${el.value}`);
    }
  });
  (CFG.drivewaySizes || []).forEach((s) => {
    const el = document.querySelector(`[data-size="${s.id}"]`);
    if (!el) return;
    patch["size." + s.id] = el.value.trim();
    if (Number(el.value) !== Number(s.mult)) {
      changedPrices.push(`${s.label}: ×${s.mult} → ×${el.value}`);
    }
  });
  if (Number($("setSeason").value) !== Number(CFG.seasonMonthlyFactor)) {
    changedPrices.push(
      `Season factor: ${CFG.seasonMonthlyFactor} → ${$("setSeason").value}`);
  }

  // Anything that moves a quote gets read back before it goes live.
  if (changedPrices.length && !confirm(
      "This changes what customers are quoted:\n\n" +
      changedPrices.join("\n") + "\n\nSave?")) {
    return;
  }

  const btn = $("settingsSave");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await call("saveSettings", { settings: patch });
    await refreshSettings();
    fillSettingsForm();
    toast("Saved");
  } catch (e) {
    fail(err, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save changes";
  }
}

async function resetSettings() {
  if (!confirm(
      "Clear every stored override and go back to what config.js ships?\n\n" +
      "The alert is left alone — use Take it down for that.")) return;

  const patch = {};
  ["name", "phone", "email", "serviceArea", "tagline", "hours", "trust"]
    .forEach((k) => (patch["biz." + k] = ""));
  (CFG.services || []).forEach((s) => (patch["price." + s.id] = ""));
  (CFG.drivewaySizes || []).forEach((s) => (patch["size." + s.id] = ""));
  patch.seasonMonthlyFactor = "";

  try {
    await call("saveSettings", { settings: patch });
    await refreshSettings();       // restores the shipped values into CFG
    fillSettingsForm();
    toast("Back to config.js defaults");
  } catch (e) {
    fail($("settingsErr"), e.message);
  }
}

function fail(el, message) {
  el.textContent = message;
  el.hidden = false;
}

boot();
