/* ============================================================
   Update checker — shared by the form and the job board.

   Three things must move together on every deploy:

       APP_VERSION here
       VERSION     in sw.js   (names the cache)
       version.txt at the root (what the running app polls)

   Use `python tools/bump_version.py 1.3.2` so they can't drift. If
   version.txt falls behind, the app offers a phantom update forever;
   if it runs ahead, nobody is ever told there's a new one.

   version.txt is the ONLY thing that decides whether an update exists.
   The service worker deliberately does not get a vote: a new worker
   installs as a *result* of updating, which used to re-raise the
   "update available" pill the instant an update succeeded.
   ============================================================ */

const APP_VERSION = "1.5.0";

/* Survives the reload so we can confirm on the other side. */
const DONE_KEY = "snow.updatedTo";

let latestVersion = null;
let onNewVersion = null;

/** Polls version.txt. Cheap, silent, safe to call often. */
async function checkForUpdate() {
  try {
    const res = await fetch("./version.txt?_=" + Date.now(), { cache: "no-cache" });
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
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) { try { await reg.update(); } catch {} }
    }
  } catch {
    /* best effort — reload regardless */
  }
  window.location.replace(window.location.pathname + "?v=" + Date.now());
}

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
      if (!target || target === APP_VERSION) toast(`Updated to v${APP_VERSION}`);
    }
  } catch {}

  registerServiceWorker();

  checkForUpdate();
  window.addEventListener("focus", checkForUpdate);
  setInterval(checkForUpdate, 120_000);
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
