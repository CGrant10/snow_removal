/* ============================================================
   Update checker — shared by the form and the job board.

   Three things must move together on every deploy:

       APP_VERSION here
       VERSION     in sw.js   (names the cache)
       version.txt at the root (what the running app polls)

   Use `python tools/bump_version.py 1.2.1` so they can't drift. If
   version.txt falls behind, the app offers a phantom update forever;
   if it runs ahead, nobody is ever told there's a new one.
   ============================================================ */

const APP_VERSION = "1.3.0";

let latestVersion = null;   // live version string, when it differs from ours
let onNewVersion = null;    // set by wireUpdater

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
    return false;              // offline: nothing to say
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
async function forceUpdate() {
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

/* ------------------------------------------------------------ overlay */
function showUpdateOverlay() {
  if (document.getElementById("updOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "updOverlay";
  overlay.className = "updOverlay";
  overlay.innerHTML = `
    <div class="updCard" role="status" aria-live="polite">
      <div class="updHead"><span class="dot"></span>Software update</div>
      <div class="updBody" id="updBody"></div>
    </div>`;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#updBody");
  const line = (html, cls = "") => {
    const d = document.createElement("div");
    d.className = "updLine" + (cls ? " " + cls : "");
    d.innerHTML = html;
    body.appendChild(d);
  };

  let canClose = false;
  const close = () => {
    overlay.classList.add("out");
    setTimeout(() => overlay.remove(), 240);
  };
  overlay.addEventListener("click", () => canClose && close());

  setTimeout(() => line("Checking for updates…"), 200);
  setTimeout(() => line(`Comparing against v${APP_VERSION}…`), 850);

  setTimeout(async () => {
    const newer = await checkForUpdate();
    if (newer) {
      line(`<strong>v${latestVersion} found</strong> — installing<span class="cur">▋</span>`, "big ok");
      setTimeout(forceUpdate, 1200);          // navigates away
    } else if (latestVersion === null) {
      line("<strong>Couldn't reach the server</strong>", "big");
      line("You're offline. Try again when you have signal.", "dim");
      canClose = true;
      setTimeout(() => overlay.isConnected && close(), 3200);
    } else {
      line(`<strong>Up to date</strong> ✓ <span class="dim">v${APP_VERSION}</span>`, "big ok");
      line("Tap anywhere to close", "dim");
      canClose = true;
      setTimeout(() => overlay.isConnected && close(), 2600);
    }
  }, 1500);
}

/**
 * Wire up the update UI.
 *   buttons – elements that open the overlay when tapped
 *   pill    – optional element revealed automatically when a poll finds
 *             a newer version, so nobody has to think to check
 */
function wireUpdater(buttons, pill) {
  buttons.filter(Boolean).forEach((b) => {
    b.textContent = "v" + APP_VERSION;
    b.addEventListener("click", showUpdateOverlay);
  });

  if (pill) {
    onNewVersion = () => (pill.hidden = false);
    pill.addEventListener("click", showUpdateOverlay);
  }

  registerServiceWorker(pill);

  checkForUpdate();
  window.addEventListener("focus", checkForUpdate);
  setInterval(checkForUpdate, 120_000);
}

/* Registered from here so both the form and the job board are installable
   and work offline, whichever one someone opens first. */
function registerServiceWorker(pill) {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;   // no worker support, only errors

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");

      reg.addEventListener("updatefound", () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener("statechange", () => {
          // A controller already exists, so this is an update rather than a
          // first install. Offer it — never reload out from under someone
          // who is halfway through the form.
          if (fresh.state === "installed" &&
              navigator.serviceWorker.controller && pill) {
            pill.hidden = false;
          }
        });
      });
    } catch (err) {
      console.warn("service worker registration failed", err);
    }
  });
}
