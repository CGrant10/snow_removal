/* ============================================================
   Update checker — shared by the form and the job board.

   Three things must move together on every deploy:

       APP_VERSION here
       VERSION     in sw-core.js  (names the cache)
       version.txt at the root    (what the running app polls)

   Use `python tools/bump_version.py 1.3.2` so they can't drift. If
   version.txt falls behind, the app offers a phantom update forever;
   if it runs ahead, nobody is ever told there's a new one.

   version.txt is the ONLY thing that decides whether an update exists.
   The service worker deliberately does not get a vote: a new worker
   installs as a *result* of updating, which used to re-raise the
   "update available" pill the instant an update succeeded.
   ============================================================ */

const APP_VERSION = "1.7.0";

/* Survives the reload so we can confirm on the other side. */
const DONE_KEY = "snow.updatedTo";

let latestVersion = null;
let onNewVersion = null;

/** Polls version.txt. Cheap, silent, safe to call often. */
async function checkForUpdate() {
  try {
    // One version.txt at the site root, shared by both apps, which each
    // live one folder down.
    const res = await fetch("../version.txt?_=" + Date.now(), { cache: "no-cache" });
    if (!res.ok) return false;
    const live = (await res.text()).trim();
    if (!live) return false;

    const newer = live !== APP_VERSION;
    latestVersion = newer ? live : APP_VERSION;
    if (newer && onNewVersion) onNewVersion(live);
    return newer;
  } catch {
    latestVersion = null;              // offline
    return false;
  }
}

/**
 * Throw away cached assets and reload onto the new build.
 *
 * Deliberately does NOT unregister the service worker. Unregistering makes
 * the reload uncontrolled, so the browser's own HTTP cache serves the old
 * files and the update appears to do nothing until the app is closed and
 * reopened. Staying controlled means the reload flows through the worker's
 * network-first handler and picks up the new files immediately.
 */
async function forceUpdate(target) {
  try {
    sessionStorage.setItem(DONE_KEY, target || "");
  } catch {}

  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }

    // Emptying our own cache is only half of it. The worker's network-first
    // fetch still goes through the BROWSER's HTTP cache, and GitHub Pages
    // sends max-age=600 — so the reload happily served ten-minute-old JS and
    // the update pill came straight back. cache:"reload" bypasses that cache
    // and overwrites the entry, so the reload sees the real files.
    await Promise.allSettled(
      BUST.map((u) => fetch(u, { cache: "reload" }).catch(() => null))
    );

    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) { try { await reg.update(); } catch {} }
    }
  } catch {
    /* best effort — reload regardless */
  }
  window.location.replace(window.location.pathname + "?v=" + Date.now());
}

/* Everything a page is built from, relative to the app folder it's in.
   Refetched past the HTTP cache on update; a 404 on any one of them is
   ignored, which is how app.js and admin.js can both be listed when only
   one of them exists in a given folder. */
const BUST = [
  "./",
  "index.html",
  "app.js",
  "admin.js",
  "manifest.webmanifest",
  "sw.js",
  "../styles.css",
  "../config.js",
  "../updater.js",
  "../sw-core.js",
];

/* ------------------------------------------------------------ toast */
function toast(message, ms = 2400) {
  const old = document.getElementById("snowToast");
  if (old) old.remove();

  const el = document.createElement("div");
  el.id = "snowToast";
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);

  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/* ------------------------------------------------------------ action */
/** Tap the version, or the pill: check, then either update or say so. */
async function runUpdate(button) {
  const label = button ? button.textContent : null;
  if (button) { button.disabled = true; button.textContent = "Checking…"; }

  const newer = await checkForUpdate();

  if (newer) {
    if (button) button.textContent = "Updating…";
    return forceUpdate(latestVersion);      // navigates away
  }

  if (button) { button.disabled = false; button.textContent = label; }
  toast(latestVersion === null
    ? "Can't check right now — you're offline"
    : `Up to date · v${APP_VERSION}`);
}

/**
 * Wire up the update UI.
 *   buttons – elements that run the update when tapped
 *   pill    – optional element revealed when a poll finds a newer version
 */
function wireUpdater(buttons, pill) {
  buttons.filter(Boolean).forEach((b) => {
    b.textContent = "v" + APP_VERSION;
    b.addEventListener("click", () => runUpdate(b));
  });

  if (pill) {
    onNewVersion = () => (pill.hidden = false);
    pill.addEventListener("click", () => runUpdate(null));
  }

  // Landed here from an update we just ran — confirm it and move on.
  try {
    const target = sessionStorage.getItem(DONE_KEY);
    if (target !== null) {
      sessionStorage.removeItem(DONE_KEY);
      // Only claim success if we really are on the version we aimed for.
      // Say so when we aren't, rather than leaving a pill that never clears
      // and no explanation for why tapping it keeps doing nothing.
      if (!target || target === APP_VERSION) {
        toast(`Updated to v${APP_VERSION}`);
      } else {
        toast(`Still on v${APP_VERSION} — close the app and reopen it`, 5000);
      }
    }
  } catch {}

  registerServiceWorker();

  checkForUpdate();
  window.addEventListener("focus", checkForUpdate);
  setInterval(checkForUpdate, 120_000);
}

/* ------------------------------------------------------------ install
   Chrome and Edge fire beforeinstallprompt and let us show a real button.
   iOS Safari never has, and Firefox never will, so there the same button
   explains that browser's own route instead. Shared by both pages.

   Buttons marked data-install-always stay visible even before (or without)
   a prompt event — that's the one on the job board's sign-in card, where
   staff go looking for it. The compact header buttons only appear once a
   real prompt is in hand.                                              */
function wireInstall(buttons, hint, hintClose) {
  const live = buttons.filter(Boolean);
  if (!live.length) return;

  const installed =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (installed) {                             // already on their home screen
    live.forEach((b) => (b.hidden = true));
    return;
  }

  const always = live.filter((b) => b.hasAttribute("data-install-always"));
  const show = (on) => live.forEach((b) => (b.hidden = !on));
  let prompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();                        // we choose when to ask
    prompt = e;
    promptEverFired = true;
    show(true);
  });

  window.addEventListener("appinstalled", () => {
    prompt = null;
    show(false);
    if (hint) hint.hidden = true;
  });

  live.forEach((b) => b.addEventListener("click", async () => {
    if (prompt) {
      prompt.prompt();
      await prompt.userChoice;                 // resolves whichever way
      prompt = null;
      show(false);
      always.forEach((x) => (x.hidden = false));
      return;
    }
    showInstallHint(hint);                     // no prompt: explain the route
  }));

  if (hintClose) {
    hintClose.addEventListener("click", () => (hint.hidden = true));
  }

  always.forEach((b) => (b.hidden = false));
}

/* Set the first time Chrome offers us a prompt. If it stays false on a
   Chromium browser, Chrome has decided the page isn't installable — and
   the reason is what reportInstallState() goes looking for. */
let promptEverFired = false;

/**
 * Write the browser's own answers into the hint card, so an install that
 * refuses to happen on a phone can be diagnosed without a USB cable.
 * Everything here is read-only and best effort.
 */
async function reportInstallState() {
  const out = document.getElementById("installDiag");
  if (!out) return;

  const lines = [];
  const link = document.querySelector('link[rel="manifest"]');
  lines.push("manifest tag: " + (link ? link.getAttribute("href") : "MISSING"));

  if (link) {
    try {
      const res = await fetch(link.href, { cache: "no-store" });
      const m = await res.json();
      lines.push(`manifest: ${res.status} · id ${m.id} · start ${m.start_url}`);
    } catch (err) {
      lines.push("manifest: FAILED TO LOAD — " + err.message);
    }
  }

  lines.push("worker: " + (navigator.serviceWorker
    ? (navigator.serviceWorker.controller ? "controlling" : "not controlling")
    : "unsupported"));
  lines.push("prompt offered: " + (promptEverFired ? "yes" : "no"));
  lines.push("display: " +
    (window.matchMedia("(display-mode: standalone)").matches
      ? "standalone" : "browser"));

  // The interesting one: Chrome refuses to offer an install when it thinks
  // a related app covering this page is already on the phone.
  if (navigator.getInstalledRelatedApps) {
    try {
      const apps = await navigator.getInstalledRelatedApps();
      lines.push("already installed here: " + (apps.length
        ? apps.map((a) => a.id || a.url || a.platform).join(", ")
        : "none"));
    } catch {
      lines.push("already installed here: unreadable");
    }
  }

  lines.push("v" + APP_VERSION);
  out.textContent = lines.join("\n");
  out.hidden = false;
}

/* Fills the hint card with directions for whichever browser this is, since
   only Chromium lets us do the install ourselves. */
function showInstallHint(hint) {
  if (!hint) return;

  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const isFirefox = /firefox|fxios/i.test(ua);

  let title = "Install this app";
  let body =
    "Open your browser's menu and choose Install app or Add to Home Screen.";

  if (isIOS) {
    title = "Add to Home Screen";
    body = "Tap the Share button in Safari, then Add to Home Screen.";
  } else if (isFirefox) {
    title = "Add to Home Screen";
    body = isAndroid
      ? "Tap the ⋮ menu, then Install or Add to Home Screen."
      : "Firefox on the desktop can't install web apps. Open this page in " +
        "Chrome or Edge to install it.";
  } else if (isAndroid) {
    title = "Add to Home Screen";
    body = "Tap the ⋮ menu, then Install app.";
  } else {
    body =
      "Click the install icon at the right end of the address bar, or open " +
      "the ⋮ menu and choose Install.";
  }

  reportInstallState();

  const t = document.getElementById("installHintTitle");
  const b = document.getElementById("installHintBody");
  if (t) t.textContent = title;
  if (b) b.textContent = body;
  hint.hidden = false;
}

/* Registered here so both the form and the job board are installable and
   work offline, whichever one someone opens first. No update handling —
   version.txt owns that. */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;   // no worker support, only errors

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch((err) => console.warn("service worker registration failed", err));
  });
}
