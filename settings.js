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
    services: (CFG.services || []).map((s) => ({
      id: s.id, label: s.label, blurb: s.blurb, base: s.base,
    })),
    order: (CFG.services || []).map((s) => s.id),
    sizes: Object.fromEntries((CFG.drivewaySizes || []).map((s) => [s.id, s.mult])),
    seasonMonthlyFactor: CFG.seasonMonthlyFactor,
  };
})();

/** What config.js ships for one service field, for the admin center to
    compare against — storing a value identical to the default would make
    a row that can never fall back. */
function defaultOf(id, part) {
  const d = DEFAULTS.services.find((s) => s.id === id);
  return d ? d[part] : undefined;
}

function restoreDefaults() {
  const CFG = window.SNOW_CONFIG;
  Object.assign(CFG.business, DEFAULTS.business);
  CFG.business.trust = [...DEFAULTS.business.trust];

  DEFAULTS.services.forEach((d) => {
    const s = (CFG.services || []).find((x) => x.id === d.id);
    if (!s) return;
    s.label = d.label;
    s.blurb = d.blurb;
    s.base = d.base;
    s.hidden = false;
  });
  // Back to the order config.js declared them in.
  (CFG.services || []).sort(
    (a, b) => DEFAULTS.order.indexOf(a.id) - DEFAULTS.order.indexOf(b.id));

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

  /* Services. config.js still decides which services *exist* — it owns
     the icon, and the icons are an SVG sprite baked into the page. What
     the Sheet controls is which of them a customer is shown, in what
     order, under what wording, at what price. */
  (CFG.services || []).forEach((sv) => {
    const price = num("price." + sv.id);
    if (price !== null) sv.base = price;

    const label = text("svc." + sv.id + ".label");
    if (label !== null) sv.label = label;

    const blurb = text("svc." + sv.id + ".blurb");
    if (blurb !== null) sv.blurb = blurb;

    // Only an explicit "no" hides one, so a service added to config.js
    // later shows up rather than defaulting to off.
    sv.hidden = s["svc." + sv.id + ".on"] === "no";
  });

  const order = text("svc.order");
  if (order !== null) {
    const wanted = order.split(",").map((t) => t.trim()).filter(Boolean);
    // Anything not listed keeps its config.js position, after the rest.
    const rank = (id) => {
      const i = wanted.indexOf(id);
      return i === -1 ? 1000 + DEFAULTS.order.indexOf(id) : i;
    };
    (CFG.services || []).sort((a, b) => rank(a.id) - rank(b.id));
  }

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
