/* ============================================================
   Job board — the admin side.

   Reads and writes the same Google Sheet the public form writes to,
   through the admin actions in apps_script/Code.gs.

   Accounts, not one shared word. Signing in trades a username and
   password for a session token; the password is never stored anywhere
   and the token is all this browser keeps. Two roles: `master` can
   change prices, publish customer alerts, and manage accounts;
   `admin` gets the job board and nothing else. The server enforces
   that — everything here just avoids showing people buttons that
   would be refused.

   The public form never loads this file and never sees an account.
   Anonymous in, authenticated out.
   ============================================================ */

const CFG = window.SNOW_CONFIG;
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "snow.admin.token";
const LEGACY_KEY = "snow.admin.pass";   // pre-accounts; cleared on sight

let token = "";
let me = { username: "", role: "admin", mustChange: false };
let rows = [];
let statuses = ["New", "Quoted", "Scheduled", "Done", "Declined"];
let filter = "open";          // "open" = anything not Done/Declined
let query = "";
let demo = false;             // showing sample data, not a real Sheet

const connected = () =>
  /^https:\/\/script\.google\.com\//.test(CFG.delivery.gsheet.url || "");
const isMaster = () => me.role === "master";

/* ------------------------------------------------------------ crypto
   Password stretching happens here, in the browser, not in Apps Script.

   The first cut had the script iterate HMAC-SHA256 a few thousand times.
   That doesn't work: every Utilities call is a round trip to a Java
   service rather than local arithmetic, so it ran long enough to hit
   "Exceeded maximum execution time" and nobody could sign in.

   WebCrypto does 200,000 PBKDF2 rounds on a phone in about a tenth of a
   second. What goes over the wire is the derived key; the server stores
   only a digest of it. So the stretching is far heavier than the script
   could ever have afforded, and a leaked Sheet still yields nothing you
   can sign in with.                                                     */
const PBKDF2_ROUNDS = 200_000;

const b64 = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));

function freshSalt() {
  return b64(crypto.getRandomValues(new Uint8Array(24)));
}

async function derive(password, salt, rounds) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: rounds, hash: "SHA-256" },
    key, 256);
  return b64(bits);
}

/** Everything needed to store a brand-new password. */
async function newSecret(password) {
  const salt = freshSalt();
  return { salt, rounds: PBKDF2_ROUNDS, proof: await derive(password, salt, PBKDF2_ROUNDS) };
}

/* ------------------------------------------------------------ api */
/** Raised when the server says the token is no longer good for anything. */
class SignedOut extends Error {}

/** POST without a token, for the two steps of signing in. */
async function callAnon(action, extra) {
  if (!connected()) throw new Error("not connected");
  const res = await fetch(CFG.delivery.gsheet.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...extra }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "rejected");
  return data;
}

async function call(action, extra) {
  if (!connected()) throw new Error("not connected");

  // text/plain for the same reason as the form: Apps Script does not
  // answer CORS preflights.
  const res = await fetch(CFG.delivery.gsheet.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, token, ...extra }),
    redirect: "follow",
  });

  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  if (!data.ok) {
    // Expired, revoked, or the account was switched off underneath us.
    if (data.error === "signedOut") {
      forgetToken();
      throw new SignedOut("Signed out — sign in again");
    }
    // Password expired into a forced change while the tab was open.
    if (data.error === "mustChange") {
      me.mustChange = true;
      showPasswordChange();
      throw new SignedOut("Set a new password to continue");
    }
    throw new Error(data.error || "rejected");
  }
  return data;
}

/* ------------------------------------------------------------ gate */
function boot() {
  $("gateBtn").addEventListener("click", signIn);
  $("user").addEventListener("keydown", (e) => e.key === "Enter" && $("pass").focus());
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
  wirePasswordChange();

  // Anyone signed in under the old shared passphrase has to sign in
  // again — there is no account behind that value to migrate to.
  localStorage.removeItem(LEGACY_KEY);
  sessionStorage.removeItem(LEGACY_KEY);

  // No Sheet wired up yet: say so plainly instead of failing on sign-in,
  // and offer the sample board so the thing can still be shown to someone.
  if (!connected()) {
    $("setupNote").hidden = false;
    $("gateBtn").disabled = true;
    $("user").disabled = $("pass").disabled = true;
    return;
  }

  const saved = localStorage.getItem(TOKEN_KEY) ||
                sessionStorage.getItem(TOKEN_KEY);
  if (saved) {
    token = saved;
    resumeSession();
  }
}

/** Pick up where a previous visit left off, without a password. */
async function resumeSession() {
  $("gateBtn").disabled = true;
  try {
    const data = await call("session", {});
    me = {
      username: data.username,
      role: data.role,
      mustChange: !!data.mustChange,
    };
    if (me.mustChange) return showPasswordChange();
    openBoard();
  } catch {
    forgetToken();               // stale or revoked: fall back to the form
  } finally {
    $("gateBtn").disabled = false;
  }
}

function rememberToken(value, remember) {
  token = value;
  try {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value);
  } catch {}
}

function forgetToken() {
  token = "";
  me = { username: "", role: "admin", mustChange: false };
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
  $("board").hidden = true;
  $("adminCenter").hidden = true;
  $("passwordChange").hidden = true;
  $("gate").hidden = false;
}

/* --------------------------------------------------- forced password */
function wirePasswordChange() {
  $("pwSave").addEventListener("click", savePassword);
  $("pwNew2").addEventListener("keydown", (e) => e.key === "Enter" && savePassword());
  $("pwCancel").addEventListener("click", signOut);
}

function showPasswordChange() {
  $("gate").hidden = true;
  $("board").hidden = true;
  $("adminCenter").hidden = true;
  $("passwordChange").hidden = false;
  $("pwWho").textContent = me.username;
  $("pwErr").hidden = true;
  $("pwCurrent").focus();
}

async function savePassword() {
  const err = $("pwErr");
  err.hidden = true;

  const current = $("pwCurrent").value;
  const next = $("pwNew").value;
  if (next.length < 10) return fail(err, "Use at least 10 characters.");
  if (next !== $("pwNew2").value) return fail(err, "The two new ones don't match.");
  if (next === current) return fail(err, "That's the same password.");

  const btn = $("pwSave");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    // Prove the current password the same way signing in does. Asking for
    // the salt again rather than remembering it keeps this working after
    // a session was restored from a token, where there was no sign-in.
    const challenge = await callAnon("authSalt", { username: me.username });
    const proof = challenge.bootstrap
      ? { currentPassword: current }
      : { currentProof: await derive(current, challenge.salt, challenge.rounds) };

    // Changing the password kills every other session, so the server
    // hands back a fresh token for this device.
    const data = await call("changePassword", {
      ...proof, ...(await newSecret(next)),
    });
    rememberToken(data.token, true);
    me.mustChange = false;
    ["pwCurrent", "pwNew", "pwNew2"].forEach((id) => ($(id).value = ""));
    $("passwordChange").hidden = true;
    openBoard();
    toast("Password changed");
  } catch (e) {
    fail(err, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save password";
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
  const username = $("user").value.trim();
  const password = $("pass").value;
  if (!username || !password) return;

  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Checking…";

  try {
    // Two steps: ask for this account's salt, derive the proof locally,
    // then send the proof. The password itself never leaves the browser
    // — except on a bootstrap account, which has no salt yet and is
    // checked against ADMIN_PASSPHRASE.
    const challenge = await callAnon("authSalt", { username });

    const credential = challenge.bootstrap
      ? { password }
      : { proof: await derive(password, challenge.salt, challenge.rounds) };

    const data = await callAnon("signIn", {
      username, ...credential, remember: $("remember").checked,
    });

    rememberToken(data.token, $("remember").checked);
    me = {
      username: data.username,
      role: data.role,
      mustChange: !!data.mustChange,
    };

    $("pass").value = "";
    if (me.mustChange) return showPasswordChange();
    openBoard();
  } catch (ex) {
    err.textContent = {
      "wrong username or password": "That username and password didn't work.",
      "username and password required": "Fill in both boxes.",
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

async function signOut() {
  // Best effort — the token is being thrown away here either way, so a
  // failed round trip shouldn't leave someone stuck on the board.
  if (token) {
    try { await call("signOut", {}); } catch {}
  }
  rows = [];
  demo = false;
  $("demoBanner").hidden = true;
  $("pass").value = "";
  forgetToken();
}

function openBoard() {
  $("gate").hidden = true;
  $("passwordChange").hidden = true;
  $("board").hidden = false;

  // The server refuses these for a plain admin regardless; hiding them
  // keeps the board from offering buttons that only ever produce errors.
  $("settingsBtn").hidden = !isMaster();
  $("whoami").textContent = me.username + (isMaster() ? " · master" : "");

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
    if (ex instanceof SignedOut) return;    // already back at the gate
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

  chipGroup($("acctRole"), () => {});
  wireAccounts();

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
  if (!isMaster()) return;          // the server would refuse anyway

  $("adminCenter").hidden = false;
  $("settingsErr").hidden = $("alertErr").hidden = $("acctErr").hidden = true;

  buildPriceFields();
  await refreshSettings();          // newest values, not whatever's cached
  fillSettingsForm();
  showLiveAlert();
  showUntilNote();
  loadAdmins();
}

/* ---------------------------------------------------------- accounts */

function wireAccounts() {
  $("acctAdd").addEventListener("click", createAdmin);
  $("acctGenerate").addEventListener("click", () => {
    $("acctPass").value = suggestPassword();
    $("acctPass").type = "text";      // it has to be readable to be handed over
  });
}

/** Four unrelated words beats a short scramble, and someone can actually
    read it down the phone to whoever is getting the account. */
function suggestPassword() {
  const words = [
    "plow", "north", "gravel", "eave", "drift", "salt", "prairie", "birch",
    "quarry", "lantern", "harvest", "timber", "copper", "willow", "ridge",
    "anvil", "cedar", "furrow", "granite", "meadow",
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return [pick(), pick(), pick(), Math.floor(10 + Math.random() * 90)].join("-");
}

async function loadAdmins() {
  try {
    renderAdmins((await call("listAdmins", {})).admins);
  } catch (e) {
    if (!(e instanceof SignedOut)) fail($("acctErr"), e.message);
  }
}

function renderAdmins(admins) {
  const host = $("acctList");
  host.innerHTML = "";

  admins.forEach((a) => {
    const row = document.createElement("div");
    row.className = "acctRow" + (a.active ? "" : " off");

    const who = document.createElement("div");
    who.className = "acctWho";
    const name = document.createElement("strong");
    name.textContent = a.username;
    who.appendChild(name);

    const tags = [];
    if (a.role === "master") tags.push("master");
    if (!a.active) tags.push("switched off");
    if (a.mustChange) tags.push("must change password");
    if (a.locked) tags.push("locked out");

    const meta = document.createElement("span");
    meta.className = "muted sm";
    meta.textContent = [
      tags.join(" · "),
      a.lastSeen ? "last seen " + new Date(a.lastSeen).toLocaleDateString() : "never signed in",
    ].filter(Boolean).join(" — ");
    who.appendChild(meta);
    row.appendChild(who);

    const acts = document.createElement("div");
    acts.className = "acctActs";
    const self = a.username.toLowerCase() === me.username.toLowerCase();

    acts.appendChild(actBtn("Reset password", () => resetAdmin(a.username)));
    if (!self) {
      acts.appendChild(actBtn(a.active ? "Switch off" : "Switch on",
        () => setAdminActive(a.username, !a.active)));
      acts.appendChild(actBtn("Delete", () => deleteAdmin(a.username), true));
    }
    row.appendChild(acts);
    host.appendChild(row);
  });
}

function actBtn(label, onClick, danger) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "linkBtn" + (danger ? " danger" : "");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function createAdmin() {
  const err = $("acctErr");
  err.hidden = true;

  const username = $("acctUser").value.trim();
  const password = $("acctPass").value;
  const role = document.querySelector("#acctRole .chip.sel").dataset.role;

  if (!username) return fail(err, "Pick a username.");
  if (password.length < 10) return fail(err, "Temp password needs 10+ characters.");

  const btn = $("acctAdd");
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    // Derived here — the temp password itself is never sent.
    renderAdmins((await call("createAdmin", {
      username, role, ...(await newSecret(password)),
    })).admins);
    $("acctUser").value = "";
    $("acctPass").value = "";
    $("acctPass").type = "password";
    toast(`${username} added — they'll set their own password`);
  } catch (e) {
    if (!(e instanceof SignedOut)) fail(err, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add admin";
  }
}

async function deleteAdmin(username) {
  if (!confirm(
      `Delete ${username}?\n\nThey're signed out immediately and the ` +
      `account is gone. Reservations they touched are unaffected.`)) return;
  try {
    renderAdmins((await call("deleteAdmin", { username })).admins);
    toast(`${username} deleted`);
  } catch (e) {
    if (!(e instanceof SignedOut)) fail($("acctErr"), e.message);
  }
}

async function setAdminActive(username, active) {
  try {
    renderAdmins((await call("setAdminActive", { username, active })).admins);
    toast(`${username} ${active ? "switched on" : "switched off"}`);
  } catch (e) {
    if (!(e instanceof SignedOut)) fail($("acctErr"), e.message);
  }
}

async function resetAdmin(username) {
  const suggested = suggestPassword();
  const password = prompt(
    `New temporary password for ${username}.\n\n` +
    `They'll be made to change it when they next sign in, and every ` +
    `device they're signed in on gets kicked out now.`, suggested);
  if (password === null) return;

  if (password.length < 10) {
    return fail($("acctErr"), "Temp password needs 10+ characters.");
  }
  try {
    renderAdmins((await call("resetAdminPassword", {
      username, ...(await newSecret(password)),
    })).admins);
    toast(`${username}: temp password set`);
  } catch (e) {
    if (!(e instanceof SignedOut)) fail($("acctErr"), e.message);
  }
}

/* The order the services are shown in, as ids. Held here while the panel
   is open and written out as svc.order on save. */
let serviceOrder = [];

/** A block per service — on/off, name, description, price, position —
    and a box per driveway size. Built from config.js, so adding a
    service there gets a row here for free. */
function buildPriceFields() {
  serviceOrder = (CFG.services || []).map((s) => s.id);
  renderServiceRows();

  $("sizeFields").innerHTML = (CFG.drivewaySizes || []).map((s) => `
    <label class="field narrow"><span>${s.label}</span>
      <input type="number" min="0" step="0.1" data-size="${s.id}"></label>`).join("");
}

function renderServiceRows() {
  const host = $("serviceRows");

  // Keep whatever's been typed but not saved yet across a reorder.
  const typed = {};
  host.querySelectorAll("[data-svc]").forEach((el) => {
    typed[el.dataset.svc + "|" + el.dataset.part] = el.type === "checkbox"
      ? el.checked : el.value;
  });

  host.innerHTML = "";
  serviceOrder.forEach((id, i) => {
    const s = (CFG.services || []).find((x) => x.id === id);
    if (!s) return;

    const row = document.createElement("div");
    row.className = "svcRow";
    row.innerHTML = `
      <div class="svcHead">
        <label class="check">
          <input type="checkbox" data-svc="${id}" data-part="on">
          <span class="svcName">${s.label}</span>
        </label>
        <div class="svcMove">
          <button type="button" class="linkBtn" data-move="up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="linkBtn" data-move="down"
                  ${i === serviceOrder.length - 1 ? "disabled" : ""}>↓</button>
        </div>
      </div>
      <div class="svcFields">
        <label class="field narrow"><span>Name shown</span>
          <input type="text" data-svc="${id}" data-part="label"></label>
        <label class="field narrow">
          <span>${s.quoteOnly ? "Price (quoted on site)" : "Base price"}</span>
          <input type="number" min="0" step="1" data-svc="${id}" data-part="price"
                 ${s.quoteOnly ? "disabled" : ""}></label>
        <label class="field"><span>Description</span>
          <input type="text" data-svc="${id}" data-part="blurb"></label>
      </div>`;

    row.querySelectorAll("[data-move]").forEach((b) => {
      b.addEventListener("click", () => moveService(i, b.dataset.move === "up" ? -1 : 1));
    });
    row.querySelector('[data-part="on"]').addEventListener("change", (e) => {
      row.classList.toggle("off", !e.target.checked);
    });

    host.appendChild(row);
  });

  // Put the in-progress edits back.
  host.querySelectorAll("[data-svc]").forEach((el) => {
    const v = typed[el.dataset.svc + "|" + el.dataset.part];
    if (v === undefined) return;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
    if (el.dataset.part === "on") el.closest(".svcRow").classList.toggle("off", !v);
  });
}

function moveService(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= serviceOrder.length) return;
  const [id] = serviceOrder.splice(index, 1);
  serviceOrder.splice(to, 0, id);
  renderServiceRows();
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

  serviceOrder = (CFG.services || []).map((s) => s.id);
  renderServiceRows();
  (CFG.services || []).forEach((s) => {
    const set = (part, value) => {
      const el = document.querySelector(`[data-svc="${s.id}"][data-part="${part}"]`);
      if (!el) return;
      if (el.type === "checkbox") {
        el.checked = value;
        el.closest(".svcRow").classList.toggle("off", !value);
      } else {
        el.value = value;
      }
    };
    set("on", !s.hidden);
    set("label", s.label);
    set("blurb", s.blurb || "");
    set("price", s.base);
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

  patch["svc.order"] = serviceOrder.join(",");

  const changedPrices = [];
  const turnedOff = [];
  (CFG.services || []).forEach((s) => {
    const get = (part) =>
      document.querySelector(`[data-svc="${s.id}"][data-part="${part}"]`);

    const on = get("on");
    if (on) {
      // Only an explicit "no" is stored; on is the absence of a row.
      patch["svc." + s.id + ".on"] = on.checked ? "" : "no";
      if (!on.checked && !s.hidden) turnedOff.push(s.label);
    }

    const label = get("label");
    if (label) {
      const v = label.value.trim();
      // Storing a value identical to the shipped one just makes a row
      // that can never fall back; treat it as "no override".
      patch["svc." + s.id + ".label"] = v === defaultOf(s.id, "label") ? "" : v;
    }

    const blurb = get("blurb");
    if (blurb) {
      const v = blurb.value.trim();
      patch["svc." + s.id + ".blurb"] = v === defaultOf(s.id, "blurb") ? "" : v;
    }

    const price = get("price");
    if (price && !price.disabled) {
      patch["price." + s.id] = price.value.trim();
      if (Number(price.value) !== Number(s.base)) {
        changedPrices.push(`${s.label}: $${s.base} → $${price.value}`);
      }
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

  // Anything that moves a quote, or takes a service off the form, gets
  // read back before it goes live.
  const impact = [
    changedPrices.length
      ? "Changes what customers are quoted:\n" + changedPrices.join("\n") : "",
    turnedOff.length
      ? "Takes off the form:\n" + turnedOff.join("\n") : "",
  ].filter(Boolean).join("\n\n");

  if (impact && !confirm(impact + "\n\nSave?")) return;

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

  const patch = { "svc.order": "" };
  ["name", "phone", "email", "serviceArea", "tagline", "hours", "trust"]
    .forEach((k) => (patch["biz." + k] = ""));
  (CFG.services || []).forEach((s) => {
    patch["price." + s.id] = "";
    ["on", "label", "blurb"].forEach((p) => (patch[`svc.${s.id}.${p}`] = ""));
  });
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
