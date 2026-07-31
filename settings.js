/* ============================================================
   Live settings + the customer alert. Shared by both apps.

   config.js is still the source of truth for the shape of things —
   which services exist, what the steps are. What lives in the Sheet is
   only a thin layer of *overrides* on top: a phone number, a price, a
   storm notice. Anything not overridden falls through to config.js, so
   the app works fully with an empty Settings tab, or no backend at all.

   Two-stage on purpose:

     1. applyCachedSettings() runs the moment this file loads, straight
        out of localStorage. Synchronous, so the first paint already has
        the right phone number instead of flashing the shipped one.
     2. refreshSettings() goes to the network afterwards and re-renders
        if anything moved.

   Load order matters: config.js, then this, then app.js/admin.js.
   ============================================================ */

const SETTINGS_CACHE = "snow.settings.v1";
const ALERT_DISMISSED = "snow.alert.dismissed";

/* Last thing the network told us: { settings: {...}, alert: {...}|null } */
let liveSettings = { settings: {}, alert: null };

const settingsUrl = () => {
  const url = (window.SNOW_CONFIG?.delivery?.gsheet?.url) || "";
  return /^https:\/\/script\.google\.com\//.test(url) ? url : "";
};

/* ------------------------------------------------------------ apply */
/* What config.js shipped, captured before anything overrides it.
   applySettings() restores these first, so removing an override really
   does put the shipped value back — without it, a cleared field would
   keep showing the last saved value until the page was reloaded. */
const DEFAULTS = (() => {
  const CFG = window.SNOW_CONFIG;
  return {
    business: { ...CFG.business, trust: [...(CFG.business.trust || [])] },
    prices: Object.fromEntries((CFG.services || []).map((s) => [s.id, s.base])),
    sizes: Object.fromEntries((CFG.drivewaySizes || []).map((s) => [s.id, s.mult])),
    seasonMonthlyFactor: CFG.seasonMonthlyFactor,
  };
})();

function restoreDefaults() {
  const CFG = window.SNOW_CONFIG;
  Object.assign(CFG.business, DEFAULTS.business);
  CFG.business.trust = [...DEFAULTS.business.trust];
  (CFG.services || []).forEach((s) => (s.base = DEFAULTS.prices[s.id]));
  (CFG.drivewaySizes || []).forEach((s) => (s.mult = DEFAULTS.sizes[s.id]));
  CFG.seasonMonthlyFactor = DEFAULTS.seasonMonthlyFactor;
}

/**
 * Fold a flat key/value map of overrides into window.SNOW_CONFIG.
 * Unknown keys are ignored, and anything that isn't a usable number is
 * left alone — a bad price should show the shipped one, not NaN.
 */
function applySettings(s) {
  restoreDefaults();
  if (!s) return;
  const CFG = window.SNOW_CONFIG;
  const text = (k) => (typeof s[k] === "string" && s[k].trim() ? s[k].trim() : null);
  const num = (k) => {
    const v = Number(s[k]);
    return s[k] !== undefined && s[k] !== "" && !isNaN(v) && v >= 0 ? v : null;
  };

  const b = CFG.business;
  const fields = {
    "biz.name": "name",
    "biz.phone": "phone",
    "biz.email": "email",
    "biz.serviceArea": "serviceArea",
    "biz.tagline": "tagline",
    "biz.hours": "hours",
  };
  Object.keys(fields).forEach((k) => {
    const v = text(k);
    if (v !== null) b[fields[k]] = v;
  });

  const trust = text("biz.trust");
  if (trust !== null) {
    b.trust = trust.split("|").map((t) => t.trim()).filter(Boolean);
  }

  (CFG.services || []).forEach((sv) => {
    const v = num("price." + sv.id);
    if (v !== null) sv.base = v;
  });

  (CFG.drivewaySizes || []).forEach((sz) => {
    const v = num("size." + sz.id);
    if (v !== null) sz.mult = v;
  });

  const season = num("seasonMonthlyFactor");
  if (season !== null) CFG.seasonMonthlyFactor = season;
}

/** Whatever we knew last time this browser had a connection. */
function applyCachedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE);
    if (!raw) return;
    const cached = JSON.parse(raw);
    liveSettings = {
      settings: cached.settings || {},
      alert: cached.alert || null,
    };
    applySettings(liveSettings.settings);
  } catch {
    /* corrupt cache is not worth failing a page load over */
  }
}

/* ------------------------------------------------------------ fetch */
/**
 * Ask the backend for the current settings and alert.
 * Resolves to false when there's nothing to do — offline, no backend
 * configured, or nothing changed since the cached copy.
 */
async function refreshSettings() {
  const url = settingsUrl();
  if (!url) return false;

  let data;
  try {
    // text/plain for the same reason as everywhere else: Apps Script does
    // not answer CORS preflights.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "settings" }),
      redirect: "follow",
    });
    if (!res.ok) return false;
    data = await res.json();
    if (!data.ok) return false;
  } catch {
    return false;                       // offline: the cache already applied
  }

  const next = { settings: data.settings || {}, alert: data.alert || null };
  const changed = JSON.stringify(next) !== JSON.stringify(liveSettings);

  liveSettings = next;
  applySettings(next.settings);
  try {
    localStorage.setItem(SETTINGS_CACHE, JSON.stringify(next));
  } catch {}

  return changed;
}

/* ------------------------------------------------------------ alert */
/**
 * Show the current alert on the customer form.
 *
 * Dismissal is deliberately sessionStorage, not localStorage: closing it
 * should get it out of the way now, and it should be back next time the
 * app is opened. The id is part of the key, so publishing a new alert
 * shows up even for someone who dismissed the last one.
 *
 * The backend decides whether an alert is still inside its window, so a
 * phone with a wrong clock can't keep a stale notice on screen.
 */
function renderAlert(host) {
  if (!host) return;

  const alert = liveSettings.alert;
  if (!alert || !alert.message) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }

  let dismissed = null;
  try {
    dismissed = sessionStorage.getItem(ALERT_DISMISSED);
  } catch {}
  if (dismissed && dismissed === alert.id) {
    host.hidden = true;
    return;
  }

  const tone = ["info", "warning", "urgent"].includes(alert.tone)
    ? alert.tone : "info";

  host.className = "alertBar " + tone;
  host.hidden = false;
  host.innerHTML = "";

  const p = document.createElement("p");
  p.textContent = alert.message;          // textContent: it's operator input
  host.appendChild(p);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "alertClose";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => {
    host.hidden = true;
    try {
      sessionStorage.setItem(ALERT_DISMISSED, alert.id || "1");
    } catch {}
  });
  host.appendChild(close);
}

applyCachedSettings();
