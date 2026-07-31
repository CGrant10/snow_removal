/* ============================================================
   Service worker core — shared by reserve/ and board/.

   Not registered directly. Each app has a one-line sw.js that sets
   APP_BASE and APP_SHELL, then importScripts() this. That's what gives
   the two apps separate registration scopes, which is the whole point:
   Android allows one installed app per scope, so when both manifests
   claimed /snow_removal/ the second one could never be installed.

   BUMP `VERSION` ON EVERY DEPLOY. It names the cache, so changing it
   is what makes browsers throw away the old files. Forget, and people
   who installed the app keep running last week's prices.

   Strategy is network-first for everything. A snow business changes
   prices and service areas mid-season, and a stale price is worse than
   a slow load. The cache is the offline fallback, not the fast path.
   ============================================================ */

const VERSION = "v1.7.1";
const CACHE = `snow-${VERSION}`;

/* How far up the shared files live. "../" from an app folder, "./" from
   the root shim. Relative URLs in a worker resolve against the script
   that was registered, not against this one. */
const BASE = self.APP_BASE || "./";

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  BASE + "styles.css",
  BASE + "config.js",
  BASE + "updater.js",
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png",
  BASE + "icons/icon-maskable-512.png",
  ...(self.APP_SHELL || []),   // the one script that app owns
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Individually, so one 404 can't fail the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;

  // Only same-origin GETs. Reservations POST to Apps Script or a webhook
  // and must never be intercepted, cached, or replayed.
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // version.txt is always live and never cached — it IS the update
  // mechanism. Cache it once and the app can never learn it's outdated.
  if (request.url.includes("version.txt")) {
    e.respondWith(
      fetch(request, { cache: "no-cache" })
        .catch(() => new Response("", { status: 504 }))
    );
    return;
  }

  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        // A navigation with nothing cached for that exact URL still gets
        // the app shell, which is the whole page anyway.
        if (request.mode === "navigate") {
          const shell = await caches.match("index.html");
          if (shell) return shell;
        }
        return new Response("Offline", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      })
  );
});

/* No message handler. The update path is: version.txt says there's a new
   build -> clear caches -> reload. install() already calls skipWaiting(),
   so there is never a worker sitting in "waiting" to be nudged. */
