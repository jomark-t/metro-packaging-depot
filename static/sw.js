/* Metro Packaging Depot - service worker.
 *
 * This is a live, logged-in app full of payroll and orders, so the worker is
 * deliberately thin. It exists so the app can be installed and so a dropped
 * connection shows a friendly page instead of the browser's error.
 *
 *  - pages and /api/ are NEVER cached: nothing private is kept on the device
 *    and nothing is ever shown stale;
 *  - static files (script, icons) go to the network first and fall back to the
 *    last copy, so a deploy is picked up straight away;
 *  - a navigation that cannot reach the server gets /static/offline.html.
 *
 * Bump CACHE to throw old copies away.
 */
const CACHE = "mpd-shell-v1";
const OFFLINE = "/static/offline.html";
const PRECACHE = [OFFLINE, "/static/icons/android-chrome-192x192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // live data: straight to the network

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }

  if (url.pathname.startsWith("/static/") && !url.pathname.startsWith("/static/uploads/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
